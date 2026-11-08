import type { Order, Quote } from "./checkout.ts";
import { type Env, now } from "./platform.ts";
import { stripe, printful, ProviderError } from "./providers.ts";

export const refundEvents = [
  "charge.refunded",
  "refund.created",
  "refund.updated",
  "refund.failed",
] as const;
export const cancellationGraceSeconds = 900;

interface Refund {
  id: string;
  status: string;
  charge: string;
}
interface Charge {
  id: string;
  payment_intent: string;
  amount: number;
  amount_refunded: number;
  currency: string;
  livemode: boolean;
}
interface Session {
  id: string;
  livemode: boolean;
  metadata: Record<string, string>;
  amount_total: number;
  currency: string;
  amount_subtotal: number;
  payment_status: string;
  total_details: {
    amount_shipping: number;
    amount_tax: number;
    amount_discount: number;
  };
  payment_intent: {
    id: string;
    latest_charge: Charge | null;
  } | null;
}

async function alert(env: Env, id: string, reason: string) {
  await env.DB.batch([
    env.DB.prepare("UPDATE orders SET last_error=? WHERE id=?").bind(
      reason,
      id,
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at) VALUES (?,?,?,?)",
    ).bind(`${id}:alert`, id, "alert", now()),
    env.DB.prepare(
      "UPDATE notifications SET status='pending',attempts=0,retry_at=0 WHERE id=? AND status='resolved'",
    ).bind(`${id}:alert`),
  ]);
  console.error("Shop cancellation/refund needs operator action", {
    orderId: id,
    reason,
  });
}

export async function recordCancellation(
  env: Env,
  order: Order,
  remote: { id: number; status: string },
) {
  await env.DB.prepare(
    "UPDATE orders SET status='cancelled',printful_id=?,printful_status=?,cancellation_at=COALESCE(cancellation_at,?),lease_until=0,reconciliation_at=0,updated_at=? WHERE id=?",
  )
    .bind(remote.id, remote.status, now(), now(), order.id)
    .run();
  await reconcileOrderRefund(env, order.id);
}

export async function refundPayment(
  env: Pick<Env, "STRIPE_SECRET_KEY" | "SHOP_ORIGIN">,
  order: Order,
) {
  if (!order.stripe_session)
    throw new Error("Refund order has no Stripe session");
  const session = await stripe<Session>(
    env,
    `/checkout/sessions/${encodeURIComponent(order.stripe_session)}?expand[]=payment_intent.latest_charge`,
  );
  const intent = session.payment_intent;
  const charge = intent?.latest_charge;
  const quote: Quote = JSON.parse(order.snapshot);
  const shipping = quote.rates.find((rate) => rate.id === order.shipping_id);
  if (
    session.id !== order.stripe_session ||
    session.livemode !== true ||
    session.metadata?.app !== "bascik-shop" ||
    session.metadata.order_id !== order.id ||
    session.metadata.shop_origin !== env.SHOP_ORIGIN ||
    !intent?.id ||
    !charge?.id ||
    charge.livemode !== true ||
    (order.stripe_payment_intent !== null &&
      order.stripe_payment_intent !== intent.id) ||
    charge.payment_intent !== intent.id ||
    charge.currency !== "usd" ||
    !Number.isSafeInteger(charge.amount) ||
    charge.amount <= 0 ||
    charge.amount !== session.amount_total ||
    session.payment_status !== "paid" ||
    session.currency !== "usd" ||
    session.amount_subtotal !== quote.subtotal ||
    !shipping ||
    session.total_details?.amount_shipping !== shipping.amount ||
    !Number.isSafeInteger(session.total_details?.amount_tax) ||
    session.total_details.amount_tax < 0 ||
    session.total_details.amount_discount !== 0 ||
    session.amount_total !==
      quote.subtotal + shipping.amount + session.total_details.amount_tax ||
    (order.payment_total !== null && charge.amount !== order.payment_total) ||
    !Number.isSafeInteger(charge.amount_refunded) ||
    charge.amount_refunded < order.refund_amount ||
    charge.amount_refunded > charge.amount
  )
    throw new Error("Refund payment/order identity or amount mismatch");
  const refunds: Refund[] = [];
  let cursor = "";
  for (let page = 0; page < 100; page++) {
    const result = await stripe<{ data: Refund[]; has_more: boolean }>(
      env,
      `/refunds?charge=${encodeURIComponent(charge.id)}&limit=100${cursor ? `&starting_after=${encodeURIComponent(cursor)}` : ""}`,
    );
    if (
      !Array.isArray(result.data) ||
      typeof result.has_more !== "boolean" ||
      result.data.some(
        (refund) =>
          !refund.id ||
          refund.charge !== charge.id ||
          ![
            "pending",
            "requires_action",
            "succeeded",
            "failed",
            "canceled",
          ].includes(refund.status),
      )
    )
      throw new Error("Invalid refund pagination or charge reference");
    refunds.push(...result.data);
    if (!result.has_more) break;
    if (!result.data.length || page === 99)
      throw new Error("Incomplete refund pagination");
    cursor = result.data[result.data.length - 1].id;
  }
  const full = charge.amount_refunded === charge.amount;
  const state = full
    ? "refunded"
    : refunds.some(
          (refund) =>
            refund.status === "pending" || refund.status === "requires_action",
        )
      ? "pending"
      : refunds[0]?.status === "failed" || refunds[0]?.status === "canceled"
        ? "failed"
        : charge.amount_refunded > 0
          ? "partial"
          : "none";
  return { intent, charge, state, full };
}

