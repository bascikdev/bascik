/**
 * Orders seeded into the browser test runtime's D1 by `serve-tests.ts`, and
 * the matching private links the e2e suite opens. The secret is a fixed test
 * value, so the tokens and tickets are reproducible on every run.
 */
import { createHmac } from "node:crypto";
import { products } from "../src/lib/catalog.ts";

export const TEST_ORDER_TOKEN_SECRET =
  "browser-test-order-token-secret-32chars+";
export const TEST_CONTROL_PORT = Number(
  process.env.SHOP_TEST_CONTROL_PORT ?? 8791,
);
const variant = products[0].variants[0];
export const fixtureVariantId = variant.id;
const hex = (hmacInput: string) =>
  createHmac("sha256", TEST_ORDER_TOKEN_SECRET).update(hmacInput).digest("hex");
export const fixtureToken = (id: string) => `${id}.${hex(`order:${id}`)}`;
export const fixtureTicket = (id: string, exp: number) =>
  `${id}.${exp}.${hex(`order-ticket:${id}.${exp}`)}`;

export interface FixtureOrder {
  id: string;
  status: string;
  paid: boolean;
  tax?: number | null;
  total?: number | null;
  refund?: { state: string; amount: number };
  shipments?: unknown[];
  quantity?: number;
  title?: string;
  /** Stored with a snapshot that is not JSON, so reading it throws. */
  broken?: boolean;
  /** Never mutated by a test, so it can be read by any test in parallel. */
  readOnly?: boolean;
}
const snapshot = (quantity: number, title: string) =>
  JSON.stringify({
    recipient: {
      name: "Browser Buyer",
      email: "browser-buyer@example.com",
      address1: "1 Fixture Way",
      address2: "",
      city: "Testville",
      state_code: "CA",
      country_code: "US",
      zip: "90001",
    },
    items: [
      {
        variantId: variant.id,
        quantity,
        price: 3000,
        title,
        variant_id: 456,
        placements: [],
      },
    ],
    rates: [{ id: "STANDARD", name: "Standard", amount: 495, currency: "usd" }],
    subtotal: 3000 * quantity,
  });
export const fixtureOrders: FixtureOrder[] = [
  {
    id: "a1".repeat(16),
    status: "submitted",
    paid: true,
    tax: 276,
    total: 3771,
  },
  // One pending order per Playwright project, so desktop and mobile can move
  // theirs through payment at the same time.
  { id: "b2".repeat(16), status: "pending", paid: false },
  { id: "b3".repeat(16), status: "pending", paid: false },
  // Read only: the unpaid-confirmation test, which never changes it.
  { id: "b4".repeat(16), status: "pending", paid: false, readOnly: true },
  { id: "c3".repeat(16), status: "expired", paid: false },
  { id: "d4".repeat(16), status: "paid", paid: true, tax: 276, total: 3771 },
  {
    id: "e5".repeat(16),
    status: "test_draft",
    paid: true,
    tax: 276,
    total: 3771,
  },
  {
    id: "f6".repeat(16),
    status: "submitted",
    paid: true,
    tax: null,
    total: null,
  },
  {
    id: "a7".repeat(16),
    status: "submitted",
    paid: true,
    tax: 276,
    total: 3771,
    title: 'Logo shirt <script>alert("$&")</script> / Black / M',
  },
  {
    id: "b8".repeat(16),
    status: "shipped",
    paid: true,
    tax: 276,
    total: 3771,
    shipments: [
      {
        carrier: "USPS",
        tracking_number: "9400",
        tracking_url:
          "https://tools.usps.com/go/TrackConfirmAction?tLabels=9400",
      },
    ],
  },
  ...(
    [
      ["refunded", 3771, "cancelled"],
      ["partial", 1000, "submitted"],
      ["pending", 0, "submitted"],
      ["failed", 1000, "submitted"],
      ["none", 0, "cancelled"],
    ] as const
  ).map(([state, amount, status], index) => ({
    id: `e${index}`.repeat(16),
    status,
    paid: true,
    tax: 276,
    total: 3771,
    refund: { state, amount },
  })),
  // Its snapshot is not JSON: the page's lookup throws while streaming.
  {
    id: "d9".repeat(16),
    status: "submitted",
    paid: true,
    tax: 276,
    total: 3771,
    broken: true,
  },
];
/** Statements that create every fixture order; `run` executes each in order. */
export function fixtureStatements(now: number) {
  const statements: { sql: string; params: unknown[] }[] = [];
  for (const order of fixtureOrders) {
    const body = order.broken
      ? "{not json"
      : snapshot(order.quantity ?? 1, order.title ?? "Logo shirt / Black / M");
    statements.push({
      sql: "INSERT OR REPLACE INTO quotes(id,snapshot,expires_at) VALUES (?,?,?)",
      params: [`quote-${order.id}`, body, now + 900],
    });
    statements.push({
      sql: "INSERT OR REPLACE INTO orders(id,quote_id,shipping_id,snapshot,status,stripe_session,shipments,created_at,updated_at,payment_tax,payment_total,refund_state,refund_amount,refund_checked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [
        order.id,
        `quote-${order.id}`,
        "STANDARD",
        body,
        order.status,
        `cs_test_${order.id}`,
        JSON.stringify(order.shipments ?? []),
        // Placed two days ago: inside the 90-day link window on every run.
        now - 2 * 86400,
        now,
        order.tax ?? null,
        order.total ?? null,
        order.refund?.state ?? "none",
        order.refund?.amount ?? 0,
        order.refund ? 1 : 0,
      ],
    });
    if (order.paid)
      statements.push({
        sql: "INSERT OR REPLACE INTO payment_events(id,order_id,created_at) VALUES (?,?,?)",
        params: [`evt_${order.id}`, order.id, now],
      });
  }
  return statements;
}
