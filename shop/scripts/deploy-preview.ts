import { appendFile, readFile, writeFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { products } from "../src/lib/catalog.ts";
import { productTemplates } from "./product-templates.ts";
import { updateCheckoutNotice } from "./checkout-notice.ts";

if (
  process.env.GITHUB_ACTIONS !== "true" ||
  process.env.GITHUB_EVENT_NAME !== "push" ||
  process.env.GITHUB_REPOSITORY !== "bascikdev/bascik" ||
  process.env.GITHUB_REF === "refs/heads/main"
)
  throw new Error(
    "Preview deployment is restricted to same-repository branch push CI.",
  );
const required = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing preview secret: ${name}`);
  return value;
};
const cfToken = required("CLOUDFLARE_API_TOKEN");
const stripeKey = required("STRIPE_SECRET_KEY");
const printfulToken = required("PRINTFUL_TOKEN");
const tokenSeed = required("ORDER_TOKEN_SEED");
if (!stripeKey.startsWith("sk_test_") || tokenSeed.length < 32)
  throw new Error(
    "Preview requires Stripe sandbox credentials and a strong order-token seed.",
  );
const branch = required("GITHUB_REF_NAME");
const account = "8572c3fcc06b71dbf05fe590e8b3f74e";
async function request<T>(
  url: string,
  token: string,
  data?: unknown,
  method?: string,
): Promise<T> {
  const form = data instanceof URLSearchParams;
  const response = await fetch(url, {
    method: method ?? (data === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": form
        ? "application/x-www-form-urlencoded"
        : "application/json",
    },
    body: data === undefined ? undefined : form ? data : JSON.stringify(data),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Preview provider request failed: ${new URL(url).hostname}${new URL(url).pathname} HTTP ${response.status}`,
    );
  return response.json() as Promise<T>;
}
const pulls = await request<
  { number: number; head: { sha: string; repo: { full_name: string } } }[]
>(
  `https://api.github.com/repos/bascikdev/bascik/pulls?state=open&head=${encodeURIComponent(`bascikdev:${branch}`)}`,
  required("GITHUB_TOKEN"),
);
if (
  pulls.length !== 1 ||
  pulls[0].head.repo.full_name !== "bascikdev/bascik" ||
  pulls[0].head.sha !== process.env.GITHUB_SHA
)
  throw new Error(
    "Preview requires exactly one open same-repository PR at this push commit.",
  );
