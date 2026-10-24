const $ = (id) => document.getElementById(id);
const COLORS = ["#ff5c97", "#2ee6a8", "#5ec8ff", "#ff8a3d", "#b69bff", "#ffd23f"];

let items = [], lists = [];
const prefs = { list: "all", filter: "all", sort: "new", q: "" };
try { Object.assign(prefs, JSON.parse(localStorage.getItem("ffis-prefs") || "{}"), { q: "" }); } catch {}
const savePrefs = () => { try { localStorage.setItem("ffis-prefs", JSON.stringify(prefs)); } catch {} };

/* ---------- helpers ---------- */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[c]));
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };
const num = (v) => (v == null || v === "" ? null : Number(v));
const money = (v, cur) => {
  if (v == null) return "—";
  try { return new Intl.NumberFormat("en-GB", { style:"currency", currency: cur || "GBP" }).format(v); }
  catch { return Number(v).toFixed(2) + (cur ? " " + cur : ""); }
};
const listColor = (id) => { const i = lists.findIndex((l) => l.id === id); return i < 0 ? "#b69bff" : COLORS[i % COLORS.length]; };
const activeList = () => lists.find((l) => l.id === prefs.list) || null;

function ago(iso) {
  if (!iso) return "";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 2) return "just now";
  if (mins < 60) return mins + " minutes ago";
  const hrs = Math.round(mins / 60);
  if (hrs < 36) return hrs + (hrs === 1 ? " hour ago" : " hours ago");
  return Math.round(hrs / 24) + " days ago";
}

function say(msg, isError) {
  $("status").textContent = msg || "";
  $("status").classList.toggle("error", !!isError);
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error((data && data.error) || "Something went wrong (" + res.status + ")");
  return data;
}
const send = (path, body, method = "POST") => api(path, { method, headers:{ "content-type":"application/json" }, body: JSON.stringify(body ?? {}) });

/* ---------- price tracking ---------- */
// Points in the item's current currency, oldest first.
function pointsOf(it) {
  const cur = it.price_currency;
  return (it.history || []).filter((h) => h.c === cur).map((h) => ({ p: Number(h.p), at: h.at }));
}
function changeOf(it) {
  const pts = pointsOf(it);
  if (pts.length < 2) return null;
  const diff = Math.round((pts[pts.length - 1].p - pts[0].p) * 100) / 100;
  return diff === 0 ? null : diff;
}
function sparkSvg(pts, color) {
  if (pts.length < 2) return "";
  const w = 84, h = 28, pad = 3;
  const ps = pts.map((x) => x.p), lo = Math.min(...ps), hi = Math.max(...ps), span = hi - lo || 1;
  const xy = pts.map((x, i) => [pad + (i * (w - pad * 2)) / (pts.length - 1), h - pad - ((x.p - lo) / span) * (h - pad * 2)]);
  const last = xy[xy.length - 1];
  return '<svg class="spark" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + " " + h + '" role="img" aria-label="Price history, ' + pts.length + ' checks">' +
    '<polyline fill="none" stroke="' + color + '" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="' + xy.map((p) => p.join(",")).join(" ") + '"/>' +
    '<circle cx="' + last[0] + '" cy="' + last[1] + '" r="3.5" fill="' + color + '"/></svg>';
}

/* ---------- totals and budget ---------- */
function totals(scope) {
  const planned = {}, todo = {};
  for (const it of scope) {
    const p = num(it.price_value);
    if (p == null) continue;
    const c = it.price_currency || "GBP";
    planned[c] = (planned[c] || 0) + p;
    if (!it.bought) todo[c] = (todo[c] || 0) + p;
  }
  return { planned, todo };
}
const sumText = (byCur) => {
  const parts = Object.entries(byCur).map(([c, v]) => money(v, c));
  return parts.length ? parts.join(" + ") : money(0, "GBP");
};

