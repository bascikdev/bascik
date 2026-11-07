import { mkdir, writeFile } from "node:fs/promises";
import { products } from "../src/lib/catalog.ts";

const key = process.env.STRIPE_SECRET_KEY;
const account = process.env.STRIPE_ACCOUNT;
const token = process.env.PRINTFUL_TOKEN ?? process.env.PRINTFUL_TOEKN;
if (!key || !/^(sk|rk)_live_/.test(key) || !account || !token)
  throw new Error(
    "Set a live Stripe key, expected STRIPE_ACCOUNT, and Printful token.",
  );
async function stripe(path: string) {
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    headers: {
      Authorization: `Bearer ${key}`,
      "Stripe-Version": "2025-02-24.acacia",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(
      `Live Stripe verification ${path}: HTTP ${response.status}`,
    );
  return response.json();
}
interface StripeEntry {
  id: string;
  active?: boolean;
  metadata?: { app?: string; handle?: string };
  tax_code?: string;
  product?: string;
  currency?: string;
  unit_amount?: number;
  tax_behavior?: string;
  status?: string;
}
async function list(path: string): Promise<StripeEntry[]> {
  const entries: StripeEntry[] = [];
  let cursor = "";
  for (;;) {
    const page: { data: StripeEntry[]; has_more: boolean } = await stripe(
      `${path}?limit=100${cursor ? `&starting_after=${cursor}` : ""}`,
    );
    entries.push(...page.data);
    if (!page.has_more) return entries;
    if (!page.data.length) throw new Error("Incomplete Stripe pagination.");
    cursor = page.data[page.data.length - 1].id;
  }
}
const identity = await stripe("/account");
const balance = await stripe("/balance");
if (identity.id !== account || balance.livemode !== true)
  throw new Error("Live Stripe account identity does not match.");
const tax = await stripe("/tax/settings");
const registrations = await list("/tax/registrations");
const inventory = await list("/products");
const prices = await list("/prices");
for (const product of products) {
  const matches = inventory.filter(
    (entry) =>
      entry.metadata?.app === "bascik-shop" &&
      entry.metadata.handle === product.slug &&
      entry.active,
  );
  if (matches.length !== 1 || matches[0].tax_code !== "txcd_30011000")
    throw new Error(`Live product classification mismatch: ${product.slug}`);
  if (
    !prices.some(
      (price) =>
        price.product === matches[0].id &&
        price.active &&
        price.currency === "usd" &&
        price.unit_amount === product.price &&
        price.tax_behavior === "exclusive",
    )
  )
    throw new Error(`Live price mismatch: ${product.slug}`);
}
const response = await fetch("https://api.printful.com/v2/stores/19022802", {
  headers: { Authorization: `Bearer ${token}`, "X-PF-Store-Id": "19022802" },
  signal: AbortSignal.timeout(30000),
});
if (!response.ok)
  throw new Error(
    `Printful production-store verification: HTTP ${response.status}`,
  );
const store = (await response.json()).data;
if (store.id !== 19022802 || store.type !== "native")
  throw new Error("Wrong production Printful store.");
const report = {
  liveAccountMatched: true,
  chargesEnabled: identity.charges_enabled === true,
  payoutsEnabled: identity.payouts_enabled === true,
  taxActive: tax.livemode === true && tax.status === "active",
  registrationCount: registrations.filter((entry) => entry.status === "active")
    .length,
  verifiedProducts: products.length,
  printfulStoreVerified: true,
  printfulFundingVerifiedByApi: false,
  checkedAt: new Date().toISOString(),
};
await mkdir(".local", { recursive: true, mode: 0o700 });
await writeFile(
  ".local/live-provider-readiness.json",
  JSON.stringify(report, null, 2),
  { mode: 0o600 },
);
console.log(JSON.stringify(report));
if (!report.chargesEnabled || !report.taxActive)
  throw new Error("Live Stripe capabilities or Tax are not ready.");
