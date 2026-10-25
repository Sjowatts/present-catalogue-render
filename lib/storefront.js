// Shops choose the currency from where the visitor connects, and this app runs in Frankfurt,
// so many UK shops answer in euros. These helpers ask for the UK storefront instead.

export const BROWSER_HEADERS = {
  "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  "accept": "text/html,application/xhtml+xml",
  "accept-language": "en-GB,en;q=0.9",
  "cache-control": "no-cache",
  "pragma": "no-cache",
  // Shopify's country and currency cookies; other platforms ignore them.
  "cookie": "localization=GB; cart_currency=GBP"
};

export const looksLikeShopify = (html) => /cdn\.shopify\.com|myshopify\.com|Shopify\.(?:theme|shop|locale)\b|shopifyPaymentsEnabled/.test(html || "");

// Shopify Markets also honours ?country=GB, which sets the market for the request.
export function withCountryGB(url) {
  const u = new URL(url);
  u.searchParams.set("country", "GB");
  return u.href;
}
