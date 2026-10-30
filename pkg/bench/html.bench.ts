/**
 * @bascik/bascik/html on a 1000-card list (Collin 2026-10-28).
 *
 * Run with:   yarn pkg:bench html
 *
 * Three ways to render the same 1000 product cards (name, price, url, badge;
 * four holes per card, nested through items.map):
 *   (a) a plain template literal, no escaping (unsafe: the floor);
 *   (b) a plain template literal with esc() on each value;
 *   (c) html, nesting fragments with .map.
 * Target: (c) within 1.5x of (b) and 3x of (a). Every variant must produce
 * the same bytes for clean data, asserted once before timing.
 */
import { test } from "vitest";
import assert from "node:assert/strict";
import { esc, html } from "../src/html.ts";

const items = Array.from({ length: 1000 }, (_, i) => ({
  name: `Product ${i} & "friends"`,
  price: (i * 1.25).toFixed(2),
  url: `/products/${i}?ref=list`,
  badge: i % 7 === 0 ? "<new>" : "",
}));

const plain = (): string =>
  `<ul>${items
    .map(
      (i) =>
        `<li class="card"><a href="${i.url}">${i.name}</a><span>${i.price}</span><em>${i.badge}</em></li>`,
    )
    .join("")}</ul>`;

const escaped = (): string =>
  `<ul>${items
    .map(
      (i) =>
        `<li class="card"><a href="${esc(i.url)}">${esc(i.name)}</a><span>${esc(i.price)}</span><em>${esc(i.badge)}</em></li>`,
    )
    .join("")}</ul>`;

// prettier-ignore
const tagged = (): string =>
  String(
    html`<ul>${items.map(
      (i) =>
        html`<li class="card"><a href="${i.url}">${i.name}</a><span>${i.price}</span><em>${i.badge}</em></li>`,
    )}</ul>`,
  );

assert.equal(tagged(), escaped());

test("1000 product cards", async ({ bench }) => {
  await bench.compare(
    bench("(a) plain template literal, no escaping", () => {
      plain();
    }),
    bench("(b) plain template literal + esc()", () => {
      escaped();
    }),
    bench("(c) html", () => {
      tagged();
    }),
  );
});
