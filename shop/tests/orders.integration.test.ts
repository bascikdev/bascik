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
} from "../src/lib/fulfillment.ts";

let runtime: Miniflare;
let env: Env;
const origin = "https://shop.example.com";
const quoteId = "quote_fixture";
const id = "32ce1859-bfe2-4c8f-a5c6-8863b425379f";
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
    (await readFile("migrations/0003_printful_templates.sql", "utf8"));
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
    if (url.includes("api.stripe.com")) return Response.json(payment);
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
      String(input).includes("api.stripe.com")
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
    if (url.includes("api.stripe.com")) return Response.json(payment);
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
      if (url.includes("api.stripe.com")) return Response.json(payment);
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
        String(input).includes("api.stripe.com")
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
    (
      await env.DB.prepare(
        "SELECT status FROM notifications WHERE id='message'",
      ).first<{ status: string }>()
    )?.status,
  ).toBe("sent");
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
    if (String(input).includes("api.stripe.com")) return Response.json(payment);
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
  expect(
    session.get(
      "shipping_options[0][shipping_rate_data][fixed_amount][amount]",
    ),
  ).toBe("500");
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
test("template quotes preserve shipping techniques and orders use saved template designs", async () => {
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
      recipient: snapshot.recipient,
    }),
    env,
  );
  const output = (await result.json()) as { quoteId: string };
  const saved = await env.DB.prepare("SELECT snapshot FROM quotes WHERE id=?")
    .bind(output.quoteId)
    .first<{ snapshot: string }>();
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
