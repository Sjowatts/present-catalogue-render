// Reads a product's name, picture, description and price from the page you are looking at, in YOUR browser,
// and builds a link back to this app. It is used by the bookmarklet and the iPhone Shortcut, so the two
// functions below must stay self-contained (no outside variables, no comments inside them).
function ffiExtract() {
  var d = document;
  function meta(names) {
    for (var i = 0; i < names.length; i++) {
      var e = d.querySelector('meta[property="' + names[i] + '"],meta[name="' + names[i] + '"],meta[itemprop="' + names[i] + '"]');
      if (e && e.getAttribute("content")) return e.getAttribute("content");
    }
    return "";
  }
  function nodes(x, out) {
    if (!x || typeof x !== "object") return out;
    if (Array.isArray(x)) { for (var i = 0; i < x.length; i++) nodes(x[i], out); return out; }
    out.push(x);
    if (x["@graph"]) nodes(x["@graph"], out);
    return out;
  }
  function isType(n, t) { var ty = n["@type"]; return ty === t || (Array.isArray(ty) && ty.indexOf(t) >= 0); }
  var product = null, offer = null;
  var blocks = d.querySelectorAll('script[type="application/ld+json"]');
  for (var b = 0; b < blocks.length && !offer; b++) {
    try {
      var list = nodes(JSON.parse(blocks[b].textContent), []);
      for (var k = 0; k < list.length && !offer; k++) {
        if (isType(list[k], "Product") || isType(list[k], "ProductGroup")) {
          product = product || list[k];
          var o = list[k].offers;
          if (Array.isArray(o)) o = o[0];
          if (o && o.offers) o = Array.isArray(o.offers) ? o.offers[0] : o.offers;
          if (o && (o.price != null || o.lowPrice != null)) offer = o;
        }
      }
    } catch (e) {}
  }
  var title = (product && product.name) || meta(["og:title", "twitter:title"]) || d.title || "";
  var image = (product && (Array.isArray(product.image) ? product.image[0] : product.image)) || meta(["og:image", "twitter:image"]);
  if (image && typeof image === "object") image = image.url || "";
  try { if (image) image = new URL(image, location.href).href; } catch (e) {}
  var description = (product && product.description) || meta(["og:description", "description"]);
  var price = "", currency = "";
  if (offer) { price = offer.price != null ? offer.price : offer.lowPrice; currency = offer.priceCurrency || ""; }
  if (price === "") {
    price = meta(["product:price:amount", "og:price:amount", "price"]);
    currency = currency || meta(["product:price:currency", "og:price:currency", "priceCurrency"]);
  }
  function cut(s, n) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n); }
  return { url: location.href, title: cut(title, 200), image: cut(image, 800), description: cut(description, 200), price: cut(price, 20), currency: cut(currency, 3) };
}

function ffiLink(base) {
  var r = ffiExtract(), q = [];
  function a(k, v) { if (v) q.push(k + "=" + encodeURIComponent(v)); }
  a("add", r.url); a("t", r.title); a("i", r.image); a("d", r.description); a("p", r.price); a("c", r.currency);
  return base + "?" + q.join("&");
}

// Reads a whole Amazon wishlist in YOUR browser (Amazon doesn't let this site read it), scrolling to load every
// present first, then puts the list on your clipboard to paste into the app. Used by the "Copy wishlist"
// bookmark, so it must stay self-contained (no outside variables, no comments inside it).
function ffiWishlist() {
  var d = document, w = window;
  var bar = d.createElement("div");
  bar.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:16px;transform:translateX(-50%);max-width:90vw;padding:14px 20px;border-radius:12px;background:#15171c;color:#f2f2f2;font:600 15px/1.4 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.45);border:1px solid #c8a96a";
  d.body.appendChild(bar);
  function say(t) { bar.textContent = t; }
  function cut(s, n) { return String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, n); }
  function currencyOf(text) {
    var t = String(text || "");
    if (t.indexOf("£") >= 0) return "GBP";
    if (t.indexOf("€") >= 0) return "EUR";
    if (t.indexOf("$") >= 0) return /\.com\.au$/.test(location.hostname) ? "AUD" : /\.ca$/.test(location.hostname) ? "CAD" : "USD";
    var h = location.hostname;
    if (/\.co\.uk$/.test(h)) return "GBP";
    if (/\.(de|fr|it|es|nl|ie)$/.test(h)) return "EUR";
    return "";
  }
  function collect() {
    var rows = d.querySelectorAll("#g-items > li, ul#g-items li[data-itemid], li[data-itemid], li.g-item-sheet");
    var out = [], seen = {};
    for (var i = 0; i < rows.length; i++) {
      var li = rows[i];
      var a = li.querySelector('a[id^="itemName_"]') || li.querySelector('a[href*="/dp/"]');
      if (!a) continue;
      var href;
      try { href = new URL(a.getAttribute("href"), location.href).href; } catch (e) { continue; }
      var m = href.match(/\/dp\/([A-Z0-9]{10})/i);
      var key = m ? m[1].toUpperCase() : href;
      if (seen[key]) continue;
      seen[key] = 1;
      var priceText = "";
      var off = li.querySelector(".a-price .a-offscreen, [id^='itemPrice_'] .a-offscreen");
      if (off) priceText = off.textContent;
      var dp = li.getAttribute("data-price");
      var price = cut(priceText, 24);
      if (!price && dp && /^[0-9.]+$/.test(dp)) price = dp;
      var img = li.querySelector("img");
      var src = img ? (img.getAttribute("src") || "") : "";
      if (src.indexOf("data:") === 0) src = "";
      out.push({ url: href, title: cut(a.getAttribute("title") || a.textContent || (img && img.alt), 200), image: cut(src, 800), price: price, currency: currencyOf(priceText) });
    }
    return out;
  }
  function finish() {
    var items = collect();
    if (!items.length) { say("Couldn't find any presents on this page. Open the wishlist itself and try again."); setTimeout(function () { bar.remove(); }, 6000); return; }
    var nameEl = d.querySelector("#profile-list-name");
    var name = cut(nameEl ? nameEl.textContent : d.title.replace(/^Amazon[^:]*:\s*/i, ""), 60);
    var text = "FFI-WISHLIST:" + JSON.stringify({ name: name, items: items });
    function done() { say("Copied " + items.length + " presents. Now go back to Present Catalogue and paste."); setTimeout(function () { bar.remove(); }, 9000); }
    function fallback() { bar.remove(); w.prompt("Copy this (Ctrl+C or Cmd+C), then paste it into Present Catalogue:", text); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  var last = -1, same = 0, rounds = 0;
  function step() {
    var n = d.querySelectorAll("#g-items > li, li[data-itemid], li.g-item-sheet").length;
    say("Reading your wishlist… " + n + " found so far. Please wait.");
    var h = d.documentElement.scrollHeight;
    w.scrollTo(0, Math.max(0, h - 1500));
    setTimeout(function () { w.scrollTo(0, d.documentElement.scrollHeight); }, 250);
    same = (n === last) ? same + 1 : 0;
    last = n;
    rounds++;
    if (same >= 3 || rounds > 120) { w.scrollTo(0, 0); finish(); } else setTimeout(step, 1100);
  }
  step();
}
