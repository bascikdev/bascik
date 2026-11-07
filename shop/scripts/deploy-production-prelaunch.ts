import { readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import {
  assertProductionPrelaunch,
  assertProductionLaunch,
} from "./production-config.ts";
import { createHmac } from "node:crypto";

const launch = process.argv.includes("--launch");
if (
  process.env.GITHUB_ACTIONS !== "true" ||
  !(
    process.env.GITHUB_EVENT_NAME === "workflow_dispatch" ||
    (launch && process.env.GITHUB_EVENT_NAME === "push")
  ) ||
  process.env.GITHUB_REF !== "refs/heads/main" ||
  process.env.GITHUB_REPOSITORY !== "bascikdev/bascik"
)
  throw new Error(
    "Production prelaunch deploy is restricted to manual main CI.",
  );
await import("./package-production.ts");
const config = JSON.parse(
  await readFile(".output/wrangler.production.json", "utf8"),
);
if (launch) assertProductionLaunch(config);
else assertProductionPrelaunch(config);
const secrets: Record<string, string> = {};
for (const name of [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "PRINTFUL_TOKEN",
  "PRINTFUL_WEBHOOK_SECRET",
  "PRINTFUL_WEBHOOK_PUBLIC_KEY",
  "ORDER_TOKEN_SECRET",
]) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing production secret: ${name}`);
  secrets[name] = value;
}
if (
  !/^(sk|rk)_live_/.test(secrets.STRIPE_SECRET_KEY) ||
  secrets.ORDER_TOKEN_SECRET.length < 32 ||
  !secrets.STRIPE_WEBHOOK_SECRET.startsWith("whsec_") ||
  !/^(?:[a-f0-9]{2}){32,}$/i.test(secrets.PRINTFUL_WEBHOOK_SECRET) ||
  !process.env.CLOUDFLARE_API_TOKEN
)
  throw new Error("Invalid production credentials.");
async function stripeEndpoint(disabled?: boolean) {
  const id = process.env.STRIPE_WEBHOOK_ENDPOINT_ID;
  if (!id || !/^we_[A-Za-z0-9]+$/.test(id))
    throw new Error("Missing production Stripe webhook identity.");
  const response = await fetch(
    `https://api.stripe.com/v1/webhook_endpoints/${id}`,
    {
      method: disabled === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${secrets.STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Stripe-Version": "2025-02-24.acacia",
      },
      body:
        disabled === undefined
          ? undefined
          : new URLSearchParams({ disabled: String(disabled) }),
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok)
    throw new Error(`Production webhook verification: HTTP ${response.status}`);
  const endpoint = await response.json();
  if (
    endpoint.id !== id ||
    endpoint.livemode !== true ||
    endpoint.url !==
      "https://bascik-shop-production.collin-inbox.workers.dev/api/webhooks/stripe" ||
    endpoint.metadata?.app !== "bascik-shop-production" ||
    ![
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
      "checkout.session.async_payment_failed",
      "checkout.session.expired",
    ].every((event) => endpoint.enabled_events?.includes(event))
  )
    throw new Error("Production webhook identity mismatch.");
  return endpoint;
}
if (launch) {
  await stripeEndpoint();
  const endpoint = await stripeEndpoint(false);
  if (endpoint.status !== "enabled")
    throw new Error("Production webhook is not enabled.");
}
function wrangler(...args: string[]) {
  const result = spawnSync(
    "yarn",
    [
      "exec",
      "wrangler",
      ...args,
      "--config",
      ".output/wrangler.production.json",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Production prelaunch operation failed: ${args[0]}`);
}
const file = ".output/production-secrets.json";
try {
  await writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
  wrangler("d1", "migrations", "apply", "DB", "--remote");
  wrangler("secret", "bulk", file);
  wrangler("deploy");
} finally {
  await rm(file, { force: true });
}
let status = 0;
for (let attempt = 0; attempt < 6; ++attempt) {
  const response = await fetch(config.vars.SHOP_ORIGIN, {
    signal: AbortSignal.timeout(30000),
  });
  status = response.status;
  if (status === 200) {
    if (launch && response.headers.get("x-robots-tag")?.includes("noindex"))
      status = 503;
    else break;
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (status !== 200)
  throw new Error(`Production prelaunch smoke failed: HTTP ${status}`);
let quoteVerified = false;
for (let attempt = 0; attempt < 6; ++attempt) {
  const quote = await fetch(`${config.vars.SHOP_ORIGIN}/api/quote`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: config.vars.SHOP_ORIGIN,
    },
    body: "{}",
    signal: AbortSignal.timeout(30000),
  });
  const error = (await quote.json()).error;
  quoteVerified = launch
    ? quote.status === 400 && error === "Enter your delivery details."
    : quote.status === 503 &&
      error === "Checkout is not open yet. Please check back soon.";
  if (quoteVerified) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (!quoteVerified)
  throw new Error(
    launch
      ? "Production checkout is not ready."
      : "Production prelaunch checkout gate is not closed.",
  );
const timestamp = Math.floor(Date.now() / 1000);
const probes: {
  path: string;
  text: string;
  headers: Record<string, string>;
}[] = [
  {
    path: "stripe",
    text: JSON.stringify({
      id: "evt_bascik_prelaunch_probe",
      type: "prelaunch.probe",
      livemode: true,
      data: { object: { id: "prelaunch-probe" } },
    }),
    headers: {},
  },
  {
    path: "printful",
    text: JSON.stringify({
      type: "order_updated",
      store_id: 19022802,
      data: { order: { external_id: "bascik-prelaunch-probe" } },
    }),
    headers: { "x-pf-webhook-public-key": secrets.PRINTFUL_WEBHOOK_PUBLIC_KEY },
  },
];
probes[0].headers["stripe-signature"] =
  `t=${timestamp},v1=${createHmac("sha256", secrets.STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${probes[0].text}`).digest("hex")}`;
probes[1].headers["x-pf-webhook-signature"] = createHmac(
  "sha256",
  Buffer.from(secrets.PRINTFUL_WEBHOOK_SECRET, "hex"),
)
  .update(probes[1].text)
  .digest("hex");
for (const probe of probes) {
  const response = await fetch(
    `${config.vars.SHOP_ORIGIN}/api/webhooks/${probe.path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...probe.headers },
      body: probe.text,
      signal: AbortSignal.timeout(30000),
    },
  );
  if (!response.ok || (await response.json()).received !== true)
    throw new Error(
      `Production ${probe.path} signature probe failed: HTTP ${response.status}`,
    );
}
console.log(
  launch
    ? "Live shop.bascik.dev deployed with commerce enabled, Stripe webhook enabled, and signed no-order callback probes verified."
    : "Production prelaunch deployed with commerce disabled and signed no-order callback probes verified. No domain route configured.",
);
