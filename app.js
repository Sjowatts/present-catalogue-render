import express from "express";
import path from "node:path";
import crypto from "node:crypto";
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

// Optional password for the whole app: set APP_PASSWORD on the server.
// Shared-list pages, the health check and the scheduled refresh stay reachable.
const OPEN_PATHS = /^\/(healthz|s\/[a-f0-9]{32}|api\/share\/[a-f0-9]{32}(\/claim)?|api\/refresh-all|style\.css|shared\.js|favicon\.svg)$/;
app.use((req, res, next) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw || OPEN_PATHS.test(req.path)) return next();
  const given = Buffer.from((req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
  const supplied = Buffer.from(given.slice(given.indexOf(":") + 1));
  const wanted = Buffer.from(pw);
  if (supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted)) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="Ffi\'s Presents"');
  res.status(401).send("Password needed");
});
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
app.use(express.static(publicDir, { index: false }));

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
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS list_id TEXT;`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS favourite BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS claimed_by TEXT;`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now();`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lists (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      budget NUMERIC,
      budget_currency TEXT DEFAULT 'GBP',
      share_token TEXT UNIQUE,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS price_history (
      id BIGSERIAL PRIMARY KEY,
      item_id TEXT NOT NULL,
      price NUMERIC NOT NULL,
      currency TEXT,
      at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`CREATE INDEX IF NOT EXISTS price_history_item ON price_history (item_id, at);`);
  // Items saved before price tracking get a starting point from their current price.
  await pool.query(`
    INSERT INTO price_history (item_id, price, currency, at)
    SELECT i.id, i.price_value, i.price_currency, COALESCE(i.last_checked, now())
    FROM items i
    WHERE i.price_value IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM price_history h WHERE h.item_id = i.id);
  `);
}

// Remember a price only when it differs from the last one we saw.
async function recordPrice(itemId, value, currency) {
  if (value == null) return;
  const { rows } = await pool.query(
    `SELECT price, currency FROM price_history WHERE item_id=$1 ORDER BY at DESC, id DESC LIMIT 1`, [itemId]);
  if (rows[0] && Number(rows[0].price) === Number(value) && rows[0].currency === (currency || null)) return;
  await pool.query(`INSERT INTO price_history (item_id, price, currency) VALUES ($1,$2,$3)`, [itemId, value, currency || null]);
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

const newId = () => `${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
const cleanText = (s, max) => String(s ?? "").trim().slice(0, max);
const cleanCurrency = (c) => (/^[A-Za-z]{3}$/.test(String(c || "")) ? String(c).toUpperCase() : "GBP");
// undefined = invalid, null = no budget, number = budget
const parseBudget = (b) => {
  if (b === null || b === undefined || b === "") return null;
  const n = Number(b);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};
const LIST_COLUMNS = `id, name, budget, budget_currency, share_token, created_at`;

/* ---------------- Backup ---------------- */
// Everything the app stores, as one JSON file.
app.get("/api/export", async (_req, res) => {
  const [lists, items, history] = await Promise.all([
    pool.query(`SELECT ${LIST_COLUMNS} FROM lists ORDER BY created_at, id`),
    pool.query(`SELECT * FROM items ORDER BY created_at DESC, id DESC`),
    pool.query(`SELECT item_id, price, currency, at FROM price_history ORDER BY at, id`)
  ]);
  const lists_out = lists.rows.map(({ share_token, ...l }) => l); // share links are not exported
  res.setHeader("content-type", "application/json");
  res.setHeader("content-disposition", 'attachment; filename="ffis-presents-' + new Date().toISOString().slice(0,10) + '.json"');
  res.send(JSON.stringify({ version: 2, exportedAt: new Date().toISOString(), lists: lists_out, items: items.rows, price_history: history.rows }, null, 2));
});

// Restore from an export (existing ids are left untouched). Old exports were a bare array of items.
app.post("/api/import", express.json({ limit: "20mb" }), async (req, res) => {
  const body = req.body;
  const items = Array.isArray(body) ? body : body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "Expected an export file from this app" });
  const lists = Array.isArray(body?.lists) ? body.lists : [];
  const history = Array.isArray(body?.price_history) ? body.price_history : [];

  for (const l of lists) {
    if (!l?.id || !l?.name) continue;
    await pool.query(
      `INSERT INTO lists (id,name,budget,budget_currency,created_at) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO NOTHING`,
      [l.id, cleanText(l.name, 60), parseBudget(l.budget) ?? null, cleanCurrency(l.budget_currency), l.created_at ?? new Date().toISOString()]);
  }

  let added = 0;
  for (const it of items) {
    if (!it?.url) continue;
    const id = it.id || newId();
    const r = await pool.query(
      `INSERT INTO items (id,url,store,title,image,description,price_value,price_currency,last_checked,source,bought,notes,list_id,favourite,claimed_by,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               (SELECT id FROM lists WHERE id=$13),$14,$15,$16)
       ON CONFLICT (id) DO NOTHING`,
      [id, it.url, it.store ?? null, it.title ?? null, it.image ?? null, it.description ?? null,
       it.price_value ?? null, it.price_currency ?? "GBP", it.last_checked ?? new Date().toISOString(),
       it.source ?? "import", !!it.bought, it.notes ?? null,
       it.list_id ?? null, !!it.favourite, it.claimed_by ?? null, it.created_at ?? new Date().toISOString()]
    );
    if (r.rowCount) {
      added += 1;
      const own = history.filter((h) => h.item_id === id && h.price != null);
      for (const h of own) {
        await pool.query(`INSERT INTO price_history (item_id,price,currency,at) VALUES ($1,$2,$3,$4)`,
          [id, h.price, h.currency ?? null, h.at ?? new Date().toISOString()]);
      }
      if (!own.length) await recordPrice(id, it.price_value, it.price_currency ?? "GBP");
    }
  }
  res.json({ ok: true, added });
});