function panelHtml(list, scope) {
  const t = totals(scope), color = listColor(list.id);
  const bc = list.budget_currency || "GBP", budget = num(list.budget);
  const planned = t.planned[bc] || 0;
  const others = Object.entries(t.planned).filter(([c]) => c !== bc).map(([c, v]) => money(v, c));
  let meter = "";
  if (budget != null) {
    const pct = budget === 0 ? 100 : Math.min(100, (planned / budget) * 100);
    const over = planned > budget;
    meter = '<div class="meter"><div class="track" role="progressbar" aria-label="Budget used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + Math.round(pct) + '"><div class="fill' + (over ? " over" : "") + '" style="width:' + pct + '%"></div></div>' +
      '<p class="' + (over ? "over" : "") + '">' + esc(money(planned, bc)) + " planned of " + esc(money(budget, bc)) + " — " +
      (over ? esc(money(planned - budget, bc)) + " over budget" : esc(money(budget - planned, bc)) + " left") + "</p>" +
      (others.length ? "<small>Not counted, different currency: " + esc(others.join(", ")) + "</small>" : "") + "</div>";
  }
  return '<div class="panel" style="--c:' + color + '">' +
    '<div class="panel-head"><h2><span class="dot"></span>' + esc(list.name) + "</h2>" +
    '<div class="panel-actions"><button type="button" class="btn btn-small" id="pEdit">Edit</button>' +
    '<button type="button" class="btn btn-small" id="pShare">' + (list.share_token ? "Sharing on" : "Share") + "</button>" +
    '<button type="button" class="btn btn-small btn-danger" id="pDelete">Delete list</button></div></div>' +
    '<div class="stats"><div class="stat"><b>' + scope.length + "</b><span>presents</span></div>" +
    '<div class="stat"><b>' + esc(sumText(t.planned)) + "</b><span>planned</span></div>" +
    '<div class="stat"><b>' + esc(sumText(t.todo)) + "</b><span>still to buy</span></div></div>" + meter + "</div>";
}

/* ---------- rendering ---------- */
const STAR = '<svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9L12 3Z"/></svg>';
const IMG_PLACEHOLDER = '<svg aria-hidden="true" width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m21 16-5-5-9 9"/></svg><span>No image</span>';

function cardHtml(it) {
  const img = safeUrl(it.image), href = safeUrl(it.url);
  const color = listColor(it.list_id);
  const price = num(it.price_value);
  const change = changeOf(it), cur = it.price_currency;
  const pts = pointsOf(it);
  let pill = "";
  if (change != null) {
    pill = change < 0
      ? '<span class="pill down">Down ' + esc(money(-change, cur)) + " since added</span>"
      : '<span class="pill up">Up ' + esc(money(change, cur)) + " since added</span>";
  }
  const claim = it.claimed_by ? '<span class="pill claim">' + esc(it.claimed_by) + ' is getting it <button type="button" class="clear-claim" data-id="' + esc(it.id) + '" aria-label="Clear who is getting this">×</button></span>' : "";
  const moveOptions = '<option value="">No list</option>' + lists.map((l) => '<option value="' + esc(l.id) + '"' + (l.id === it.list_id ? " selected" : "") + ">" + esc(l.name) + "</option>").join("");
  return '<div class="thumb">' + (img ? '<img src="' + esc(img) + '" alt="" loading="lazy">' : IMG_PLACEHOLDER) +
    '<span class="badge">' + esc(hostOf(it.url)) + "</span>" +
    '<button type="button" class="fav" data-id="' + esc(it.id) + '" aria-pressed="' + !!it.favourite + '" aria-label="Favourite">' + STAR + "</button>" +
    '<span class="pricepill' + (price == null ? " none" : "") + '">' + esc(money(price, cur)) + "</span></div>" +
    '<div class="body"><h2 class="title">' + esc(it.title || "(No title)") + "</h2>" +
    (it.description ? '<p class="desc">' + esc(it.description) + "</p>" : "") +
    '<div class="trend">' + sparkSvg(pts, change != null && change < 0 ? "#2ee6a8" : "#ffd23f") + pill + claim + "</div>" +
    '<div class="linkrow">' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">Open product</a>' : "") +
    '<span class="checked">Checked ' + esc(ago(it.last_checked)) + "</span></div>" +
    '<div class="rule"></div>' +
    '<div class="actions"><label class="check"><input type="checkbox" class="toggleBought" data-id="' + esc(it.id) + '"' + (it.bought ? " checked" : "") + "> Already bought</label>" +
    '<div class="btn-group"><button type="button" class="btn btn-small refresh" data-id="' + esc(it.id) + '">Refresh</button>' +
    '<button type="button" class="btn btn-small btn-danger delete" data-id="' + esc(it.id) + '">Remove</button></div></div>' +
    '<div class="movewrap"><label for="move-' + esc(it.id) + '" class="eyebrow" style="font-size:12px">List</label><select id="move-' + esc(it.id) + '" class="select move" data-id="' + esc(it.id) + '">' + moveOptions + "</select></div>" +
    '<div class="notes"><label for="notes-' + esc(it.id) + '" class="eyebrow" style="font-size:12px">Notes</label>' +
    '<textarea id="notes-' + esc(it.id) + '" class="noteBox" data-id="' + esc(it.id) + '" placeholder="Size, colour, delivery notes">' + esc(it.notes || "") + "</textarea>" +
    '<div class="saved" id="saved-' + esc(it.id) + '" role="status"></div></div></div>';
}

