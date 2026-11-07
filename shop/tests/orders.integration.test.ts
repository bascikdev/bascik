import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";
import { type Env, hmac, now, orderToken } from "../src/lib/platform.ts";
import { products } from "../src/lib/catalog.ts";
import {
  quoteRequest,
  checkoutRequest,
  printfulItems,
  type Quote,
} from "../src/lib/checkout.ts";
import {
  stripeWebhook,
  orderStatus,
  printfulWebhook,
} from "../src/lib/webhooks.ts";
import {
  processOrder,
  sendNotifications,
  sweep,
  processOrderMessage,
} from "../src/lib/fulfillment.ts";

let runtime: Miniflare;
let env: Env;
const origin = "https://shop.example.com";
const quoteId = "quote_fixture";
const id = "32ce1859bfe24c8fa5c68863b425379f";
const variantId = products[0].variants[0].id;
const snapshot: Quote = {
  recipient: {
    name: "Test Buyer",
    email: "buyer@example.com",
    address1: "Example street",
    address2: "",
    city: "Example",
    state_code: "CA",
    country_code: "US",
    zip: "90001",
  },
  items: [
    {
      variantId,
      quantity: 1,
      price: 3000,
      title: "Test shirt",
      variant_id: 456,
      placements: [
        {
          placement: "front",
          technique: "dtg",
          layers: [
            {
              type: "file",
              url: "https://example.com/art.png",
              position: { width: 10, height: 10, top: 1, left: 1 },
            },
          ],
        },
      ],
    },
  ],
  rates: [{ id: "STANDARD", name: "Standard", amount: 500, currency: "usd" }],
  subtotal: 3000,
};
const payment = {
  id: "cs_test_fixture",
  payment_status: "paid",
  currency: "usd",
  amount_subtotal: 3000,
  amount_total: 3750,
  livemode: false,
  metadata: { app: "bascik-shop", order_id: id, shop_origin: origin },
  total_details: { amount_shipping: 500, amount_tax: 250, amount_discount: 0 },
  automatic_tax: { status: "complete" },
};
beforeAll(async () => {
  runtime = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('fixture'); } }",
    compatibilityDate: "2026-07-30",
    d1Databases: ["DB"],
  });
  const DB = await runtime.getD1Database("DB");
  const sql =
    (await readFile("migrations/0001_shop.sql", "utf8")) +
    "\n" +
    (await readFile("migrations/0002_printful_v2.sql", "utf8")) +
    "\n" +
    (await readFile("migrations/0003_printful_templates.sql", "utf8")) +
    "\n" +
    (await readFile("migrations/0004_order_confirmation.sql", "utf8")) +
    "\n" +
    (await readFile("migrations/0005_vinyl_decals.sql", "utf8"));
  await DB.batch(
    sql
      .split(";")
      .map((statement) => statement.trim())
      .filter(Boolean)
      .map((statement) => DB.prepare(statement)),
  );
  env = {
    DB,
    SHOP_ORIGIN: origin,
    SHOP_ENABLED: "true",
    SHOP_MODE: "test",
    SHOP_FULFILLMENT_ENABLED: "true",
    STRIPE_SECRET_KEY: "sk_test_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_fixture",
    ORDER_TOKEN_SECRET: "fixture-order-token-secret-long-enough",
    PRINTFUL_TOKEN: "fixture",
    PRINTFUL_STORE_ID: "123",
    PRINTFUL_WEBHOOK_SECRET: "ab".repeat(32),
    PRINTFUL_WEBHOOK_PUBLIC_KEY: "fixture-public-key",
    EMAIL_FROM: "sender@example.com",
    ALERT_EMAIL: "operator@example.com",
    SUPPORT_EMAIL: "support@example.com",
    TAX_CODE_SHIRT: "txcd_30011000",
    TAX_CODE_HAT: "txcd_30011000",
    EMAIL: { send: vi.fn(async () => ({ messageId: "fixture-message" })) },
  };
});
beforeEach(async () => {
  vi.restoreAllMocks();
  env.SHOP_MODE = "test";
  env.STRIPE_SECRET_KEY = "sk_test_fixture";
  payment.livemode = false;
  for (const table of [
    "notifications",
    "payment_events",
    "orders",
    "quotes",
    "variant_mappings",
    "printful_v2_mappings",
    "printful_template_mappings",
    "rate_limits",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare(
    "INSERT INTO quotes(id,snapshot,expires_at) VALUES (?,?,?)",
  )
    .bind(quoteId, JSON.stringify(snapshot), now() + 900)
    .run();
  await env.DB.prepare(
    "INSERT INTO orders(id,quote_id,shipping_id,snapshot,stripe_session,created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
  )
    .bind(
      id,
      quoteId,
      "STANDARD",
      JSON.stringify(snapshot),
      payment.id,
      now(),
      now(),
    )
    .run();
  env.EMAIL = { send: vi.fn(async () => ({ messageId: "fixture-message" })) };
});
afterAll(async () => {
  await runtime.dispose();
});
function post(path: string, data: unknown) {
  return new Request(`${origin}${path}`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(data),
  });
}
async function eventRequest(
  eventId: string,
  session = payment,
  type = "checkout.session.completed",
) {
  const payload = JSON.stringify({
    id: eventId,
    type,
    livemode: false,
    data: { object: session },
  });
  const timestamp = now();
  return new Request(`${origin}/api/webhooks/stripe`, {
    method: "POST",
    body: payload,
    headers: {
      "stripe-signature": `t=${timestamp},v1=${await hmac(env.STRIPE_WEBHOOK_SECRET, `${timestamp}.${payload}`)}`,
    },
  });
}
test("duplicate Stripe deliveries durably record payment without regressing fulfillment", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json(payment),
  );
  const context = { platform: { env } };
  expect(
    (await stripeWebhook(await eventRequest("evt_fixture"), context)).status,
  ).toBe(200);
  await env.DB.prepare("UPDATE orders SET status='submitted' WHERE id=?")
    .bind(id)
    .run();
  expect(
    (await stripeWebhook(await eventRequest("evt_fixture"), context)).status,
  ).toBe(200);
  const order = await env.DB.prepare("SELECT status FROM orders WHERE id=?")
    .bind(id)
    .first<{ status: string }>();
  expect(order?.status).toBe("submitted");
  expect(
    (await env.DB.prepare("SELECT * FROM payment_events").all()).results,
  ).toHaveLength(1);
  expect(
    (await env.DB.prepare("SELECT * FROM notifications").all()).results,
  ).toHaveLength(1);
});
test("ignores another business's payment on the shared Stripe account", async () => {
  const fetcher = vi.spyOn(globalThis, "fetch");
  const unrelated = {
    ...payment,
    metadata: { ...payment.metadata, app: "unrelated" },
  };
  const response = await stripeWebhook(
    await eventRequest("evt_other", unrelated),
    { platform: { env } },
  );
  expect(response.status).toBe(200);
  expect(fetcher).not.toHaveBeenCalled();
});
test("does not accept an unpaid or mismatched payment", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ ...payment, payment_status: "unpaid" }),
  );
  expect(
    (
      await stripeWebhook(await eventRequest("evt_unpaid"), {
        platform: { env },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first<{ status: string }>()
    )?.status,
  ).toBe("pending");
});

