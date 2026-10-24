import express from "express";
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

/* ---------- Currency conversion (to GBP) ---------- */
// ECB rates via frankfurter.app (free, no API key). Cached for an hour.
const rateCache = new Map();
async function gbpRate(cur) {
  const hit = rateCache.get(cur);
  if (hit && Date.now() - hit.at < 3600_000) return hit.rate;
  const res = await fetch(`https://api.frankfurter.app/latest?from=${encodeURIComponent(cur)}&to=GBP`);
  const data = await res.json();
  const rate = data?.rates?.GBP;
  if (typeof rate !== "number") throw new Error("No GBP rate for " + cur);
  rateCache.set(cur, { rate, at: Date.now() });
  return rate;
}

async function convertToGBP(value, currency) {
  if (value == null) return { value: null, currency: "GBP" };
  const cur = String(currency || "").toUpperCase();
  if (!cur || cur === "GBP") return { value, currency: "GBP" };
  try {
    const rate = await gbpRate(cur);
    return { value: Math.round(value * rate * 100) / 100, currency: "GBP" };
  } catch (e) {
    console.error("Conversion failed:", e.message);
  }
  // Keep the original amount labelled with its own currency; the UI shows that currency.
  return { value, currency: cur };
}

/* ---------- Scrape + convert ---------- */
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

  // 💱 Convert to GBP before storing
  if (priceValue != null) {
    const conv = await convertToGBP(priceValue, priceCurrency || "GBP");
    priceValue = conv.value;
    priceCurrency = conv.currency; // "GBP"
  } else {
    priceCurrency = "GBP";
  }

  return {
    url,
    store: host,
    title: title || "(No title found)",
    image,
    description: description || null,
    priceValue: priceValue ?? null,
    priceCurrency: priceCurrency ?? "GBP",
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
app.get("/", (_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Ffis Presents</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800;900&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#0b0c10; --card:#0e1116; --muted:#9aa3af; --text:#e5e7eb;
    --accent:#7c3aed; --accent-2:#6d28d9; --danger:#ef4444; --ring:#2a2f38;
    --border:#181c22; --shadow: 0 8px 30px rgba(0,0,0,.35);
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--text); font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto; }

  header { position:sticky; top:0; z-index:10; backdrop-filter: blur(8px);
    background: linear-gradient(180deg, rgba(11,12,16,.85), rgba(11,12,16,.65) 70%, transparent);
    border-bottom:1px solid rgba(255,255,255,.04);
  }
  .header-inner { padding:22px 20px; max-width:1200px; margin:0 auto; display:flex; flex-direction:column; gap:16px; align-items:center; }
  h1 { margin:0; font-size:56px; font-weight:900; letter-spacing:.3px; text-align:center; }

  .controls { width:100%; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  input { flex:1; padding:12px 14px; border-radius:12px; border:1px solid var(--ring); background:#0f1115; color:var(--text); }
  button { padding:12px 16px; border-radius:12px; border:0; background:var(--accent); color:white; font-weight:700; cursor:pointer; box-shadow: var(--shadow); }
  button:hover { background:var(--accent-2); }

  main { padding:24px; max-width:1200px; margin:0 auto; }
  .meta-bar { color:var(--muted); font-size:12px; margin:0 0 14px; text-align:center; }

  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:22px; }
  .card { background:var(--card); border:1px solid var(--border); border-radius:16px; overflow:hidden; box-shadow: var(--shadow); transition: transform .12s ease; }
  .card:hover { transform: translateY(-2px); }
  .thumb { aspect-ratio: 16/10; background:#0f1216; display:grid; place-items:center; }
  .thumb img { width:100%; height:100%; object-fit:contain; }

  .pad { padding:16px; }
  .row { display:flex; gap:10px; align-items:center; justify-content:space-between; }
  .title { font-weight:700; line-height:1.3; }
  .title.bought { text-decoration:line-through; color:#9aa3af }
  .desc { color:#a3e635; font-size:12px; margin-top:6px; line-height:1.35; }

  .badge { display:inline-flex; align-items:center; gap:6px; padding:6px 10px; border-radius:999px; background:#121722; border:1px solid #1b2230; font-size:12px; color:#cbd5e1; }
  .price { font-size:20px; font-weight:900; }

  .btn-danger { background:var(--danger); }
  .btn-danger:hover { filter:brightness(.95); }
  .check { display:flex; align-items:center; gap:8px; }
  .muted { color:var(--muted); font-size:12px; }
  .link { color:#93c5fd; text-decoration:underline; }

  .empty { color:var(--muted); padding:24px; border:1px dashed #444; border-radius:12px; text-align:center; }

  .notes { margin-top:12px; }
  .notes label { display:block; margin-bottom:6px; color:var(--muted); font-size:12px; }
  .notes textarea {
    width:100%; min-height:80px; padding:12px; border-radius:12px;
    border:1px solid var(--ring); background:#0f1115; color:#e5e7eb; resize:vertical;
  }
  .saved { color:#34d399; font-size:12px; margin-top:6px; display:none; }
</style>
</head>
<body>
  <header>
    <div class="header-inner">
      <h1>🎁 Ffis Presents</h1>
      <div class="controls">
        <input type="url" id="url" placeholder="Paste a product link…" />
        <button id="add">Add</button>
        <button id="refreshAll">Refresh All</button>
        <a href="/api/export" download><button type="button">Export</button></a>
        <button id="importBtn" type="button">Import</button>
        <input type="file" id="importFile" accept="application/json" style="display:none" />
      </div>
      <div class="meta-bar"><span id="count">0</span> items • Prices converted and shown in £</div>
    </div>
  </header>
  <main>
    <div id="list" class="grid"></div>
    <div id="empty" class="empty" style="display:none;">No items yet — paste a link above.</div>
  </main>
<script>
const elList = document.getElementById("list");
const elEmpty = document.getElementById("empty");
const elUrl = document.getElementById("url");
const btnAdd = document.getElementById("add");
const btnRefreshAll = document.getElementById("refreshAll");

// Always display as GBP (values already converted on the server)
function fmtPriceGBP(v, cur) {
  if (v == null) return "—";
  const code = cur || "GBP";
  try { return new Intl.NumberFormat("en-GB",{style:"currency",currency:code}).format(v) + (code === "GBP" ? "" : " (not converted)"); }
  catch { return "£" + Number(v).toFixed(2); }
}
function debounce(fn, ms){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
const saveNote = debounce(async (id, text)=>{
  await fetch("/api/items/"+id+"/notes", {
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ notes: text })
  });
  const s = document.getElementById("saved-"+id);
  if (s) { s.style.display="block"; setTimeout(()=>s.style.display="none", 1200); }
}, 600);

function storeBadge(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\\./,'');
    return '<span class="badge">🛍️ '+host+'</span>';
  } catch { return ''; }
}

async function load() {
  const res = await fetch("/api/items");
  const data = await res.json();
  elList.innerHTML = "";
  elEmpty.style.display = data.length ? "none" : "block";
  document.getElementById("count").textContent = data.length;

  for (const it of data) {
    const card = document.createElement("div");
    card.className = "card";
    const img = it.image ? '<img src="'+it.image+'" alt="">' : '<div style="color:#9aa3af">no image</div>';
    const desc = it.description ? '<div class="desc">'+it.description+'</div>' : '';
    const notes = it.notes || "";

    card.innerHTML = \`
      <div class="thumb">\${img}</div>
      <div class="pad">
        <div class="row">
          <div class="title \${it.bought ? "bought": ""}">\${it.title || "(No title)"} </div>
          \${storeBadge(it.url)}
        </div>
        \${desc}
        <div class="row" style="margin-top:12px;">
          <div class="price">\${fmtPriceGBP(it.price_value ?? it.priceValue, it.price_currency ?? it.priceCurrency)}</div>
          <a class="link" href="\${it.url}" target="_blank" rel="noopener">Open product</a>
        </div>
        <div class="row" style="margin-top:10px;">
          <label class="check">
            <input type="checkbox" \${it.bought ? "checked": ""} data-id="\${it.id}" class="toggleBought" />
            <span class="muted">Already bought</span>
          </label>
          <div>
            <button class="refresh" data-id="\${it.id}">Refresh</button>
            <button class="delete btn-danger" data-id="\${it.id}">Remove</button>
          </div>
        </div>

        <div class="notes">
          <label>Notes</label>
          <textarea class="noteBox" data-id="\${it.id}" placeholder="Size, colour, delivery notes…">\${notes.replace(/</g,"&lt;")}</textarea>
          <div class="saved" id="saved-\${it.id}">Saved</div>
        </div>
      </div>
    \`;
    elList.appendChild(card);
  }

  document.querySelectorAll(".toggleBought").forEach(cb => {
    cb.onchange = async (e) => {
      const id = e.target.getAttribute("data-id");
      await fetch("/api/items/"+id+"/bought", {
        method:"POST",
        headers: { "content-type":"application/json" },
        body: JSON.stringify({ bought: e.target.checked })
      });
      load();
    };
  });
  document.querySelectorAll(".delete").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      await fetch("/api/items/"+id, { method:"DELETE" });
      load();
    };
  });
  document.querySelectorAll(".refresh").forEach(btn => {
    btn.onclick = async () => {
      const id = btn.getAttribute("data-id");
      await fetch("/api/refresh/"+id, { method:"POST" });
      load();
    };
  });
  document.querySelectorAll(".noteBox").forEach(ta => {
    ta.oninput = (e) => {
      const id = ta.getAttribute("data-id");
      saveNote(id, e.target.value);
    };
  });
}

btnAdd.onclick = async () => {
  const url = elUrl.value.trim();
  if (!url) return;
  await fetch("/api/add", {
    method:"POST", headers:{ "content-type":"application/json" },
    body: JSON.stringify({ url })
  });
  elUrl.value = "";
  load();
};

btnRefreshAll.onclick = async () => {
  const res = await fetch("/api/items");
  const data = await res.json();
  for (const it of data) await fetch("/api/refresh/" + it.id, { method:"POST" });
  load();
};

document.getElementById("importBtn").onclick = () => document.getElementById("importFile").click();
document.getElementById("importFile").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const items = JSON.parse(await file.text());
    const res = await fetch("/api/import", {
      method:"POST", headers:{ "content-type":"application/json" },
      body: JSON.stringify(items)
    });
    const out = await res.json();
    alert(res.ok ? "Imported " + out.added + " new items" : (out.error || "Import failed"));
  } catch (err) { alert("That file isn't a valid export."); }
  e.target.value = "";
  load();
};

load();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
(async () => {
  app.listen(PORT, () => console.log("Price catalogue on http://localhost:"+PORT));
  await initDbWithRetry();
})();
