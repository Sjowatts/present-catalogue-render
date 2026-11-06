// Integration tests (need DATABASE_URL): shops that refuse automatic reading, and details sent from the browser.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasDb = !!process.env.DATABASE_URL;

async function startServer(port, extraEnv = {}) {
  const child = spawn("node", ["app.js"], { cwd: root, env: { ...process.env, PORT: String(port), ...extraEnv }, stdio: "ignore" });
  const base = "http://localhost:" + port;
  for (let i = 0; i < 60; i++) {
    try { if ((await (await fetch(base + "/healthz")).json()).db) return { base, stop: () => child.kill() }; } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  child.kill();
  throw new Error("server did not start");
}
const post = (base, p, body) => fetch(base + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body ?? {}) });
const listen = (srv) => new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv.address().port)));
const del = (base, id) => fetch(base + "/api/items/" + id, { method: "DELETE" });

const AKAMAI = "<HTML><HEAD>\n<TITLE>Access Denied</TITLE>\n</HEAD><BODY>\n<H1>Access Denied</H1>\nYou don't have permission to access this server.<P>Reference #18.1b291eb8</P>\n</BODY></HTML>";
// mode: "403" refuses with an Akamai-style page; "200-denied" answers 200 with the same page; "ok" is a normal shop.
function shop(mode, state) {
  return http.createServer((req, res) => {
    state.hits += 1;
    res.setHeader("content-type", "text/html");
    if (mode === "403") { res.statusCode = 403; return res.end(AKAMAI); }
    if (mode === "200-denied") return res.end(AKAMAI.replace("</HEAD>", '<meta property="og:image" content="https://errors.example/block.png"></HEAD>'));
    res.end("<html><head><title>Real Jumper</title>" +
      '<meta property="og:image" content="https://img.example/real.jpg">' +
      '<script type="application/ld+json">' + JSON.stringify({ "@type": "Product", name: "Real Jumper", offers: { "@type": "Offer", price: "50", priceCurrency: "GBP" } }) +
      "</script></head><body><h1>Real Jumper</h1></body></html>");
  });
}
const link = (port, slug) => `http://127.0.0.1:${port}/products/${slug}-${Date.now().toString(36)}`;

test("a shop that refuses us: no error page is saved, the name comes from the link, and we say so", { skip: !hasDb }, async (t) => {
  const s = await startServer(3230);
  t.after(s.stop);
  for (const mode of ["403", "200-denied"]) {
    const state = { hits: 0 };
    const srv = shop(mode, state), port = await listen(srv);
    t.after(() => srv.close());
    const item = await (await post(s.base, "/api/add", { url: link(port, "goose-knitted-stripe-jumper") })).json();
    assert.match(item.title, /^Goose knitted stripe jumper/, mode);
    assert.doesNotMatch(JSON.stringify(item), /Access Denied|errors\.example/i, mode);
    assert.equal(item.price_value, null);
    assert.equal(item.image, null);
    assert.equal(item.source, "blocked");
    assert.deepEqual(item.lookup, { unread: true, blocked: true });
    await del(s.base, item.id);
  }
});

test("details sent from your own browser are used, and complete ones skip the shop", { skip: !hasDb }, async (t) => {
  const s = await startServer(3231);
  t.after(s.stop);
  const state = { hits: 0 };
  const srv = shop("403", state), port = await listen(srv);
  t.after(() => srv.close());

  const full = await (await post(s.base, "/api/add", { url: link(port, "full"), hint: { title: "Goose Knitted Stripe Jumper", price: "£70.00", currency: "GBP", image: "https://img.example/goose.jpg", description: "Soft and warm" } })).json();
  assert.equal(full.title, "Goose Knitted Stripe Jumper");
  assert.equal(Number(full.price_value), 70);
  assert.equal(full.image, "https://img.example/goose.jpg");
  assert.equal(full.description, "Soft and warm");
  assert.equal(full.source, "browser");
  assert.equal(full.lookup.unread, false);
  assert.equal(state.hits, 0); // nothing was asked of the shop

  const partial = await (await post(s.base, "/api/add", { url: link(port, "partial"), hint: { title: "Only a name" } })).json();
  assert.equal(partial.title, "Only a name");
  assert.equal(partial.price_value, null);
  assert.equal(partial.source, "browser");
  assert.equal(partial.lookup.blocked, false); // we did get something, so it isn't reported as a refusal
  assert.ok(state.hits >= 1);

  // odd details are dropped, not trusted
  const odd = await (await post(s.base, "/api/add", { url: link(port, "odd-lamp-shade"), hint: { title: "Access Denied", image: "javascript:alert(1)", price: "abc" } })).json();
  assert.match(odd.title, /^Odd lamp shade/);
  assert.equal(odd.image, null);
  assert.equal(odd.price_value, null);
  assert.equal(odd.source, "blocked");

  for (const i of [full, partial, odd]) await del(s.base, i.id);
});

test("a normal shop still works, and the browser's details win over what the server read", { skip: !hasDb }, async (t) => {
  const s = await startServer(3232);
  t.after(s.stop);
  const state = { hits: 0 };
  const srv = shop("ok", state), port = await listen(srv);
  t.after(() => srv.close());

  const plain = await (await post(s.base, "/api/add", { url: link(port, "plain") })).json();
  assert.equal(plain.title, "Real Jumper");
  assert.equal(Number(plain.price_value), 50);
  assert.equal(plain.image, "https://img.example/real.jpg");
  assert.equal(plain.source, "heuristics");
  assert.deepEqual(plain.lookup, { unread: false, blocked: false });

  const hinted = await (await post(s.base, "/api/add", { url: link(port, "hinted"), hint: { price: 40 } })).json();
  assert.equal(Number(hinted.price_value), 40); // your browser said £40; the shop page says £50
  assert.equal(hinted.title, "Real Jumper"); // the rest still comes from the page
  assert.equal(hinted.source, "browser");
  for (const i of [plain, hinted]) await del(s.base, i.id);
});

