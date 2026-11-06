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
