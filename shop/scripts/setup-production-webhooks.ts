import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const key = process.env.STRIPE_SECRET_KEY;
const token = process.env.PRINTFUL_TOKEN ?? process.env.PRINTFUL_TOEKN;
const expectedAccount = process.env.STRIPE_ACCOUNT;
if (!key || !/^(sk|rk)_live_/.test(key) || !token || !expectedAccount)
  throw new Error("Expected live Stripe identity and Printful credentials.");
const origin = "https://bascik-shop-production.collin-inbox.workers.dev";
const stripeUrl = `${origin}/api/webhooks/stripe`;
const printfulUrl = `${origin}/api/webhooks/printful`;
const evidenceFile = ".local/production-webhooks.json";
await mkdir(".local", { recursive: true, mode: 0o700 });
const saved = existsSync(evidenceFile)
  ? JSON.parse(await readFile(evidenceFile, "utf8"))
  : {};
async function persist() {
  await writeFile(evidenceFile, JSON.stringify(saved, null, 2), {
    mode: 0o600,
  });
}
async function stripe(path: string, params?: URLSearchParams) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: params ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`Production Stripe webhook setup: HTTP ${response.status}`);
  return response.json();
}
const account = await stripe("/account");
if (
  account.id !== expectedAccount ||
  (await stripe("/balance")).livemode !== true
)
  throw new Error("Wrong live Stripe account.");
const stripeWasSaved = Boolean(saved.stripe);
if (!saved.stripe) {
  for (let cursor = ""; ;) {
    const page = await stripe(
      `/webhook_endpoints?limit=100${cursor ? `&starting_after=${cursor}` : ""}`,
    );
    if (page.data.some((entry: { url: string }) => entry.url === stripeUrl))
      throw new Error(
        "Production endpoint already exists without saved signing secret; inspect before rotating.",
      );
    if (!page.has_more) break;
    if (!page.data.length) throw new Error("Incomplete webhook pagination.");
    cursor = page.data[page.data.length - 1].id;
  }
  saved.stripe = await stripe(
    "/webhook_endpoints",
    new URLSearchParams({
      url: stripeUrl,
      api_version: "2025-02-24.acacia",
      "metadata[app]": "bascik-shop-production",
      "enabled_events[0]": "checkout.session.completed",
      "enabled_events[1]": "checkout.session.async_payment_succeeded",
      "enabled_events[2]": "checkout.session.async_payment_failed",
      "enabled_events[3]": "checkout.session.expired",
    }),
  );
  await persist();
}
const endpoint = await stripe(`/webhook_endpoints/${saved.stripe.id}`);
if (
  !endpoint.livemode ||
  endpoint.url !== stripeUrl ||
  endpoint.metadata.app !== "bascik-shop-production" ||
  !saved.stripe.secret?.startsWith("whsec_")
)
  throw new Error("Production Stripe webhook evidence mismatch.");
if (stripeWasSaved && endpoint.status !== "disabled")
  throw new Error(
    "Saved production webhook is enabled. Refusing to disrupt an active shop.",
  );
await stripe(
  `/webhook_endpoints/${endpoint.id}`,
  new URLSearchParams({ disabled: "true" }),
);
async function pf(payload?: object) {
  const response = await fetch("https://api.printful.com/v2/webhooks", {
    method: payload ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "X-PF-Store-Id": "19022802",
      "Content-Type": "application/json",
    },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `Production Printful webhook setup: HTTP ${response.status}`,
    );
  const result = await response.json();
  return result.result ?? result.data;
}
const current = await pf();
if (!saved.printful) {
  if (current.default_url || current.events?.length)
    throw new Error(
      "Printful token already has a webhook. Refusing to replace another app's configuration.",
    );
  saved.printful = await pf({
    default_url: printfulUrl,
    events: [
      "shipment_sent",
      "shipment_returned",
      "shipment_canceled",
      "order_updated",
      "order_failed",
      "order_canceled",
      "order_put_hold",
      "order_remove_hold",
    ].map((type) => ({ type })),
  });
  await persist();
} else if (
  current.default_url !== printfulUrl ||
  current.public_key !== saved.printful.public_key
) {
  throw new Error(
    "Printful webhook configuration changed; refusing replacement.",
  );
}
if (
  !/^(?:[a-f0-9]{2}){32,}$/i.test(saved.printful.secret_key) ||
  !saved.printful.public_key
)
  throw new Error("Missing Printful one-time signing credentials.");
saved.orderTokenSecret ??= randomBytes(32).toString("hex");
if (
  typeof saved.orderTokenSecret !== "string" ||
  saved.orderTokenSecret.length < 32
)
  throw new Error(
    "Invalid saved production order-token secret; refusing silent rotation.",
  );
await persist();
const secrets: Record<string, string> = {
  SHOP_CLOUDFLARE_API_TOKEN: process.env.SHOP_CLOUDFLARE_API_TOKEN ?? "",
  STRIPE_SECRET_KEY: key,
  STRIPE_ACCOUNT: expectedAccount,
  STRIPE_WEBHOOK_SECRET: saved.stripe.secret,
  PRINTFUL_TOKEN: token,
  PRINTFUL_WEBHOOK_SECRET: saved.printful.secret_key,
  PRINTFUL_WEBHOOK_PUBLIC_KEY: saved.printful.public_key,
  ORDER_TOKEN_SECRET: saved.orderTokenSecret,
  STRIPE_WEBHOOK_ENDPOINT_ID: saved.stripe.id,
};
for (const [name, value] of Object.entries(secrets)) {
  if (!value) throw new Error(`Missing production credential: ${name}`);
  const result = spawnSync(
    "gh",
    [
      "secret",
      "set",
      name,
      "--repo",
      "bascikdev/bascik",
      "--env",
      "shop-production",
    ],
    { input: value, encoding: "utf8" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Production GitHub secret installation failed: ${name}`);
}
console.log(
  "Production signing credentials installed in main-only environment. Stripe endpoint disabled; Printful notifications staged. No payment or confirmation sent.",
);
