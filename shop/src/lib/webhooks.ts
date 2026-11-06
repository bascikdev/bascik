import {
  handler,
  hmac,
  equal,
  now,
  json,
  configuration,
  ShopError,
  orderToken,
  body,
  boundedText,
  sameOrigin,
  type Env,
} from "./platform.ts";
import { type Order, type Quote } from "./checkout.ts";
import { paidSession, recordPayment } from "./fulfillment.ts";

export async function verifyStripeSignature(
  secret: string,
  payload: string,
  header: string,
) {
  const parts = header.split(",").map((part) => part.trim().split("="));
  const timestamp = parts.find(([key]) => key === "t")?.[1];
  if (
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now() - Number(timestamp)) > 300
  )
    throw new ShopError("Invalid payment signature.", 400);
  const expected = await hmac(secret, `${timestamp}.${payload}`);
  if (
    !parts.some(
      ([key, value]) => key === "v1" && value && equal(expected, value),
    )
  )
    throw new ShopError("Invalid payment signature.", 400);
}
export async function verifyPrintfulSignature(
  secret: string,
  payload: string,
  signature: string,
) {
  if (!/^(?:[a-f0-9]{2}){32,}$/i.test(secret))
    throw new ShopError("Printful signature is not configured.", 503);
  if (!/^[a-f0-9]{64}$/i.test(signature))
    throw new ShopError("Invalid Printful signature.", 403);
  const key = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(secret.match(/../g)!, (byte) => parseInt(byte, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  const expected = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  if (!equal(expected, signature.toLowerCase()))
    throw new ShopError("Invalid Printful signature.", 403);
}
export const stripeWebhook = handler(async (request, env) => {
  configuration(env);
  const text = await boundedText(request, 262_144);
  await verifyStripeSignature(
    env.STRIPE_WEBHOOK_SECRET,
    text,
    request.headers.get("stripe-signature") ?? "",
  );
  const event = JSON.parse(text) as {
    id: string;
    type: string;
    livemode: boolean;
    data: { object: { id: string; metadata?: Record<string, string> } };
  };
  if (typeof event.id !== "string" || !event.data?.object)
    throw new ShopError("Invalid payment event.");
  if (
    ![
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
    ].includes(event.type)
  )
    return json({ received: true });
  const session = event.data.object;
  if (
    session.metadata?.app !== "bascik-shop" ||
    session.metadata.shop_origin !== env.SHOP_ORIGIN
  )
    return json({ received: true });
  if (event.livemode !== (env.SHOP_MODE === "live"))
    throw new ShopError("Wrong payment environment.");
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?")
    .bind(session.metadata.order_id)
    .first<Order>();
  if (!order) throw new ShopError("Order is not available yet.", 503);
  if (order.stripe_session && order.stripe_session !== session.id)
    throw new ShopError("Payment session mismatch.");
  if (!(await paidSession(env, session.id, order))) {
    if (
      event.type === "checkout.session.expired" ||
      event.type === "checkout.session.async_payment_failed"
    ) {
      await env.DB.prepare(
        "UPDATE orders SET status=?,stripe_session=?,lease_until=0,updated_at=? WHERE id=? AND status='pending'",
      )
        .bind(
          event.type === "checkout.session.expired" ? "expired" : "cancelled",
          session.id,
          now(),
          order.id,
        )
        .run();
    }
    return json({ received: true });
  }
  await recordPayment(env, order, session.id, event.id);
  if (env.JOBS) await env.JOBS.send({ orderId: order.id });
  return json({ received: true });
});
export const printfulWebhook = handler(async (request, env) => {
  if (!env.PRINTFUL_WEBHOOK_SECRET || !env.PRINTFUL_WEBHOOK_PUBLIC_KEY)
    throw new ShopError("Webhook not configured.", 503);
  if (
    !equal(
      request.headers.get("x-pf-webhook-public-key") ?? "",
      env.PRINTFUL_WEBHOOK_PUBLIC_KEY,
    )
  )
    throw new ShopError("Invalid webhook.", 403);
  const text = await boundedText(request, 262_144);
  await verifyPrintfulSignature(
    env.PRINTFUL_WEBHOOK_SECRET,
    text,
    request.headers.get("x-pf-webhook-signature") ?? "",
  );
  const event = JSON.parse(text) as {
    store_id: number;
    data?: { order?: { external_id?: string } };
  };
  if (!event || !Number.isSafeInteger(event.store_id))
    throw new ShopError("Invalid Printful event.");
  if (String(event.store_id) !== env.PRINTFUL_STORE_ID)
    throw new ShopError("Wrong Printful store.");
  const id = event.data?.order?.external_id;
  if (typeof id !== "string" || !/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(id))
    return json({ received: true });
  // Notifications only trigger an authenticated provider re-fetch, never a trusted status update.
  await env.DB.prepare(
    "UPDATE orders SET retry_at=0 WHERE id=? AND status IN ('submitted','submitting','shipped')",
  )
    .bind(id)
    .run();
  if (env.JOBS) await env.JOBS.send({ orderId: id });
  return json({ received: true });
});
export const orderStatus = handler(async (request, env: Env) => {
  sameOrigin(request, env);
  const data = await body(request);
  const token = typeof data.token === "string" ? data.token : "";
  if (!/^(?:[a-f0-9]{32}|[a-f0-9-]{36})\.[a-f0-9]{64}$/.test(token))
    throw new ShopError("Order link not found.", 404);
  const id = token.split(".")[0];
  if (!env.ORDER_TOKEN_SECRET || !equal(token, await orderToken(env, id)))
    throw new ShopError("Order link not found.", 404);
  const order = await env.DB.prepare(
    "SELECT * FROM orders WHERE id=? AND token_revoked=0",
  )
    .bind(id)
    .first<Order>();
  if (!order || now() - order.created_at > 90 * 86400)
    throw new ShopError("This order link has expired.", 404);
  const quote: Quote = JSON.parse(order.snapshot);
  const payment = await env.DB.prepare(
    "SELECT id FROM payment_events WHERE order_id=? LIMIT 1",
  )
    .bind(order.id)
    .first();
  return json({
    orderId: order.id,
    status: order.status,
    paymentConfirmed: payment !== null,
    testMode: env.SHOP_MODE === "test",
    shipments: JSON.parse(order.shipments),
    items: quote.items.map((item) => ({
      variantId: item.variantId,
      quantity: item.quantity,
    })),
  });
});