test("refreshing a shop that refuses leaves everything as it was", { skip: !hasDb }, async (t) => {
  const s = await startServer(3233);
  t.after(s.stop);
  const state = { hits: 0 };
  const srv = shop("403", state), port = await listen(srv);
  t.after(() => srv.close());
  const item = await (await post(s.base, "/api/add", { url: link(port, "kept"), hint: { title: "My Jumper", price: 70, image: "https://img.example/j.jpg" } })).json();

  await new Promise((r) => setTimeout(r, 1100)); // so a changed timestamp would show
  const again = await (await post(s.base, "/api/refresh/" + item.id, {})).json();
  assert.equal(again.title, "My Jumper");
  assert.equal(Number(again.price_value), 70);
  assert.equal(again.image, "https://img.example/j.jpg");
  assert.equal(again.source, "browser");
  assert.equal(new Date(again.last_checked).getTime(), new Date(item.last_checked).getTime()); // not marked as checked
  assert.deepEqual(again.lookup, { unread: true, blocked: true });
  const history = (await (await fetch(s.base + "/api/items")).json()).find((i) => i.id === item.id).history;
  assert.deepEqual(history.map((h) => h.p), [70]);
  await del(s.base, item.id);
});

import { existsSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
const hasBrowser = (() => { try { return existsSync(process.env.CHROMIUM_PATH || chromium.executablePath()); } catch { return false; } })();

// The page reader used by the bookmarklet and the iPhone Shortcut, run on common product page shapes in a real browser.
test("the page reader understands common product pages", { skip: !hasBrowser }, async (t) => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  t.after(() => browser.close());
  const src = readFileSync(path.join(root, "public", "extract.js"), "utf8");
  const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
  const cases = {
    graph: [`<title>Goose Jumper | Shop</title><meta property="og:image" content="/img/goose.jpg">${ld({ "@graph": [{ "@type": "WebSite", name: "Shop" }, { "@type": ["Product"], name: "Goose Knitted Stripe Jumper", description: "Super-soft.", image: ["/img/goose.jpg"], offers: { "@type": "Offer", price: "70.00", priceCurrency: "GBP" } }] })}`,
      { title: "Goose Knitted Stripe Jumper", image: "https://shop.test/img/goose.jpg", description: "Super-soft.", price: "70.00", currency: "GBP" }],
    group: [`<title>x</title>${ld({ "@type": "ProductGroup", name: "Linen Shirt", offers: { "@type": "AggregateOffer", offers: [{ "@type": "Offer", price: 45.5, priceCurrency: "EUR" }] } })}`,
      { title: "Linen Shirt", image: "", description: "", price: "45.5", currency: "EUR" }],
    low: [`<title>x</title>${ld({ "@type": "Product", name: "Mug", offers: { "@type": "AggregateOffer", lowPrice: "8", priceCurrency: "GBP" } })}`,
      { title: "Mug", image: "", description: "", price: "8", currency: "GBP" }],
    meta: [`<title>Plain Lamp</title><meta property="og:title" content="Plain Lamp, brass"><meta property="og:image" content="https://cdn.example/lamp.png"><meta property="og:description" content="Brass lamp"><meta property="product:price:amount" content="19.99"><meta property="product:price:currency" content="GBP">`,
      { title: "Plain Lamp, brass", image: "https://cdn.example/lamp.png", description: "Brass lamp", price: "19.99", currency: "GBP" }],
    nothing: [`<title>Just a page</title>`, { title: "Just a page", image: "", description: "", price: "", currency: "" }],
    badjson: [`<title>Fallback title</title><script type="application/ld+json">{ not json</script><meta property="product:price:amount" content="5">`,
      { title: "Fallback title", image: "", description: "", price: "5", currency: "" }]
  };
  const page = await browser.newPage();
  await page.route("https://shop.test/**", (r) => r.fulfill({ contentType: "text/html", body: "<html><head></head><body></body></html>" }));
  for (const [name, [head, want]] of Object.entries(cases)) {
    await page.goto("https://shop.test/p/1");
    await page.setContent(`<html><head>${head}</head><body>x</body></html>`);
    await page.evaluate(() => { history.replaceState(null, "", "https://shop.test/p/1"); });
    await page.addScriptTag({ content: src });
    const got = await page.evaluate(() => { const r = ffiExtract(); return { title: r.title, image: r.image, description: r.description, price: r.price, currency: r.currency }; });
    assert.deepEqual(got, want, name);
  }
  // the link it builds carries only what was found, properly encoded
  await page.goto("https://shop.test/p/1");
  await page.setContent(`<html><head><title>Cup &amp; Saucer</title><meta property="product:price:amount" content="12.5"></head></html>`);
  await page.addScriptTag({ content: src });
  const built = new URL(await page.evaluate(() => ffiLink("https://app.example/mum")));
  assert.equal(built.origin + built.pathname, "https://app.example/mum");
  assert.equal(built.searchParams.get("add"), "https://shop.test/p/1");
  assert.equal(built.searchParams.get("t"), "Cup & Saucer");
  assert.equal(built.searchParams.get("p"), "12.5");
  assert.equal(built.searchParams.has("i"), false);
});