export async function canceledPrintfulOrder(
  env: Pick<Env, "PRINTFUL_TOKEN" | "PRINTFUL_STORE_ID">,
  order: Order,
) {
  let remote: { id: number; external_id: string; status: string } | null = null;
  try {
    remote = await printful(env, `/orders/@${encodeURIComponent(order.id)}`);
  } catch (error) {
    if (!(error instanceof ProviderError && error.status === 404)) throw error;
  }
  if (
    remote &&
    (remote.external_id !== order.id ||
      !Number.isSafeInteger(remote.id) ||
      (order.printful_id !== null && remote.id !== order.printful_id))
  )
    throw new Error("Refund fulfillment reference mismatch");
  return remote;
}

export async function reconcileOrderRefund(env: Env, orderId: string) {
  if (env.SHOP_MODE !== "live") return;
  const order = await env.DB.prepare(
    "UPDATE orders SET reconciliation_lease=?,reconciliation_attempts=reconciliation_attempts+1 WHERE id=? AND stripe_session IS NOT NULL AND reconciliation_lease<? RETURNING *",
  )
    .bind(now() + 120, orderId, now())
    .first<Order>();
  if (!order?.stripe_session) return;
  try {
    const { intent, charge, state, full } = await refundPayment(env, order);
    const saved = await env.DB.prepare(
      "UPDATE orders SET stripe_payment_intent=?,refund_amount=?,refund_state=?,refund_checked_at=?,status=CASE WHEN ? AND status IN ('paid','submitting') THEN 'failed' ELSE status END WHERE id=? AND reconciliation_lease=? AND refund_amount<=? RETURNING id",
    )
      .bind(
        intent.id,
        charge.amount_refunded,
        state,
        now(),
        Number(full),
        order.id,
        order.reconciliation_lease,
        charge.amount_refunded,
      )
      .first();
    if (!saved) return;
    let remote: { id: number; external_id: string; status: string } | null =
      null;
    if (
      full ||
      order.status === "cancelled" ||
      order.last_error === "Printful status: canceled" ||
      order.last_error === "Printful status: cancelled"
    ) {
      remote = await canceledPrintfulOrder(env, order);
    }
    const canceled =
      remote !== null && ["canceled", "cancelled"].includes(remote.status);
    const resolved = full && canceled;
    const cancellationAt = canceled
      ? (order.cancellation_at ?? now())
      : order.cancellation_at;
    const attention =
      full && !canceled
        ? "Payment fully refunded but fulfillment cancellation is not verified. Reconcile Printful; do not resubmit."
        : state === "failed"
          ? "Stripe refund failed or was canceled."
          : canceled &&
              !full &&
              now() >= (cancellationAt ?? now()) + cancellationGraceSeconds
            ? "Printful canceled; a full Stripe refund is still outstanding."
            : null;
    const finalized = await env.DB.prepare(
      "UPDATE orders SET stripe_payment_intent=?,refund_amount=?,refund_state=?,refund_checked_at=?,printful_status=COALESCE(?,printful_status),cancellation_at=?,status=CASE WHEN ? THEN 'cancelled' WHEN ? THEN 'failed' ELSE status END,last_error=CASE WHEN ? THEN NULL ELSE last_error END,reconciliation_lease=0,reconciliation_attempts=0,reconciliation_at=?,lease_until=CASE WHEN ? THEN 0 ELSE lease_until END,updated_at=? WHERE id=? AND reconciliation_lease=? RETURNING id",
    )
      .bind(
        intent.id,
        charge.amount_refunded,
        state,
        now(),
        remote?.status ?? null,
        cancellationAt,
        Number(canceled),
        Number(full && !canceled),
        Number(resolved),
        resolved ? now() + 86400 : now() + cancellationGraceSeconds,
        Number(full || canceled),
        now(),
        order.id,
        order.reconciliation_lease,
      )
      .first();
    if (!finalized) return;
    if (resolved) {
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE notifications SET status='resolved',lease_until=0 WHERE order_id=? AND kind='alert'",
        ).bind(order.id),
        env.DB.prepare(
          "INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at) VALUES (?,?,?,?)",
        ).bind(
          `${order.id}:cancellation-refund`,
          order.id,
          "cancellation-refund",
          now(),
        ),
      ]);
    } else if (attention) await alert(env, order.id, attention);
  } catch (error) {
    const reason =
      error instanceof ProviderError
        ? `${error.provider} HTTP ${error.status}`
        : error instanceof Error
          ? error.message
          : "Unknown reconciliation failure";
    console.error("Shop refund reconciliation failed", { orderId, reason });
    await env.DB.prepare(
      "UPDATE orders SET reconciliation_lease=0,reconciliation_at=? WHERE id=? AND reconciliation_lease=?",
    )
      .bind(
        Math.max(
          now() +
            Math.min(
              86400,
              60 * 2 ** Math.min(order.reconciliation_attempts, 10),
            ),
          error instanceof ProviderError ? error.retryAt : 0,
        ),
        order.id,
        order.reconciliation_lease,
      )
      .run();
    if (
      order.reconciliation_attempts >= 8 ||
      !(error instanceof ProviderError) ||
      (error.status >= 400 && error.status < 500 && error.status !== 429)
    )
      await alert(
        env,
        order.id,
        "Cancellation/refund reconciliation requires operator review.",
      );
  }
}

