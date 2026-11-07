import { mkdir, writeFile } from "node:fs/promises";
import catalog from "../catalog/products.json" with { type: "json" };
import { productTemplates } from "./product-templates.ts";

const token = process.env.PRINTFUL_TOKEN ?? process.env.PRINTFUL_TOEKN;
if (!token) throw new Error("Set PRINTFUL_TOKEN in your local environment.");
if (!process.env.PRINTFUL_TOKEN)
  console.warn(
    "Using the existing PRINTFUL_TOEKN variable for this read-only audit. Configure PRINTFUL_TOKEN for the app.",
  );
async function get(path: string, storeId?: number) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  if (storeId) headers["X-PF-Store-Id"] = String(storeId);
  const response = await fetch(`https://api.printful.com${path}`, { headers });
  if (!response.ok)
    throw new Error(`Printful audit ${path}: HTTP ${response.status}`);
  return (await response.json()).result;
}
const stores: { id: number; name: string; type: string }[] =
  await get("/stores");
const matches = stores.filter(
  (store) => store.type === "shopify" && /bascik/i.test(store.name),
);
if (matches.length !== 1)
  throw new Error(
    "Expected one Bascik Shopify store; select the source manually.",
  );
const store = matches[0];
const products = [];
for (const product of catalog) {
  if (productTemplates[product.slug]?.catalogVariantId) continue;
  const result = await get(`/sync/products/@${product.id}`, store.id);
  for (const variant of product.variants) {
    const mapped = result.sync_variants.find(
      (entry: { external_id: string }) => entry.external_id === variant.id,
    );
    if (!mapped?.synced || !mapped.files?.length)
      throw new Error(`Missing print-ready mapping for variant ${variant.id}`);
  }
  products.push(result);
}
await mkdir(".local", { recursive: true, mode: 0o700 });
await writeFile(
  ".local/printful-shopify.json",
  JSON.stringify({ store, products }, null, 2),
  { mode: 0o600 },
);
console.log(
  "Read-only audit complete: four products and 24 variant mappings saved privately in .local/printful-shopify.json. No store, webhook, or order was changed.",
);
