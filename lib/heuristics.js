import * as cheerio from "cheerio";

/* ---------- utilities ---------- */
export function parsePriceString(str) {
  if (!str) return { value: null, currency: null };
  const currencySymbols = { "£":"GBP", "€":"EUR", "$":"USD", "¥":"JPY" };
  let currency = null;

  for (const [sym, iso] of Object.entries(currencySymbols)) if (str.includes(sym)) currency = iso;
  const iso = str.match(/\b(GBP|USD|EUR|JPY)\b/i);
  if (iso) currency = iso[1].toUpperCase();

  const compact = str.replace(/\s/g, "");
  const m = compact.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})|\d+)/);
  if (!m) return { value: null, currency };
  let raw = m[0];

  const hasDec = /[.,]\d{2}$/.test(raw);
  const normalized = hasDec
    ? raw.replace(/[.,](?=.*[.,]\d{2}$)/g, "").replace(/[.,](\d{2})$/, ".$1")
    : raw.replace(/[.,]/g, "");
  const value = Number(normalized);
  if (Number.isNaN(value)) return { value: null, currency };
  return { value, currency };
}

const BAD_CONTEXT = [
  "was","rrp","list price","listprice","previous","orig","original",
  "save","saving","discount","compare at","compareto","strike","strikethrough",
  "per month","/month","month","from","deposit","credit","trade-in","trade in",
  "postage","shipping","delivery","carriage","fee","voucher","coupon"
];

const GOOD_HINTS = [
  "price to pay","price-to-pay","current price","now","deal","our price","you pay","buy it now","total"
];

const looksBad = t => BAD_CONTEXT.some(k => t.includes(k));

function scorePriceContext($, el) {
  const text = $(el).text().toLowerCase();
  const cls = ($(el).attr("class") || "").toLowerCase();
  const id  = ($(el).attr("id") || "").toLowerCase();
  let s = 0;
  GOOD_HINTS.forEach(g => { if (text.includes(g)||cls.includes(g)||id.includes(g)) s += 4; });
  if (looksBad(text)||looksBad(cls)||looksBad(id)) s -= 8;
  if ($(el).closest("s, strike, del, .priceBlockStrikePriceString, .basisPrice").length) s -= 10;
  return s;
}

const metaCurrency = $ =>
  (
    $('meta[itemprop="priceCurrency"]').attr("content") ||
    $('meta[property="product:price:currency"]').attr("content") ||
    $('meta[name="currency"]').attr("content") ||
    ""
  ).toUpperCase() || null;

function bestImage($) {
  return (
    $('meta[property="og:image"]').attr("content") ||
    $('meta[name="twitter:image"]').attr("content") ||
    $("#landingImage").attr("src") ||
    $('img[data-old-hires]').attr("data-old-hires") ||
    $('img.ux-image-carousel-item--image').attr("src") ||
    $('img#icImg').attr("src") ||
    $('img').filter((_,el)=> Number(el.attribs.width||0) >= 300 || Number(el.attribs.height||0) >= 300).first().attr("src") ||
    null
  );
}

function bestDescription($) {
  const c = [
    $('meta[name="description"]').attr("content"),
    $('meta[property="og:description"]').attr("content"),
    $('meta[name="twitter:description"]').attr("content")
  ].filter(Boolean);
  let d = c[0] || "";
  d = d.replace(/\s+/g," ").trim();
  if (d.length > 160) d = d.slice(0,157) + "…";
  return d || null;
}

/* ---------- site-specific ---------- */
const hostFromUrl = url => { try { return new URL(url).hostname.replace(/^www\./,""); } catch { return ""; } };