function render() {
  // lists row
  const inList = (id) => items.filter((i) => i.list_id === id).length;
  $("lists").innerHTML =
    '<button type="button" class="chip" data-list="all" aria-pressed="' + (prefs.list === "all") + '" style="--c:#ffd23f">All <span class="n">' + items.length + "</span></button>" +
    lists.map((l, i) => '<button type="button" class="chip" data-list="' + esc(l.id) + '" aria-pressed="' + (prefs.list === l.id) + '" style="--c:' + COLORS[i % COLORS.length] + '"><span class="dot"></span>' + esc(l.name) + ' <span class="n">' + inList(l.id) + "</span></button>").join("") +
    '<button type="button" class="chip chip-add" id="newList">+ New list</button>';

  const list = activeList();
  if (prefs.list !== "all" && !list) prefs.list = "all";
  const scope = items.filter((i) => prefs.list === "all" || i.list_id === prefs.list);

  $("addLabel").textContent = list ? "Add a present to " + list.name : "Add a present";
  const panel = $("panel");
  panel.hidden = !list;
  panel.innerHTML = list ? panelHtml(list, scope) : "";

  // tabs
  const counts = { all: scope.length, todo: scope.filter((i) => !i.bought).length, bought: scope.filter((i) => i.bought).length,
    fav: scope.filter((i) => i.favourite).length, drop: scope.filter((i) => (changeOf(i) ?? 0) < 0).length };
  for (const k of Object.keys(counts)) $("n-" + k).textContent = counts[k];
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-pressed", String(t.dataset.filter === prefs.filter)));
  $("sort").value = prefs.sort;

  // filter, search, sort
  const q = prefs.q.trim().toLowerCase();
  let shown = scope.filter((i) => {
    if (prefs.filter === "todo" && i.bought) return false;
    if (prefs.filter === "bought" && !i.bought) return false;
    if (prefs.filter === "fav" && !i.favourite) return false;
    if (prefs.filter === "drop" && !((changeOf(i) ?? 0) < 0)) return false;
    return !q || [i.title, i.description, i.notes, hostOf(i.url), i.claimed_by].some((f) => String(f || "").toLowerCase().includes(q));
  });
  const byPrice = (a, b, dir) => { const x = num(a.price_value), y = num(b.price_value); if (x == null) return 1; if (y == null) return -1; return dir * (x - y); };
  const sorters = {
    new: (a, b) => new Date(b.created_at) - new Date(a.created_at),
    old: (a, b) => new Date(a.created_at) - new Date(b.created_at),
    low: (a, b) => byPrice(a, b, 1), high: (a, b) => byPrice(a, b, -1),
    drop: (a, b) => (changeOf(a) ?? 0) - (changeOf(b) ?? 0),
    az: (a, b) => String(a.title || "").localeCompare(String(b.title || ""))
  };
  shown = shown.slice().sort(sorters[prefs.sort] || sorters.new);

  const grid = $("list");
  grid.innerHTML = "";
  for (const it of shown) {
    const card = document.createElement("article");
    card.className = "card" + (it.bought ? " is-bought" : "");
    card.style.setProperty("--c", listColor(it.list_id));
    card.innerHTML = cardHtml(it);
    grid.appendChild(card);
  }
  const noMatches = !shown.length && scope.length;
  if (prefs.filter === "all" && !q || !shown.length) {
    const tile = document.createElement("div");
    tile.className = "add-tile";
    tile.innerHTML = '<svg aria-hidden="true" width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg><p>' +
      (noMatches ? "Nothing matches. Try another filter or search." :
        scope.length ? "Paste a link above to add the next present" :
        list ? "This list is empty. Paste a link above to add the first present" : "No presents yet. Paste a link above to add the first one") + "</p>";
    grid.appendChild(tile);
  }
}