test("delayed sandbox payment remains pending until the asynchronous success callback", async () => {
  let paymentStatus = "unpaid";
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ ...payment, payment_status: paymentStatus }),
  );
  const context = { platform: { env } };
  expect(
    (await stripeWebhook(await eventRequest("evt_delayed_completed"), context))
      .status,
  ).toBe(200);
  expect(
    await env.DB.prepare("SELECT status FROM orders WHERE id=?")
      .bind(id)
      .first(),
  ).toMatchObject({ status: "pending" });
  expect(
    (await env.DB.prepare("SELECT * FROM payment_events").all()).results,
  ).toHaveLength(0);
  expect(
    (await env.DB.prepare("SELECT * FROM notifications").all()).results,
  ).toHaveLength(0);
  paymentStatus = "paid";
  const success = await eventRequest(
    "evt_delayed_success",
    payment,
    "checkout.session.async_payment_succeeded",
  );
  expect((await stripeWebhook(success, context)).status).toBe(200);
  expect(
    await env.DB.prepare("SELECT status FROM orders WHERE id=?")
      .bind(id)
      .first(),
  ).toMatchObject({ status: "paid" });
  expect(
    (await env.DB.prepare("SELECT * FROM payment_events").all()).results,
  ).toHaveLength(1);
  expect(
    (await env.DB.prepare("SELECT * FROM notifications").all()).results,
  ).toHaveLength(1);
  expect(env.EMAIL!.send).not.toHaveBeenCalled();
});

test.each([
  ["checkout.session.async_payment_failed", "cancelled"],
  ["checkout.session.expired", "expired"],
])(
  "unpaid %s closes the order without authorizing fulfillment",
  async (type, status) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ...payment, payment_status: "unpaid" }),
    );
    expect(
      (
        await stripeWebhook(
          await eventRequest("evt_unpaid_terminal", payment, type),
          { platform: { env } },
        )
      ).status,
    ).toBe(200);
    await processOrder(env, id);
    expect(
      await env.DB.prepare("SELECT status,printful_id FROM orders WHERE id=?")
        .bind(id)
        .first(),
    ).toMatchObject({ status, printful_id: null });
    expect(
      (await env.DB.prepare("SELECT * FROM payment_events").all()).results,
    ).toHaveLength(0);
    expect(
      (await env.DB.prepare("SELECT * FROM notifications").all()).results,
    ).toHaveLength(0);
    expect(env.EMAIL!.send).not.toHaveBeenCalled();
  },
);

test("payment callbacks continue after the storefront is closed", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json(payment),
  );
  const closed = { ...env, SHOP_ENABLED: "false" };
  const response = await stripeWebhook(await eventRequest("evt_closed"), {
    platform: { env: closed },
  });
  expect(response.status).toBe(200);
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first<{ status: string }>()
    )?.status,
  ).toBe("paid");
});

