import * as cheerio from "cheerio";

/* ---------- utilities ---------- */
export function parsePriceString(str) {
  if (!str) return { value: null, currency: null };
  const currencySymbols = { "£":"GBP", "€":"EUR", "$":"USD", "¥":"JPY" };
  let currency = null;

  // symbol or ISO present
  for (const [sym, iso] of Object.entries(currencySymbols)) if (str.includes(sym)) currency = iso;
  const iso = str.match(/\b(GBP|USD|EUR|JPY)\b/i);
  if (iso) currency = iso[1].toUpperCase();

  const compact = str.replace(/\s/g, "");
  const m = compact.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})|\d+)/);
  if (!m) return { value: null, currency };
  let raw = m[0];

  // normalise thousands/decimals
  const hasDec = /[.,]\d{2}$/.test(raw);
  let normalized = hasDec
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
  "postage","shipping","delivery","carriage","fee"
];

function looksBad(textLower) {
  return BAD_CONTEXT.some(k => textLower.includes(k));
}

function scorePriceContext($, el) {
  const text = $(el).text().toLowerCase();
  const cls = ($(el).attr("class") || "").toLowerCase();
  const id  = ($(el).attr("id") || "").toLowerCase();
  let s = 0;
  // good signals
  ["current","now","price","ourprice","deal","you pay","basket","total","buy it now","bin"].forEach(g=>{
    if (text.includes(g) || cls.includes(g) || id.includes(g)) s += 3;
  });
  // bad signals
  if (looksBad(text) || looksBad(cls) || looksBad(id)) s -= 6;
  if ($(el).find("s, strike, del").length) s -= 8;
  if (["button","a","input"].includes(el.tagName)) s -= 3;
  return s;
}

function metaCurrency($) {
  return (
    $('meta[itemprop="priceCurrency"]').attr("content") ||
    $('meta[property="product:price:currency"]').attr("content") ||
    $('meta[name="currency"]').attr("content") ||
    null
  )?.toUpperCase() || null;
}

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

/* ---------- site-specific extractors ---------- */
function hostFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./,""); } catch { return ""; }
}

function fromAmazon($) {
  // deal/our/sale price areas
  const sel = [
    "#corePrice_feature_div .a-price .a-offscreen",
    "#priceblock_dealprice",
    "#priceblock_ourprice",
    "#priceblock_saleprice",
    ".a-price .a-offscreen"
  ];
  for (const s of sel) {
    const t = $(s).first().text() || $(s).first().attr("content");
    if (!t) continue;
    const tl = String(t).toLowerCase();
    if (looksBad(tl) || tl.includes("list")) continue;
    const { value, currency } = parsePriceString(t);
    if (value != null) return { value, currency, source: "amazon" };
  }
  return null;
}

function fromEbay($) {
  const sel = [
    "#prcIsum", "#mm-saleDscPrc",
    "span.x-price-primary .ux-textspans",
    'span[itemprop="price"]'
  ];
  for (const s of sel) {
    const t = $(s).first().text() || $(s).first().attr("content");
    if (!t) continue;
    const tl = String(t).toLowerCase();
    if (looksBad(tl)) continue;
    const { value, currency } = parsePriceString(t);
    if (value != null) return { value, currency, source: "ebay" };
  }
  return null;
}

function fromArgos($) {
  const sel = [
    '[data-test="product-price"]',
    'meta[itemprop="price"]'
  ];
  for (const s of sel) {
    const t = $(s).first().text() || $(s).first().attr("content");
    if (!t) continue;
    const { value, currency } = parsePriceString(t);
    if (value != null) return { value, currency, source: "argos" };
  }
  return null;
}

function fromCurrys($) {
  const sel = [
    'meta[itemprop="price"]',
    '.product-price .amount, .price .amount'
  ];
  for (const s of sel) {
    const t = $(s).first().text() || $(s).first().attr("content");
    if (!t) continue;
    const { value, currency } = parsePriceString(t);
    if (value != null) return { value, currency, source: "currys" };
  }
  return null;
}

function fromJohnLewis($) {
  const sel = [
    'meta[itemprop="price"]',
    '[data-test="price-current"]'
  ];
  for (const s of sel) {
    const t = $(s).first().text() || $(s).first().attr("content");
    if (!t) continue;
    const { value, currency } = parsePriceString(t);
    if (value != null) return { value, currency, source: "johnlewis" };
  }
  return null;
}

/* ---------- main heuristic ---------- */
export function scrapeWithHeuristics(html, url = "") {
  const $ = cheerio.load(html);
  const host = hostFromUrl(url);

  // title
  let title =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("h1").first().text() ||
    $("title").text() || null;

  const candidates = [];
  const pushCand = (el, text, source) => {
    const t = (text || "").trim();
    if (!t || looksBad(t.toLowerCase())) return;
    const { value, currency } = parsePriceString(t);
    if (value != null) candidates.push({ value, currency, score: scorePriceContext($, el), source });
  };

  // common selectors
  const selPool = [
    "[itemprop='price']", "meta[itemprop='price']",
    "meta[property='product:price:amount']",
    ".price, .current-price, .price__current, .price-now, .now-price, .sale-price, .product-price__price",
    "#price, #ourprice, #dealprice, #priceblock_ourprice, #priceblock_dealprice",
    ".a-price .a-offscreen",
    "span.x-price-primary .ux-textspans, #prcIsum, #mm-saleDscPrc"
  ];
  for (const sel of selPool) {
    $(sel).each((_, el) => {
      const $el = $(el);
      const text = el.tagName?.toLowerCase() === "meta" ? ($el.attr("content") || "") : $el.text();
      pushCand(el, text, sel);
    });
  }
  $("[class*='price'], [id*='price']").each((_, el) => pushCand(el, $(el).text(), "near:price"));

  // JSON-LD Product
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
          if (p != null) candidates.push({ value: Number(p), currency: c, score: 80, source: "jsonld" });
        }
      }
    } catch {}
  });

  // site-specific last (highest trust if present)
  let sitePick = null;
  if (host.includes("amazon.")) sitePick = fromAmazon($);
  else if (host.includes("ebay.")) sitePick = fromEbay($);
  else if (host.includes("argos.")) sitePick = fromArgos($);
  else if (host.includes("currys.")) sitePick = fromCurrys($);
  else if (host.includes("johnlewis.")) sitePick = fromJohnLewis($);
  if (sitePick) candidates.push({ ...sitePick, score: 100 });

  // choose best
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
