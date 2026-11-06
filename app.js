import express from "express";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { scrapeWithHeuristics, parsePriceString } from "./lib/heuristics.js";
import { extractUrl, cleanUrl, urlKey } from "./lib/links.js";
import { sendAlert, priceDropped, dropMessage } from "./lib/alerts.js";
import {
  isUsableSlug, uniqueSlug, possessive, generatePin, hashPin, verifyPin, signToken, verifyToken,
  parseCookies, makeRateLimiter, parseNames, SLUG_RE, RESERVED
} from "./lib/spaces.js";
import { renderHtmlWithPlaywright } from "./lib/renderers/playwright.js";
import { BROWSER_HEADERS, looksLikeShopify, withCountryGB } from "./lib/storefront.js";
import { looksBlocked, titleFromUrl, cleanHint } from "./lib/lookup.js";

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
let sessionSecret = null;

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Behind Render/Fly the real visitor address is in X-Forwarded-For.
app.set("trust proxy", 1);

/* ---------- Who may do what ----------
   - The owner's own site (the root, "") is open unless APP_PASSWORD is set; then it asks for that password.
   - Each person has a private space at /<name>. It asks for that person's PIN.
   - The owner (APP_PASSWORD) can open every space and manage them.
   Page shells, scripts and styles are open; all data goes through /api, which checks access. */
const basicOk = (req) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return false;
  const given = Buffer.from((req.headers.authorization || "").replace(/^Basic /, ""), "base64").toString();
  const supplied = Buffer.from(given.slice(given.indexOf(":") + 1));
  const wanted = Buffer.from(pw);
  return supplied.length === wanted.length && crypto.timingSafeEqual(supplied, wanted);
};
const adminOk = (req) => basicOk(req);
const rootOk = (req) => !process.env.APP_PASSWORD || basicOk(req);
const challenge = (res) => { res.setHeader("WWW-Authenticate", 'Basic realm="Ffi\'s Presents"'); res.status(401).send("Password needed"); };

// Managing the family pages is for the owner (APP_PASSWORD) only.
const needAdmin = (req, res, next) => {
  if (adminOk(req)) return next();
  res.status(403).json({ error: process.env.APP_PASSWORD
    ? "Only the owner can do this"
    : "Set APP_PASSWORD on the server first, so only you can manage the family pages" });
};

const OPEN_ASSETS = /^\/(healthz|s\/[a-f0-9]{32}|style\.css|main\.js|shared\.js|favicon\.svg|extract\.js|manifest\.webmanifest|sw\.js|icon-192\.png|icon-512\.png|apple-touch-icon\.png)$/;
const SLUG_PAGE = /^\/([a-z0-9][a-z0-9-]{1,29})$/;
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || OPEN_ASSETS.test(req.path)) return next();
  const m = req.path.match(SLUG_PAGE);
  if (m && !RESERVED.has(m[1])) return next(); // a person's page: it asks for a PIN itself
  if (rootOk(req)) return next();
  challenge(res);
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
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS orig_value NUMERIC;`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS orig_currency TEXT;`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS price_locked BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS details_locked BOOLEAN DEFAULT FALSE;`);
  await pool.query(`ALTER TABLE items ADD COLUMN IF NOT EXISTS space TEXT NOT NULL DEFAULT '';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS items_space ON items (space);`);
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
  // Private spaces ('' is the owner's own site) and a few server-wide settings.
  await pool.query(`ALTER TABLE lists ADD COLUMN IF NOT EXISTS space TEXT NOT NULL DEFAULT '';`);
  await pool.query(`CREATE INDEX IF NOT EXISTS lists_space ON lists (space);`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS spaces (
      slug TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      pin_hash TEXT,
      ntfy_topic TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  await pool.query(`INSERT INTO spaces (slug, name) VALUES ('', 'Ffi') ON CONFLICT (slug) DO NOTHING;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  await pool.query(`INSERT INTO settings (key, value) VALUES ('session_secret', $1) ON CONFLICT (key) DO NOTHING`, [crypto.randomBytes(32).toString("hex")]);
  sessionSecret = (await pool.query(`SELECT value FROM settings WHERE key='session_secret'`)).rows[0].value;
  // Items saved before price tracking get a starting point from their current price.
  await pool.query(`
    INSERT INTO price_history (item_id, price, currency, at)
    SELECT i.id, i.price_value, i.price_currency, COALESCE(i.last_checked, now())
    FROM items i
    WHERE i.price_value IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM price_history h WHERE h.item_id = i.id);
  `);
}