/* ---------------- Lists ---------------- */
app.get("/api/lists", async (_req, res) => {
  const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists ORDER BY created_at, id`);
  res.json(rows);
});

app.post("/api/lists", async (req, res) => {
  const name = cleanText(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: "Give the list a name" });
  const budget = parseBudget(req.body?.budget);
  if (budget === undefined) return res.status(400).json({ error: "Budget must be a number" });
  const id = newId();
  await pool.query(`INSERT INTO lists (id,name,budget,budget_currency) VALUES ($1,$2,$3,$4)`,
    [id, name, budget, cleanCurrency(req.body?.currency)]);
  const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE id=$1`, [id]);
  res.json(rows[0]);
});

// Rename a list or change its budget (send only the fields to change).
app.post("/api/lists/:id", async (req, res) => {
  const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE id=$1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: "List not found" });
  const cur = rows[0], b = req.body || {};
  const name = "name" in b ? cleanText(b.name, 60) : cur.name;
  if (!name) return res.status(400).json({ error: "Give the list a name" });
  const budget = "budget" in b ? parseBudget(b.budget) : (cur.budget == null ? null : Number(cur.budget));
  if (budget === undefined) return res.status(400).json({ error: "Budget must be a number" });
  const currency = "currency" in b ? cleanCurrency(b.currency) : cur.budget_currency;
  await pool.query(`UPDATE lists SET name=$2, budget=$3, budget_currency=$4 WHERE id=$1`, [cur.id, name, budget, currency]);
  const out = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE id=$1`, [cur.id]);
  res.json(out.rows[0]);
});

// Presents in a deleted list are kept, just unsorted.
app.delete("/api/lists/:id", async (req, res) => {
  await pool.query(`UPDATE items SET list_id=NULL WHERE list_id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM lists WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

// Turn the private share link for a list on or off. Turning it on again makes a new link.
app.post("/api/lists/:id/share", async (req, res) => {
  const token = req.body?.enabled ? crypto.randomBytes(16).toString("hex") : null;
  const r = await pool.query(`UPDATE lists SET share_token=$2 WHERE id=$1`, [req.params.id, token]);
  if (!r.rowCount) return res.status(404).json({ error: "List not found" });
  const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE id=$1`, [req.params.id]);
  res.json(rows[0]);
});

/* ---------------- Items ---------------- */
app.get("/api/items", async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT i.*,
      COALESCE((
        SELECT json_agg(json_build_object('p', h.price, 'c', h.currency, 'at', h.at) ORDER BY h.at, h.id)
        FROM (SELECT * FROM price_history WHERE item_id = i.id ORDER BY at DESC, id DESC LIMIT 40) h
      ), '[]'::json) AS history
    FROM items i
    ORDER BY i.created_at DESC, i.id DESC`);
  res.json(rows);
});

app.post("/api/add", async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: "Missing url" });
  try {
    const data = await scrapeProduct(url);
    const id = newId();
    await pool.query(
      `INSERT INTO items (id,url,store,title,image,description,price_value,price_currency,last_checked,source,bought,notes,list_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,null,(SELECT id FROM lists WHERE id=$11))`,
      [id, data.url, data.store, data.title, data.image, data.description, data.priceValue, data.priceCurrency, data.lastChecked, data.source, req.body?.list_id ?? null]
    );
    await recordPrice(id, data.priceValue, data.priceCurrency);
    const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message || "Scrape failed" });
  }
});

async function refreshItem(id) {
  const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
  if (!rows.length) return null;
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
  await recordPrice(id, data.priceValue, data.priceCurrency);
  const { rows: fresh } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
  return fresh[0];
}

