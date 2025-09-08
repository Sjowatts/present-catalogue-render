import * as cheerio from "cheerio";

export const parsePriceString = (str) => {
  if (!str) return { value: null, currency: null };
  const currencySymbols = { "£": "GBP", "€": "EUR", "$": "USD", "¥": "JPY" };
  let currency = null;
  for (const sym of Object.keys(currencySymbols)) {
    if (str.includes(sym)) { currency = currencySymbols[sym]; break; }
  }
  const match = str.replace(/\s/g, "").match(/(\d+[.,]?\d*)/);
  if (!match) return { value: null, currency };
  const value = Number(match[0].replace(",", "."));
  return { value, currency };
};

export function scrapeWithHeuristics(html) {
  const $ = cheerio.load(html);
  let title = $("title").text() || null;
  let image = $('meta[property="og:image"]').attr("content") || null;
  let priceValue = null, priceCurrency = null;

  $('[class*="price"],[id*="price"]').each((_, el) => {
    const { value, currency } = parsePriceString($(el).text());
    if (value != null) { priceValue = value; priceCurrency = currency; }
  });

  return { title, image, priceValue, priceCurrency };
}