/* ---------- Currency conversion (everything is shown in pounds) ---------- */
// ECB rates via frankfurter.app (free, no API key), cached for an hour.
// FX_API_URL can point somewhere else (the tests do).
const FX_BASE = process.env.FX_API_URL || "https://api.frankfurter.app";
const rateCache = new Map();
async function gbpRate(cur) {
  const hit = rateCache.get(cur);
  if (hit && Date.now() - hit.at < 3600_000) return hit.rate;
  const res = await fetch(`${FX_BASE}/latest?from=${encodeURIComponent(cur)}&to=GBP`, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error("No exchange rate for " + cur + " (" + res.status + ")");
  const rate = (await res.json())?.rates?.GBP;
  if (typeof rate !== "number" || !(rate > 0)) throw new Error("No GBP rate for " + cur);
  rateCache.set(cur, { rate, at: Date.now() });
  return rate;
}
const round2 = (n) => Math.round(n * 100) / 100;

// -> { value, currency, rate, orig }. Pounds stay as they are; anything else is converted and the
// original amount is kept in `orig`. If no rate is available the price keeps its own currency.
async function toGBP(value, currency) {
  if (value == null) return { value: null, currency: null, rate: null, orig: null };
  const cur = String(currency || "GBP").toUpperCase();
  if (cur === "GBP") return { value, currency: "GBP", rate: 1, orig: null };
  try {
    const rate = await gbpRate(cur);
    return { value: round2(value * rate), currency: "GBP", rate, orig: { value, currency: cur } };
  } catch (e) {
    console.error("Conversion failed:", e.message);
    return { value, currency: cur, rate: null, orig: null };
  }
}

// Prices saved in another currency (older items, imports) are converted once a rate is available.
async function convertExistingToGBP() {
  const { rows } = await pool.query(
    `SELECT id, price_value, price_currency FROM items
     WHERE price_value IS NOT NULL AND price_currency IS NOT NULL AND price_currency <> 'GBP'`);
  for (const it of rows) {
    const conv = await toGBP(Number(it.price_value), it.price_currency);
    if (conv.currency !== "GBP") continue;
    await pool.query(`UPDATE items SET price_value=$2, price_currency='GBP', orig_value=$3, orig_currency=$4 WHERE id=$1`,
      [it.id, conv.value, conv.orig.value, conv.orig.currency]);
    await pool.query(
      `UPDATE price_history SET price=ROUND(price * $3::numeric, 2), currency='GBP' WHERE item_id=$1 AND currency=$2`,
      [it.id, it.price_currency, conv.rate]);
  }
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
      convertExistingToGBP().catch((e) => console.error("Converting saved prices failed:", e.message));
    } catch (e) {
      console.error("DB init failed (attempt " + attempt + "): " + e.message);
      await new Promise(r => setTimeout(r, Math.min(30000, 2000 * attempt)));
    }
  }
}

/* ---------- Scrape ---------- */
// `hint` holds details read by the person's own browser (see public/extract.js): they win over what
// the server reads, and when they are complete the shop is not contacted at all.
async function scrapeProduct(url, hint = {}) {
  const host = normalizeHost(url);
  let title=null, image=null, priceValue=null, priceCurrency=null, description=null, source="heuristics";
  let wasBlocked = false;
  const complete = !!(hint.title && hint.price != null);

  // A shop that refuses us answers with an error page; never keep that page's "title" or "picture".
  const adopt = (found, status) => {
    if (looksBlocked(status, found.title)) { wasBlocked = true; return false; }
    ({ title, image, priceValue, priceCurrency, description } = found);
    return true;
  };

  if (!complete) {
    // First try fast fetch
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
      if (res.ok) {
        const html = await res.text();
        if (adopt(scrapeWithHeuristics(html, url), res.status)) {
          // A Shopify shop that answered in another currency (it sees a server in Frankfurt):
          // ask for the UK storefront and use that answer if it is in pounds.
          if (priceValue != null && priceCurrency && priceCurrency !== "GBP" && looksLikeShopify(html)) {
            try {
              const gb = await fetch(withCountryGB(url), { headers: BROWSER_HEADERS, redirect: "follow" });
              if (gb.ok) {
                const again = scrapeWithHeuristics(await gb.text(), url);
                if (again.priceValue != null && again.priceCurrency === "GBP" && !looksBlocked(gb.status, again.title)) {
                  ({ title, image, priceValue, priceCurrency, description } = again);
                }
              }
            } catch {}
          }
        }
      } else {
        wasBlocked = looksBlocked(res.status, "");
      }
    } catch {}

    // Fallback to a real browser if no price (only where one is installed)
    if (priceValue == null) {
      try {
        const html = await renderHtmlWithPlaywright(url);
        const found = scrapeWithHeuristics(html, url);
        if (looksBlocked(200, found.title)) wasBlocked = true;
        else { ({ title, image, priceValue, priceCurrency, description } = found); source = "playwright"; wasBlocked = false; }
      } catch {}
    }
  }

  // Details from the person's own browser win.
  let usedHint = false;
  if (hint.title) { title = hint.title; usedHint = true; }
  if (hint.image) { image = hint.image; usedHint = true; }
  if (hint.description) { description = hint.description; usedHint = true; }
  if (hint.price != null) { priceValue = hint.price; priceCurrency = hint.currency || priceCurrency || "GBP"; usedHint = true; }
  if (usedHint) source = "browser";

  // Everything is shown in pounds: convert anything else and keep the original amount.
  const conv = await toGBP(priceValue, priceCurrency);
  const unread = title == null && priceValue == null && image == null;

  return {
    url,
    store: host,
    title: title || null,
    image,
    description: description || null,
    priceValue: conv.value ?? null,
    priceCurrency: conv.currency,
    origValue: conv.orig ? conv.orig.value : null,
    origCurrency: conv.orig ? conv.orig.currency : null,
    lastChecked: new Date().toISOString(),
    source,
    unread,
    blocked: unread && wasBlocked
  };
}

