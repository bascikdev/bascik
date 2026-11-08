import { readFile, mkdir, writeFile } from "node:fs/promises";
import { products } from "../src/lib/catalog.ts";
import { shippingPlacements } from "../src/lib/printful-design.ts";
import { productTemplates } from "./product-templates.ts";

const token = process.env.PRINTFUL_TOKEN ?? process.env.PRINTFUL_TOEKN;
const storeId = Number(process.env.PRINTFUL_STORE_ID);
if (!token || !Number.isSafeInteger(storeId) || storeId <= 0)
  throw new Error(
    "Set PRINTFUL_TOKEN and PRINTFUL_STORE_ID for template auditing.",
  );
async function get(path: string) {
  const response = await fetch(`https://api.printful.com${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      "X-PF-Store-Id": String(storeId),
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`Printful template audit ${path}: HTTP ${response.status}`);
  return response.json();
}
const store = (await get(`/v2/stores/${storeId}`)).data;
if (store.id !== storeId || store.type !== "native")
  throw new Error("Template auditing requires the dedicated Manual/API store.");
interface Template {
  id: number;
  title: string;
  available_variant_ids: number[];
  placements: {
    placement: string;
    technique_key: string;
    options: unknown[];
  }[];
  placement_option_data: { type: string; options: unknown[] }[];
}
const templates: Template[] = [];
for (let offset = 0; offset < 10_000; offset += 100) {
  const page = await get(`/product-templates?limit=100&offset=${offset}`);
  if (
    !Array.isArray(page.result?.items) ||
    !Number.isSafeInteger(page.paging?.total)
  )
    throw new Error("Invalid Printful template pagination.");
  templates.push(...page.result.items);
  if (templates.length >= page.paging.total) break;
  if (!page.result.items.length || offset === 9900)
    throw new Error("Incomplete Printful template pagination.");
}
const source: {
  products: {
    sync_product: { name: string };
    sync_variants: {
      external_id: string;
      variant_id: number;
      color: string;
      size: string;
    }[];
  }[];
} = JSON.parse(await readFile(".local/printful-shopify.json", "utf8"));
const mappings = [];
for (const product of products) {
  const approved = productTemplates[product.slug];
  if (!approved) throw new Error(`Unknown template for ${product.slug}`);
  const matches = templates.filter(
    (template) =>
      template.id === approved.id &&
      template.title === (approved.title ?? product.title),
  );
  const originals = source.products.filter(
    (entry) => entry.sync_product.name === product.title,
  );
  if (
    matches.length !== 1 ||
    (!approved.catalogVariantId && originals.length !== 1)
  )
    throw new Error(`Ambiguous or missing template for ${product.slug}`);
  const template = matches[0];
  if (!Number.isSafeInteger(template.id) || template.id <= 0)
    throw new Error("Invalid Printful template ID.");
  const design = shippingPlacements(
    template.placements.map((placement) => {
      const options =
        template.placement_option_data.find(
          (entry) => entry.type === placement.placement,
        )?.options ?? [];
      if (placement.options.length || options.length)
        throw new Error(
          "Template placement options require an explicit reviewed translation.",
        );
      return {
        placement: placement.placement,
        technique: placement.technique_key.toLowerCase(),
      };
    }),
  );
  for (const variant of product.variants) {
    if (approved.catalogVariantId) {
      if (!template.available_variant_ids.includes(approved.catalogVariantId))
        throw new Error(`Template variant mismatch for ${variant.id}`);
      mappings.push({
        variant_id: variant.id,
        store_id: storeId,
        catalog_variant_id: approved.catalogVariantId,
        product_template_id: template.id,
        shipping_placements: design,
        verified: false,
      });
      continue;
    }
    const original = originals[0].sync_variants.filter(
      (entry) => entry.external_id === variant.id,
    );
    if (
      original.length !== 1 ||
      original[0].color !== variant.color ||
      original[0].size !== (variant.size ?? "One size") ||
      !template.available_variant_ids.includes(original[0].variant_id)
    )
      throw new Error(`Template variant mismatch for ${variant.id}`);
    mappings.push({
      variant_id: variant.id,
      store_id: storeId,
      catalog_variant_id: original[0].variant_id,
      product_template_id: template.id,
      shipping_placements: design,
      verified: false,
    });
  }
}
await mkdir(".local", { recursive: true, mode: 0o700 });
await writeFile(
  ".local/printful-template-mappings.json",
  JSON.stringify(
    { store: { id: storeId, name: store.name }, mappings },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  `Read-only audit: ${mappings.length} variant/template references saved privately. No orders created and no mappings marked verified.`,
);
