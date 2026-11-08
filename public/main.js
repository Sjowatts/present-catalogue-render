const $ = (id) => document.getElementById(id);

// "/" is the owner's own site; "/mum" is Mum's private page. Every data request says which one it is for.
const SPACE = (location.pathname.match(/^\/([a-z0-9][a-z0-9-]{1,29})\/?$/) || [])[1] || "";
const nativeFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  if (typeof input === "string" && input.startsWith("/api/")) init = { ...init, headers: { ...(init.headers || {}), "X-Space": SPACE } };
  return nativeFetch(input, init);
};
const COLORS = ["#c8a96a", "#8aa6c9", "#7fb59d", "#c98f7a", "#a79bc4", "#8d939e"];

let items = [], lists = [];
let renderedPeople = false;
const prefs = { list: "all", filter: "all", sort: "new", q: "" };
const PREFS_KEY = "ffis-prefs" + (SPACE ? "-" + SPACE : "");
try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"), { q: "" }); } catch {}
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch {} };

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
const listColor = (id) => { const i = lists.findIndex((l) => l.id === id); return i < 0 ? "#8d939e" : COLORS[i % COLORS.length]; };
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

function say(msg, kind) {
  $("status").textContent = msg || "";
  $("status").classList.toggle("error", kind === true);
  $("status").classList.toggle("warn", kind === "warn");
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) throw Object.assign(new Error((data && data.error) || "Something went wrong (" + res.status + ")"), { status: res.status, data });
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

// Where a pound price came from, or a heads-up when it could not be converted yet.
function origNote(it) {
  if (it.url && it.price_value == null && !it.price_locked && (it.source === "blocked" || !it.image))
    return '<p class="orig warnnote">This shop couldn\'t be read automatically. Press Edit to add the price and photo.</p>';
  if (it.orig_currency && it.orig_value != null && it.price_currency === "GBP")
    return '<p class="orig">Converted from ' + esc(money(Number(it.orig_value), it.orig_currency)) + " (approx.)</p>";
  if (it.price_value != null && it.price_currency && it.price_currency !== "GBP")
    return '<p class="orig">Not converted to pounds yet. Try Refresh later.</p>';
  return "";
}

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
    '<span class="badge">' + esc(hostOf(it.url) || "Added by hand") + "</span>" +
    '<button type="button" class="fav" data-id="' + esc(it.id) + '" aria-pressed="' + !!it.favourite + '" aria-label="Favourite">' + STAR + "</button>" +
    '<span class="pricepill' + (price == null ? " none" : "") + '">' + esc(money(price, cur)) + "</span></div>" +
    '<div class="body"><h2 class="title">' + esc(it.title || "(No title)") + "</h2>" +
    (it.description ? '<p class="desc">' + esc(it.description) + "</p>" : "") +
    origNote(it) +
    '<div class="trend">' + sparkSvg(pts, change != null && change < 0 ? "#6bbf9b" : "#c8a96a") + pill + claim + "</div>" +
    '<div class="linkrow">' + (href ? '<a href="' + esc(href) + '" target="_blank" rel="noopener">Open product</a>' : "") +
    '<span class="checked">' + (it.price_locked ? "Price set by you" : it.url ? "Checked " + esc(ago(it.last_checked)) : "") + "</span></div>" +
    '<div class="rule"></div>' +
    '<div class="actions"><label class="check"><input type="checkbox" class="toggleBought" data-id="' + esc(it.id) + '"' + (it.bought ? " checked" : "") + "> Already bought</label>" +
    '<div class="btn-group"><button type="button" class="btn btn-small edit" data-id="' + esc(it.id) + '">Edit</button>' +
    (it.url ? '<button type="button" class="btn btn-small refresh" data-id="' + esc(it.id) + '">Refresh</button>' : "") +
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
    '<button type="button" class="chip" data-list="all" aria-pressed="' + (prefs.list === "all") + '" style="--c:#c8a96a">All <span class="n">' + items.length + "</span></button>" +
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

