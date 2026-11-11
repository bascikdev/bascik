import type { Order, Quote } from "./checkout.ts";
import { orderSummary, type OrderSummary } from "./order-summary.ts";
import { type Env, digest, equal, now, orderToken } from "./platform.ts";

/** The order as the customer may see it: no name, address, email, or art. */
export interface OrderView {
  orderId: string;
  status: string;
  refund: { state: string; amount: number; checkedAt: number | null };
  paymentConfirmed: boolean;
  testMode: boolean;
  confirmationEmail: string;
  summary: OrderSummary | null;
  shipments: Shipment[];
  items: { variantId: string; quantity: number }[];
  /** Changes whenever the page would render differently; the browser polls against it. */
  fingerprint: string;
}
export interface Shipment {
  carrier?: string | null;
  tracking_number?: string | null;
  tracking_url?: string | null;
}
const TOKEN = /^(?:[a-f0-9]{32}|[a-f0-9-]{36})\.[a-f0-9]{64}$/;
export const ORDER_LINK_DAYS = 90;

/** The order id a long-lived token names, or `null` when the token is not valid. */
export async function orderIdFromToken(env: Env, token: string) {
  if (!TOKEN.test(token)) return null;
  const id = token.split(".")[0];
  if (!env.ORDER_TOKEN_SECRET || !equal(token, await orderToken(env, id)))
    return null;
  return id;
}
/** The order behind a long-lived token, or `null` when the token is not valid. */
export async function orderViewByToken(env: Env, token: string) {
  const id = await orderIdFromToken(env, token);
  return id ? orderView(env, id) : null;
}
/**
 * One batched read of the order, its payment record, and its confirmation
 * email. Returns `null` for an unknown, revoked, or over-90-day order.
 */
export async function orderView(
  env: Env,
  id: string,
): Promise<OrderView | null> {
  const [orders, payments, confirmations] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM orders WHERE id=? AND token_revoked=0").bind(
      id,
    ),
    env.DB.prepare(
      "SELECT id FROM payment_events WHERE order_id=? LIMIT 1",
    ).bind(id),
    env.DB.prepare(
      "SELECT status FROM notifications WHERE order_id=? AND kind='confirmation'",
    ).bind(id),
  ]);
  const order = orders.results[0] as Order | undefined;
  if (!order || now() - order.created_at > ORDER_LINK_DAYS * 86400) return null;
  const quote: Quote = JSON.parse(order.snapshot);
  const paymentConfirmed = payments.results.length > 0;
  const confirmation = confirmations.results[0] as
    { status: string } | undefined;
  const view = {
    orderId: order.id,
    status: order.status,
    refund: {
      state: order.refund_state,
      amount: order.refund_amount,
      checkedAt: order.refund_checked_at || null,
    },
    paymentConfirmed,
    testMode: env.SHOP_MODE === "test",
    confirmationEmail:
      env.SHOP_MODE === "test"
        ? "disabled"
        : (confirmation?.status ?? "pending"),
    summary: paymentConfirmed ? orderSummary(order, quote) : null,
    shipments: JSON.parse(order.shipments) as Shipment[],
    items: quote.items.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
  };
  return { ...view, fingerprint: await fingerprint(view) };
}
/** A short digest of everything the order page renders from. */
async function fingerprint(view: Omit<OrderView, "fingerprint">) {
  return (
    await digest(
      JSON.stringify([
        view.status,
        view.paymentConfirmed,
        view.confirmationEmail,
        view.refund,
        view.shipments,
        view.summary,
      ]),
    )
  ).slice(0, 16);
}