app.post("/api/refresh/:id", async (req, res) => {
  try {
    const item = await refreshItem(req.params.id);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (e) {
    res.status(500).json({ error: e.message || "Refresh failed" });
  }
});

// Re-check every price. Meant for a scheduled job; needs REFRESH_TOKEN set on the server.
let refreshAllRunning = false;
app.post("/api/refresh-all", async (req, res) => {
  const token = process.env.REFRESH_TOKEN;
  if (!token) return res.status(503).json({ error: "Set REFRESH_TOKEN on the server to enable this" });
  const given = Buffer.from(String(req.headers["x-refresh-token"] || ""));
  const wanted = Buffer.from(token);
  if (given.length !== wanted.length || !crypto.timingSafeEqual(given, wanted)) return res.status(401).json({ error: "Wrong token" });
  if (refreshAllRunning) return res.status(202).json({ started: false, message: "Already running" });
  const { rows } = await pool.query(`SELECT id FROM items ORDER BY last_checked NULLS FIRST`);
  refreshAllRunning = true;
  res.status(202).json({ started: true, items: rows.length });
  (async () => {
    for (const { id } of rows) {
      try { await refreshItem(id); } catch (e) { console.error("Refresh failed for " + id + ": " + e.message); }
    }
    refreshAllRunning = false;
  })();
});

const itemUpdater = (sql, pick) => async (req, res) => {
  const value = pick(req.body || {});
  const r = await pool.query(sql, [req.params.id, value]);
  if (!r.rowCount) return res.status(404).json({ error: "Not found" });
  const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1`, [req.params.id]);
  res.json(rows[0]);
};
app.post("/api/items/:id/bought", itemUpdater(`UPDATE items SET bought=$2 WHERE id=$1`, (b) => !!b.bought));
app.post("/api/items/:id/favourite", itemUpdater(`UPDATE items SET favourite=$2 WHERE id=$1`, (b) => !!b.favourite));
app.post("/api/items/:id/notes", itemUpdater(`UPDATE items SET notes=$2 WHERE id=$1`, (b) => b.notes ?? null));
// The owner can set or clear who is getting a present.
app.post("/api/items/:id/claim", itemUpdater(`UPDATE items SET claimed_by=$2 WHERE id=$1`, (b) => cleanText(b.claimed_by, 40) || null));
app.post("/api/items/:id/list", itemUpdater(
  `UPDATE items SET list_id=(SELECT id FROM lists WHERE id=$2) WHERE id=$1`, (b) => b.list_id ?? null));

app.delete("/api/items/:id", async (req, res) => {
  await pool.query(`DELETE FROM price_history WHERE item_id=$1`, [req.params.id]);
  await pool.query(`DELETE FROM items WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});

/* ---------------- Shared lists (no password; the link is the key) ---------------- */
const listByToken = async (token) => {
  if (!/^[a-f0-9]{32}$/.test(String(token))) return null;
  const { rows } = await pool.query(`SELECT id, name FROM lists WHERE share_token=$1`, [token]);
  return rows[0] || null;
};

app.get("/s/:token", (_req, res) => res.sendFile(path.join(publicDir, "shared.html")));

// Only what a visitor needs: no notes, no other lists.
app.get("/api/share/:token", async (req, res) => {
  const list = await listByToken(req.params.token);
  if (!list) return res.status(404).json({ error: "This link isn't active any more" });
  const { rows } = await pool.query(
    `SELECT id, title, image, url, description, price_value, price_currency, bought, claimed_by, favourite
     FROM items WHERE list_id=$1 ORDER BY favourite DESC, created_at DESC, id DESC`, [list.id]);
  res.json({ list: { name: list.name }, items: rows });
});

app.post("/api/share/:token/claim", async (req, res) => {
  const list = await listByToken(req.params.token);
  if (!list) return res.status(404).json({ error: "This link isn't active any more" });
  const name = cleanText(req.body?.name, 40);
  if (!name) return res.status(400).json({ error: "Add your name first" });
  const { rows } = await pool.query(`SELECT id, claimed_by FROM items WHERE id=$1 AND list_id=$2`, [req.body?.itemId, list.id]);
  if (!rows.length) return res.status(404).json({ error: "Present not found" });
  const owner = rows[0].claimed_by;
  if (req.body?.claim === false) {
    if (owner && owner.toLowerCase() !== name.toLowerCase()) return res.status(403).json({ error: "Someone else is getting this one" });
    await pool.query(`UPDATE items SET claimed_by=NULL WHERE id=$1`, [rows[0].id]);
  } else {
    if (owner && owner.toLowerCase() !== name.toLowerCase()) return res.status(409).json({ error: owner + " is already getting this one" });
    await pool.query(`UPDATE items SET claimed_by=$2 WHERE id=$1`, [rows[0].id, name]);
  }
  res.json({ ok: true });
});

/* --------------- UI --------------- */
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

const PORT = process.env.PORT || 3000;
(async () => {
  app.listen(PORT, () => console.log("Price catalogue on http://localhost:"+PORT));
  await initDbWithRetry();
})();
