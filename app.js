import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { scrapeWithHeuristics } from "./lib/heuristics.js";
import { renderHtmlWithPlaywright } from "./lib/renderers/playwright.js";

import pgPkg from "pg";
const { Pool } = pgPkg;
const dbUrl = (process.env.DATABASE_URL || "").replace(/^postgresql:\/\//, "postgres://");
const isLocalDb = /@(localhost|127\.0\.0\.1)/.test(dbUrl);
const pool = new Pool({
  connectionString: dbUrl,
  ssl: isLocalDb ? false : { rejectUnauthorized: false },
  keepAlive: true,
  max: 5,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 15000
});
// Serverless Postgres (Neon etc.) drops idle connections; don't crash on it.
pool.on("error", (e) => console.error("Idle DB client error:", e.message));
let dbReady = false;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const normalizeHost = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
};

/* ---------- DB setup ---------- */
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS items (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      store TEXT,
      title TEXT,
      image TEXT,
      description TEXT,
      price_value NUMERIC,
      price_currency TEXT,
      last_checked TIMESTAMPTZ,
      source TEXT,
      bought BOOLEAN DEFAULT FALSE,
      notes TEXT
    );
  `);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS bought BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS notes TEXT;`);
}

async function initDbWithRetry() {
  if (!dbUrl) console.error("DATABASE_URL is not set");
  for (let attempt = 1; !dbReady; attempt++) {
    try {
      await initDb();
      dbReady = true;
      console.log("Database ready");
    } catch (e) {
      console.error("DB init failed (attempt " + attempt + "): " + e.message);
      await new Promise(r => setTimeout(r, Math.min(30000, 2000 * attempt)));
    }
  }
}

/* ---------- Scrape ---------- */
async function scrapeProduct(url) {
  const host = normalizeHost(url);
  let title=null, image=null, priceValue=null, priceCurrency=null, description=null, source="heuristics";

  // First try fast fetch
  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-GB,en;q=0.9",
        "cache-control": "no-cache", "pragma": "no-cache"
      },
      redirect: "follow"
    });
    if (res.ok) {
      const html = await res.text();
      ({ title, image, priceValue, priceCurrency, description } = scrapeWithHeuristics(html, url));
    }
  } catch {}

  // Fallback to Playwright render if no price
  if (priceValue == null) {
    try {
      const html = await renderHtmlWithPlaywright(url);
      ({ title, image, priceValue, priceCurrency, description } = scrapeWithHeuristics(html, url));
      source = "playwright";
    } catch {}
  }

  return {
    url,
    store: host,
    title: title || "(No title found)",
    image,
    description: description || null,
    priceValue: priceValue ?? null,
    priceCurrency: priceValue != null ? (priceCurrency || "GBP") : null, // keep the shop's own currency
    lastChecked: new Date().toISOString(),
    source
  };
}

/* ---------------- API ---------------- */
app.get("/healthz", (_req, res) => res.json({ ok: true, db: dbReady }));

app.use("/api", (_req, res, next) => {
  if (dbReady) return next();
  res.status(503).json({ error: "Database not connected yet. Check DATABASE_URL." });
});

