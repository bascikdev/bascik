import { expect, test } from "vitest";
import { parse, serialize } from "parse5";
import { renderOrder, renderOrderNotice } from "../src/lib/order-page.ts";
import type { OrderView } from "../src/lib/order-view.ts";

const id = "32ce1859bfe24c8fa5c68863b425379f";
const view = (overrides: Partial<OrderView> = {}): OrderView => ({
  orderId: id,
  status: "submitted",
  refund: { state: "none", amount: 0, checkedAt: null },
  paymentConfirmed: true,
  testMode: false,
  confirmationEmail: "sent",
  summary: {
    reference: `BASCIK-${id.toUpperCase()}`,
    placedAt: "2026-11-07T19:45:07.000Z",
    items: [
      {
        variantId: "v1",
        title: 'Logo shirt <script>alert("$&")</script> / Black / M',
        quantity: 2,
        price: 3000,
      },
    ],
    subtotal: 6000,
    shipping: 495,
    shippingService: "Standard",
    tax: 276,
    total: 6771,
  },
  shipments: [
    {
      carrier: "USPS",
      tracking_number: "9400",
      tracking_url: "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400",
    },
    {
      carrier: "Evil",
      tracking_number: "1",
      tracking_url: "javascript:alert(1)",
    },
    { carrier: "Plain", tracking_number: "2", tracking_url: "http://x.test/" },
    { carrier: null, tracking_number: null, tracking_url: null },
  ],
  items: [{ variantId: "v1", quantity: 2 }],
  fingerprint: "abcdef0123456789",
  ...overrides,
});
const testIds = (html: string) =>
  [...html.matchAll(/data-testid="([^"]+)"/g)].map((m) => m[1]);
const hooks = (html: string) =>
  [...html.matchAll(/data-order-[a-z-]+/g)].map((m) => m[0]);