/* ---------------- Spaces ---------------- */
const spaceCache = new Map(); // slug -> row | null
async function getSpace(slug) {
  if (spaceCache.has(slug)) return spaceCache.get(slug);
  const { rows } = await pool.query(`SELECT slug, name, pin_hash, ntfy_topic FROM spaces WHERE slug=$1`, [slug]);
  const row = rows[0] || null;
  if (row || spaceCache.size < 500) spaceCache.set(slug, row);
  return row;
}
const clearSpaceCache = () => spaceCache.clear();

// Which space does this request mean? "" = the owner's site, null = not a valid address.
function spaceOf(req) {
  const raw = req.headers["x-space"] ?? req.query?.space ?? "";
  const slug = String(raw).trim().toLowerCase();
  if (slug === "") return "";
  return SLUG_RE.test(slug) ? slug : null;
}
const cookieName = (slug) => "ffi_" + slug;
const cookieOk = (req, slug) => !!sessionSecret && verifyToken(sessionSecret, parseCookies(req.headers.cookie)[cookieName(slug)]) === slug;
const SESSION_MS = 30 * 24 * 3600 * 1000;

const OPEN_API = /^\/api\/(share\/[a-f0-9]{32}(\/claim)?|refresh-all|space-info|space-login|space-logout|manifest\/[a-z0-9-]+)$/;

/* ---------------- API ---------------- */
app.get("/healthz", (_req, res) => res.json({ ok: true, db: dbReady }));

app.use("/api", async (req, res, next) => {
  if (!dbReady) return res.status(503).json({ error: "Database not connected yet. Check DATABASE_URL." });
  if (OPEN_API.test("/api" + req.path)) return next();
  try {
    const slug = spaceOf(req);
    if (slug === null) return res.status(404).json({ error: "There's no page at this address" });
    req.space = slug;
    if (slug === "") {
      if (!rootOk(req)) return challenge(res);
      return next();
    }
    const row = await getSpace(slug);
    if (!row) return res.status(404).json({ error: "There's no page at this address" });
    req.spaceRow = row;
    if (adminOk(req) || cookieOk(req, slug)) return next();
    res.status(401).json({ error: "PIN needed", code: "pin_required", name: row.name });
  } catch (e) { next(e); }
});

