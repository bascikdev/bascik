import { writeFile } from "node:fs/promises";
import { products } from "../src/lib/catalog.ts";

const token = process.env.PRINTFUL_TOKEN ?? process.env.PRINTFUL_TOEKN;
if (!token) throw new Error("Printful token is required.");
const templates = new Map([
  ["100-organic-cotton-bascik-logo-front-unisex", 109921208],
  ["100-organic-cotton-bascik-insignia-shirt-unisex", 109921207],
  ["100-organic-cotton-bascik-logo-dad-hat-unisex", 109921204],
  ["100-organic-cotton-bascik-insignia-dad-hat-unisex", 109921206],
]);
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
  const templateId = templates.get(product.slug);
  if (!templateId) throw new Error(`Unknown product ${product.slug}`);
  const { result: template } = await get(`/product-templates/${templateId}`);
  if (
    template.title !== product.title ||
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
  "Refreshed Printful shipping destinations for all four approved products.",
);