test("a paid amount mismatch never authorizes production", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({ ...payment, amount_total: 1 }),
  );
  const response = await stripeWebhook(await eventRequest("evt_mismatch"), {
    platform: { env },
  });
  expect(response.status).toBe(502);
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first<{ status: string }>()
    )?.status,
  ).toBe("pending");
});
test("the scheduled sweep recovers a missing payment webhook even with the storefront closed", async () => {
  await env.DB.prepare("UPDATE orders SET created_at=? WHERE id=?")
    .bind(now() - 120, id)
    .run();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json(payment),
  );
  await sweep({
    ...env,
    SHOP_ENABLED: "false",
    SHOP_FULFILLMENT_ENABLED: "false",
  });
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first<{ status: string }>()
    )?.status,
  ).toBe("paid");
  expect(
    (await env.DB.prepare("SELECT * FROM payment_events").all()).results,
  ).toHaveLength(1);
  expect(env.EMAIL!.send).not.toHaveBeenCalled();
});
test("expired unpaid sessions do not clear the cart or create notifications", async () => {
  await env.DB.prepare("UPDATE orders SET created_at=? WHERE id=?")
    .bind(now() - 120, id)
    .run();
  vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      ...payment,
      payment_status: "unpaid",
      status: "expired",
      automatic_tax: { status: "requires_location_inputs" },
    }),
  );
  await sweep(env);
  const response = await orderStatus(
    post("/api/order", { token: await orderToken(env, id) }),
    { platform: { env } },
  );
  expect(await response.json()).toMatchObject({
    status: "expired",
    paymentConfirmed: false,
  });
  expect(env.EMAIL!.send).not.toHaveBeenCalled();
});
test("provider throttling preserves the paid order and respects Retry-After", async () => {
  await env.DB.prepare("UPDATE orders SET status='paid' WHERE id=?")
    .bind(id)
    .run();
  const time = now();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () =>
      Response.json({}, { status: 429, headers: { "retry-after": "600" } }),
    );
  await processOrder(env, id);
  const order = await env.DB.prepare(
    "SELECT status,retry_at FROM orders WHERE id=?",
  )
    .bind(id)
    .first<{ status: string; retry_at: number }>();
  expect(order?.status).toBe("paid");
  expect(order?.retry_at).toBeGreaterThanOrEqual(time + 600);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
  ["checkout.session.async_payment_failed", "cancelled"],
  ["checkout.session.expired", "expired"],
])(
  "unpaid %s does not produce a confirmation or authorize fulfillment",
  async (type, status) => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({ ...payment, payment_status: "unpaid" }),
    );
    const response = await stripeWebhook(
      await eventRequest("evt_unpaid_terminal", payment, type),
      { platform: { env } },
    );
    expect(response.status).toBe(200);
    expect(
      (
        await env.DB.prepare("SELECT status FROM orders WHERE id=?")
          .bind(id)
          .first<{ status: string }>()
      )?.status,
    ).toBe(status);
    expect(
      (await env.DB.prepare("SELECT * FROM notifications").all()).results,
    ).toHaveLength(0);
    expect(
      (await env.DB.prepare("SELECT * FROM payment_events").all()).results,
    ).toHaveLength(0);
  },
);
test("an out-of-order unpaid failure never regresses a recorded paid order", async () => {
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(payment));
  await stripeWebhook(await eventRequest("evt_paid_first"), {
    platform: { env },
  });
  fetcher.mockImplementation(async () =>
    Response.json({ ...payment, payment_status: "unpaid" }),
  );
  await stripeWebhook(
    await eventRequest(
      "evt_failure_late",
      payment,
      "checkout.session.async_payment_failed",
    ),
    { platform: { env } },
  );
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first<{ status: string }>()
    )?.status,
  ).toBe("paid");
});
test("private order tokens work, public payment IDs and forged tokens do not", async () => {
  const token = await orderToken(env, id);
  const context = { platform: { env } };
  expect(
    (await orderStatus(post("/api/order", { token }), context)).status,
  ).toBe(200);
  expect(
    (await orderStatus(post("/api/order", { token: payment.id }), context))
      .status,
  ).toBe(404);
  const response = await orderStatus(post("/api/order", { token }), context);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await response.json())).not.toContain(
    "buyer@example.com",
  );
});
test("printable confirmation exposes only verified purchase totals and a stable reference", async () => {
  const token = await orderToken(env, id);
  const context = { platform: { env } };
  const pending = await orderStatus(post("/api/order", { token }), context);
  expect(await pending.json()).toMatchObject({
    paymentConfirmed: false,
    summary: null,
    confirmationEmail: "disabled",
  });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payment));
  await stripeWebhook(await eventRequest("evt_confirmation"), context);
  const paid = await orderStatus(post("/api/order", { token }), context);
  const result = await paid.json();
  expect(result).toMatchObject({
    paymentConfirmed: true,
    summary: {
      reference: `BASCIK-${id.toUpperCase()}`,
      items: [{ title: "Test shirt", price: 3000, quantity: 1, variantId }],
      subtotal: 3000,
      shipping: 500,
      tax: 250,
      total: 3750,
    },
  });
  const text = JSON.stringify(result);
  for (const privateValue of [
    snapshot.recipient.email,
    snapshot.recipient.name,
    snapshot.recipient.address1,
    payment.id,
    "https://example.com/art.png",
  ])
    expect(text).not.toContain(privateValue);
  await stripeWebhook(await eventRequest("evt_confirmation"), context);
  const repeated = await orderStatus(post("/api/order", { token }), context);
  expect((await repeated.json()).summary).toEqual(result.summary);
});
test("legacy paid order confirmation does not invent unrecorded tax or a final total", async () => {
  await env.DB.prepare(
    "INSERT INTO payment_events(id,order_id,created_at) VALUES (?,?,?)",
  )
    .bind("evt_legacy", id, now())
    .run();
  const result = await orderStatus(
    post("/api/order", { token: await orderToken(env, id) }),
    { platform: { env } },
  );
  expect((await result.json()).summary).toMatchObject({
    reference: `BASCIK-${id.toUpperCase()}`,
    tax: null,
    total: null,
  });
});
test("forged Printful events cannot mutate order state", async () => {
  const response = await printfulWebhook(
    post("/api/webhooks/printful?key=wrong", {
      store_id: 123,
      data: { order: { external_id: id } },
    }),
    { platform: { env } },
  );
  expect(response.status).toBe(403);
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first<{ status: string }>()
    )?.status,
  ).toBe("pending");
});
test("concurrent consumers create and confirm only one physical order", async () => {
  env.SHOP_MODE = "live";
  env.STRIPE_SECRET_KEY = "sk_live_fixture";
  payment.livemode = true;
  await env.DB.prepare("UPDATE orders SET status='paid' WHERE id=?")
    .bind(id)
    .run();
  const requests: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    requests.push(`${init?.method ?? "GET"} ${url}`);
    if (new URL(url).hostname === "api.stripe.com")
      return Response.json(payment);
    if (url.includes("/orders/@"))
      return Response.json({ code: 404 }, { status: 404 });
    if (url.includes("/shipments"))
      return Response.json({
        data: [],
        paging: { total: 0, offset: 0, limit: 100 },
      });
    if (url.endsWith("/v2/orders")) {
      const submitted = JSON.parse(String(init?.body));
      expect(submitted.order_items).toEqual([
        {
          source: "catalog",
          catalog_variant_id: 456,
          quantity: 1,
          retail_price: "30.00",
          placements: snapshot.items[0].placements,
        },
      ]);
      expect(submitted.items).toBeUndefined();
    }
    if (url.includes("/confirm"))
      return Response.json({
        data: {
          id: 100,
          external_id: id,
          status: "pending",
          costs: { calculation_status: "done" },
        },
      });
    return Response.json({
      data: {
        id: 100,
        external_id: id,
        status: "draft",
        costs: { calculation_status: "done" },
      },
    });
  });
  await Promise.all([processOrder(env, id), processOrder(env, id)]);
  expect(
    requests.filter(
      (request) => request === "POST https://api.printful.com/v2/orders",
    ),
  ).toHaveLength(1);
  expect(
    requests.filter((request) => request.includes("/confirm")),
  ).toHaveLength(1);
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first<{ status: string }>()
    )?.status,
  ).toBe("submitted");
});
test("an ambiguous submission goes to operator review rather than creating another order", async () => {
  await env.DB.prepare("UPDATE orders SET status='submitting' WHERE id=?")
    .bind(id)
    .run();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      new URL(String(input)).hostname === "api.stripe.com"
        ? Response.json(payment)
        : Response.json({}, { status: 404 }),
    );
  await processOrder(env, id);
  expect(
    fetcher.mock.calls.every(([, options]) => options?.method !== "POST"),
  ).toBe(true);
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first<{ status: string }>()
    )?.status,
  ).toBe("failed");
  expect(
    (
      await env.DB.prepare("SELECT kind FROM notifications").all<{
        kind: string;
      }>()
    ).results[0].kind,
  ).toBe("alert");
});
test("v2 draft calculation waits and reuses the external reference before confirmation", async () => {
  await env.DB.prepare("UPDATE orders SET status='paid' WHERE id=?")
    .bind(id)
    .run();
  let created = false;
  let calculated = false;
  const calls: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    if (new URL(url).hostname === "api.stripe.com")
      return Response.json(payment);
    if (url.includes("/shipments"))
      return Response.json({
        data: [],
        paging: { total: 0, limit: 100, offset: 0 },
      });
    if (url.includes("/orders/@") && !created)
      return Response.json({}, { status: 404 });
    if (init?.method === "POST" && url.endsWith("/orders")) created = true;
    return Response.json({
      data: {
        id: 100,
        external_id: id,
        status: url.endsWith("/confirmation") ? "pending" : "draft",
        costs: { calculation_status: calculated ? "done" : "calculating" },
      },
    });
  });
  await processOrder(env, id);
  expect(calls.filter((url) => url.includes("/confirmation"))).toHaveLength(0);
  expect(
    await env.DB.prepare("SELECT status,lease_until FROM orders WHERE id=?")
      .bind(id)
      .first(),
  ).toMatchObject({ status: "submitting", lease_until: 0 });
  calculated = true;
  await env.DB.prepare("UPDATE orders SET retry_at=0 WHERE id=?")
    .bind(id)
    .run();
  await processOrder(env, id);
  expect(
    calls.filter((url) => url === "POST https://api.printful.com/v2/orders"),
  ).toHaveLength(1);
  expect(calls.filter((url) => url.includes("/confirmation"))).toHaveLength(0);
  expect(
    (
      await env.DB.prepare("SELECT status FROM orders WHERE id=?")
        .bind(id)
        .first()
    )?.status,
  ).toBe("test_draft");
});
test("sandbox payment webhook creates one unconfirmed draft and never emails or confirms production", async () => {
  let created = false;
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      const url = String(input);
      if (new URL(url).hostname === "api.stripe.com")
        return Response.json(payment);
      if (url.includes("/confirmation"))
        throw new Error("Test mode reached production");
      if (url.includes("/orders/@") && !created)
        return Response.json({}, { status: 404 });
      if (init?.method === "POST" && url.endsWith("/orders")) created = true;
      return Response.json({
        data: {
          id: 100,
          external_id: id,
          status: "draft",
          costs: { calculation_status: "done" },
        },
      });
    });
  await stripeWebhook(await eventRequest("evt_sandbox_draft", payment), {
    platform: { env },
  });
  await Promise.all([processOrder(env, id), processOrder(env, id)]);
  await sweep(env);
  await stripeWebhook(await eventRequest("evt_sandbox_duplicate", payment), {
    platform: { env },
  });
  const order = await env.DB.prepare(
    "SELECT status,printful_id FROM orders WHERE id=?",
  )
    .bind(id)
    .first();
  expect(order).toMatchObject({ status: "test_draft", printful_id: 100 });
  expect(
    fetcher.mock.calls.filter(
      ([input, init]) =>
        String(input).endsWith("/v2/orders") && init?.method === "POST",
    ),
  ).toHaveLength(1);
  expect(
    fetcher.mock.calls.some(([input]) =>
      String(input).includes("/confirmation"),
    ),
  ).toBe(false);
  expect(env.EMAIL!.send).not.toHaveBeenCalled();
});
test.each(["failed", "calculating"])(
  "v2 draft costs %s cannot confirm after exhausted attempts",
  async (calculation_status) => {
    await env.DB.prepare(
      "UPDATE orders SET status='submitting',attempts=7 WHERE id=?",
    )
      .bind(id)
      .run();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        new URL(String(input)).hostname === "api.stripe.com"
          ? Response.json(payment)
          : Response.json({
              data: {
                id: 100,
                external_id: id,
                status: "draft",
                costs: { calculation_status },
              },
            }),
      );
    await processOrder(env, id);
    expect(
      (
        await env.DB.prepare("SELECT status FROM orders WHERE id=?")
          .bind(id)
          .first()
      )?.status,
    ).toBe("failed");
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).includes("/confirmation"),
      ),
    ).toBe(false);
  },
);
test("v2 callbacks use store_id and only schedule authenticated reconciliation", async () => {
  await env.DB.prepare(
    "UPDATE orders SET status='submitted',retry_at=? WHERE id=?",
  )
    .bind(now() + 900, id)
    .run();
  const text = JSON.stringify({
    store_id: 123,
    type: "shipment_sent",
    data: { order: { external_id: id } },
  });
  const response = await printfulWebhook(
    new Request(`${origin}/api/webhooks/printful`, {
      method: "POST",
      body: text,
      headers: {
        "x-pf-webhook-public-key": env.PRINTFUL_WEBHOOK_PUBLIC_KEY,
        "x-pf-webhook-signature": createHmac(
          "sha256",
          Buffer.from(env.PRINTFUL_WEBHOOK_SECRET, "hex"),
        )
          .update(text)
          .digest("hex"),
      },
    }),
    { platform: { env } },
  );
  expect(response.status).toBe(200);
  expect(
    await env.DB.prepare("SELECT status,retry_at FROM orders WHERE id=?")
      .bind(id)
      .first(),
  ).toMatchObject({ status: "submitted", retry_at: 0 });
});
test("customer notification retries survive failure and concurrent delivery", async () => {
  env.SHOP_MODE = "live";
  await env.DB.prepare(
    "INSERT INTO notifications(id,order_id,kind,created_at) VALUES (?,?,?,?)",
  )
    .bind("message", id, "confirmation", now())
    .run();
  vi.mocked(env.EMAIL!.send).mockRejectedValueOnce(
    new Error("Temporary provider failure"),
  );
  await sendNotifications(env);
  await sendNotifications(env);
  expect(env.EMAIL!.send).toHaveBeenCalledTimes(1);
  expect(
    await env.DB.prepare(
      "SELECT status,retry_at FROM notifications WHERE id='message'",
    ).first<{ status: string; retry_at: number }>(),
  ).toMatchObject({ status: "pending" });
  await env.DB.prepare(
    "UPDATE notifications SET retry_at=0 WHERE id='message'",
  ).run();
  await Promise.all([sendNotifications(env), sendNotifications(env)]);
  expect(env.EMAIL!.send).toHaveBeenCalledTimes(2);
  expect(
    await env.DB.prepare(
      "SELECT status,message_id,sent_at FROM notifications WHERE id='message'",
    ).first(),
  ).toMatchObject({
    status: "sent",
    message_id: "fixture-message",
    sent_at: expect.any(Number),
  });
  expect(env.EMAIL!.send).toHaveBeenLastCalledWith(
    expect.objectContaining({
      subject: `Order confirmation: BASCIK-${id.toUpperCase()}`,
      text: expect.stringContaining(`Order number: BASCIK-${id.toUpperCase()}`),
    }),
  );
});
test("confirmation email contains verified totals and never promises a separate receipt email", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payment));
  await stripeWebhook(await eventRequest("evt_email"), { platform: { env } });
  env.SHOP_MODE = "live";
  await sendNotifications(env);
  expect(env.EMAIL!.send).toHaveBeenCalledTimes(1);
  const message = vi.mocked(env.EMAIL!.send).mock.calls[0][0];
  expect(message.from).toEqual({ name: "Bascik Shop", email: env.EMAIL_FROM });
  expect(message.replyTo).toBe(env.SUPPORT_EMAIL);
  expect(message.html).toContain("background-color:#18191b");
  expect(message.html).toContain("background-color:#d3ff8d");
  expect(message.html).toContain("$37.50");
  expect(message.text).toContain("Subtotal: $30.00");
  expect(message.text).toContain("Shipping (Standard): $5.00");
  expect(message.text).toContain("Tax: $2.50");
  expect(message.text).toContain("Total paid: $37.50");
  expect(message.text).toContain("printable confirmation");
  expect(message.text).not.toContain("Stripe sends");
});
test("queue processing sends confirmation without waiting for the scheduled sweep or manufacturing", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(payment));
  await stripeWebhook(await eventRequest("evt_queue_email"), {
    platform: { env },
  });
  env.SHOP_MODE = "live";
  const fetcher = vi.spyOn(globalThis, "fetch");
  fetcher.mockClear();
  await processOrderMessage({ ...env, SHOP_FULFILLMENT_ENABLED: "false" }, id);
  expect(env.EMAIL!.send).toHaveBeenCalledTimes(1);
  expect(fetcher).not.toHaveBeenCalled();
  await processOrderMessage({ ...env, SHOP_FULFILLMENT_ENABLED: "false" }, id);
  expect(env.EMAIL!.send).toHaveBeenCalledTimes(1);
  const result = await orderStatus(
    post("/api/order", { token: await orderToken(env, id) }),
    { platform: { env } },
  );
  expect(await result.json()).toMatchObject({
    confirmationEmail: "sent",
    summary: { total: 3750 },
  });
});
test("operator alerts do not depend on valid customer receipt shipping details", async () => {
  env.SHOP_MODE = "live";
  await env.DB.prepare("UPDATE orders SET snapshot=? WHERE id=?")
    .bind(JSON.stringify({ ...snapshot, rates: [] }), id)
    .run();
  await env.DB.prepare(
    "INSERT INTO notifications(id,order_id,kind,created_at) VALUES (?,?,?,?)",
  )
    .bind("alert-message", id, "alert", now())
    .run();
  await sendNotifications(env);
  expect(env.EMAIL!.send).toHaveBeenCalledWith(
    expect.objectContaining({
      to: env.ALERT_EMAIL,
      subject: expect.stringContaining("needs attention"),
    }),
  );
});
test("partial shipment updates retain tracking and deduplicate earlier shipments", async () => {
  env.SHOP_MODE = "live";
  env.STRIPE_SECRET_KEY = "sk_live_fixture";
  payment.livemode = true;
  await env.DB.prepare("UPDATE orders SET status='submitted' WHERE id=?")
    .bind(id)
    .run();
  let polls = 0;
  const first = {
    id: 1,
    carrier: "Fixture",
    tracking_number: "TRACK1",
    tracking_url: "https://example.com/track/1",
  };
  const second = {
    id: 2,
    carrier: "Fixture",
    tracking_number: "TRACK2",
    tracking_url: "https://example.com/track/2",
  };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (new URL(String(input)).hostname === "api.stripe.com")
      return Response.json(payment);
    if (String(input).includes("/shipments")) {
      const shipments = polls === 1 ? [first] : [first, second];
      return Response.json({
        data: shipments,
        paging: { total: shipments.length, offset: 0, limit: 100 },
      });
    }
    ++polls;
    return Response.json({
      data: {
        id: 100,
        external_id: id,
        status: polls === 1 ? "partial" : "fulfilled",
        costs: { calculation_status: "done" },
      },
    });
  });
  await processOrder(env, id);
  await env.DB.prepare("UPDATE orders SET retry_at=0 WHERE id=?")
    .bind(id)
    .run();
  await processOrder(env, id);
  const order = await env.DB.prepare(
    "SELECT status,shipments FROM orders WHERE id=?",
  )
    .bind(id)
    .first<{ status: string; shipments: string }>();
  expect(order?.status).toBe("shipped");
  expect(JSON.parse(order!.shipments)).toEqual([first, second]);
  expect(
    (await env.DB.prepare("SELECT kind FROM notifications ORDER BY kind").all())
      .results,
  ).toEqual([{ kind: "shipment:1" }, { kind: "shipment:2" }]);
});
test("late shipped callbacks and recovery refresh tracking without manufacturing again", async () => {
  env.SHOP_MODE = "live";
  env.STRIPE_SECRET_KEY = "sk_live_fixture";
  payment.livemode = true;
  await env.DB.prepare(
    "UPDATE orders SET status='shipped',printful_id=100,retry_at=? WHERE id=?",
  )
    .bind(now() + 900, id)
    .run();
  const shipment = {
    id: 3,
    carrier: "Fixture",
    tracking_number: "RESHIP",
    tracking_url: "https://example.com/track/3",
  };
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) => {
      const url = String(input);
      if (new URL(url).hostname === "api.stripe.com")
        return Response.json(payment);
      if (new URL(url).pathname.endsWith("/shipments"))
        return Response.json({
          data: [shipment],
          paging: { total: 1, offset: 0, limit: 100 },
        });
      return Response.json({
        data: {
          id: 100,
          external_id: id,
          status: "fulfilled",
          costs: { calculation_status: "done" },
        },
      });
    });
  const event = JSON.stringify({
    store_id: 123,
    data: { order: { external_id: id } },
  });
  const response = await printfulWebhook(
    new Request(`${origin}/api/webhooks/printful`, {
      method: "POST",
      body: event,
      headers: {
        "x-pf-webhook-public-key": env.PRINTFUL_WEBHOOK_PUBLIC_KEY,
        "x-pf-webhook-signature": createHmac(
          "sha256",
          Buffer.from(env.PRINTFUL_WEBHOOK_SECRET, "hex"),
        )
          .update(event)
          .digest("hex"),
      },
    }),
    { platform: { env } },
  );
  expect(response.status).toBe(200);
  await Promise.all([processOrder(env, id), processOrder(env, id)]);
  expect(
    await env.DB.prepare("SELECT status,shipments FROM orders WHERE id=?")
      .bind(id)
      .first(),
  ).toMatchObject({ status: "shipped", shipments: JSON.stringify([shipment]) });
  await env.DB.prepare("UPDATE orders SET retry_at=0 WHERE id=?")
    .bind(id)
    .run();
  await sweep(env);
  expect(
    await env.DB.prepare(
      "SELECT kind FROM notifications WHERE kind='shipment:3'",
    ).all(),
  ).toMatchObject({ results: [{ kind: "shipment:3" }] });
  expect(
    fetcher.mock.calls.filter(([input]) =>
      new URL(String(input)).pathname.endsWith("/shipments"),
    ),
  ).toHaveLength(2);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false,
  );
});
test("shipped orders cannot create or confirm drafts when provider state regresses", async () => {
  env.SHOP_MODE = "live";
  env.STRIPE_SECRET_KEY = "sk_live_fixture";
  payment.livemode = true;
  await env.DB.prepare("UPDATE orders SET status='shipped' WHERE id=?")
    .bind(id)
    .run();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      new URL(String(input)).hostname === "api.stripe.com"
        ? Response.json(payment)
        : Response.json({
            data: { id: 100, external_id: id, status: "draft" },
          }),
    );
  await processOrder(env, id);
  expect(fetcher.mock.calls.some(([, init]) => init?.method === "POST")).toBe(
    false,
  );
  expect(
    await env.DB.prepare("SELECT status FROM orders WHERE id=?")
      .bind(id)
      .first(),
  ).toMatchObject({ status: "failed" });
});
test.each(["stripe", "printful"])(
  "%s webhooks reject oversized multibyte payloads before signature processing",
  async (provider) => {
    const action = provider === "stripe" ? stripeWebhook : printfulWebhook;
    const response = await action(
      new Request(`${origin}/api/webhooks/${provider}`, {
        method: "POST",
        body: "é".repeat(131073),
        headers: { "x-pf-webhook-public-key": env.PRINTFUL_WEBHOOK_PUBLIC_KEY },
      }),
      { platform: { env } },
    );
    expect(response.status).toBe(413);
  },
);
test("hosted Checkout uses the fixed destination and does not recollect shipping", async () => {
  await env.DB.prepare("DELETE FROM orders").run();
  const requests: { url: string; body: URLSearchParams }[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
    const url = String(input);
    requests.push({ url, body: options?.body as URLSearchParams });
    return Response.json(
      url.endsWith("/customers")
        ? { id: "cus_fixture" }
        : { id: "cs_test_new", url: "https://checkout.stripe.com/test" },
    );
  });
  const result = await checkoutRequest(
    post("/api/checkout", { quoteId, shippingId: "STANDARD" }),
    env,
  );
  expect(result.status).toBe(200);
  const customer = requests.find((entry) =>
    entry.url.endsWith("/customers"),
  )!.body;
  const session = requests.find((entry) =>
    entry.url.endsWith("/checkout/sessions"),
  )!.body;
  expect(customer.get("shipping[address][country]")).toBe("US");
  expect(session.has("shipping_address_collection[allowed_countries][0]")).toBe(
    false,
  );
  expect(session.get("automatic_tax[enabled]")).toBe("true");
  expect(session.get("metadata[order_id]")).toMatch(/^[a-f0-9]{32}$/);
  expect(
    session.get(
      "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
    ),
  ).toBe("500");
});
test("existing UUID order links remain readable", async () => {
  const legacyId = "32ce1859-bfe2-4c8f-a5c6-8863b425379f";
  await env.DB.prepare("UPDATE orders SET id=? WHERE id=?")
    .bind(legacyId, id)
    .run();
  const result = await orderStatus(
    post("/api/order", { token: await orderToken(env, legacyId) }),
    { platform: { env } },
  );
  expect(result.status).toBe(200);
  expect(await result.json()).toMatchObject({ orderId: legacyId });
});
test("quotes require verified private mappings and server prices", async () => {
  await env.DB.prepare("INSERT INTO printful_v2_mappings VALUES (?,?,?,1)")
    .bind(variantId, 456, JSON.stringify(snapshot.items[0].placements))
    .run();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
    Response.json({
      data: String(input).endsWith("/v2/shipping-rates")
        ? [
            {
              shipping: "STANDARD",
              shipping_method_name: "Standard",
              rate: "5.00",
              currency: "USD",
            },
          ]
        : { costs: {} },
    }),
  );
  const result = await quoteRequest(
    post("/api/quote", {
      items: [{ variantId, quantity: 2, price: 1 }],
      recipient: snapshot.recipient,
    }),
    env,
  );
  expect((await result.json()).subtotal).toBe(6000);
});
test("legacy sync mappings cannot enable a v2 quote", async () => {
  await env.DB.prepare("INSERT INTO variant_mappings VALUES (?,?,?,1)")
    .bind(variantId, 123, 456)
    .run();
  const fetcher = vi.spyOn(globalThis, "fetch");
  await expect(
    quoteRequest(
      post("/api/quote", {
        items: [{ variantId, quantity: 1 }],
        recipient: snapshot.recipient,
      }),
      env,
    ),
  ).rejects.toThrow("not ready for ordering");
  expect(fetcher).not.toHaveBeenCalled();
});
test.each([
  [1, "US", "CA", false],
  [2, "US", "California", true],
  [2, "US", "AK", false],
  [2, "US", "HI", false],
  [2, "US", "DC", false],
  [2, "CA", "ON", false],
])(
  "new %i-shirt quote to %s/%s has free standard shipping: %s",
  async (quantity, country, state, free) => {
    await env.DB.prepare("INSERT INTO printful_v2_mappings VALUES (?,?,?,1)")
      .bind(variantId, 456, JSON.stringify(snapshot.items[0].placements))
      .run();
    await env.DB.prepare("DELETE FROM orders").run();
    let session: URLSearchParams | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/shipping-rates"))
        return Response.json({
          data: [
            {
              shipping: "STANDARD",
              shipping_method_name: "Standard",
              rate: "5.00",
              currency: "USD",
            },
            {
              shipping: "STANDARD_CARBON_OFFSET",
              shipping_method_name: "Carbon offset",
              rate: "6.00",
              currency: "USD",
            },
            {
              shipping: "EXPRESS",
              shipping_method_name: "Express",
              rate: "10.00",
              currency: "USD",
            },
          ],
        });
      if (url.endsWith("/customers"))
        return Response.json({ id: "cus_shipping_fixture" });
      session = init?.body as URLSearchParams;
      return Response.json({
        id: "cs_test_shipping_fixture",
        url: "https://checkout.stripe.com/test",
      });
    });
    const response = await quoteRequest(
      post("/api/quote", {
        items: [{ variantId, quantity, price: 1 }],
        subtotal: 999999,
        freeShipping: true,
        recipient: {
          ...snapshot.recipient,
          country_code: country,
          state_code: state,
        },
      }),
      env,
    );
    expect(response.status).toBe(200);
    const quoted = (await response.json()) as {
      quoteId: string;
      subtotal: number;
      rates: { id: string; amount: number; name: string }[];
    };
    expect(quoted.subtotal).toBe(quantity * 3000);
    expect(quoted.rates.map((rate) => rate.amount)).toEqual([
      free ? 0 : 500,
      600,
      1000,
    ]);
    expect(quoted.rates[0].name).toBe(
      free ? "Free standard shipping - Standard" : "Standard",
    );
    const created = await checkoutRequest(
      post("/api/checkout", {
        quoteId: quoted.quoteId,
        shippingId: "STANDARD",
      }),
      env,
    );
    expect(created.status).toBe(200);
    expect(
      session?.get(
        "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
      ),
    ).toBe(free ? "0" : "500");
    const order = await env.DB.prepare(
      "SELECT snapshot,shipping_id FROM orders WHERE quote_id=?",
    )
      .bind(quoted.quoteId)
      .first<{ snapshot: string; shipping_id: string }>();
    expect(order?.shipping_id).toBe("STANDARD");
    expect(JSON.parse(order!.snapshot).rates).toEqual(
      quoted.rates.map((rate) => ({ ...rate, currency: "usd" })),
    );
  },
);