async function load() {
  try {
    [items, lists] = await Promise.all([api("/api/items"), api("/api/lists")]);
    render();
  } catch (e) { say(e.message, true); }
}

/* ---------- confetti ---------- */
function confetti(x, y) {
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = $("confetti"), ctx = cv.getContext("2d");
  cv.width = innerWidth; cv.height = innerHeight;
  const parts = Array.from({ length: 70 }, () => ({
    x, y, vx: (Math.random() - .5) * 10, vy: -Math.random() * 11 - 3, r: Math.random() * 6 + 4, rot: Math.random() * 6,
    vr: (Math.random() - .5) * .4, c: COLORS[Math.floor(Math.random() * COLORS.length)]
  }));
  let frame = 0;
  (function tick() {
    ctx.clearRect(0, 0, cv.width, cv.height);
    for (const p of parts) {
      p.vy += .35; p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.c; ctx.fillRect(-p.r / 2, -p.r / 4, p.r, p.r / 2); ctx.restore();
    }
    if (++frame < 90) requestAnimationFrame(tick); else ctx.clearRect(0, 0, cv.width, cv.height);
  })();
}

/* ---------- debounced notes ---------- */
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const saveNote = debounce(async (id, text) => {
  try {
    await send("/api/items/" + id + "/notes", { notes: text });
    const it = items.find((i) => i.id === id); if (it) it.notes = text;
    const s = $("saved-" + id);
    if (s) { s.textContent = "Saved"; setTimeout(() => { s.textContent = ""; }, 1200); }
  } catch (e) { say(e.message, true); }
}, 600);

/* ---------- card actions ---------- */
const grid = $("list");
grid.addEventListener("change", async (e) => {
  const cb = e.target.closest(".toggleBought"), mv = e.target.closest(".move");
  try {
    if (cb) {
      if (cb.checked) { const r = cb.getBoundingClientRect(); confetti(r.left + r.width / 2, r.top + r.height / 2); }
      await send("/api/items/" + cb.dataset.id + "/bought", { bought: cb.checked });
      await load();
    } else if (mv) {
      await send("/api/items/" + mv.dataset.id + "/list", { list_id: mv.value || null });
      await load();
    }
  } catch (err) { say(err.message, true); await load(); }
});
grid.addEventListener("click", async (e) => {
  const del = e.target.closest(".delete"), ref = e.target.closest(".refresh"), fav = e.target.closest(".fav"), clr = e.target.closest(".clear-claim");
  try {
    if (del) {
      if (!confirm("Remove this present?")) return;
      await api("/api/items/" + del.dataset.id, { method:"DELETE" }); await load();
    } else if (ref) {
      ref.disabled = true; ref.textContent = "Refreshing…";
      await api("/api/refresh/" + ref.dataset.id, { method:"POST" }); await load();
    } else if (fav) {
      const on = fav.getAttribute("aria-pressed") !== "true";
      await send("/api/items/" + fav.dataset.id + "/favourite", { favourite: on }); await load();
    } else if (clr) {
      await send("/api/items/" + clr.dataset.id + "/claim", { claimed_by: null }); await load();
    }
  } catch (err) { say(err.message, true); await load(); }
});
grid.addEventListener("input", (e) => { const ta = e.target.closest(".noteBox"); if (ta) saveNote(ta.dataset.id, ta.value); });

/* ---------- lists, filters, search, sort ---------- */
$("lists").addEventListener("click", (e) => {
  const chip = e.target.closest("[data-list]");
  if (chip) { prefs.list = chip.dataset.list; savePrefs(); render(); }
  else if (e.target.closest("#newList")) openListDialog(null);
});
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => { prefs.filter = t.dataset.filter; savePrefs(); render(); }));
$("sort").addEventListener("change", (e) => { prefs.sort = e.target.value; savePrefs(); render(); });
$("search").addEventListener("input", (e) => { prefs.q = e.target.value; render(); });

/* list dialog */
let editingId = null;
function openListDialog(list) {
  editingId = list ? list.id : null;
  $("listDialogTitle").textContent = list ? "Edit list" : "New list";
  $("listName").value = list ? list.name : "";
  $("listBudget").value = list && list.budget != null ? Number(list.budget) : "";
  $("listCurrency").value = list ? list.budget_currency || "GBP" : "GBP";
  $("listDialog").showModal();
  $("listName").focus();
}
$("listCancel").onclick = () => $("listDialog").close();
$("listForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { name: $("listName").value, budget: $("listBudget").value === "" ? null : $("listBudget").value, currency: $("listCurrency").value };
  try {
    const saved = editingId ? await send("/api/lists/" + editingId, body) : await send("/api/lists", body);
    prefs.list = saved.id; savePrefs();
    $("listDialog").close();
    await load();
  } catch (err) { say(err.message, true); $("listDialog").close(); }
});

