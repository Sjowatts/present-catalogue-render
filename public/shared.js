const $ = (id) => document.getElementById(id);
const token = location.pathname.split("/").pop();
const COLORS = ["#ff5c97", "#2ee6a8", "#5ec8ff", "#ff8a3d", "#b69bff", "#ffd23f"];
let items = [];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const money = (v, cur) => {
  if (v == null) return "—";
  try { return new Intl.NumberFormat("en-GB", { style:"currency", currency: cur || "GBP" }).format(v); }
  catch { return Number(v).toFixed(2) + (cur ? " " + cur : ""); }
};
const say = (msg, isError) => { $("status").textContent = msg || ""; $("status").classList.toggle("error", !!isError); };

const getName = () => $("myName").value.trim();
try { $("myName").value = localStorage.getItem("ffis-name") || ""; } catch {}
$("myName").addEventListener("input", () => { try { localStorage.setItem("ffis-name", getName()); } catch {} render(); });

const STAR = '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/></svg>';
const IMG_PLACEHOLDER = '<svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/></svg><span>No image</span>';

function cardHtml(it, i) {
  const img = safeUrl(it.image), href = safeUrl(it.url);
  const mine = it.claimed_by && getName() && it.claimed_by.toLowerCase() === getName().toLowerCase();
  let action;
  if (it.bought) action = '<span class="pill">Already bought</span>';
  else if (mine) action = '<button type="button" class="btn claimbtn" data-id="' + esc(it.id) + '" data-claim="false">You’re getting this. Undo</button>';
  else if (it.claimed_by) action = '<span class="pill claim">' + esc(it.claimed_by) + " is getting this</span>";
  else action = '<button type="button" class="btn btn-primary claimbtn" style="min-height:48px;font-size:16px" data-id="' + esc(it.id) + '" data-claim="true">I’ll get this</button>';
  return '<div class="thumb">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : IMG_PLACEHOLDER) +
    '<span class="badge">' + esc(hostOf(it.url)) + "</span>" +
    (it.favourite ? '<span class="fav" aria-label="A top pick" style="background:var(--yellow);color:var(--ink);pointer-events:none">' + STAR + "</span>" : "") +
    '<span class="pricepill' + (it.price_value == null ? " none" : "") + '">' + esc(money(it.price_value, it.price_currency)) + "</span></div>" +
    '<div class="body"><h2 class="title">' + esc(it.title || "(No title)") + "</h2>" +
    (it.description ? '<p class="desc">' + esc(it.description) + "</p>" : "") +
    '<div class="linkrow">' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">Open product</a>' : "") + "</div>" +
    action + "</div>";
}

function render() {
  const grid = $("list");
  grid.innerHTML = "";
  items.forEach((it, i) => {
    const card = document.createElement("article");
    card.className = "card" + (it.bought ? " is-bought" : "");
    card.style.setProperty("--c", COLORS[i % COLORS.length]);
    card.innerHTML = cardHtml(it, i);
    grid.appendChild(card);
  });
  if (!items.length) {
    const tile = document.createElement("div");
    tile.className = "add-tile";
    tile.innerHTML = "<p>Nothing on this list yet.</p>";
    grid.appendChild(tile);
  }
}

async function load() {
  try {
    const res = await fetch("/api/share/" + encodeURIComponent(token));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "This link isn't working");
    $("listName").textContent = data.list.name;
    document.title = data.list.name + " · Ffi's Presents";
    $("intro").textContent = "Pick something to get, and tick “I’ll get this” so nobody buys the same present twice.";
    $("whoami").hidden = false;
    items = data.items;
    render();
  } catch (e) {
    $("listName").textContent = "This link isn't active";
    $("intro").textContent = e.message;
  }
}

$("list").addEventListener("click", async (e) => {
  const btn = e.target.closest(".claimbtn");
  if (!btn) return;
  const name = getName();
  if (!name) { say("Add your name at the top first.", true); $("myName").focus(); return; }
  btn.disabled = true;
  try {
    const res = await fetch("/api/share/" + encodeURIComponent(token) + "/claim", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ itemId: btn.dataset.id, name, claim: btn.dataset.claim === "true" })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong");
    say("");
  } catch (err) { say(err.message, true); }
  await load();
});

load();