export async function reconcileRefundEvent(env: Env, paymentIntent: string) {
  if (!/^pi_[A-Za-z0-9_]+$/.test(paymentIntent))
    throw new Error("Invalid refund payment intent");
  let order = await env.DB.prepare(
    "SELECT * FROM orders WHERE stripe_payment_intent=?",
  )
    .bind(paymentIntent)
    .first<Order>();
  if (!order) {
    const sessions = await stripe<{
      data: { id: string; metadata: Record<string, string> }[];
      has_more: boolean;
    }>(
      env,
      `/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntent)}&limit=100`,
    );
    if (!Array.isArray(sessions.data) || sessions.has_more)
      throw new Error("Incomplete refund session lookup");
    for (const session of sessions.data) {
      if (
        session.metadata?.app !== "bascik-shop" ||
        session.metadata.shop_origin !== env.SHOP_ORIGIN
      )
        continue;
      const candidate = await env.DB.prepare(
        "SELECT * FROM orders WHERE id=? AND stripe_session=?",
      )
        .bind(session.metadata.order_id, session.id)
        .first<Order>();
      if (candidate) {
        if (order) throw new Error("Refund matches multiple orders");
        order = candidate;
      }
    }
  }
  if (order) await reconcileOrderRefund(env, order.id);
}