/* list panel buttons */
$("panel").addEventListener("click", async (e) => {
  const list = activeList(); if (!list) return;
  if (e.target.closest("#pEdit")) openListDialog(list);
  else if (e.target.closest("#pShare")) openShare(list);
  else if (e.target.closest("#pDelete")) {
    if (!confirm('Delete the list "' + list.name + '"? The presents in it are kept.')) return;
    try { await api("/api/lists/" + list.id, { method:"DELETE" }); prefs.list = "all"; savePrefs(); await load(); } catch (err) { say(err.message, true); }
  }
});

/* share dialog */
function shareHtml(list) {
  if (!list.share_token) {
    return "<p>Make a private link for this list. Anyone with the link can see the presents and tick “I’ll get this” so nobody buys the same thing. They can’t change anything else, and they never see your notes.</p>" +
      '<div class="dlg-actions"><button type="button" class="btn btn-violet" id="shareOn">Create link</button></div>';
  }
  const link = location.origin + "/s/" + list.share_token;
  return "<p>Anyone with this link can see this list. Send it only to people you trust.</p>" +
    '<div class="copyrow"><input id="shareLink" readonly value="' + esc(link) + '" aria-label="Share link"><button type="button" class="btn btn-violet" id="shareCopy">Copy</button></div>' +
    '<div class="dlg-actions"><button type="button" class="btn btn-danger" id="shareOff">Stop sharing</button></div>';
}
let sharingId = null;
function openShare(list) {
  sharingId = list.id;
  $("shareBody").innerHTML = shareHtml(list);
  if (!$("shareDialog").open) $("shareDialog").showModal();
}
$("shareClose").onclick = () => $("shareDialog").close();
$("shareBody").addEventListener("click", async (e) => {
  try {
    if (e.target.closest("#shareOn") || e.target.closest("#shareOff")) {
      const on = !!e.target.closest("#shareOn");
      if (!on && !confirm("Stop sharing? The current link will stop working.")) return;
      const updated = await send("/api/lists/" + sharingId + "/share", { enabled: on });
      lists = lists.map((l) => (l.id === updated.id ? updated : l));
      render(); openShare(updated);
    } else if (e.target.closest("#shareCopy")) {
      const input = $("shareLink");
      try { await navigator.clipboard.writeText(input.value); e.target.textContent = "Copied"; }
      catch { input.select(); e.target.textContent = "Press Cmd+C"; }
    }
  } catch (err) { say(err.message, true); }
});

/* ---------- add, refresh, import ---------- */
async function addItem() {
  const url = $("url").value.trim();
  if (!url) return;
  const btn = $("add");
  btn.disabled = true; btn.textContent = "Adding…"; say("Looking up the product. This can take a few seconds.");
  try {
    await send("/api/add", { url, list_id: prefs.list === "all" ? null : prefs.list });
    $("url").value = ""; say("");
    await load();
  } catch (e) { say(e.message, true); }
  btn.disabled = false; btn.textContent = "Add";
}
$("add").onclick = addItem;
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") addItem(); });

$("refreshAll").onclick = async () => {
  const btn = $("refreshAll"); btn.disabled = true;
  const targets = items.filter((i) => prefs.list === "all" || i.list_id === prefs.list);
  let failed = 0;
  for (let n = 0; n < targets.length; n++) {
    say("Checking price " + (n + 1) + " of " + targets.length + "…");
    try { await api("/api/refresh/" + targets[n].id, { method:"POST" }); } catch { failed++; }
  }
  say(failed ? failed + " of " + targets.length + " could not be checked." : "Prices checked.", !!failed);
  btn.disabled = false;
  await load();
};

$("importBtn").onclick = () => $("importFile").click();
$("importFile").onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const out = await send("/api/import", JSON.parse(await file.text()));
    say("Imported " + out.added + " new " + (out.added === 1 ? "present" : "presents") + ".");
  } catch (err) { say(err instanceof SyntaxError ? "That file isn't a valid export." : err.message, true); }
  e.target.value = ""; await load();
};

$("search").value = "";
load();