test("exactly $50 merchandise does not qualify even when shipping brings the total above $50", async () => {
  const hat = products.find((product) => product.slug.includes("hat"))!
    .variants[0].id;
  await env.DB.prepare("INSERT INTO printful_v2_mappings VALUES (?,?,?,1)")
    .bind(hat, 456, JSON.stringify(snapshot.items[0].placements))
    .run();
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({
      data: [
        {
          shipping: "STANDARD",
          shipping_method_name: "Standard",
          rate: "5.00",
          currency: "USD",
        },
      ],
    }),
  );
  const response = await quoteRequest(
    post("/api/quote", {
      items: [{ variantId: hat, quantity: 2 }],
      recipient: snapshot.recipient,
    }),
    env,
  );
  expect(await response.json()).toMatchObject({
    subtotal: 5000,
    rates: [{ id: "STANDARD", amount: 500 }],
  });
});

test.each(["missing-standard", "invalid-rate", "provider-failure"])(
  "free shipping never invents availability on %s",
  async (mode) => {
    await env.DB.prepare("INSERT INTO printful_v2_mappings VALUES (?,?,?,1)")
      .bind(variantId, 456, JSON.stringify(snapshot.items[0].placements))
      .run();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      mode === "provider-failure"
        ? Response.json({ error: "unavailable" }, { status: 503 })
        : Response.json({
            data: [
              {
                shipping: mode === "missing-standard" ? "EXPRESS" : "STANDARD",
                shipping_method_name: "Shipping",
                rate: mode === "invalid-rate" ? "invalid" : "10.00",
                currency: "USD",
              },
            ],
          }),
    );
    const request = post("/api/quote", {
      items: [{ variantId, quantity: 2 }],
      recipient: snapshot.recipient,
    });
    if (mode === "missing-standard") {
      expect(await (await quoteRequest(request, env)).json()).toMatchObject({
        subtotal: 6000,
        rates: [{ id: "EXPRESS", amount: 1000 }],
      });
    } else {
      await expect(quoteRequest(request, env)).rejects.toThrow();
      expect(
        (
          await env.DB.prepare("SELECT id FROM quotes WHERE id!=?")
            .bind(quoteId)
            .all()
        ).results,
      ).toHaveLength(0);
    }
  },
);

