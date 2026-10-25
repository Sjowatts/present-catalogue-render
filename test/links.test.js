import test from "node:test";
import assert from "node:assert/strict";
import { extractUrl, cleanUrl, urlKey } from "../lib/links.js";

test("extractUrl finds the link in shared text", () => {
  assert.equal(extractUrl("Look at this https://shop.example/p/1?x=1 so nice!"), "https://shop.example/p/1?x=1");
  assert.equal(extractUrl("(https://shop.example/p/1)."), "https://shop.example/p/1");
  assert.equal(extractUrl("www.shop.example/p/1"), "https://www.shop.example/p/1");
  assert.equal(extractUrl("shop.example/p/1 lovely"), "https://shop.example/p/1");
  assert.equal(extractUrl("no link here"), null);
  assert.equal(extractUrl(""), null);
  assert.equal(extractUrl(null), null);
});

test("cleanUrl drops tracking junk but keeps product options", () => {
  assert.equal(
    cleanUrl("https://shop.example/products/jumper?utm_source=ig&utm_medium=social&variant=123&fbclid=abc&colour=blue#reviews"),
    "https://shop.example/products/jumper?variant=123&colour=blue");
  assert.equal(cleanUrl("https://shop.example/p/1?gclid=1&srsltid=2&_ga=3"), "https://shop.example/p/1");
  assert.equal(cleanUrl("https://shop.example/p/1?tag=gifts&size=M"), "https://shop.example/p/1?tag=gifts&size=M");
  assert.equal(cleanUrl("not a url"), "not a url");
});

test("cleanUrl shortens Amazon links to /dp/ASIN", () => {
  assert.equal(
    cleanUrl("https://www.amazon.co.uk/Some-Long-Product-Name/dp/B08N5WRWNW/ref=sr_1_3?crid=XYZ&keywords=a&qid=1&sr=8-3&th=1"),
    "https://www.amazon.co.uk/dp/B08N5WRWNW");
  assert.equal(cleanUrl("https://www.amazon.com/gp/product/b08n5wrwnw?psc=1"), "https://www.amazon.com/dp/B08N5WRWNW");
});

test("urlKey treats the same product the same", () => {
  const a = urlKey("https://www.shop.example/products/jumper/?utm_source=x&b=2&a=1");
  const b = urlKey("https://shop.example/products/jumper?a=1&b=2#top");
  assert.equal(a, b);
  assert.notEqual(a, urlKey("https://shop.example/products/jumper?a=1&b=3"));
  assert.notEqual(urlKey("https://shop.example/a"), urlKey("https://shop.example/b"));
  assert.equal(urlKey("garbage"), "");
  assert.equal(
    urlKey("https://www.amazon.co.uk/x/dp/B08N5WRWNW/ref=abc"),
    urlKey("https://amazon.co.uk/dp/B08N5WRWNW?th=1"));
});
