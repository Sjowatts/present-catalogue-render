// The "Copy wishlist" bookmark, run in a real browser against a page shaped like an Amazon wishlist.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const chromePath = process.env.CHROMIUM_PATH;
let chromium = null;
try { ({ chromium } = await import("playwright")); } catch {}
const canRun = !!(chromium && chromePath && fs.existsSync(chromePath));

const li = (i, more = "") => `
  <li data-id="id${i}" data-itemid="id${i}" data-price="${more ? "-Infinity" : i * 10 + 0.99}" class="g-item-sheet">
    <img src="https://m.media-amazon.com/images/I/img${i}.jpg" alt="pic ${i}">
    <h2><a id="itemName_id${i}" title="Product number ${i}" href="/dp/B0ABCDE${String(i).padStart(3, "0")}/?coliid=X&amp;colid=Y">Product number ${i}</a></h2>
    ${more || `<span id="itemPrice_id${i}" class="a-price"><span class="a-offscreen">£${i * 10}.99</span></span>`}
  </li>`;

test("Copy wishlist reads every item, even ones that load as you scroll", { skip: !canRun }, async (t) => {
  const browser = await chromium.launch({ executablePath: chromePath });
  t.after(() => browser.close());
  const page = await (await browser.newContext()).newPage();
  await page.route("https://www.amazon.co.uk/**", (r) => r.fulfill({ contentType: "text/html; charset=utf-8", body: `<html><head><title>Amazon.co.uk: Owain's list</title></head><body>
    <span id="profile-list-name">Owain's list</span><ul id="g-items">${li(1)}${li(2, "<span>Currently unavailable</span>")}</ul>
    <script>
      let n = 2; const ul = document.getElementById("g-items");
      const make = (i) => '<li data-itemid="id' + i + '" class="g-item-sheet"><img src="https://m.media-amazon.com/images/I/img' + i + '.jpg"><a id="itemName_id' + i + '" title="Product number ' + i + '" href="/dp/B0ABCDE' + String(i).padStart(3, "0") + '/">x</a><span class="a-price"><span class="a-offscreen">\u00a3' + i + '0.99</span></span></li>';
      window.addEventListener("scroll", () => { if (n < 6) { n++; ul.insertAdjacentHTML("beforeend", make(n)); } });
      document.body.style.minHeight = "4000px";
    </script></body></html>` }));
  await page.goto("https://www.amazon.co.uk/hz/wishlist/ls/ABC");
  let copied = "";
  await page.exposeFunction("__copied", (x) => { copied = x; });
  await page.evaluate(() => { Object.defineProperty(navigator, "clipboard", { value: { writeText: (x) => { window.__copied(x); return Promise.resolve(); } } }); });
  const src = fs.readFileSync(path.join(root, "public/extract.js"), "utf8");
  const fn = src.slice(src.indexOf("function ffiWishlist()"));
  await page.evaluate(`(function(){${fn};ffiWishlist();})()`);
  await page.waitForFunction(() => document.body.innerText.includes("Copied"), null, { timeout: 30000 });
  assert.ok(copied.startsWith("FFI-WISHLIST:"));
  const data = JSON.parse(copied.slice("FFI-WISHLIST:".length));
  assert.equal(data.name, "Owain's list");
  assert.equal(data.items.length, 6,  "loaded the extra items after scrolling, got " + data.items.length);
  const one = data.items[0];
  assert.equal(one.title, "Product number 1");
  assert.equal(one.price, "£10.99");
  assert.equal(one.currency, "GBP");
  assert.match(one.url, /^https:\/\/www\.amazon\.co\.uk\/dp\/B0ABCDE001/);
  assert.match(one.image, /img1\.jpg$/);
  assert.equal(data.items[1].price, ""); // "Currently unavailable": no price, and no made-up one
  assert.equal(data.items[1].currency, "GBP"); // no symbol to read, so it goes by the .co.uk site
});