// The family menu: a row of everyone's names; each opens that person's page (which asks for their PIN
// unless this device is already signed in there).
async function renderPeople() {
  let people = [];
  try { people = await api("/api/family"); } catch { return; }
  const box = $("people");
  if (!people.length) { box.hidden = true; return; }
  const here = (slug) => (slug === SPACE ? ' aria-current="page"' : "");
  box.innerHTML = '<span class="eyebrow">Family</span>' +
    '<a class="chip chip-person" href="/"' + (SPACE ? "" : ' aria-current="page"') + ">Ffi</a>" +
    people.map((x) => '<a class="chip chip-person" href="/' + esc(x.slug) + '"' + here(x.slug) + ">" + esc(x.name) + "</a>").join("");
  box.hidden = false;
}

async function load() {
  try {
    [items, lists] = await Promise.all([api("/api/items"), api("/api/lists")]);
    render();
    if (!renderedPeople) { renderedPeople = true; renderPeople(); }
    return true;
  } catch (e) {
    if (e.status === 401 && e.data && e.data.code === "pin_required") showLogin();
    else say(e.message, true);
    return false;
  }
}

/* ---------- confetti ---------- */
const CONFETTI = ["#c8a96a", "#f3f4f6", "#8aa6c9", "#6bbf9b"];
function confetti(x, y) {
  if (window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cv = $("confetti"), ctx = cv.getContext("2d");
  cv.width = innerWidth; cv.height = innerHeight;
  const parts = Array.from({ length: 56 }, () => ({
    x, y, vx: (Math.random() - .5) * 10, vy: -Math.random() * 11 - 3, r: Math.random() * 6 + 4, rot: Math.random() * 6,
    vr: (Math.random() - .5) * .4, c: CONFETTI[Math.floor(Math.random() * CONFETTI.length)]
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
  const del = e.target.closest(".delete"), ref = e.target.closest(".refresh"), fav = e.target.closest(".fav"), clr = e.target.closest(".clear-claim"), edit = e.target.closest(".edit");
  if (edit) { const it = items.find((x) => x.id === edit.dataset.id); if (it) openItemDialog(it); return; }
  try {
    if (del) {
      if (!confirm("Remove this present?")) return;
      await api("/api/items/" + del.dataset.id, { method:"DELETE" }); await load();
    } else if (ref) {
      ref.disabled = true; ref.textContent = "Refreshing…";
      const r = await api("/api/refresh/" + ref.dataset.id, { method:"POST" });
      say(r.lookup && r.lookup.unread ? (hostOf(r.url) || "The shop") + " wouldn't let this site read the page, so nothing was updated." : "", r.lookup && r.lookup.unread ? "warn" : false);
      await load();
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
let sharingAll = false; // true while the dialog is about the whole page rather than one list
function openShare(list) {
  sharingAll = false;
  sharingId = list.id;
  $("shareTitle").textContent = "Share this list";
  $("shareBody").innerHTML = shareHtml(list);
  if (!$("shareDialog").open) $("shareDialog").showModal();
}
function shareAllHtml(token) {
  if (!token) {
    return "<p>Make one private link for everything on this page: every list, with all the links, pictures and prices. Whoever has it can look and tick “I’ll get this”, but can’t change anything and never sees your notes.</p>" +
      '<div class="dlg-actions"><button type="button" class="btn btn-violet" id="shareOn">Create link</button></div>';
  }
  const link = location.origin + "/w/" + token;
  return "<p>Anyone with this link can see everything on this page. Send it only to people you trust.</p>" +
    '<div class="copyrow"><input id="shareLink" readonly value="' + esc(link) + '" aria-label="Share link"><button type="button" class="btn btn-violet" id="shareCopy">Copy</button></div>' +
    '<div class="dlg-actions"><button type="button" class="btn btn-danger" id="shareOff">Stop sharing</button></div>';
}
async function openShareAll() {
  try {
    const { token } = await api("/api/page-share");
    sharingAll = true;
    $("shareTitle").textContent = "Share everything";
    $("shareBody").innerHTML = shareAllHtml(token);
    if (!$("shareDialog").open) $("shareDialog").showModal();
  } catch (err) { say(err.message, true); }
}
$("shareAllBtn").onclick = openShareAll;
$("shareClose").onclick = () => $("shareDialog").close();
$("shareBody").addEventListener("click", async (e) => {
  try {
    if (e.target.closest("#shareOn") || e.target.closest("#shareOff")) {
      const on = !!e.target.closest("#shareOn");
      if (!on && !confirm("Stop sharing? The current link will stop working.")) return;
      if (sharingAll) {
        const { token } = await send("/api/page-share", { enabled: on });
        $("shareBody").innerHTML = shareAllHtml(token);
        return;
      }
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
function sayDuplicate(err, url, hint) {
  const st = $("status");
  st.classList.remove("error");
  st.textContent = err.message + ". ";
  const show = document.createElement("button");
  show.type = "button"; show.className = "linkbtn"; show.textContent = "Show it";
  show.onclick = () => {
    const dup = err.data && err.data.duplicate;
    prefs.list = "all"; prefs.filter = "all"; prefs.q = (dup && dup.title) || ""; $("search").value = prefs.q; savePrefs(); render();
    say("");
  };
  const again = document.createElement("button");
  again.type = "button"; again.className = "linkbtn"; again.textContent = "Add anyway";
  again.onclick = () => addItem({ force: true, url, hint });
  st.append(show, again);
}

async function addItem(opts = {}) {
  const url = (opts.url || $("url").value).trim();
  if (!url) return;
  const btn = $("add");
  btn.disabled = true; btn.textContent = "Adding…"; say("Looking up the product. This can take a few seconds.");
  try {
    const added = await send("/api/add", { url, hint: opts.hint, force: !!opts.force, list_id: prefs.list === "all" ? null : prefs.list });
    $("url").value = "";
    const shop = hostOf(added.url);
    if (added.lookup && added.lookup.blocked) say((shop || "That shop") + " doesn't let this site read its pages, so I saved the link with a name from the address. Press Edit on the card to add the price and photo, or use \"Add from phone\" to add it straight from the shop's page.", "warn");
    else if (added.lookup && added.lookup.unread) say("I couldn't read any details from that page. Press Edit on the card to add them.", "warn");
    else say("");
    await load();
  } catch (e) {
    if (e.status === 409) sayDuplicate(e, url, opts.hint); else say(e.message, true);
  }
  btn.disabled = false; btn.textContent = "Add";
}
$("add").onclick = () => addItem();
$("url").addEventListener("keydown", (e) => { if (e.key === "Enter") addItem(); });

$("refreshAll").onclick = async () => {
  const btn = $("refreshAll"); btn.disabled = true;
  const targets = items.filter((i) => prefs.list === "all" || i.list_id === prefs.list);
  let failed = 0, refused = 0;
  for (let n = 0; n < targets.length; n++) {
    say("Checking price " + (n + 1) + " of " + targets.length + "…");
    try { const r = await api("/api/refresh/" + targets[n].id, { method:"POST" }); if (r.lookup && r.lookup.unread) refused++; } catch { failed++; }
  }
  if (failed) say(failed + " of " + targets.length + " could not be checked.", true);
  else if (refused) say("Prices checked. " + refused + (refused === 1 ? " shop wouldn't" : " shops wouldn't") + " let this site read the page, so those weren't updated.", "warn");
  else say("Prices checked.");
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

/* ---------- add by hand / edit ---------- */
let editing = null; // the present being edited, or null when adding a new one
let startPrice = "";
function openItemDialog(it) {
  editing = it || null;
  $("itemDialogTitle").textContent = it ? "Edit present" : "Add by hand";
  $("fTitle").value = it ? it.title || "" : "";
  $("fUrl").value = it ? it.url || "" : "";
  startPrice = it && it.price_value != null ? String(Number(it.price_value)) : "";
  $("fPrice").value = startPrice;
  $("fCurrency").value = "GBP";
  $("fImage").value = it ? it.image || "" : "";
  $("fDesc").value = it ? it.description || "" : "";
  $("fPriceLock").checked = it ? !!it.price_locked : true;
  $("fDetailsLock").checked = it ? !!it.details_locked : true;
  $("lockBox").hidden = !it;
  $("itemError").textContent = "";
  $("itemDialog").showModal();
  $("fTitle").focus();
}
$("addByHand").onclick = () => openItemDialog(null);
$("itemCancel").onclick = () => $("itemDialog").close();
$("fPrice").addEventListener("input", () => { if (editing) $("fPriceLock").checked = true; });
$("fCurrency").addEventListener("change", () => { if (editing) $("fPriceLock").checked = true; });
$("fTitle").addEventListener("input", () => { if (editing) $("fDetailsLock").checked = true; });
$("fImage").addEventListener("input", () => { if (editing) $("fDetailsLock").checked = true; });
$("fDesc").addEventListener("input", () => { if (editing) $("fDetailsLock").checked = true; });

$("itemForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const save = $("itemSave"); save.disabled = true;
  $("itemError").textContent = "";
  const price = $("fPrice").value;
  try {
    if (editing) {
      const body = { title: $("fTitle").value, url: $("fUrl").value, image: $("fImage").value, description: $("fDesc").value,
        price_locked: $("fPriceLock").checked, details_locked: $("fDetailsLock").checked };
      if (price !== startPrice || $("fCurrency").value !== "GBP") { body.price = price; body.currency = $("fCurrency").value; }
      await send("/api/items/" + editing.id + "/edit", body);
    } else {
      await send("/api/items/manual", { title: $("fTitle").value, url: $("fUrl").value, price, currency: $("fCurrency").value,
        image: $("fImage").value, description: $("fDesc").value, list_id: prefs.list === "all" ? null : prefs.list });
    }
    $("itemDialog").close();
    await load();
  } catch (err) {
    if (err.status === 409 && !editing) {
      $("itemError").textContent = err.message + ". Clear the link to add it without one.";
    } else $("itemError").textContent = err.message;
  }
  save.disabled = false;
});

/* ---------- import a wishlist ---------- */
// The "Copy wishlist" bookmark (ffiWishlist in extract.js) reads an Amazon wishlist in your own browser and
// copies it; you paste it here and it is added, skipping anything already on this page.
const wishlistHref = () => "javascript:(function(){" + ffiWishlist.toString().replace(/\s*\n\s*/g, " ") + ";ffiWishlist();})()";
const NEW_LIST = "__new__";
function parseWishlist(text) {
  const t = String(text || "").trim();
  if (!t.startsWith("FFI-WISHLIST:")) throw new Error("That isn't a copied wishlist. Click the Copy wishlist bookmark on the Amazon list first, then paste.");
  let data;
  try { data = JSON.parse(t.slice("FFI-WISHLIST:".length)); } catch { throw new Error("The pasted text looks cut off. Try copying again."); }
  if (!data || !Array.isArray(data.items) || !data.items.length) throw new Error("That wishlist has no presents in it.");
  return data;
}
function openWishlistDialog() {
  $("wishlistMarklet").href = wishlistHref();
  const cur = activeList();
  $("wishlistList").innerHTML = '<option value="' + NEW_LIST + '">A new list</option>' +
    lists.map((l) => '<option value="' + esc(l.id) + '"' + (cur && cur.id === l.id ? " selected" : "") + ">" + esc(l.name) + "</option>").join("") +
    '<option value="">No list</option>';
  $("wishlistPaste").value = ""; $("wishlistName").value = ""; $("wishlistMsg").textContent = "";
  $("wishlistNameRow").hidden = $("wishlistList").value !== NEW_LIST;
  $("wishlistDialog").showModal();
}
$("wishlistBtn").onclick = openWishlistDialog;
$("wishlistClose").onclick = () => $("wishlistDialog").close();
$("wishlistMarklet").addEventListener("click", (e) => e.preventDefault());
$("wishlistMarkletCopy").onclick = (e) => copyText(wishlistHref(), e.target);
$("wishlistList").onchange = () => { $("wishlistNameRow").hidden = $("wishlistList").value !== NEW_LIST; };
$("wishlistPaste").addEventListener("input", () => {
  try { const d = parseWishlist($("wishlistPaste").value); if (!$("wishlistName").value) $("wishlistName").value = d.name || ""; $("wishlistMsg").textContent = d.items.length + " presents ready to import."; $("wishlistMsg").classList.remove("error"); }
  catch { $("wishlistMsg").textContent = ""; }
});
$("wishlistGo").onclick = async () => {
  const msg = $("wishlistMsg"), btn = $("wishlistGo");
  msg.classList.remove("error");
  try {
    const data = parseWishlist($("wishlistPaste").value);
    const where = $("wishlistList").value;
    const body = { items: data.items };
    if (where === NEW_LIST) body.list_name = $("wishlistName").value.trim() || data.name || "Wishlist";
    else if (where) body.list_id = where;
    btn.disabled = true; msg.textContent = "Importing " + data.items.length + " presents…";
    const r = await send("/api/wishlist-import", body);
    if (r.list) prefs.list = r.list.id; else prefs.list = "all";
    savePrefs();
    await load();
    msg.textContent = "Added " + r.added + (r.skipped ? ", skipped " + r.skipped + " already here" : "") + (r.invalid ? ", " + r.invalid + " had no usable link" : "") + ".";
  } catch (e) { msg.classList.add("error"); msg.textContent = e.message; }
  btn.disabled = false;
};

/* ---------- add from phone ---------- */
// The two small functions in extract.js read the shop page in your own browser (so a shop that blocks
// this site can't stop it) and build a link back here that carries the name, picture and price.
const pageBase = () => location.origin + (SPACE ? "/" + SPACE : "/");
const extractorSource = () => (ffiExtract.toString() + ";" + ffiLink.toString()).replace(/\s*\n\s*/g, " ");
const bookmarkletHref = () => "javascript:(function(){" + extractorSource() + ";location.href=ffiLink(" + JSON.stringify(pageBase()) + ");})()";
const shortcutScript = () => extractorSource() + "\ncompletion(ffiLink(" + JSON.stringify(pageBase()) + "));";

function openPhoneDialog() {
  $("phoneLink").value = pageBase() + "?add=";
  $("bookmarklet").href = bookmarkletHref();
  $("phoneDialog").showModal();
}
$("phoneBtn").onclick = openPhoneDialog;
$("phoneClose").onclick = () => $("phoneDialog").close();
$("bookmarklet").addEventListener("click", (e) => e.preventDefault());
$("scriptCopy").onclick = (e) => copyText(shortcutScript(), e.target);
$("bookmarkletCopy").onclick = (e) => copyText(bookmarkletHref(), e.target);
$("phoneCopy").onclick = async (e) => {
  try { await navigator.clipboard.writeText($("phoneLink").value); e.target.textContent = "Copied"; }
  catch { $("phoneLink").select(); e.target.textContent = "Press Cmd+C"; }
};

// Opened from a share or the shortcut/bookmarklet: /?add=<link> or /?url=<link>&text=...
// -> { url, hint } or null. Details can come with the link: t=name, i=picture, d=description, p=price, c=currency
// (from the bookmarklet or the iPhone Shortcut), or the page title from a phone's Share button.
function takeSharedLink() {
  const q = new URLSearchParams(location.search);
  if (!["add", "url", "text", "title"].some((k) => q.has(k))) return null;
  const grab = (v) => (v || "").match(/https?:\/\/[^\s<>"']+/i);
  const hasDetails = ["t", "i", "p"].some((k) => q.has(k));
  let found = null;
  // /?add= with nothing after it but the link takes everything, so a link pasted without encoding keeps its own & and ?.
  const raw = !hasDetails && location.search.match(/[?&]add=(.*)$/);
  if (raw) { let v = raw[1]; try { v = decodeURIComponent(v); } catch {} found = grab(v); }
  if (!found) found = [q.get("add"), q.get("url"), q.get("text"), q.get("title")].map(grab).find(Boolean);
  const hint = {};
  if (hasDetails) {
    hint.title = q.get("t"); hint.image = q.get("i"); hint.description = q.get("d"); hint.price = q.get("p"); hint.currency = q.get("c");
  } else if (q.get("title") && !/https?:\/\//i.test(q.get("title"))) hint.title = q.get("title");
  history.replaceState(null, "", location.pathname);
  return found ? { url: found[0], hint } : null;
}

/* ---------- price alerts ---------- */
const randomTopic = () => Array.from(crypto.getRandomValues(new Uint8Array(20)), (b) => "abcdefghijklmnopqrstuvwxyz0123456789"[b % 36]).join("");
async function openAlertsDialog() {
  $("alertsBody").innerHTML = "<p>Checking…</p>";
  $("alertsDialog").showModal();
  let enabled = false;
  try { enabled = (await api("/api/alerts/status")).enabled; } catch {}
  const showOn = () => {
    $("alertsBody").innerHTML = "<p><b>Notifications are on.</b> You'll get one on your phone when:</p><ul><li>a price goes down or up by 2% or more, and</li><li>someone ticks <b>I’ll get this</b> on a shared link (or changes their mind).</li></ul>" +
      "<p>Heads up: the “getting this” messages tell whoever has this topic who is buying what. If this list is for someone who shouldn’t find out, only subscribe on your own phone.</p>" +
      "<p>Prices are only checked when you press <b>Refresh prices</b>, unless the daily automatic check is set up.</p>" +
      '<div class="dlg-actions"><button type="button" class="btn" id="alertOff">Turn off</button><button type="button" class="btn btn-violet" id="alertTest">Send a test alert</button></div><p class="status" id="alertMsg" role="status"></p>';
    $("alertTest").onclick = async () => {
      $("alertMsg").classList.remove("error"); $("alertMsg").textContent = "Sending…";
      try { await send("/api/alerts/test", {}); $("alertMsg").textContent = "Sent. Check your phone."; }
      catch (e) { $("alertMsg").classList.add("error"); $("alertMsg").textContent = e.message; }
    };
    $("alertOff").onclick = async () => {
      try {
        const r = await send("/api/alerts/topic", { topic: "" });
        if (r.enabled) { $("alertMsg").classList.add("error"); $("alertMsg").textContent = "This is set on the server, so it can't be turned off here."; }
        else showOff();
      } catch (e) { $("alertMsg").classList.add("error"); $("alertMsg").textContent = e.message; }
    };
  };
  const showOff = () => {
    const topic = randomTopic();
    $("alertsBody").innerHTML = "<p>Get a notification on your phone when a price changes or someone says they’ll get a present. It's free and needs no account.</p><ol>" +
      "<li>Install the free <b>ntfy</b> app on your phone, tap <b>+</b>, and subscribe to this secret topic name:</li>" +
      '<li><div class="copyrow"><input id="topicBox" value="' + esc(topic) + '" aria-label="Secret topic name" maxlength="64"><button type="button" class="btn" id="topicCopy">Copy</button></div></li>' +
      "<li>Press <b>Turn on notifications</b> below, then send yourself a test.</li></ol>" +
      "<p>Keep the topic name private: anyone who knows it can read your alerts. To check prices every day on their own, the daily price check also needs to be switched on.</p>" +
      '<div class="dlg-actions"><button type="button" class="btn btn-violet" id="topicSave">Turn on notifications</button></div><p class="status" id="alertMsg" role="status"></p>';
    $("topicCopy").onclick = async (e) => {
      try { await navigator.clipboard.writeText($("topicBox").value); e.target.textContent = "Copied"; }
      catch { $("topicBox").select(); e.target.textContent = "Press Cmd+C"; }
    };
    $("topicSave").onclick = async () => {
      try { await send("/api/alerts/topic", { topic: $("topicBox").value }); showOn(); }
      catch (e) { $("alertMsg").classList.add("error"); $("alertMsg").textContent = e.message; }
    };
  };
  if (enabled) showOn(); else showOff();
}
$("alertsBtn").onclick = openAlertsDialog;
$("alertsClose").onclick = () => $("alertsDialog").close();

/* ---------- private pages: PIN, family, change PIN ---------- */
let afterSignIn = null; // something to do once the PIN is accepted (e.g. a link that was shared in)

function showLogin() {
  document.body.classList.add("locked");
  if ($("loginDialog").open) return;
  $("loginForm").hidden = false; $("loginMissing").hidden = true;
  $("loginTitle").textContent = $("siteTitle").textContent || "Enter your PIN";
  $("loginError").textContent = ""; $("loginPin").value = "";
  $("loginDialog").showModal();
  $("loginPin").focus();
}
function showMissing() {
  document.body.classList.add("locked");
  $("siteTitle").textContent = "Page not found";
  $("loginForm").hidden = true; $("loginMissing").hidden = false;
  $("loginTitle").textContent = "This page isn't here";
  $("loginDialog").showModal();
}
$("loginDialog").addEventListener("cancel", (e) => e.preventDefault()); // there is nothing to see until the PIN is right
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("loginGo"); btn.disabled = true; $("loginError").textContent = "";
  try {
    await send("/api/space-login", { space: SPACE, pin: $("loginPin").value });
    $("loginDialog").close();
    document.body.classList.remove("locked");
    if (await load() && afterSignIn) { const f = afterSignIn; afterSignIn = null; f(); }
  } catch (err) { $("loginError").textContent = err.message; $("loginPin").select(); }
  btn.disabled = false;
});

$("lockBtn").onclick = async () => { try { await send("/api/space-logout", { space: SPACE }); } catch {} location.reload(); };

$("pinBtn").onclick = () => { $("newPin").value = ""; $("pinError").textContent = ""; $("pinDialog").showModal(); $("newPin").focus(); };
$("pinCancel").onclick = () => $("pinDialog").close();
$("pinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  try { await send("/api/space-pin", { pin: $("newPin").value }); $("pinDialog").close(); say("Your PIN has been changed."); }
  catch (err) { $("pinError").textContent = err.message; }
});

// The owner's page for creating and looking after everyone's pages.
const pageLink = (slug) => location.origin + "/" + slug;
const messageFor = (name, slug, pin) => "Hi " + name + "! Here's your own gift list: " + pageLink(slug) + "\nYour PIN is " + pin + " (you can change it once you're in).";
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text); btn.textContent = "Copied"; }
  catch { btn.textContent = "Press Cmd+C"; window.prompt("Copy this:", text); }
}
function renderPins(rows) {
  const box = $("familyResults");
  if (!rows.length) { box.innerHTML = ""; return; }
  box.innerHTML = "<h3>Send these now</h3><p>The PINs are shown only this once. Copy each message and send it to that person.</p>" +
    rows.map((r, i) => '<div class="pinrow"><div><b>' + esc(r.name) + '</b><br><span class="muted">' + esc(pageLink(r.slug)) + " &middot; PIN <b>" + esc(r.pin) + '</b></span></div>' +
      '<button type="button" class="btn btn-small" data-copy="' + i + '">Copy message</button></div>').join("") +
    '<div class="dlg-actions"><button type="button" class="btn btn-violet" id="copyAll">Copy all messages</button></div>';
  box.querySelectorAll("[data-copy]").forEach((b) => (b.onclick = () => { const r = rows[Number(b.dataset.copy)]; copyText(messageFor(r.name, r.slug, r.pin), b); }));
  $("copyAll").onclick = (e) => copyText(rows.map((r) => messageFor(r.name, r.slug, r.pin)).join("\n\n"), e.target);
}
async function renderFamily() {
  let spaces;
  try { spaces = await api("/api/spaces"); }
  catch (e) {
    $("familyForm").hidden = true; $("familyList").innerHTML = "";
    $("familyError").textContent = e.message; return;
  }
  $("familyForm").hidden = false; $("familyError").textContent = "";
  $("familyList").innerHTML = spaces.length ? "<h3>Pages</h3>" + spaces.map((s) =>
    '<div class="pinrow"><div><b>' + esc(s.name) + '</b><br><span class="muted">' + esc(pageLink(s.slug)) + " &middot; " + s.presents + (s.presents === 1 ? " present" : " presents") + '</span></div>' +
    '<div class="btn-group"><button type="button" class="btn btn-small" data-reset="' + esc(s.slug) + '">New PIN</button>' +
    '<button type="button" class="btn btn-small btn-danger" data-delete="' + esc(s.slug) + '" data-name="' + esc(s.name) + '" data-n="' + s.presents + '">Delete</button></div></div>').join("") : "";
  $("familyList").querySelectorAll("[data-reset]").forEach((b) => (b.onclick = async () => {
    if (!confirm("Make a new PIN? The old one will stop working.")) return;
    try { const r = await send("/api/spaces/" + b.dataset.reset + "/reset-pin", {}); renderPins([r]); } catch (e) { $("familyError").textContent = e.message; }
  }));
  $("familyList").querySelectorAll("[data-delete]").forEach((b) => (b.onclick = async () => {
    const n = Number(b.dataset.n);
    if (!confirm("Delete " + b.dataset.name + "'s page" + (n ? " and all " + n + " presents in it" : "") + "? This can't be undone.")) return;
    try { await api("/api/spaces/" + b.dataset.delete + "?confirm=" + encodeURIComponent(b.dataset.delete), { method: "DELETE" }); renderFamily(); } catch (e) { $("familyError").textContent = e.message; }
  }));
}
$("familyBtn").onclick = () => { $("familyResults").innerHTML = ""; $("familyDialog").showModal(); renderFamily(); };
$("familyClose").onclick = () => $("familyDialog").close();
$("familyForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("familyError").textContent = "";
  try {
    const out = await send("/api/spaces", { names: $("familyNames").value });
    renderPins(out.created);
    await renderFamily();
    if (out.skipped.length) $("familyError").textContent = out.skipped.map((s) => s.name + " " + s.reason).join(". ") + ".";
  } catch (err) { $("familyError").textContent = err.message; }
});

/* ---------- start ---------- */
if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});
$("search").value = "";
$("exportLink").href = "/api/export?space=" + encodeURIComponent(SPACE);

async function boot() {
  const shared = takeSharedLink();
  if (SPACE) {
    $("manifestLink").href = "/api/manifest/" + SPACE;
  }
  let info;
  try { info = await api("/api/space-info"); }
  catch (e) { if (e.status === 404) { showMissing(); return; } info = { name: "Ffi", root: !SPACE }; }
  // The site is always "Present Catalogue"; under it, just the person's name.
  $("whose").textContent = info.name;
  $("whose").hidden = false;
  document.title = info.name + " · Present Catalogue";
  $("appTitle").content = info.name;
  $("bookmarklet").textContent = "Add " + info.name; // the bookmark takes its name from this button
  $("familyBtn").hidden = !!SPACE;
  $("pinBtn").hidden = !SPACE; $("lockBtn").hidden = !SPACE;
  if (shared) afterSignIn = () => addItem({ url: shared.url, hint: shared.hint });
  if (await load() && afterSignIn) { const f = afterSignIn; afterSignIn = null; f(); }
}
boot();