// AMAZON: lock onto “price to pay” blocks; skip RRP/list/struck.
function fromAmazon($) {
  const sel = [
    '#corePrice_feature_div .a-price[data-a-color="price"] .a-offscreen',
    '#apex_desktop .a-price[data-a-color="price"] .a-offscreen',
    '#apex_desktop_renewed .a-price[data-a-color="price"] .a-offscreen',
    '#corePrice_feature_div .a-section .a-price .a-offscreen',
    '#priceblock_dealprice', '#priceblock_ourprice', '#priceblock_saleprice'
  ];
  for (const s of sel) {
    const $el = $(s).first();
    if (!$el.length) continue;
    if ($el.closest('s, strike, del, .priceBlockStrikePriceString, .basisPrice').length) continue;
    const t = $el.text() || $el.attr("content"); if (!t) continue;
    const tl = t.toLowerCase();
    if (looksBad(tl) || tl.includes("rrp") || tl.includes("list")) continue;
    const { value, currency } = parsePriceString(t);
    if (value != null) return { value, currency, source: "amazon" };
  }
  // Fallback: buybox “Price: £xx.xx”
  const label = $('#corePrice_feature_div').text().toLowerCase();
  if (label.includes("price")) {
    const t = $('#corePrice_feature_div .a-price .a-offscreen').first().text();
    const { value, currency } = parsePriceString(t);
    if (value != null) return { value, currency, source: "amazon-fallback" };
  }
  return null;
}

function fromEbay($) {
  const sel = ["#prcIsum","#mm-saleDscPrc","span.x-price-primary .ux-textspans",'span[itemprop="price"]'];
  for (const s of sel) {
    const t = $(s).first().text() || $(s).first().attr("content");
    if (!t) continue;
    if (looksBad(String(t).toLowerCase())) continue;
    const { value, currency } = parsePriceString(t);
    if (value != null) return { value, currency, source: "ebay" };
  }
  return null;
}

/* ---------- main ---------- */
export function scrapeWithHeuristics(html, url = "") {
  const $ = cheerio.load(html);
  const host = hostFromUrl(url);

  let title =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("h1").first().text() ||
    $("title").text() || null;

  const candidates = [];
  const pushCand = (el, text, source) => {
    const t = (text || "").trim(); if (!t) return;
    const tl = t.toLowerCase();     if (looksBad(tl)) return;
    if ($(el).closest("s, strike, del, .priceBlockStrikePriceString, .basisPrice").length) return;
    const { value, currency } = parsePriceString(t);
    if (value != null) candidates.push({ value, currency, score: scorePriceContext($, el), source });
  };

  // Generic selectors
  const selPool = [
    "[itemprop='price']", "meta[itemprop='price']",
    "meta[property='product:price:amount']",
    ".a-price .a-offscreen",
    ".price, .current-price, .price__current, .price-now, .now-price, .sale-price, .product-price__price",
    "#price, #ourprice, #dealprice, #priceblock_ourprice, #priceblock_dealprice",
    "span.x-price-primary .ux-textspans, #prcIsum, #mm-saleDscPrc"
  ];
  for (const sel of selPool) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const text = el.tagName?.toLowerCase() === "meta" ? ($el.attr("content") || "") : $el.text();
      pushCand(el, text, sel);
    });
  }

  // JSON-LD Product is highly reliable; prefer it strongly
  const currMeta = metaCurrency($);
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(data) ? data : (data["@graph"] || [data]);
      for (const node of nodes) {
        const types = node && (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]);
        if (!types || !types.includes("Product")) continue;
        title = title || node.name || title;
        let offers = node.offers;
        if (Array.isArray(offers)) offers = offers[0];
        if (offers) {
          const p = offers.price ?? offers.priceSpecification?.price ?? offers.lowPrice ?? offers.highPrice;
          const c = (offers.priceCurrency ?? offers.priceSpecification?.priceCurrency ?? currMeta) || null;
          if (p != null) candidates.push({ value: Number(p), currency: c, score: 120, source: "jsonld" });
        }
      }
    } catch {}
  });

  // Site-specific (highest trust)
  if (host.includes("amazon.")) {
    const pick = fromAmazon($);
    if (pick) candidates.push({ ...pick, score: 140 });
  } else if (host.includes("ebay.")) {
    const pick = fromEbay($);
    if (pick) candidates.push({ ...pick, score: 130 });
  }

  let priceValue = null, priceCurrency = null;
  if (candidates.length) {
    candidates.sort((a,b) => (b.score - a.score) || (a.value - b.value));
    priceValue = candidates[0].value;
    priceCurrency = candidates[0].currency || currMeta || null;
  }

  const image = bestImage($);
  const description = bestDescription($);
  return { title, image, priceValue, priceCurrency, description };
}
