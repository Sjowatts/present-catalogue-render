import * as cheerio from "cheerio";

/** Robust price parsing: handles 1,234.56 / 1.234,56 / 1234 */
export function parsePriceString(str) {
  if (!str) return { value: null, currency: null };
  const currencySymbols = { "£":"GBP", "€":"EUR", "$":"USD", "¥":"JPY" };
  let currency = null;

  for (const [sym, iso] of Object.entries(currencySymbols)) {
    if (str.includes(sym)) currency = iso;
  }
  const isoMatch = str.match(/\b(GBP|USD|EUR|JPY)\b/i);
  if (isoMatch) currency = isoMatch[1].toUpperCase();

  const compact = str.replace(/\s/g, "");
  const m = compact.match(/(\d{1,3}(?:[.,]\d{3})*(?:[.,]\d{2})|\d+(?:[.,]\d{2})|\d+)/);
  if (!m) return { value:null, currency };
  let raw = m[0];

  const hasDecimal = /[.,]\d{2}$/.test(raw);
  let normalized = hasDecimal
    ? raw.replace(/[.,](?=.*[.,]\d{2}$)/g, "").replace(/[.,](\d{2})$/, ".$1")
    : raw.replace(/[.,]/g, "");
  const value = Number(normalized);
  if (Number.isNaN(value)) return { value:null, currency };
  return { value, currency };
}

/** Prefer current price, down-rank "was/rrp" etc. */
function scorePriceContext($, el) {
  const cls = ($(el).attr("class") || "").toLowerCase();
  const id  = ($(el).attr("id") || "").toLowerCase();
  const txt = $(el).text().toLowerCase();
  let s = 0;
  const good = ["current","now","price","ourprice","deal","you pay","total","buy it now","bin"];
  const bad  = ["was","rrp","strike","old","previous","save","discount","orig","list","compare"];
  good.forEach(g => { if (cls.includes(g) || id.includes(g) || txt.includes(g)) s += 2; });
  bad.forEach(b  => { if (cls.includes(b) || id.includes(b) || txt.includes(b)) s -= 3; });
  if ($(el).find("s, strike, del").length) s -= 5; // crossed-out
  if (["button","a","input"].includes(el.tagName)) s -= 2;
  return s;
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
  const cands = [
    $('meta[name="description"]').attr("content"),
    $('meta[property="og:description"]').attr("content"),
    $('meta[name="twitter:description"]').attr("content")
  ].filter(Boolean);
  let desc = cands[0] || "";
  desc = desc.replace(/\s+/g, " ").trim();
  if (desc.length > 160) desc = desc.slice(0,157) + "…";
  return desc || null;
}

export function scrapeWithHeuristics(html, url = "") {
  const $ = cheerio.load(html);

  // Title
  let title =
    $('meta[property="og:title"]').attr("content") ||
    $('meta[name="twitter:title"]').attr("content") ||
    $("h1").first().text() ||
    $("title").text() || null;

  const candidates = [];
  const pushCand = (el, text, source) => {
    const { value, currency } = parsePriceString(text || "");
    if (value != null) candidates.push({ value, currency, score: scorePriceContext($, el), source });
  };

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

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).contents().text());
      const nodes = Array.isArray(data) ? data : (data["@graph"] || [data]);
      for (const node of nodes) {
        const types = node && (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]);
        if (types && types.includes("Product")) {
          title = title || node.name || title;
          let offers = node.offers;
          if (Array.isArray(offers)) offers = offers[0];
          if (offers) {
            const p = offers.price ?? offers.priceSpecification?.price ?? offers.lowPrice ?? offers.highPrice;
            const c = offers.priceCurrency ?? offers.priceSpecification?.priceCurrency;
            if (p != null) candidates.push({ value: Number(p), currency: c || null, score: 50, source: "jsonld" });
          }
        }
      }
    } catch {}
  });

  let priceValue = null, priceCurrency = null;
  if (candidates.length) {
    candidates.sort((a,b) => (b.score - a.score) || (a.value - b.value));
    priceValue   = candidates[0].value;
    priceCurrency= candidates[0].currency || null;
  }

  const image = bestImage($);
  const description = bestDescription($);

  return { title, image, priceValue, priceCurrency, description };
}