test("old over-$50 pending quotes keep their original shipping amount when creating Checkout", async () => {
  const legacy = {
    ...snapshot,
    items: snapshot.items.map((item) => ({ ...item, quantity: 2 })),
    subtotal: 6000,
  };
  const saved = JSON.stringify(legacy);
  await env.DB.prepare("UPDATE quotes SET snapshot=? WHERE id=?")
    .bind(saved, quoteId)
    .run();
  await env.DB.prepare(
    "UPDATE orders SET snapshot=?,stripe_session=NULL WHERE id=?",
  )
    .bind(saved, id)
    .run();
  let session: URLSearchParams | undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    if (String(input).endsWith("/customers"))
      return Response.json({ id: "cus_legacy" });
    session = init?.body as URLSearchParams;
    return Response.json({
      id: "cs_test_legacy",
      url: "https://checkout.stripe.com/test",
    });
  });
  expect(
    (
      await checkoutRequest(
        post("/api/checkout", { quoteId, shippingId: "STANDARD" }),
        env,
      )
    ).status,
  ).toBe(200);
  expect(
    session?.get(
      "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
    ),
  ).toBe("500");
  expect(
    (
      await env.DB.prepare("SELECT snapshot FROM orders WHERE id=?")
        .bind(id)
        .first<{ snapshot: string }>()
    )?.snapshot,
  ).toBe(saved);
});

