import { expect, test } from "vitest";
import { orderEmail } from "../src/lib/order-email.ts";
import type { OrderSummary } from "../src/lib/order-summary.ts";

const summary: OrderSummary = {
  reference: "BASCIK-32CE1859BFE24C8FA5C68863B425379F",
  placedAt: "2026-11-07T19:45:07.000Z",
  items: [
    {
      variantId: "fixture",
      title: "Logo shirt / Stone / S",
      quantity: 1,
      price: 3000,
    },
  ],
  subtotal: 3000,
  shipping: 495,
  shippingService: "Standard",
  tax: 276,
  total: 3771,
};
test("branded confirmation includes matching HTML and plain-text purchase details", () => {
  const message = orderEmail(
    summary,
    "https://shop.example.com/order#token=fixture",
    "shop@example.com",
    false,
  );
  expect(message.subject).toBe(`Order confirmation: ${summary.reference}`);
  for (const part of [message.text, message.html]) {
    for (const text of [
      summary.reference,
      summary.items[0].title,
      "$30.00",
      "$4.95",
      "$2.76",
      "$37.71",
      "shop@example.com",
    ])
      expect(part).toContain(text);
  }
  expect(message.html).toContain("#d3ff8d");
  expect(message.html).toContain("#18191b");
  expect(message.html).toContain("View order &amp; print confirmation");
  expect(message.html).not.toMatch(/<script|<iframe|<img|<link/i);
});
test("email HTML escapes dynamic text and URLs", () => {
  const message = orderEmail(
    {
      ...summary,
      items: [
        {
          ...summary.items[0],
          title: '<img src=x onerror="attack()"> & title',
        },
      ],
      shippingService: "<script>attack()</script>",
    },
    'https://shop.example.com/order#token=fixture&next="value"',
    "shop@example.com",
    false,
  );
  expect(message.html).toContain(
    "&lt;img src=x onerror=&quot;attack()&quot;&gt; &amp; title",
  );
  expect(message.html).toContain("&lt;script&gt;attack()&lt;/script&gt;");
  expect(message.html).toContain("&amp;next=&quot;value&quot;");
  expect(message.html).not.toMatch(/<script|<img/);
});
test("shipment updates share branding and legacy totals remain explicitly unknown", () => {
  const message = orderEmail(
    { ...summary, tax: null, total: null },
    "https://shop.example.com/order#token=fixture",
    "shop@example.com",
    true,
  );
  expect(message.subject).toBe(`Shipment update for ${summary.reference}`);
  expect(message.html).toContain("latest fulfillment and tracking");
  expect(message.html).toContain("See your Stripe receipt");
  expect(message.html).not.toContain("Total paid");
  expect(message.text).not.toContain("Total paid");
});
