import test from "node:test";
import assert from "node:assert/strict";
import {
  slugify, uniqueSlug, isUsableSlug, possessive, generatePin, hashPin, verifyPin,
  signToken, verifyToken, parseCookies, makeRateLimiter, parseNames
} from "../lib/spaces.js";

test("slugify and unique addresses", () => {
  assert.equal(slugify("Mum"), "mum");
  assert.equal(slugify("Grandad Izzy"), "grandad-izzy");
  assert.equal(slugify("Zoë O'Neil"), "zoe-o-neil");
  assert.equal(slugify("  --Ben--  "), "ben");
  assert.equal(slugify("!!!"), "");
  const taken = new Set(["mum"]);
  assert.equal(uniqueSlug("Dad", taken), "dad");
  assert.equal(uniqueSlug("Mum", taken), "mum-2");
  assert.equal(uniqueSlug("API", new Set()), "api-2"); // reserved words are never used as-is
  assert.equal(uniqueSlug("Q", new Set()), "p-q");
  assert.ok(isUsableSlug("owain") && !isUsableSlug("s") && !isUsableSlug("healthz") && !isUsableSlug("Mum") && !isUsableSlug("a"));
  assert.ok(uniqueSlug("x".repeat(80), new Set()).length <= 30);
});

test("possessive names", () => {
  assert.equal(possessive("Mum"), "Mum's");
  assert.equal(possessive("Chris"), "Chris'");
});

test("pins are 6 digits and checked with a salted hash", () => {
  for (let i = 0; i < 50; i++) assert.match(generatePin(), /^\d{6}$/);
  const h = hashPin("123456");
  assert.notEqual(h, hashPin("123456")); // salted
  assert.ok(verifyPin("123456", h));
  assert.ok(!verifyPin("123457", h));
  assert.ok(!verifyPin("", h));
  assert.ok(!verifyPin("123456", null));
  assert.ok(!verifyPin("123456", "plain"));
});

test("session tokens can't be forged and expire", () => {
  const t = signToken("secret-a", "mum", 1000, 5000);
  assert.equal(verifyToken("secret-a", t, 5500), "mum");
  assert.equal(verifyToken("secret-a", t, 6001), null); // expired
  assert.equal(verifyToken("secret-b", t, 5500), null); // another secret
  const [body, sig] = t.split(".");
  const forged = Buffer.from("dad." + 999999999).toString("base64url") + "." + sig;
  assert.equal(verifyToken("secret-a", forged, 5500), null);
  assert.equal(verifyToken("secret-a", "", 5500), null);
  assert.equal(verifyToken("secret-a", "garbage", 5500), null);
  assert.equal(verifyToken("secret-a", body, 5500), null);
});

test("cookie parsing", () => {
  assert.deepEqual(parseCookies("a=1; ffi_mum=abc.def; b=x%20y"), { a: "1", ffi_mum: "abc.def", b: "x y" });
  assert.deepEqual(parseCookies(undefined), {});
});

test("rate limiter", () => {
  const rl = makeRateLimiter({ max: 3, windowMs: 1000 });
  assert.ok(rl.hit("k", 0).ok && rl.hit("k", 1).ok && rl.hit("k", 2).ok);
  const blocked = rl.hit("k", 3);
  assert.equal(blocked.ok, false);
  assert.ok(blocked.retryAfterMs > 0);
  assert.ok(rl.hit("other", 3).ok);
  assert.ok(rl.hit("k", 1001).ok); // window passed
  rl.reset("k");
  assert.ok(rl.hit("k", 1002).ok);
});

test("parseNames splits on lines and commas, trims and drops repeats", () => {
  assert.deepEqual(parseNames("Mum, Dad\nGrandma;  Mum ,, Ben "), ["Mum", "Dad", "Grandma", "Ben"]);
  assert.deepEqual(parseNames(["A", " a ", "B"]), ["A", "B"]);
  assert.deepEqual(parseNames(""), []);
  assert.equal(parseNames("x".repeat(100))[0].length, 40);
});
