app.get("/", (_req, res) => {
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>My Price Catalogue</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  :root { --bg:#0b0c10; --card:#111316; --muted:#9aa3af; --text:#e5e7eb; --accent:#8b5cf6; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:Inter,sans-serif; }
  header { padding:20px; display:flex; gap:12px; flex-wrap:wrap; }
  input { flex:1; padding:12px; border-radius:8px; border:1px solid #333; }
  button { padding:12px 16px; border-radius:8px; border:0; background:var(--accent); color:white; font-weight:600; }
  main { padding:20px; max-width:1000px; margin:0 auto; }
  .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(250px,1fr)); gap:16px; }
  .card { background:var(--card); border:1px solid #222; border-radius:12px; padding:12px; }
  .title { font-weight:600; }
  .price { font-size:18px; font-weight:600; margin:8px 0; }
  .empty { color:var(--muted); padding:20px; border:1px dashed #444; border-radius:8px; text-align:center; }
</style>
</head>
<body>
  <header>
    <input type="url" id="url" placeholder="Paste a product link..." />
    <button id="add">Add</button>
    <button id="refreshAll">Refresh All</button>
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

async function load() {
  const res = await fetch("/api/items");
  const data = await res.json();
  elList.innerHTML = "";
  if (!data.length) elEmpty.style.display = "block"; else elEmpty.style.display = "none";
  for (const it of data) {
    const card = document.createElement("div");
    card.className = "card";
    card.innerHTML = \`
      <div class="title">\${it.title}</div>
      <div class="price">\${fmtPrice(it.priceValue, it.priceCurrency)}</div>
      <a href="\${it.url}" target="_blank">Open product</a>
    \`;
    elList.appendChild(card);
  }
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
  for (const it of data) {
    await fetch("/api/refresh/" + it.id, { method:"POST" });
  }
  load();
};

load();
</script>
</body>
</html>`);
});