test("a paid order renders the full confirmation with every hook and test id", () => {
  const html = String(renderOrder(view(), { ticket: "t.1.2", expired: false }));
  expect(html).toContain("Your order is with Printful.");
  expect(html).toContain(`BASCIK-${id.toUpperCase()}`);
  expect(html).toContain("Placed November 7, 2026");
  expect(html).toContain("Quantity: 2 · $30.00 each");
  expect(html).toContain("$60.00");
  expect(html).toContain("$4.95 · Standard");
  expect(html).toContain("$2.76");
  expect(html).toContain("Total paid");
  expect(html).toContain("$67.71");
  expect(html).toContain("Your confirmation email has been sent.");
  expect(html).toContain("Print confirmation");
  for (const name of [
    "order-summary",
    "order-reference",
    "order-item",
    "order-refund",
    "order-email",
    "order-print",
    "order-help",
  ])
    expect(testIds(html)).toContain(name);
  for (const hook of [
    "data-order-status",
    "data-order-refund",
    "data-order-summary",
    "data-order-reference",
    "data-order-date",
    "data-order-lines",
    "data-order-subtotal",
    "data-order-shipping",
    "data-order-tax",
    "data-order-total-label",
    "data-order-total",
    "data-order-email",
    "data-order-print",
    "data-order-id",
    "data-order-items",
    "data-order-fingerprint",
  ])
    expect(hooks(html)).toContain(hook);
  expect(html).toContain('data-order-pending=""');
  expect(html).not.toContain("<order-");
  expect(serialize(parse(html))).toContain("Print confirmation");
});
test("item titles are escaped, including regex replacement tokens", () => {
  const html = String(renderOrder(view(), { ticket: "t", expired: false }));
  expect(html).not.toContain("<script>alert");
  expect(html).toContain(
    "&lt;script&gt;alert(&quot;$&amp;&quot;)&lt;/script&gt;",
  );
  expect(html).toContain("$&amp;");
});
test("the rendered page carries nothing private", () => {
  const html = String(renderOrder(view(), { ticket: "t", expired: false }));
  for (const privateValue of [
    "buyer@example.com",
    "Test Buyer",
    "Example street",
    "cs_test_",
    "https://example.com/art.png",
    "t.1.2",
  ])
    expect(html).not.toContain(privateValue);
});
test("tracking links are emitted only for https URLs, with noreferrer noopener", () => {
  const html = String(renderOrder(view(), { ticket: "t", expired: false }));
  expect(html).toContain("USPS: 9400");
  expect(html).toContain(
    '<a href="https://tools.usps.com/go/TrackConfirmAction?tLabels=9400" rel="noreferrer noopener">Track shipment</a>',
  );
  expect(html).not.toContain("javascript:");
  expect(html).not.toContain("about:invalid");
  expect(html).not.toContain("http://x.test/");
  expect(html).toContain("Evil: 1");
  expect(html).toContain("Plain: 2");
  expect(html).toContain("Carrier: Tracking pending");
  expect((html.match(/Track shipment/g) ?? []).length).toBe(1);
});
test("cart clearing data is emitted only once payment is confirmed", () => {
  const paid = String(renderOrder(view(), { ticket: "t", expired: false }));
  expect(paid).toContain(`data-order-id="${id}"`);
  expect(paid).toContain(
    `data-order-items="[{&quot;variantId&quot;:&quot;v1&quot;,&quot;quantity&quot;:2}]"`,
  );
  const unpaid = String(
    renderOrder(
      view({ status: "pending", paymentConfirmed: false, summary: null }),
      { ticket: "t", expired: false },
    ),
  );
  expect(unpaid).toContain(`data-order-id="${id}"`);
  expect(unpaid).toContain('data-order-items=""');
  expect(unpaid).toContain("Waiting for payment confirmation.");
  expect(unpaid).toContain('data-order-pending="true"');
  expect(unpaid).not.toContain("Print confirmation");
  expect(unpaid).not.toMatch(/data-order-summary[^>]*>/);
});
test("the summary hides what the receipt cannot confirm", () => {
  const legacy = String(
    renderOrder(
      view({ summary: { ...view().summary!, tax: null, total: null } }),
      { ticket: "t", expired: false },
    ),
  );
  expect(legacy).toContain("See Stripe receipt");
  expect(legacy).toContain("Total before tax");
  expect(legacy).toContain("$64.95");
});
test.each([
  [
    "refunded",
    6771,
    "cancelled",
    "Your full refund of $67.71 has been issued.",
  ],
  ["partial", 1000, "submitted", "A partial refund of $10.00 has been issued."],
  ["pending", 0, "submitted", "A refund is processing."],
  [
    "failed",
    1000,
    "submitted",
    "A refund needs attention. $10.00 has already been refunded.",
  ],
  ["none", 0, "cancelled", "A full refund has not yet been confirmed."],
] as const)(
  "refund state %s is shown without rewriting the receipt",
  (state, amount, status, text) => {
    const html = String(
      renderOrder(view({ status, refund: { state, amount, checkedAt: 1 } }), {
        ticket: "t",
        expired: false,
      }),
    );
    expect(html).toContain(text);
    expect(html).toContain("$67.71");
    expect(html).toContain("Total paid");
  },
);
test("polling continues while the confirmation email is queued", () => {
  const html = String(
    renderOrder(view({ confirmationEmail: "pending" }), {
      ticket: "t",
      expired: false,
    }),
  );
  expect(html).toContain('data-order-pending="true"');
  expect(html).toContain("Your confirmation email is queued.");
});
test("notices render the status line and the help text, nothing else", () => {
  for (const [kind, text] of [
    ["expired", "Refreshing your order link"],
    ["not-found", "Order link not found."],
    ["failed", "Order lookup failed."],
    ["no-ticket", "Use the private link from your order confirmation."],
  ] as const) {
    const html = String(renderOrderNotice(kind));
    expect(html).toContain(text);
    expect(testIds(html)).toContain("order-help");
    expect(html).not.toContain("data-order-summary");
    expect(html).not.toContain("Print confirmation");
    expect(html).not.toContain("Error:");
    expect(html).not.toContain("    at ");
  }
  expect(String(renderOrderNotice("expired"))).toContain(
    'data-order-notice="expired"',
  );
  expect(String(renderOrderNotice("not-found"))).toContain(
    'class="status error"',
  );
});
