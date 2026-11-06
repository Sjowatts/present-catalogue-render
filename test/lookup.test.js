import test from "node:test";
import assert from "node:assert/strict";
import { looksBlocked, titleFromUrl, cleanHint } from "../lib/lookup.js";

test("block pages are recognised", () => {
  assert.equal(looksBlocked(403, "Anything"), true);
  assert.equal(looksBlocked(429, ""), true);
  assert.equal(looksBlocked(200, "Access Denied"), true);
  assert.equal(looksBlocked(200, "Just a moment..."), true);
  assert.equal(looksBlocked(200, "Attention Required! | Cloudflare"), true);
  assert.equal(looksBlocked(200, "Are you a robot?"), true);
  assert.equal(looksBlocked(200, "Goose Knitted Stripe Jumper - Denim Blue"), false);
  assert.equal(looksBlocked(200, "Access to Fresh Food | Shop"), false);
  assert.equal(looksBlocked(200, ""), false);
  assert.equal(looksBlocked(404, "Not found"), false);
});

test("a readable name is made from the link", () => {
  assert.equal(titleFromUrl("https://shop.example/products/goose-knitted-stripe-jumper-denim-blue"), "Goose knitted stripe jumper denim blue");
  assert.equal(titleFromUrl("https://www.shop.example/fashion/brown-pink-striped-frill-sleeve-t-shirt-409906"), "Brown pink striped frill sleeve t shirt 409906");
  assert.equal(titleFromUrl("https://www.fatface.com/e00398s1"), "fatface.com item");
  assert.equal(titleFromUrl("https://www.shop.example/"), "shop.example item");
  assert.equal(titleFromUrl("https://shop.example/p/some_nice_lamp.html"), "Some nice lamp");
  assert.equal(titleFromUrl("not a link"), "New present");
});

test("details from the browser are checked before use", () => {
  assert.deepEqual(cleanHint({ title: "  Wool   Jumper ", image: "https://img.example/a.jpg", description: "Soft", price: "£1,299.00", currency: "gbp" }),
    { title: "Wool Jumper", image: "https://img.example/a.jpg", description: "Soft", price: 1299, currency: "GBP" });
  assert.deepEqual(cleanHint({ image: "javascript:alert(1)", price: "abc", currency: "pounds" }), {});
  assert.deepEqual(cleanHint({ title: "Access Denied" }), {});
  assert.deepEqual(cleanHint({ price: 12.5 }), { price: 12.5 });
  assert.deepEqual(cleanHint({ price: -3 }), {});
  assert.deepEqual(cleanHint({ price: "" }), {});
  assert.deepEqual(cleanHint(null), {});
  assert.deepEqual(cleanHint("text"), {});
  assert.equal(cleanHint({ title: "x".repeat(500) }).title.length, 200);
});
