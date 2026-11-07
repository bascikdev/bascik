import { type Env, now, orderToken } from "./platform.ts";
import {
  type Order,
  type Quote,
  printfulItems,
  recipient,
} from "./checkout.ts";
import { printful, printfulList, ProviderError, stripe } from "./providers.ts";

interface PrintfulOrder {
  id: number;
  external_id: string;
  status: string;
  costs: { calculation_status: "done" | "calculating" | "failed" };
  shipments: {
    id: number;
    carrier?: string;
    tracking_number?: string;
    tracking_url?: string;
  }[];
}
class FulfillmentInvariantError extends Error {}
export async function notification(env: Env, orderId: string, kind: string) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at) VALUES (?,?,?,?)",
  )
    .bind(`${orderId}:${kind}`, orderId, kind, now())
    .run();
}
export async function failOrder(env: Env, orderId: string, reason: string) {
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE orders SET status='failed',last_error=?,updated_at=?,lease_until=0 WHERE id=?",
    ).bind(reason, now(), orderId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at) VALUES (?,?,?,?)",
    ).bind(`${orderId}:alert`, orderId, "alert", now()),
  ]);
  console.error("Shop fulfillment needs operator action", { orderId, reason });
}
export interface CheckoutSession {
  id: string;
  status: string;
  payment_status: string;
  currency: string;
  amount_subtotal: number;
  amount_total: number;
  livemode: boolean;
  metadata: Record<string, string>;
  total_details: {
    amount_shipping: number;
    amount_tax: number;
    amount_discount: number;
  };
  automatic_tax: { status: string };
  shipping_cost?: { shipping_rate: string | { id: string } };
  customer_details?: { email: string | null };
  shipping_details?: {
    name: string;
    address: {
      line1: string;
      line2?: string | null;
      city?: string | null;
      state?: string | null;
      country: string;
      postal_code?: string | null;
    };
  } | null;
  collected_information?: {
    shipping_details?: CheckoutSession["shipping_details"];
  };
}
export async function paidSession(
  env: Env,
  sessionId: string,
  order: Order,
  retrieved?: CheckoutSession,
) {
  const session =
    retrieved ??
    (await stripe<CheckoutSession>(
      env,
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    ));
  if (
    session.id !== sessionId ||
    session.metadata?.app !== "bascik-shop" ||
    session.metadata.order_id !== order.id ||
    session.metadata.shop_origin !== env.SHOP_ORIGIN ||
    session.livemode !== (env.SHOP_MODE === "live")
  )
    throw new FulfillmentInvariantError("Payment/order identity mismatch");
  if (session.payment_status !== "paid") return false;
  const quote: Quote = JSON.parse(order.snapshot);
  const shipping = quote.rates.find((rate) => rate.id === order.shipping_id);
  if (
    !shipping ||
    session.currency !== "usd" ||
    session.amount_subtotal !== quote.subtotal ||
    session.total_details?.amount_shipping !== shipping.amount ||
    !Number.isSafeInteger(session.total_details?.amount_tax) ||
    session.total_details.amount_tax < 0 ||
    session.total_details.amount_discount !== 0 ||
    session.amount_total !==
      quote.subtotal + shipping.amount + session.total_details.amount_tax ||
    session.automatic_tax?.status !== "complete"
  )
    throw new FulfillmentInvariantError("Payment/order snapshot mismatch");
  if (quote.checkoutForm) {
    const details =
      session.collected_information?.shipping_details ??
      session.shipping_details;
    if (!details || !session.customer_details?.email)
      throw new FulfillmentInvariantError("Payment shipping details missing");
    const address = recipient({
      name: details.name,
      email: session.customer_details.email,
      address1: details.address.line1,
      address2: details.address.line2 ?? "",
      city: details.address.city,
      state_code: details.address.state ?? "",
      country_code: details.address.country,
      zip: details.address.postal_code ?? "",
    });
    const rateId =
      typeof session.shipping_cost?.shipping_rate === "string"
        ? session.shipping_cost.shipping_rate
        : session.shipping_cost?.shipping_rate?.id;
    if (
      rateId !== shipping.stripeRateId ||
      Object.keys(address).some(
        (key) =>
          address[key as keyof typeof address].toLocaleLowerCase("en") !==
          quote.recipient[key as keyof typeof address].toLocaleLowerCase("en"),
      )
    )
      throw new FulfillmentInvariantError(
        "Payment shipping/address snapshot mismatch",
      );
  }
  return session.payment_status === "paid";
}
export async function recordPayment(
  env: Env,
  order: Order,
  sessionId: string,
  eventId: string,
) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO payment_events(id,order_id,created_at) VALUES (?,?,?)",
    ).bind(eventId, order.id, now()),
    env.DB.prepare(
      "UPDATE orders SET status='paid',stripe_session=?,updated_at=?,lease_until=0,retry_at=0,attempts=0 WHERE id=? AND status='pending'",
    ).bind(sessionId, now(), order.id),
    env.DB.prepare(
      "INSERT OR IGNORE INTO notifications(id,order_id,kind,created_at) VALUES (?,?,?,?)",
    ).bind(`${order.id}:confirmation`, order.id, "confirmation", now()),
  ]);
}
async function reconcilePayment(env: Env, orderId: string) {
  const order = await env.DB.prepare(
    "UPDATE orders SET lease_until=? WHERE id=? AND status='pending' AND stripe_session IS NOT NULL AND lease_until<? AND retry_at<=? RETURNING *",
  )
    .bind(now() + 120, orderId, now(), now())
    .first<Order>();
  if (!order?.stripe_session) return;
  try {
    const session = await stripe<CheckoutSession>(
      env,
      `/checkout/sessions/${encodeURIComponent(order.stripe_session)}`,
    );
    if (await paidSession(env, order.stripe_session, order, session)) {
      await recordPayment(env, order, session.id, `reconciled:${session.id}`);
    } else {
      await env.DB.prepare(
        "UPDATE orders SET status=?,lease_until=0,retry_at=?,updated_at=?,attempts=0 WHERE id=? AND status='pending'",
      )
        .bind(
          session.status === "expired" ? "expired" : "pending",
          now() + 900,
          now(),
          order.id,
        )
        .run();
    }
  } catch (error) {
    console.error("Shop payment reconciliation failed", {
      orderId: order.id,
      type: error instanceof Error ? error.name : "Unknown",
    });
    if (error instanceof FulfillmentInvariantError || order.attempts >= 7) {
      await failOrder(
        env,
        order.id,
        "Payment reconciliation requires operator review",
      );
    } else {
      await env.DB.prepare(
        "UPDATE orders SET lease_until=0,retry_at=?,attempts=attempts+1 WHERE id=? AND status='pending'",
      )
        .bind(
          Math.max(
            now() + Math.min(3600, 60 * 2 ** order.attempts),
            error instanceof ProviderError ? error.retryAt : 0,
          ),
          order.id,
        )
        .run();
    }
  }
}
async function lookup(env: Env, order: Order) {
  try {
    return await printful<PrintfulOrder>(
      env,
      `/orders/@${encodeURIComponent(order.id)}`,
    );
  } catch (error) {
    if (error instanceof ProviderError && error.status === 404) return null;
    throw error;
  }
}
async function recordPrintful(env: Env, order: Order, remote: PrintfulOrder) {
  if (remote.external_id !== order.id || !Number.isSafeInteger(remote.id))
    throw new FulfillmentInvariantError("Printful order reference mismatch");
  await env.DB.prepare("UPDATE orders SET printful_id=? WHERE id=?")
    .bind(remote.id, order.id)
    .run();
  if (["failed", "canceled", "cancelled", "onhold"].includes(remote.status)) {
    await failOrder(env, order.id, `Printful status: ${remote.status}`);
    return;
  }
  const shipments = await printfulList<PrintfulOrder["shipments"][number]>(
    env,
    `/orders/${remote.id}/shipments`,
  );
  const status =
    remote.status === "fulfilled" || order.status === "shipped"
      ? "shipped"
      : "submitted";
  await env.DB.prepare(
    "UPDATE orders SET status=?,shipments=?,updated_at=?,lease_until=0,retry_at=?,attempts=0,last_error=NULL WHERE id=?",
  )
    .bind(status, JSON.stringify(shipments), now(), now() + 900, order.id)
    .run();
  for (const shipment of shipments)
    if (shipment.tracking_number)
      await notification(env, order.id, `shipment:${shipment.id}`);
}
export async function processOrder(env: Env, orderId: string) {
  if (env.SHOP_FULFILLMENT_ENABLED !== "true") return;
  const claim = await env.DB.prepare(
    "UPDATE orders SET lease_until=?,attempts=attempts+1 WHERE id=? AND status IN ('paid','submitting','submitted','shipped') AND lease_until<? AND retry_at<=? RETURNING *",
  )
    .bind(now() + 120, orderId, now(), now())
    .first<Order>();
  if (!claim) return;
  try {
    if (
      !claim.stripe_session ||
      !(await paidSession(env, claim.stripe_session, claim))
    )
      throw new FulfillmentInvariantError(
        "Order has no verified successful payment",
      );
    let remote = await lookup(env, claim);
    if (claim.status === "shipped") {
      if (!remote || remote.status === "draft")
        throw new FulfillmentInvariantError(
          "Shipped order has no matching production order",
        );
      if (env.SHOP_MODE !== "live")
        throw new FulfillmentInvariantError(
          "Test order unexpectedly entered Printful production",
        );
      await recordPrintful(env, claim, remote);
      return;
    }
    if (!remote && claim.status !== "paid") {
      await failOrder(
        env,
        claim.id,
        "Ambiguous Printful submission. Inspect external reference before any replay.",
      );
      return;
    }
    const quote: Quote = JSON.parse(claim.snapshot);
    if (!remote) {
      await env.DB.prepare(
        "UPDATE orders SET status='submitting',updated_at=? WHERE id=?",
      )
        .bind(now(), claim.id)
        .run();
      remote = await printful<PrintfulOrder>(env, "/orders", {
        external_id: claim.id,
        shipping: claim.shipping_id,
        recipient: quote.recipient,
        order_items: printfulItems(quote),
        retail_costs: {
          currency: "USD",
        },
      });
      if (remote.external_id !== claim.id || !Number.isSafeInteger(remote.id))
        throw new FulfillmentInvariantError(
          "Printful order reference mismatch",
        );
      await env.DB.prepare("UPDATE orders SET printful_id=? WHERE id=?")
        .bind(remote.id, claim.id)
        .run();
    }
    if (env.SHOP_MODE === "test" && remote.status !== "draft")
      throw new FulfillmentInvariantError(
        "Test order unexpectedly entered Printful production",
      );
    if (remote.status === "draft") {
      if (remote.costs?.calculation_status === "calculating") {
        if (claim.attempts >= 8)
          throw new FulfillmentInvariantError(
            "Printful v2 draft costs did not finish calculating",
          );
        await env.DB.prepare(
          "UPDATE orders SET lease_until=0,retry_at=? WHERE id=?",
        )
          .bind(now() + 60, claim.id)
          .run();
        return;
      }
      if (remote.costs?.calculation_status !== "done")
        throw new FulfillmentInvariantError(
          "Printful v2 draft costs are not ready",
        );
      if (env.SHOP_MODE === "test") {
        await env.DB.prepare(
          "UPDATE orders SET status='test_draft',printful_id=?,lease_until=0,retry_at=0,attempts=0,last_error=NULL,updated_at=? WHERE id=?",
        )
          .bind(remote.id, now(), claim.id)
          .run();
        return;
      }
      remote = await printful<PrintfulOrder>(
        env,
        `/orders/${remote.id}/confirmation`,
        {},
      );
    }
    await recordPrintful(env, claim, remote);
  } catch (error) {
    const reason =
      error instanceof ProviderError
        ? `${error.provider} HTTP ${error.status}`
        : error instanceof FulfillmentInvariantError
          ? error.message
          : error instanceof Error
            ? error.name
            : "Unknown failure";
    console.error("Shop fulfillment attempt failed", {
      orderId: claim.id,
      reason,
    });
    if (
      error instanceof FulfillmentInvariantError ||
      (error instanceof ProviderError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 429) ||
      claim.attempts >= 8
    ) {
      await failOrder(env, claim.id, reason);
    } else {
      await env.DB.prepare(
        "UPDATE orders SET lease_until=0,retry_at=?,last_error=? WHERE id=?",
      )
        .bind(
          Math.max(
            now() + Math.min(3600, 60 * 2 ** claim.attempts),
            error instanceof ProviderError ? error.retryAt : 0,
          ),
          reason,
          claim.id,
        )
        .run();
    }
  }
}
export async function sendNotifications(env: Env) {
  if (env.SHOP_MODE === "test") return;
  const pending = await env.DB.prepare(
    "SELECT id FROM notifications WHERE status='pending' AND retry_at<=? AND lease_until<? ORDER BY created_at LIMIT 10",
  )
    .bind(now(), now())
    .all<{ id: string }>();
  for (const entry of pending.results) {
    const message = await env.DB.prepare(
      "UPDATE notifications SET lease_until=?,attempts=attempts+1 WHERE id=? AND status='pending' AND lease_until<? RETURNING *",
    )
      .bind(now() + 120, entry.id, now())
      .first<{
        id: string;
        order_id: string;
        kind: string;
        attempts: number;
      }>();
    if (!message) continue;
    try {
      const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?")
        .bind(message.order_id)
        .first<Order>();
      if (!order) throw new Error("Notification order missing");
      const quote: Quote = JSON.parse(order.snapshot);
      if (!env.EMAIL) throw new Error("Email binding missing");
      const alert = message.kind === "alert";
      const link = `${env.SHOP_ORIGIN}/order#token=${encodeURIComponent(await orderToken(env, order.id))}`;
      const subject = alert
        ? "Bascik shop: fulfillment needs attention"
        : message.kind.startsWith("shipment:")
          ? "Your Bascik shipment update"
          : "Your Bascik order";
      const text = alert
        ? `Order ${order.id} needs attention. Inspect the shop logs, Stripe payment, and Printful external reference. Do not resubmit before reconciling.`
        : `Thank you for your order.\n\n${quote.items.map((item) => `${item.quantity} x ${item.title}`).join("\n")}\n\nOrder status and tracking: ${link}\n\nThis private link is for your order only. Stripe sends your payment receipt separately.\n\nQuestions? ${env.SUPPORT_EMAIL}`;
      await env.EMAIL.send({
        from: env.EMAIL_FROM,
        to: alert ? env.ALERT_EMAIL : quote.recipient.email,
        replyTo: env.SUPPORT_EMAIL,
        subject,
        text,
      });
      await env.DB.prepare(
        "UPDATE notifications SET status='sent',lease_until=0 WHERE id=?",
      )
        .bind(message.id)
        .run();
    } catch (error) {
      console.error("Shop notification failed", {
        notificationId: message.id,
        type: error instanceof Error ? error.name : "Unknown",
      });
      await env.DB.prepare(
        "UPDATE notifications SET status=?,lease_until=0,retry_at=? WHERE id=?",
      )
        .bind(
          message.attempts >= 8 ? "failed" : "pending",
          now() + Math.min(3600, 60 * 2 ** message.attempts),
          message.id,
        )
        .run();
    }
  }
}
export async function sweep(env: Env) {
  if (env.SHOP_FULFILLMENT_ENABLED !== "true" && !env.EMAIL) return;
  const unpaid = await env.DB.prepare(
    "SELECT id FROM orders WHERE status='pending' AND stripe_session IS NOT NULL AND retry_at<=? AND lease_until<? AND created_at<? ORDER BY updated_at LIMIT 10",
  )
    .bind(now(), now(), now() - 60)
    .all<{ id: string }>();
  for (const order of unpaid.results) await reconcilePayment(env, order.id);
  const pending = await env.DB.prepare(
    "SELECT id FROM orders WHERE (status IN ('paid','submitting','submitted') OR (status='shipped' AND created_at>?)) AND retry_at<=? AND lease_until<? ORDER BY retry_at,updated_at LIMIT 10",
  )
    .bind(now() - 90 * 86400, now(), now())
    .all<{ id: string }>();
  for (const order of pending.results) await processOrder(env, order.id);
  await sendNotifications(env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at<?").bind(now()),
    env.DB.prepare(
      "DELETE FROM quotes WHERE expires_at<? AND id NOT IN (SELECT quote_id FROM orders)",
    ).bind(now() - 86400),
  ]);
}
