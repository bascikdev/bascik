import { writeFile } from "node:fs/promises";
import { products } from "../src/lib/catalog.ts";
import { productTemplates } from "./product-templates.ts";

const token = process.env.PRINTFUL_TOKEN ?? process.env.PRINTFUL_TOEKN;
if (!token) throw new Error("Printful token is required.");
async function get(path: string) {
  const response = await fetch(`https://api.printful.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-PF-Store-Id": "19022802",
    },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw new Error(`Printful ${path}: HTTP ${response.status}`);
  return response.json();
}
const destinations: Record<string, string[]> = {};
for (const product of products) {
  const approved = productTemplates[product.slug];
  const templateId = approved?.id;
  if (!templateId) throw new Error(`Unknown product ${product.slug}`);
  const { result: template } = await get(`/product-templates/${templateId}`);
  if (
    template.title !== (approved.title ?? product.title) ||
    !Number.isSafeInteger(template.product_id)
  )
    throw new Error(`Unexpected Printful template ${templateId}`);
  const response = await get(
    `/v2/catalog-products/${template.product_id}/shipping-countries`,
  );
  const entries: { code: string }[] = response.data;
  if (
    !Array.isArray(entries) ||
    !entries.length ||
    response.paging?.next ||
    entries.some(
      (entry) =>
        typeof entry.code !== "string" || !/^[A-Z]{2}$/.test(entry.code),
    )
  )
    throw new Error(
      `Invalid or incomplete shipping countries for ${product.slug}`,
    );
  destinations[product.id] = [
    ...new Set(entries.map((entry) => entry.code)),
  ].sort();
}
await writeFile(
  "catalog/shipping-countries.json",
  JSON.stringify(destinations, null, 2) + "\n",
);
console.log(
  `Refreshed Printful shipping destinations for all ${products.length} approved products.`,
);
