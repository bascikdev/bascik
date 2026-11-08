import { mkdir, writeFile } from "node:fs/promises";
import { products as catalog } from "../src/lib/catalog.ts";

const key = process.env.STRIPE_SECRET_KEY;
if (!key?.startsWith("sk_test_"))
  throw new Error(
    "This setup command only accepts a Stripe sandbox secret key.",
  );
const write = process.argv.includes("--write");
async function call(
  path: string,
  params?: URLSearchParams,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${key}`,
    "Stripe-Version": "2025-02-24.acacia",
  };
  if (params) headers["Content-Type"] = "application/x-www-form-urlencoded";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`https://api.stripe.com/v1${path}`, {
    method: params ? "POST" : "GET",
    headers,
    body: params,
  });
  if (!response.ok)
    throw new Error(`Stripe sandbox setup ${path}: HTTP ${response.status}`);
  return response.json();
}
async function list<T extends { id: string }>(
  path: string,
  params = new URLSearchParams(),
): Promise<T[]> {
  const entries: T[] = [];
  params.set("limit", "100");
  let cursor = "";
  for (;;) {
    if (cursor) params.set("starting_after", cursor);
    const page: { data: T[]; has_more: boolean } = await call(
      `${path}?${params}`,
    );
    entries.push(...page.data);
    if (!page.has_more) return entries;
    const next = page.data.at(-1)?.id;
    if (!next || next === cursor)
      throw new Error("Incomplete Stripe sandbox setup pagination.");
    cursor = next;
  }
}
const balance = await call("/balance");
if (balance.livemode !== false)
  throw new Error("Sandbox mode could not be verified.");
const account = await call("/account");
const tax = await call("/tax/settings");
const report: {
  mode: string;
  accountVerified: boolean;
  taxStatus: string;
  products: { handle: string; product: string; price: string }[];
} = {
  mode: "sandbox",
  accountVerified: account.id === process.env.STRIPE_ACCOUNT,
  taxStatus: tax.status,
  products: [],
};
await mkdir(".local", { recursive: true, mode: 0o700 });
await writeFile(
  ".local/stripe-readiness.json",
  JSON.stringify(report, null, 2),
);
if (!report.accountVerified)
  throw new Error(
    "The sandbox secret key account differs from STRIPE_ACCOUNT. Confirm the sandbox account ID before any writes. Readiness report saved; no resources changed.",
  );
if (write) {
  const shirtCode = process.env.TAX_CODE_SHIRT;
  const hatCode = process.env.TAX_CODE_HAT;
  if (!shirtCode || !hatCode)
    throw new Error(
      "Choose TAX_CODE_SHIRT and TAX_CODE_HAT before creating products.",
    );
  for (const code of new Set([
    shirtCode,
    hatCode,
    ...catalog.flatMap((product) => (product.taxCode ? [product.taxCode] : [])),
  ]))
    await call(`/tax_codes/${encodeURIComponent(code)}`);
  const existing = await list<{
    id: string;
    tax_code: string;
    metadata: Record<string, string>;
  }>("/products");
  for (const product of catalog) {
    const code =
      product.taxCode ?? (product.slug.includes("hat") ? hatCode : shirtCode);
    const existingProduct = existing.find(
      (entry: { metadata: Record<string, string> }) =>
        entry.metadata?.app === "bascik-shop" &&
        entry.metadata.handle === product.slug,
    );
    const remote: { id: string; tax_code: string } =
      existingProduct ??
      (await call(
        "/products",
        new URLSearchParams({
          name: product.title,
          description: product.description,
          tax_code: code,
          "metadata[app]": "bascik-shop",
          "metadata[handle]": product.slug,
        }),
        `bascik-shop-product:${product.slug}`,
      ));
    if (remote.tax_code !== code)
      throw new Error(
        `Stripe product tax code mismatch for ${product.slug}. Review the existing product before rerunning setup.`,
      );
    const prices = await list<{
      id: string;
      unit_amount: number;
      currency: string;
      active: boolean;
      tax_behavior: string;
    }>("/prices", new URLSearchParams({ product: remote.id }));
    const price =
      prices.find(
        (entry: {
          unit_amount: number;
          currency: string;
          active: boolean;
          tax_behavior: string;
        }) =>
          entry.active &&
          entry.unit_amount === product.price &&
          entry.currency === "usd" &&
          entry.tax_behavior === "exclusive",
      ) ??
      (await call(
        "/prices",
        new URLSearchParams({
          product: remote.id,
          currency: "usd",
          unit_amount: String(product.price),
          tax_behavior: "exclusive",
          "metadata[app]": "bascik-shop",
        }),
        `bascik-shop-price:${product.slug}:${product.price}`,
      ));
    report.products.push({
      handle: product.slug,
      product: remote.id,
      price: price.id,
    });
  }
}
await writeFile(
  ".local/stripe-readiness.json",
  JSON.stringify(report, null, 2),
);
console.log(
  JSON.stringify({
    mode: report.mode,
    accountVerified: report.accountVerified,
    taxStatus: report.taxStatus,
    productsCreatedOrReused: report.products.length,
  }),
);
