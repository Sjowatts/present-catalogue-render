import test from "node:test";
import assert from "node:assert/strict";
import { parsePriceString, scrapeWithHeuristics } from "../lib/heuristics.js";

test("parses thousands separators and decimals", () => {
  assert.equal(parsePriceString("£1,299").value, 1299);
  assert.equal(parsePriceString("£2,499").value, 2499);
  assert.equal(parsePriceString("£1,299.00").value, 1299);
  assert.equal(parsePriceString("£12.50").value, 12.5);
  assert.equal(parsePriceString("1.299,00 €").value, 1299);
  assert.equal(parsePriceString("$1,049.99").currency, "USD");
});

test("ignores prices from related-product carousels", () => {
  const html = '<div class="price">£100.00</div><div class="carousel"><span class="price">£9.99</span></div>';
  assert.equal(scrapeWithHeuristics(html, "https://shop.example/x").priceValue, 100);
});

test("reads JSON-LD prices given as strings", () => {
  const html = '<script type="application/ld+json">{"@type":"Product","name":"x","offers":{"@type":"Offer","price":"1,299.00","priceCurrency":"GBP"}}</script>';
  assert.equal(scrapeWithHeuristics(html, "https://a.b/c").priceValue, 1299);
});

test("skips struck-through and 'was' prices", () => {
  const html = '<s class="price">£80.00</s><span class="price">£60.00</span>';
  assert.equal(scrapeWithHeuristics(html, "https://shop.example/x").priceValue, 60);
});
