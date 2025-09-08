import express from "express";
import dotenv from "dotenv";
dotenv.config();

import fetch from "node-fetch";
import { scrapeWithHeuristics } from "./lib/heuristics.js";
import { renderHtmlWithPlaywright } from "./lib/renderers/playwright.js";

import pgPkg from "pg";
const { Pool } = pgPkg;
const pool = new Pool({
  connectionString: (process.env.DATABASE_URL || "").replace(/^postgresql:\/\//, "postgres://"),
  ssl: { rejectUnauthorized: false }
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const normalizeHost = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ""); }
  catch { return ""; }
};

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

async function scrapeProduct(url) {
  const host = normalizeHost(url);
  let title=null, image=null, priceValue=null, priceCurrency=null, description=null, source="heuristics";

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
    priceCurrency: priceCurrency ?? null,
    lastChecked: new Date().toISOString(),
    source
  };
}

/* ---------------- API ---------------- */
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
      `UPDATE items SET store=$2,title=$3,image=$4,description=$5,price_value=$6,price_currency=$7,last_checked=$8,source=$9
       WHERE id=$1`,
      [id, data.store, data.title, data.image, data.description, data.priceValue, data.priceCurrency, data.lastChecked, data.source]
    );
    res.json({ id, ...rows[0], ...data });
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
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#0b0c10; --card:#111316; --muted:#9aa3af; --text:#e5e7eb;
    --accent:#8b5cf6; --green:#10b981; --danger:#ef4444; --ring:#2a2f38;
  }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--text); font-family:Inter,sans-serif; }
  header { padding:24px 20px; max-width:1100px; margin:0 auto; display:flex; flex-direction:column; gap:14px; align-items:center; }
  h1 { margin:0; font-size:48px; font-weight:800; letter-spacing:.3px; text-align:center; }
  .controls { width:100%; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
  input { flex:1; padding:12px; border-radius:10px; border:1px solid var(--ring); background:#0f1115; color:var(--text); }
  button { padding:12px 16px; border-radius:10px; border:0; background:var(--accent); color:white; font-weight:600; cursor:pointer; }
  main { padding:20px; max-width:1100px; margin:0 auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:18px; }
  .card { background:var(--card); border:1px solid #1c1f25; border-radius:14px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,.25); }
  .thumb { aspect-ratio: 16/10; background:#0f1216; display:grid; place-items:center; }
  .thumb img { width:100%; height:100%; object-fit:contain; }
  .pad { padding:14px; }
  .title { font-weight:600; }
  .title.bought { text-decoration:line-through; color:#9aa3af }
  .desc { color:var(--green); font-size:13px; margin-top:6px; line-height:1.35; }
  .meta { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:10px; }
  .price { font-size:18px; font-weight:700; }
  .row { display:flex; gap:8px; align-items:center; justify-content:space-between; margin-top:10px; }
  .muted { color:var(--muted); font-size:12px; }
  .link { color:#93c5fd; text-decoration:underline; }
  .btn-danger { background:var(--danger); }
  .check { display:flex; align-items:center; gap:8px; }
  .empty { color:var(--muted); padding:20px; border:1px dashed #444; border-radius:8px; text-align:center; }

  .notes { margin-top:12px; }
  .notes label { display:block; margin-bottom:6px; color:var(--muted); font-size:12px; }
  .notes textarea {
    width:100%; min-height:80px; padding:10px; border-radius:10px;
    border:1px solid var(--ring); background:#0f1115; color:var(--text); resize:vertical;
  }
  .saved { color:var(--green); font-size:12px; margin-top:6px; display:none; }
</style>
</head>
<body>
  <header>
    <h1>🎁 Ffis Presents</h1>
    <div class="controls">
      <input type="url" id="url" placeholder="Paste a product link…" />
      <button id="add">Add</button>
      <button id="refreshAll">Refresh All</button>
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

function fmtPrice(v, c) {
  if (v == null) return "—";
  try { return new Intl.NumberFormat("en-GB",{style:"currency",currency:c||"GBP"}).format(v); }
  catch { return v; }
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

async function load() {
  const res = await fetch("/api/items");
  const data = await res.json();
  elList.innerHTML = "";
  elEmpty.style.display = data.length ? "none" : "block";

  for (const it of data) {
    const card = document.createElement("div");
    card.className = "card";
    const img = it.image ? '<img src="'+it.image+'" alt="">' : '<div style="color:#9aa3af">no image</div>';
    const desc = it.description ? '<div class="desc">'+it.description+'</div>' : '';
    const notes = it.notes || "";

    card.innerHTML = \`
      <div class="thumb">\${img}</div>
      <div class="pad">
        <div class="title \${it.bought ? "bought": ""}">\${it.title || "(No title)"} </div>
        \${desc}
        <div class="meta">
          <div class="price">\${fmtPrice(it.price_value ?? it.priceValue, it.price_currency ?? it.priceCurrency)}</div>
          <a class="link" href="\${it.url}" target="_blank">Open product</a>
        </div>
        <div class="row">
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

  // actions
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

load();
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
(async () => {
  await initDb();
  app.listen(PORT, () => console.log("Price catalogue on http://localhost:"+PORT));
})();