const pr = pulls[0].number;
const name = `bascik-shop-pr-${pr}`;
async function cf<T>(path: string, data?: unknown) {
  const response = await request<{ success: boolean; result: T }>(
    `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
    cfToken,
    data,
  );
  if (!response.success)
    throw new Error(`Cloudflare preview operation failed: ${path}`);
  return response.result;
}
const { subdomain } = await cf<{ subdomain: string }>("workers/subdomain");
if (!subdomain || !/^[a-z0-9-]+$/.test(subdomain))
  throw new Error("Cloudflare Workers subdomain is not configured.");
const origin = `https://${name}.${subdomain}.workers.dev`;
const dbs = await cf<{ name: string; uuid: string }[]>(
  "d1/database?per_page=100",
);
const dbName = `${name}-db`;
let db = dbs.find((entry) => entry.name === dbName);
if (!db)
  db = await cf<{ name: string; uuid: string }>("d1/database", {
    name: dbName,
  });
const queues = await cf<{ queue_name: string }[]>("queues?per_page=100");
for (const queue_name of [`${name}-dead`, `${name}-jobs`])
  if (!queues.some((entry) => entry.queue_name === queue_name))
    await cf("queues", { queue_name });
const tax = await request<{ livemode: boolean; status: string }>(
  "https://api.stripe.com/v1/tax/settings",
  stripeKey,
);
if (tax.livemode !== false || tax.status !== "active")
  throw new Error("Stripe sandbox Tax is not ready.");
async function pf<T>(path: string): Promise<T> {
  const response = await fetch(`https://api.printful.com${path}`, {
    headers: {
      Authorization: `Bearer ${printfulToken}`,
      "X-PF-Store-Id": "19022802",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok)
    throw new Error(
      `Printful preview mapping ${path}: HTTP ${response.status}`,
    );
  return response.json() as Promise<T>;
}
const store = await pf<{ data: { id: number; type: string } }>(
  "/v2/stores/19022802",
);
if (store.data.id !== 19022802 || store.data.type !== "native")
  throw new Error("Wrong Printful preview store.");
const escape = (value: string) => `'${value.replaceAll("'", "''")}'`;
const mappings: string[] = [];
for (const product of products) {
  const approved = productTemplates[product.slug];
  const templateId = approved?.id;
  if (!templateId) throw new Error("Unknown preview product.");
  const { result: template } = await pf<{
    result: {
      title: string;
      product_id: number;
      available_variant_ids: number[];
      placements: {
        placement: string;
        technique_key: string;
        options: unknown[];
      }[];
      placement_option_data: { type: string; options: unknown[] }[];
    };
  }>(`/product-templates/${templateId}`);
  if (
    template.title !== (approved.title ?? product.title) ||
    !template.placements.length ||
    template.placements.some((entry) => entry.options.length) ||
    template.placement_option_data.some((entry) => entry.options.length)
  )
    throw new Error(
      "Saved template changed; inspect preview mappings before deployment.",
    );
  const placements = template.placements.map((entry) => ({
    placement: entry.placement,
    technique: entry.technique_key.toLowerCase(),
  }));
  const variants: { id: number; color: string; size: string }[] = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await pf<{ data: typeof variants; paging: { total: number } }>(
      `/v2/catalog-products/${template.product_id}/catalog-variants?limit=100&offset=${offset}`,
    );
    variants.push(...page.data);
    if (variants.length >= page.paging.total) break;
    if (!page.data.length || offset === 900)
      throw new Error("Incomplete catalog variant pagination.");
  }
  for (const variant of product.variants) {
    const matches = variants.filter(
      (entry) =>
        entry.color === variant.color &&
        (approved.catalogVariantId
          ? entry.id === approved.catalogVariantId
          : entry.size === (variant.size ?? "One size")) &&
        template.available_variant_ids.includes(entry.id),
    );
    if (matches.length !== 1)
      throw new Error(`Preview variant mismatch: ${variant.id}`);
    mappings.push(
      `INSERT INTO printful_template_mappings VALUES (${escape(variant.id)},19022802,${matches[0].id},${templateId},${escape(JSON.stringify(placements))},1) ON CONFLICT(variant_id) DO UPDATE SET store_id=excluded.store_id,catalog_variant_id=excluded.catalog_variant_id,product_template_id=excluded.product_template_id,shipping_placements=excluded.shipping_placements,verified=1;`,
    );
  }
}
const config = JSON.parse(await readFile(".output/wrangler.json", "utf8"));
if (
  config.vars.SHOP_MODE !== "test" ||
  config.routes?.length ||
  config.send_email?.length
)
  throw new Error("Unsafe preview build.");
config.name = name;
config.account_id = account;
config.vars = {
  ...config.vars,
  SHOP_MODE: "test",
  SHOP_ORIGIN: origin,
  SHOP_ENABLED: "true",
  SHOP_FULFILLMENT_ENABLED: "true",
  PRINTFUL_STORE_ID: "19022802",
  TAX_CODE_SHIRT: "txcd_30011000",
  TAX_CODE_HAT: "txcd_30011000",
  EMAIL_FROM: "preview@example.com",
  SUPPORT_EMAIL: "preview@example.com",
  ALERT_EMAIL: "preview@example.com",
};
config.d1_databases = [
  {
    binding: "DB",
    database_name: dbName,
    database_id: db.uuid,
    migrations_dir: "./migrations",
  },
];
config.queues = {
  producers: [{ binding: "JOBS", queue: `${name}-jobs` }],
  consumers: [
    {
      queue: `${name}-jobs`,
      max_batch_size: 5,
      max_retries: 3,
      dead_letter_queue: `${name}-dead`,
    },
  ],
};
await writeFile(".output/wrangler.json", JSON.stringify(config, null, 2));
const checkoutPath = ".output/public/checkout.html";
const checkout = await readFile(checkoutPath, "utf8");
await writeFile(
  checkoutPath,
  updateCheckoutNotice(
    checkout,
    "Sandbox preview: use Stripe test payment details only. Orders create unconfirmed Printful drafts. Nothing will be charged, produced, shipped, or emailed.",
  ),
);
function wrangler(...args: string[]) {
  const result = spawnSync(
    "yarn",
    ["exec", "wrangler", ...args, "--config", ".output/wrangler.json"],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Wrangler preview operation failed: ${args[0]}`);
}
wrangler("d1", "migrations", "apply", "DB", "--remote");
await writeFile(".output/preview-mappings.sql", mappings.join("\n"));
wrangler(
  "d1",
  "execute",
  "DB",
  "--remote",
  "--file",
  ".output/preview-mappings.sql",
);
const webhook = await request<{
  id: string;
  secret: string;
  livemode: boolean;
}>(
  "https://api.stripe.com/v1/webhook_endpoints",
  stripeKey,
  new URLSearchParams({
    url: `${origin}/api/webhooks/stripe`,
    api_version: "2025-02-24.acacia",
    "metadata[app]": "bascik-shop-preview",
    "metadata[pr]": String(pr),
    "enabled_events[0]": "checkout.session.completed",
    "enabled_events[1]": "checkout.session.async_payment_succeeded",
    "enabled_events[2]": "checkout.session.async_payment_failed",
    "enabled_events[3]": "checkout.session.expired",
  }),
);
if (webhook.livemode !== false || !webhook.secret?.startsWith("whsec_"))
  throw new Error("Wrong Stripe webhook environment.");
const secretFile = ".output/preview-secrets.json";
try {
  await writeFile(
    secretFile,
    JSON.stringify({
      STRIPE_SECRET_KEY: stripeKey,
      STRIPE_WEBHOOK_SECRET: webhook.secret,
      PRINTFUL_TOKEN: printfulToken,
      ORDER_TOKEN_SECRET: createHmac("sha256", tokenSeed)
        .update(name)
        .digest("hex"),
      PRINTFUL_WEBHOOK_SECRET: randomBytes(32).toString("hex"),
      PRINTFUL_WEBHOOK_PUBLIC_KEY: `unused-preview-${pr}`,
    }),
    { mode: 0o600 },
  );
  wrangler("secret", "bulk", secretFile);
  wrangler("deploy");
} finally {
  await rm(secretFile, { force: true });
}
const retired: string[] = [];
for (let starting_after = ""; ;) {
  const page = await request<{
    data: { id: string; metadata: Record<string, string>; url: string }[];
    has_more: boolean;
  }>(
    `https://api.stripe.com/v1/webhook_endpoints?limit=100${starting_after ? `&starting_after=${starting_after}` : ""}`,
    stripeKey,
  );
  for (const entry of page.data)
    if (
      entry.id !== webhook.id &&
      entry.metadata.app === "bascik-shop-preview" &&
      entry.metadata.pr === String(pr) &&
      entry.url === `${origin}/api/webhooks/stripe`
    )
      retired.push(entry.id);
  if (!page.has_more) break;
  if (!page.data.length)
    throw new Error("Incomplete Stripe webhook pagination.");
  starting_after = page.data.at(-1)!.id;
}
for (const id of retired)
  await request(
    `https://api.stripe.com/v1/webhook_endpoints/${id}`,
    stripeKey,
    undefined,
    "DELETE",
  );
let status = 0;
for (let attempt = 0; attempt < 6; ++attempt) {
  const response = await fetch(origin, { signal: AbortSignal.timeout(30_000) });
  status = response.status;
  if (status === 200) break;
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
if (status !== 200)
  throw new Error(`Preview smoke check failed: HTTP ${status}`);
await appendFile(
  required("GITHUB_STEP_SUMMARY"),
  `## Shop PR #${pr}\n\n${origin}\n\nStripe sandbox; Printful draft-only; no customer email or production confirmation. D1: ${dbName}; queues: ${name}-jobs / ${name}-dead. Stripe endpoint: ${webhook.id}.\n`,
);
const comment = spawnSync(
  "gh",
  [
    "pr",
    "comment",
    String(pr),
    "--body",
    `Shop preview: ${origin}\n\nStripe sandbox payments are enabled. Paid orders create unconfirmed Printful drafts only. Production confirmation and customer email are blocked in test mode. No live domain changes.`,
  ],
  { stdio: "inherit" },
);
if (comment.error || comment.status !== 0)
  throw new Error("Preview deployed but PR comment failed.");