test.each([500, 0])(
  "paid orders over 50 dollars retain their saved %i-cent shipping through verification and fulfillment",
  async (shipping) => {
    env.SHOP_MODE = "live";
    env.STRIPE_SECRET_KEY = "sk_live_fixture";
    const saved = JSON.stringify({
      ...snapshot,
      items: snapshot.items.map((item) => ({ ...item, quantity: 2 })),
      subtotal: 6000,
      rates: [{ ...snapshot.rates[0], amount: shipping }],
    });
    await env.DB.prepare(
      "UPDATE orders SET snapshot=?,status='paid' WHERE id=?",
    )
      .bind(saved, id)
      .run();
    const paid = {
      ...payment,
      livemode: true,
      amount_subtotal: 6000,
      amount_total: 6000 + shipping + 250,
      total_details: { ...payment.total_details, amount_shipping: shipping },
    };
    await env.DB.prepare(
      "INSERT INTO payment_events(id,order_id,created_at) VALUES (?,?,?)",
    )
      .bind("evt_saved_shipping", id, now())
      .run();
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const url = String(input);
        if (url.startsWith("https://api.stripe.com"))
          return Response.json(paid);
        if (url.includes("/orders/@"))
          return Response.json({}, { status: 404 });
        if (url.endsWith("/confirmation"))
          return Response.json({
            data: {
              id: 100,
              external_id: id,
              status: "pending",
              costs: { calculation_status: "done" },
            },
          });
        if (url.includes("/shipments"))
          return Response.json({
            data: [],
            paging: { total: 0, offset: 0, limit: 100 },
          });
        expect(url).toBe("https://api.printful.com/v2/orders");
        const submitted = JSON.parse(String(init?.body));
        expect(submitted.shipping).toBe("STANDARD");
        expect(submitted.order_items[0].quantity).toBe(2);
        return Response.json({
          data: {
            id: 100,
            external_id: id,
            status: "draft",
            costs: { calculation_status: "done" },
          },
        });
      });
    await processOrder(env, id);
    const order = await env.DB.prepare(
      "SELECT snapshot,status,payment_tax,payment_total FROM orders WHERE id=?",
    )
      .bind(id)
      .first();
    expect(order).toMatchObject({
      snapshot: saved,
      status: "submitted",
      payment_tax: 250,
      payment_total: 6000 + shipping + 250,
    });
    const response = await orderStatus(
      post("/api/order", { token: await orderToken(env, id) }),
      { platform: { env } },
    );
    expect(await response.json()).toMatchObject({
      summary: { subtotal: 6000, shipping, total: 6000 + shipping + 250 },
    });
    expect(
      fetcher.mock.calls.filter(([input]) =>
        String(input).includes("/confirmation"),
      ),
    ).toHaveLength(1);
  },
);
test.each([
  [["bascik-logo-vinyl-decal"], 500],
  [["bascik-logo-vinyl-decal", "bascik-insignia-vinyl-decal"], 1000],
  [["bascik-logo-vinyl-decal", "bascik-insignia-vinyl-decal", variantId], 4000],
])(
  "decal cart %j preserves verified designs, $5 prices, and tangible-goods tax",
  async (variants, subtotal) => {
    const decalEnv = { ...env, PRINTFUL_STORE_ID: "19022802" };
    const migration = await readFile(
      "migrations/0005_vinyl_decals.sql",
      "utf8",
    );
    await env.DB.batch(
      migration
        .split(";")
        .filter((sql) => sql.trim())
        .map((sql) => env.DB.prepare(sql)),
    );
    await env.DB.prepare(
      "INSERT INTO printful_template_mappings VALUES (?,?,?,?,?,1)",
    )
      .bind(
        variantId,
        19022802,
        456,
        789,
        JSON.stringify([{ placement: "front", technique: "dtg" }]),
      )
      .run();
    await env.DB.prepare("DELETE FROM orders").run();
    let session: URLSearchParams | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
      const url = String(input);
      if (url.endsWith("/shipping-rates")) {
        const payload = JSON.parse(String(options?.body));
        expect(payload.order_items).toEqual(
          variants.map((variant) => ({
            source: "catalog",
            catalog_variant_id:
              variant === variantId
                ? 456
                : variant === "bascik-logo-vinyl-decal"
                  ? 24972
                  : 24971,
            quantity: 1,
            retail_price: variant === variantId ? "30.00" : "5.00",
            placements: [
              {
                placement: "front",
                technique: variant === variantId ? "dtg" : "digital",
              },
            ],
          })),
        );
        return Response.json({
          data: [
            {
              shipping: "STANDARD",
              shipping_method_name: "Standard",
              rate: "5.00",
              currency: "USD",
            },
          ],
        });
      }
      if (url.endsWith("/customers"))
        return Response.json({ id: "cus_decal_fixture" });
      expect(url).toBe("https://api.stripe.com/v1/checkout/sessions");
      session = options?.body as URLSearchParams;
      return Response.json({
        id: "cs_test_decal_fixture",
        url: "https://checkout.stripe.com/test",
      });
    });
    const quoted = await quoteRequest(
      post("/api/quote", {
        items: variants.map((variantId) => ({
          variantId,
          quantity: 1,
          price: 1,
        })),
        recipient: snapshot.recipient,
      }),
      decalEnv,
    );
    expect(quoted.status).toBe(200);
    const result = (await quoted.json()) as {
      quoteId: string;
      subtotal: number;
    };
    expect(result.subtotal).toBe(subtotal);
    const stored = await env.DB.prepare(
      "SELECT snapshot FROM quotes WHERE id=?",
    )
      .bind(result.quoteId)
      .first<{ snapshot: string }>();
    const quote = JSON.parse(stored!.snapshot) as Quote;
    expect(printfulItems(quote)).toEqual(
      variants.map((variant) => ({
        source: "product_template",
        product_template_id:
          variant === variantId
            ? 789
            : variant === "bascik-logo-vinyl-decal"
              ? 109978527
              : 109978655,
        catalog_variant_id:
          variant === variantId
            ? 456
            : variant === "bascik-logo-vinyl-decal"
              ? 24972
              : 24971,
        quantity: 1,
        retail_price: variant === variantId ? "30.00" : "5.00",
      })),
    );
    const checkout = await checkoutRequest(
      post("/api/checkout", {
        quoteId: result.quoteId,
        shippingId: "STANDARD",
      }),
      decalEnv,
    );
    expect(checkout.status).toBe(200);
    for (const [index, variant] of variants.entries()) {
      expect(
        session?.get(`line_items[${index}][price_data][unit_amount]`),
      ).toBe(variant === variantId ? "3000" : "500");
      expect(
        session?.get(
          `line_items[${index}][price_data][product_data][tax_code]`,
        ),
      ).toBe(variant === variantId ? "txcd_30011000" : "txcd_99999999");
    }
  },
);
test("template quotes preserve shipping techniques and orders use saved template designs", async () => {
  const logger = vi.spyOn(console, "info").mockImplementation(() => {});
  const design = [{ placement: "front_dtf_hat", technique: "dtfilm" }];
  await env.DB.prepare(
    "INSERT INTO printful_template_mappings VALUES (?,?,?,?,?,1)",
  )
    .bind(
      variantId,
      Number(env.PRINTFUL_STORE_ID),
      456,
      789,
      JSON.stringify(design),
    )
    .run();
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input, init) => {
      expect(String(input)).toBe("https://api.printful.com/v2/shipping-rates");
      expect(JSON.parse(String(init?.body)).recipient.state_code).toBe("CA");
      expect(JSON.parse(String(init?.body)).order_items).toEqual([
        {
          source: "catalog",
          catalog_variant_id: 456,
          quantity: 1,
          retail_price: "30.00",
          placements: design,
        },
      ]);
      return Response.json({
        data: [
          {
            shipping: "STANDARD",
            shipping_method_name: "Standard",
            rate: "5.00",
            currency: "USD",
          },
        ],
      });
    });
  const result = await quoteRequest(
    post("/api/quote", {
      items: [{ variantId, quantity: 1 }],
      recipient: { ...snapshot.recipient, state_code: "California" },
    }),
    env,
  );
  const output = (await result.json()) as { quoteId: string };
  const saved = await env.DB.prepare("SELECT snapshot FROM quotes WHERE id=?")
    .bind(output.quoteId)
    .first<{ snapshot: string }>();
  expect(JSON.parse(saved!.snapshot).recipient.state_code).toBe("CA");
  expect(logger).toHaveBeenCalledWith("Shop shipping quote requested", {
    requestId: null,
    country: "US",
    state: "CA",
    items: [
      {
        productId: products[0].id,
        variantId,
        variant: products[0].variants[0].title,
        quantity: 1,
      },
    ],
  });
  const logs = JSON.stringify(logger.mock.calls);
  for (const privateValue of [
    snapshot.recipient.name,
    snapshot.recipient.email,
    snapshot.recipient.address1,
    snapshot.recipient.zip,
  ])
    expect(logs).not.toContain(privateValue);
  expect(printfulItems(JSON.parse(saved!.snapshot))).toEqual([
    {
      source: "product_template",
      product_template_id: 789,
      catalog_variant_id: 456,
      quantity: 1,
      retail_price: "30.00",
    },
  ]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});
test.each([
  ["unverified", 123, 0],
  ["different store", 999, 1],
])(
  "a %s template cannot authorize checkout",
  async (_label, store, verified) => {
    await env.DB.prepare(
      "INSERT INTO printful_template_mappings VALUES (?,?,?,?,?,?)",
    )
      .bind(
        variantId,
        store,
        456,
        789,
        JSON.stringify([{ placement: "front", technique: "dtg" }]),
        verified,
      )
      .run();
    await expect(
      quoteRequest(
        post("/api/quote", {
          items: [{ variantId, quantity: 1 }],
          recipient: snapshot.recipient,
        }),
        env,
      ),
    ).rejects.toThrow("not ready for ordering");
  },
);