// Download every saved item as JSON (backup)
// Diagnostics: lists every price found on a product page and which one wins.
// Usage: /api/debug-price?url=https://shop.example/product
app.get("/api/debug-price", async (req, res) => {
  if (req.space !== "") return res.status(403).json({ error: "Only the owner can use this" });
  const url = String(req.query.url || "");
  if (!/^https?:\/\//.test(url)) return res.status(400).json({ error: "Pass ?url=https://..." });
  const out = { url };
  try {
    const r = await fetch(url, { headers: BROWSER_HEADERS, redirect: "follow" });
    out.fetchStatus = r.status;
    if (r.ok) {
      const html = await r.text();
      out.fast = scrapeWithHeuristics(html, url, { debug: true });
      out.shopify = looksLikeShopify(html);
      if (out.shopify) {
        try {
          const gb = await fetch(withCountryGB(url), { headers: BROWSER_HEADERS, redirect: "follow" });
          out.ukStorefront = { status: gb.status };
          if (gb.ok) {
            const again = scrapeWithHeuristics(await gb.text(), url, { debug: true });
            out.ukStorefront.priceValue = again.priceValue;
            out.ukStorefront.priceCurrency = again.priceCurrency;
          }
        } catch (e) { out.ukStorefront = { error: e.message }; }
      }
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
// Everything one person has, as plain data. Share links and PINs are not included.
async function exportSpace(space) {
  const [lists, items, history] = await Promise.all([
    pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE space=$1 ORDER BY created_at, id`, [space]),
    pool.query(`SELECT * FROM items WHERE space=$1 ORDER BY created_at DESC, id DESC`, [space]),
    pool.query(`SELECT item_id, price, currency, at FROM price_history WHERE item_id IN (SELECT id FROM items WHERE space=$1) ORDER BY at, id`, [space])
  ]);
  return { version: 2, exportedAt: new Date().toISOString(), lists: lists.rows.map(({ share_token, ...l }) => l), items: items.rows, price_history: history.rows };
}
const sendJsonFile = (res, name, data) => {
  res.setHeader("content-type", "application/json");
  res.setHeader("content-disposition", 'attachment; filename="' + name + "-" + new Date().toISOString().slice(0, 10) + '.json"');
  res.send(JSON.stringify(data, null, 2));
};

app.get("/api/export", async (req, res) => sendJsonFile(res, "ffis-presents", await exportSpace(req.space)));

// The owner's full backup: their own site and every family page. Each part can be imported on its own.
app.get("/api/export-all", needAdmin, async (_req, res) => {
  const { rows } = await pool.query(`SELECT slug, name FROM spaces ORDER BY created_at, slug`);
  const spaces = [];
  for (const s of rows) spaces.push({ slug: s.slug, name: s.name, export: await exportSpace(s.slug) });
  sendJsonFile(res, "ffis-presents-everyone", { version: 3, exportedAt: new Date().toISOString(), spaces });
});

// Restore from an export (existing ids are left untouched). Old exports were a bare array of items.
app.post("/api/import", express.json({ limit: "50mb" }), async (req, res) => {
  // A full backup (from /api/export-all) holds several pages: take the one for this address.
  const body = Array.isArray(req.body?.spaces) ? req.body.spaces.find((s) => s.slug === req.space)?.export : req.body;
  if (!body) return res.status(400).json({ error: "That backup has nothing for this page" });
  const items = Array.isArray(body) ? body : body?.items;
  if (!Array.isArray(items)) return res.status(400).json({ error: "Expected an export file from this app" });
  const lists = Array.isArray(body?.lists) ? body.lists : [];
  const history = Array.isArray(body?.price_history) ? body.price_history : [];

  for (const l of lists) {
    if (!l?.id || !l?.name) continue;
    await pool.query(
      `INSERT INTO lists (id,name,budget,budget_currency,created_at,space) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING`,
      [l.id, cleanText(l.name, 60), parseBudget(l.budget) ?? null, cleanCurrency(l.budget_currency), l.created_at ?? new Date().toISOString(), req.space]);
  }

  let added = 0;
  for (const it of items) {
    // Presents added by hand have no link, so a name is enough.
    if (!it || (!it.url && !it.title)) continue;
    const id = it.id || newId();
    const r = await pool.query(
      `INSERT INTO items (id,url,store,title,image,description,price_value,price_currency,last_checked,source,bought,notes,list_id,favourite,claimed_by,created_at,orig_value,orig_currency,price_locked,details_locked,space)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,
               (SELECT id FROM lists WHERE id=$13 AND space=$21),$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (id) DO NOTHING`,
      [id, it.url ?? "", it.store ?? null, it.title ?? null, it.image ?? null, it.description ?? null,
       it.price_value ?? null, it.price_currency ?? "GBP", it.last_checked ?? new Date().toISOString(),
       it.source ?? "import", !!it.bought, it.notes ?? null,
       it.list_id ?? null, !!it.favourite, it.claimed_by ?? null, it.created_at ?? new Date().toISOString(),
       it.orig_value ?? null, it.orig_currency ?? null, !!it.price_locked, !!it.details_locked, req.space]
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
  convertExistingToGBP().catch((e) => console.error("Converting imported prices failed:", e.message));
  res.json({ ok: true, added });
});

/* ---------------- Lists ---------------- */
app.get("/api/lists", async (req, res) => {
  const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE space=$1 ORDER BY created_at, id`, [req.space]);
  res.json(rows);
});

app.post("/api/lists", async (req, res) => {
  const name = cleanText(req.body?.name, 60);
  if (!name) return res.status(400).json({ error: "Give the list a name" });
  const budget = parseBudget(req.body?.budget);
  if (budget === undefined) return res.status(400).json({ error: "Budget must be a number" });
  const id = newId();
  await pool.query(`INSERT INTO lists (id,name,budget,budget_currency,space) VALUES ($1,$2,$3,$4,$5)`,
    [id, name, budget, cleanCurrency(req.body?.currency), req.space]);
  const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE id=$1`, [id]);
  res.json(rows[0]);
});

// Rename a list or change its budget (send only the fields to change).
app.post("/api/lists/:id", async (req, res) => {
  const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE id=$1 AND space=$2`, [req.params.id, req.space]);
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
  await pool.query(`UPDATE items SET list_id=NULL WHERE list_id=$1 AND space=$2`, [req.params.id, req.space]);
  await pool.query(`DELETE FROM lists WHERE id=$1 AND space=$2`, [req.params.id, req.space]);
  res.json({ ok: true });
});

// Turn the private share link for a list on or off. Turning it on again makes a new link.
app.post("/api/lists/:id/share", async (req, res) => {
  const token = req.body?.enabled ? crypto.randomBytes(16).toString("hex") : null;
  const r = await pool.query(`UPDATE lists SET share_token=$2 WHERE id=$1 AND space=$3`, [req.params.id, token, req.space]);
  if (!r.rowCount) return res.status(404).json({ error: "List not found" });
  const { rows } = await pool.query(`SELECT ${LIST_COLUMNS} FROM lists WHERE id=$1`, [req.params.id]);
  res.json(rows[0]);
});

/* ---------------- Items ---------------- */
app.get("/api/items", async (req, res) => {
  const { rows } = await pool.query(`
    SELECT i.*,
      COALESCE((
        SELECT json_agg(json_build_object('p', h.price, 'c', h.currency, 'at', h.at) ORDER BY h.at, h.id)
        FROM (SELECT * FROM price_history WHERE item_id = i.id ORDER BY at DESC, id DESC LIMIT 40) h
      ), '[]'::json) AS history
    FROM items i
    WHERE i.space = $1
    ORDER BY i.created_at DESC, i.id DESC`, [req.space]);
  res.json(rows);
});

// Is this link already on the list? Compared after tidying (www., tracking junk, trailing slash).
async function findDuplicate(url, space) {
  const key = urlKey(url);
  if (!key) return null;
  const { rows } = await pool.query(`SELECT id, title, url, list_id FROM items WHERE url <> '' AND space=$1`, [space]);
  return rows.find((r) => urlKey(r.url) === key) || null;
}
const duplicateReply = (res, dup) =>
  res.status(409).json({ error: "That present is already on your list", duplicate: { id: dup.id, title: dup.title, list_id: dup.list_id } });

const httpUrlOrNull = (v) => {
  try { const u = new URL(String(v)); return /^https?:$/.test(u.protocol) ? u.href : null; } catch { return null; }
};
// undefined = invalid, null = empty, number = price
const parsePrice = (v) => {
  if (v === null || v === undefined || String(v).trim() === "") return null;
  const n = typeof v === "number" ? v : parsePriceString(String(v)).value;
  return Number.isFinite(n) && n >= 0 ? n : undefined;
};

app.post("/api/add", async (req, res) => {
  const pasted = String(req.body?.url ?? "").trim();
  if (!pasted) return res.status(400).json({ error: "Missing url" });
  const found = extractUrl(pasted);
  if (!found) return res.status(400).json({ error: "That doesn't look like a link" });
  const url = cleanUrl(found);
  try {
    if (!req.body?.force) {
      const dup = await findDuplicate(url, req.space);
      if (dup) return duplicateReply(res, dup);
    }
    const data = await scrapeProduct(url, cleanHint(req.body?.hint));
    const id = newId();
    await pool.query(
      `INSERT INTO items (id,url,store,title,image,description,price_value,price_currency,last_checked,source,bought,notes,list_id,orig_value,orig_currency,space)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,false,null,(SELECT id FROM lists WHERE id=$11 AND space=$14),$12,$13,$14)`,
      [id, data.url, data.store, data.title || titleFromUrl(url), data.image, data.description, data.priceValue, data.priceCurrency, data.lastChecked, data.blocked ? "blocked" : data.source, req.body?.list_id ?? null, data.origValue, data.origCurrency, req.space]
    );
    await recordPrice(id, data.priceValue, data.priceCurrency);
    const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
    // `lookup` tells the page whether the shop could be read; it is not stored.
    res.json({ ...rows[0], lookup: { unread: data.unread, blocked: data.blocked } });
  } catch (e) {
    res.status(500).json({ error: e.message || "Scrape failed" });
  }
});

// A present added by hand: no link needed. Its details and price are protected from automatic changes.
app.post("/api/items/manual", async (req, res) => {
  const b = req.body || {};
  const title = cleanText(b.title, 200);
  if (!title) return res.status(400).json({ error: "Give the present a name" });
  let url = "";
  if (String(b.url ?? "").trim()) {
    const found = extractUrl(b.url);
    if (!found) return res.status(400).json({ error: "That link doesn't look right" });
    url = cleanUrl(found);
    if (!b.force) { const dup = await findDuplicate(url, req.space); if (dup) return duplicateReply(res, dup); }
  }
  const price = parsePrice(b.price);
  if (price === undefined) return res.status(400).json({ error: "Price must be a number" });
  let image = null;
  if (String(b.image ?? "").trim()) {
    image = httpUrlOrNull(String(b.image).trim());
    if (!image) return res.status(400).json({ error: "The image link doesn't look right" });
  }
  const conv = await toGBP(price, b.currency);
  const id = newId();
  await pool.query(
    `INSERT INTO items (id,url,store,title,image,description,price_value,price_currency,last_checked,source,bought,notes,list_id,orig_value,orig_currency,price_locked,details_locked,space)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),'manual',false,null,(SELECT id FROM lists WHERE id=$9 AND space=$13),$10,$11,$12,true,$13)`,
    [id, url, url ? normalizeHost(url) : null, title, image, cleanText(b.description, 500) || null,
     conv.value, conv.currency, b.list_id ?? null, conv.orig ? conv.orig.value : null, conv.orig ? conv.orig.currency : null, price != null, req.space]);
  await recordPrice(id, conv.value, conv.currency);
  const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
  res.json(rows[0]);
});

// Edit a present by hand. Send only the fields to change. Changing the price protects it from
// automatic updates unless price_locked is sent as false; details_locked works the same for the rest.
app.post("/api/items/:id/edit", async (req, res) => {
  const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1 AND space=$2`, [req.params.id, req.space]);
  if (!rows.length) return res.status(404).json({ error: "Not found" });
  const cur = rows[0], b = req.body || {};

  const title = "title" in b ? cleanText(b.title, 200) : cur.title;
  if (!title) return res.status(400).json({ error: "Give the present a name" });
  const description = "description" in b ? (cleanText(b.description, 500) || null) : cur.description;

  let image = cur.image;
  if ("image" in b) {
    if (String(b.image ?? "").trim()) {
      image = httpUrlOrNull(String(b.image).trim());
      if (!image) return res.status(400).json({ error: "The image link doesn't look right" });
    } else image = null;
  }

  let url = cur.url;
  if ("url" in b) {
    if (String(b.url ?? "").trim()) {
      const found = extractUrl(b.url);
      if (!found) return res.status(400).json({ error: "That link doesn't look right" });
      url = cleanUrl(found);
    } else url = "";
  }

  let value = cur.price_value, currency = cur.price_currency, origValue = cur.orig_value, origCurrency = cur.orig_currency;
  const priceGiven = "price" in b;
  if (priceGiven) {
    const price = parsePrice(b.price);
    if (price === undefined) return res.status(400).json({ error: "Price must be a number" });
    const conv = await toGBP(price, b.currency);
    value = conv.value; currency = conv.currency;
    origValue = conv.orig ? conv.orig.value : null; origCurrency = conv.orig ? conv.orig.currency : null;
  }
  const priceLocked = "price_locked" in b ? !!b.price_locked : (priceGiven ? true : !!cur.price_locked);
  const detailsLocked = "details_locked" in b ? !!b.details_locked : !!cur.details_locked;

  await pool.query(
    `UPDATE items SET title=$2, description=$3, image=$4, url=$5, store=$6, price_value=$7, price_currency=$8,
       orig_value=$9, orig_currency=$10, price_locked=$11, details_locked=$12 WHERE id=$1`,
    [cur.id, title, description, image, url, url ? normalizeHost(url) : null, value, currency, origValue, origCurrency, priceLocked, detailsLocked]);
  if (priceGiven) await recordPrice(cur.id, value, currency);
  const out = await pool.query(`SELECT * FROM items WHERE id=$1`, [cur.id]);
  res.json(out.rows[0]);
});

// `space` limits the lookup to one person's items (the daily job passes none).
async function refreshItem(id, space = null) {
  const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1 AND ($2::text IS NULL OR space=$2)`, [id, space]);
  if (!rows.length) return null;
  const cur = rows[0];
  if (!cur.url) throw Object.assign(new Error("This present has no link to check"), { status: 400 });
  const data = await scrapeProduct(cur.url);
  const priceLocked = !!cur.price_locked, detailsLocked = !!cur.details_locked;
  await pool.query(
    `UPDATE items SET store=$2,
       title=CASE WHEN $13::boolean OR $3 = '(No title found)' THEN title ELSE COALESCE($3, title) END,
       image=CASE WHEN $13::boolean THEN image ELSE COALESCE($4, image) END,
       description=CASE WHEN $13::boolean THEN description ELSE COALESCE($5, description) END,
       price_value=CASE WHEN $12::boolean THEN price_value ELSE COALESCE($6, price_value) END,
       price_currency=CASE WHEN $12::boolean OR $6::numeric IS NULL THEN price_currency ELSE $7 END,
       orig_value=CASE WHEN $12::boolean OR $6::numeric IS NULL THEN orig_value ELSE $10::numeric END,
       orig_currency=CASE WHEN $12::boolean OR $6::numeric IS NULL THEN orig_currency ELSE $11 END,
       last_checked=CASE WHEN $14::boolean THEN last_checked ELSE $8 END,
       source=CASE WHEN $14::boolean THEN source ELSE $9 END
     WHERE id=$1`,
    [id, data.store, data.title, data.image, data.description, data.priceValue, data.priceCurrency, data.lastChecked, data.source, data.origValue, data.origCurrency, priceLocked, detailsLocked, data.unread]
  );
  if (!priceLocked) await recordPrice(id, data.priceValue, data.priceCurrency);
  const { rows: fresh } = await pool.query(`SELECT * FROM items WHERE id=$1`, [id]);
  const item = fresh[0];
  item.lookup = { unread: data.unread, blocked: data.blocked };
  if (!priceLocked && cur.price_currency === "GBP" && item.price_currency === "GBP" && priceDropped(cur.price_value, item.price_value)) {
    const topic = topicOf(await getSpace(cur.space), cur.space);
    if (topic) {
      const r = await sendAlert({ ...dropMessage(item, cur.price_value, item.price_value), topic });
      if (!r.sent) console.error("Price alert not sent:", r.reason);
    }
  }
  return item;
}

app.post("/api/refresh/:id", async (req, res) => {
  try {
    const item = await refreshItem(req.params.id, req.space);
    if (!item) return res.status(404).json({ error: "Not found" });
    res.json(item);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message || "Refresh failed" });
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
  const { rows } = await pool.query(`SELECT id FROM items WHERE url <> '' ORDER BY last_checked NULLS FIRST`);
  refreshAllRunning = true;
  res.status(202).json({ started: true, items: rows.length });
  (async () => {
    for (const { id } of rows) {
      try { await refreshItem(id); } catch (e) { console.error("Refresh failed for " + id + ": " + e.message); }
    }
    refreshAllRunning = false;
  })();
});

/* ---------------- Price-drop alerts ---------------- */
// Each person sets their own ntfy topic in the app. The owner's site can also use NTFY_TOPIC on the server.
const topicOf = (row, slug) => (row && row.ntfy_topic) || (slug === "" ? process.env.NTFY_TOPIC : null) || null;
const TOPIC_RE = /^[A-Za-z0-9_-]{8,64}$/;

app.get("/api/alerts/status", async (req, res) => res.json({ enabled: !!topicOf(await getSpace(req.space), req.space) }));

app.post("/api/alerts/topic", async (req, res) => {
  const topic = String(req.body?.topic ?? "").trim();
  if (topic && !TOPIC_RE.test(topic)) return res.status(400).json({ error: "Use 8 to 64 letters, numbers, dashes or underscores" });
  await pool.query(`UPDATE spaces SET ntfy_topic=$2 WHERE slug=$1`, [req.space, topic || null]);
  clearSpaceCache();
  res.json({ enabled: !!topicOf(await getSpace(req.space), req.space) });
});

app.post("/api/alerts/test", async (req, res) => {
  const topic = topicOf(await getSpace(req.space), req.space);
  if (!topic) return res.status(400).json({ error: "Alerts aren't switched on yet. Save a topic name first." });
  const sp = await getSpace(req.space);
  const r = await sendAlert({ topic, title: possessive(sp?.name || "Ffi") + " Presents test", message: "If you can read this, price-drop alerts are working.", tags: ["white_check_mark"] });
  if (!r.sent) return res.status(502).json({ error: "Couldn't send the alert: " + r.reason });
  res.json({ ok: true });
});

// Each statement takes the present's id as $1, the new value as $2 and the space as $3.
const itemUpdater = (sql, pick) => async (req, res) => {
  const value = pick(req.body || {});
  const r = await pool.query(sql, [req.params.id, value, req.space]);
  if (!r.rowCount) return res.status(404).json({ error: "Not found" });
  const { rows } = await pool.query(`SELECT * FROM items WHERE id=$1 AND space=$2`, [req.params.id, req.space]);
  res.json(rows[0]);
};
app.post("/api/items/:id/bought", itemUpdater(`UPDATE items SET bought=$2 WHERE id=$1 AND space=$3`, (b) => !!b.bought));
app.post("/api/items/:id/favourite", itemUpdater(`UPDATE items SET favourite=$2 WHERE id=$1 AND space=$3`, (b) => !!b.favourite));
app.post("/api/items/:id/notes", itemUpdater(`UPDATE items SET notes=$2 WHERE id=$1 AND space=$3`, (b) => b.notes ?? null));
// The owner can set or clear who is getting a present.
app.post("/api/items/:id/claim", itemUpdater(`UPDATE items SET claimed_by=$2 WHERE id=$1 AND space=$3`, (b) => cleanText(b.claimed_by, 40) || null));
app.post("/api/items/:id/list", itemUpdater(
  `UPDATE items SET list_id=(SELECT id FROM lists WHERE id=$2 AND space=$3) WHERE id=$1 AND space=$3`, (b) => b.list_id ?? null));

app.delete("/api/items/:id", async (req, res) => {
  await pool.query(`DELETE FROM price_history WHERE item_id IN (SELECT id FROM items WHERE id=$1 AND space=$2)`, [req.params.id, req.space]);
  await pool.query(`DELETE FROM items WHERE id=$1 AND space=$2`, [req.params.id, req.space]);
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
    `SELECT id, title, image, url, description, price_value, price_currency, orig_value, orig_currency, bought, claimed_by, favourite
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

/* ---------------- Spaces: PIN login, the owner's page for managing them ---------------- */
const loginLimiter = makeRateLimiter({ max: 8, windowMs: 10 * 60_000 });
const TOO_SOON = (ms) => "Too many tries. Please wait " + Math.max(1, Math.ceil(ms / 60000)) + " minutes and try again.";

// Open: just the name, so the page can say whose it is before asking for a PIN.
app.get("/api/space-info", async (req, res) => {
  const slug = spaceOf(req);
  const row = slug === null ? null : await getSpace(slug);
  if (!row) return res.status(404).json({ error: "There's no page at this address" });
  res.json({ name: row.name, root: slug === "", locked: slug !== "" });
});

app.post("/api/space-login", async (req, res) => {
  const slug = String(req.body?.space ?? "").trim().toLowerCase();
  const row = SLUG_RE.test(slug) ? await getSpace(slug) : null;
  if (!row) return res.status(404).json({ error: "There's no page at this address" });
  const key = req.ip + "|" + slug;
  const limit = loginLimiter.hit(key);
  if (!limit.ok) return res.status(429).json({ error: TOO_SOON(limit.retryAfterMs) });
  if (!row.pin_hash || !verifyPin(String(req.body?.pin ?? "").trim(), row.pin_hash)) {
    return res.status(401).json({ error: "That PIN isn't right" });
  }
  loginLimiter.reset(key);
  res.cookie(cookieName(slug), signToken(sessionSecret, slug, SESSION_MS), { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: SESSION_MS, path: "/" });
  res.json({ ok: true, name: row.name });
});

app.post("/api/space-logout", (req, res) => {
  const slug = String(req.body?.space ?? "").trim().toLowerCase();
  if (SLUG_RE.test(slug)) res.clearCookie(cookieName(slug), { path: "/" });
  res.json({ ok: true });
});

// Change your own PIN (you must already be signed in to the space).
app.post("/api/space-pin", async (req, res) => {
  if (req.space === "") return res.status(400).json({ error: "The owner's site uses the server password instead" });
  const pin = String(req.body?.pin ?? "").trim();
  if (pin.length < 4 || pin.length > 20) return res.status(400).json({ error: "Use a PIN of 4 to 20 characters" });
  await pool.query(`UPDATE spaces SET pin_hash=$2 WHERE slug=$1`, [req.space, hashPin(pin)]);
  clearSpaceCache();
  res.json({ ok: true });
});

// Each person's installable app opens their own page.
app.get("/api/manifest/:slug", async (req, res) => {
  const row = SLUG_RE.test(req.params.slug) ? await getSpace(req.params.slug) : null;
  if (!row || !row.slug) return res.status(404).json({ error: "Not found" });
  res.type("application/manifest+json").json({
    id: "/" + row.slug, name: possessive(row.name) + " Presents", short_name: row.name,
    description: "A gift list with prices, budgets and shareable lists",
    start_url: "/" + row.slug, scope: "/", display: "standalone", background_color: "#0e0f12", theme_color: "#0e0f12",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" }
    ],
    share_target: { action: "/" + row.slug, method: "GET", params: { title: "title", text: "text", url: "url" } }
  });
});

// The family menu: everyone's name and address, for anyone signed in to a page (or the owner).
// Opening another page still asks for that person's PIN. The owner's own site lists them only for the owner.
app.get("/api/family", async (req, res) => {
  if (req.space === "" && !adminOk(req)) return res.json([]);
  const { rows } = await pool.query(`SELECT slug, name FROM spaces WHERE slug <> '' ORDER BY created_at, slug`);
  res.json(rows);
});

app.get("/api/spaces", needAdmin, async (_req, res) => {
  const { rows } = await pool.query(`
    SELECT s.slug, s.name, s.created_at, (s.pin_hash IS NOT NULL) AS has_pin,
           (SELECT count(*)::int FROM items i WHERE i.space = s.slug) AS presents
    FROM spaces s WHERE s.slug <> '' ORDER BY s.created_at, s.slug`);
  res.json(rows);
});

// Create pages for several people at once. Each PIN is shown here once and never stored in readable form.
app.post("/api/spaces", needAdmin, async (req, res) => {
  const names = parseNames(req.body?.names).slice(0, 30);
  if (!names.length) return res.status(400).json({ error: "Type at least one name" });
  const existing = (await pool.query(`SELECT slug, name FROM spaces`)).rows;
  const taken = new Set(existing.map((r) => r.slug));
  const takenNames = new Set(existing.map((r) => r.name.toLowerCase()));
  const created = [], skipped = [];
  for (const name of names) {
    if (takenNames.has(name.toLowerCase())) { skipped.push({ name, reason: "already has a page" }); continue; }
    const slug = uniqueSlug(name, taken);
    taken.add(slug); takenNames.add(name.toLowerCase());
    const pin = generatePin();
    await pool.query(`INSERT INTO spaces (slug, name, pin_hash) VALUES ($1,$2,$3)`, [slug, name, hashPin(pin)]);
    created.push({ name, slug, pin, path: "/" + slug });
  }
  clearSpaceCache();
  res.json({ created, skipped });
});

app.post("/api/spaces/:slug/reset-pin", needAdmin, async (req, res) => {
  const row = await getSpace(req.params.slug);
  if (!row || !row.slug) return res.status(404).json({ error: "Not found" });
  const pin = generatePin();
  await pool.query(`UPDATE spaces SET pin_hash=$2 WHERE slug=$1`, [row.slug, hashPin(pin)]);
  clearSpaceCache();
  loginLimiter.reset(req.ip + "|" + row.slug);
  res.json({ name: row.name, slug: row.slug, pin, path: "/" + row.slug });
});

// Deletes the page and everything in it. Needs ?confirm=<the page's address> so it can't happen by accident.
app.delete("/api/spaces/:slug", needAdmin, async (req, res) => {
  const row = await getSpace(req.params.slug);
  if (!row || !row.slug) return res.status(404).json({ error: "Not found" });
  if (req.query.confirm !== row.slug) return res.status(400).json({ error: "Confirmation missing" });
  await pool.query(`DELETE FROM price_history WHERE item_id IN (SELECT id FROM items WHERE space=$1)`, [row.slug]);
  await pool.query(`DELETE FROM items WHERE space=$1`, [row.slug]);
  await pool.query(`DELETE FROM lists WHERE space=$1`, [row.slug]);
  await pool.query(`DELETE FROM spaces WHERE slug=$1`, [row.slug]);
  clearSpaceCache();
  res.json({ ok: true });
});

/* --------------- UI --------------- */
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
// A person's own page: the same app; it asks for their PIN.
app.get("/:slug", (req, res, next) => {
  if (!SLUG_RE.test(req.params.slug) || RESERVED.has(req.params.slug)) return next();
  res.sendFile(path.join(publicDir, "index.html"));
});

const PORT = process.env.PORT || 3000;
(async () => {
  app.listen(PORT, () => console.log("Price catalogue on http://localhost:"+PORT));
  await initDbWithRetry();
})();