// Download every saved item as JSON (backup)
// Diagnostics: lists every price found on a product page and which one wins.
// Usage: /api/debug-price?url=https://shop.example/product
app.get("/api/debug-price", async (req, res) => {
  const url = String(req.query.url || "");
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Pass ?url=https://..." });
  const out = { url };
  try {
    const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36", "accept-language": "en-GB,en;q=0.9" }, redirect: "follow" });
    out.fetchStatus = r.status;
    if (r.ok) {
      const html = await r.text();
      out.fast = scrapeWithHeuristics(html, url, { debug: true });
      // Price-like text anywhere in the raw HTML (inline scripts, data attributes) to see where a shop hides its price.
      out.priceSnippets = [...html.matchAll(/.{0,60}(?:price|amount)["'\s]*[:=]\s*["']?[£$€]?\d[\d.,]*.{0,30}/gi)]
        .slice(0, 25).map(m => m[0].replace(/\s+/g, " "));
      out.htmlLength = html.length;
    }
  } catch (e) { out.fetchError = e.message; }
  if (out.fast?.priceValue == null) {
    try { out.playwright = scrapeWithHeuristics(await renderHtmlWithPlaywright(url), url, { debug: true }); }
    catch (e) { out.playwrightError = e.message; }
  }
  res.json(out);
});

app.get("/api/export", async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM items ORDER BY last_checked DESC`);
  res.setHeader("content-type", "application/json");
  res.setHeader("content-disposition", 'attachment; filename="ffis-presents-' + new Date().toISOString().slice(0,10) + '.json"');
  res.send(JSON.stringify(rows, null, 2));
});

// Restore items from a previous export (existing ids are left untouched)
app.post("/api/import", express.json({ limit: "20mb" }), async (req, res) => {
  const items = Array.isArray(req.body) ? req.body : req.body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "Expected a JSON array of items" });
  let added = 0;
  for (const it of items) {
    if (!it?.url) continue;
    const id = it.id || `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    const r = await pool.query(
      `INSERT INTO items (id,url,store,title,image,description,price_value,price_currency,last_checked,source,bought,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (id) DO NOTHING`,
      [id, it.url, it.store ?? null, it.title ?? null, it.image ?? null, it.description ?? null,
       it.price_value ?? null, it.price_currency ?? "GBP", it.last_checked ?? new Date().toISOString(),
       it.source ?? "import", !!it.bought, it.notes ?? null]
    );
    added += r.rowCount;
  }
  res.json({ ok: true, added });
});

app.get("/api/items", async (_req, res) => {
  const { rows } = await pool.query(`SELECT * FROM items ORDER BY last_checked DESC`);
  res.json(rows);
});

app.post("/api/add", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url" });
  try {
    const data = await scrapeProduct(url);
    const id = `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
    await pool.query(
      `INSERT INTO items (id,url,store,title,image,description,price_value,price_currency,last_checked,source,bought,notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,null)`,
      [id, data.url, data.store, data.title, data.image, data.description, data.priceValue, data.priceCurrency, data.lastChecked, data.source]
    );
    res.json({ id, ...data, bought:false, notes:null });
  } catch (e) {
    res.status(500).json({ error: e.message || "Scrape failed" });
  }
});

app.post("/api/refresh/:id", async (req, res) => {
  const { id } = req.params;
  const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  try {
    const data = await scrapeProduct(rows[0].url);
    await pool.query(
      `UPDATE items SET store=$2,
         title=CASE WHEN $3 = '(No title found)' THEN title ELSE COALESCE($3, title) END,
         image=COALESCE($4, image), description=COALESCE($5, description),
         price_value=COALESCE($6, price_value),
         price_currency=CASE WHEN $6::numeric IS NULL THEN price_currency ELSE $7 END,
         last_checked=$8, source=$9
       WHERE id=$1`,
      [id, data.store, data.title, data.image, data.description, data.priceValue, data.priceCurrency, data.lastChecked, data.source]
    );
    const { rows: fresh } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
    res.json(fresh[0]);
  } catch (e) {
    res.status(500).json({ error: e.message || "Refresh failed" });
  }
});

// Toggle bought
app.post("/api/items/:id/bought", async (req,res) => {
  const { id } = req.params;
  const { bought } = req.body || {};
  await pool.query(`UPDATE items SET bought=$2 WHERE id=$1`, [id, !!bought]);
  const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
  res.json(rows[0] || { ok:true });
});

// Update notes
app.post("/api/items/:id/notes", async (req,res) => {
  const { id } = req.params;
  const { notes } = req.body || {};
  await pool.query(`UPDATE items SET notes=$2 WHERE id=$1`, [id, notes ?? null]);
  const { rows } = await pool.query(`SELECT notes FROM items WHERE id=$1`, [id]);
  res.json(rows[0] || { ok:true });
});

// Delete item
app.delete("/api/items/:id", async (req,res) => {
  const { id } = req.params;
  await pool.query(`DELETE FROM items WHERE id=$1`, [id]);
  res.json({ ok:true });
});

/* --------------- UI --------------- */
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

const PORT = process.env.PORT || 3000;
(async () => {
  app.listen(PORT, () => console.log("Price catalogue on http://localhost:"+PORT));
  await initDbWithRetry();
})();
