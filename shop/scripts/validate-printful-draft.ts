import { mkdir, readFile, writeFile } from "node:fs/promises";
import { products } from "../src/lib/catalog.ts";
import { printful, printfulList, ProviderError } from "../src/lib/providers.ts";
import {
  shippingPlacements,
  type PrintfulShippingPlacement,
} from "../src/lib/printful-design.ts";

const token = process.env.PRINTFUL_TOKEN ?? process.env.PRINTFUL_TOEKN;
const storeId = Number(process.env.PRINTFUL_STORE_ID);
if (!token || storeId !== 19022802)
  throw new Error(
    "Draft validation is restricted to the approved API store 19022802.",
  );
const env = { PRINTFUL_TOKEN: token, PRINTFUL_STORE_ID: String(storeId) };
const proposal: {
  store: { id: number };
  mappings: {
    variant_id: string;
    store_id: number;
    catalog_variant_id: number;
    product_template_id: number;
    shipping_placements: PrintfulShippingPlacement[];
    verified: boolean;
  }[];
} = JSON.parse(
  await readFile(".local/printful-template-mappings.json", "utf8"),
);
const variants = products.flatMap((product) =>
  product.variants.map((variant) => ({ product, variant })),
);
if (
  proposal.store.id !== storeId ||
  proposal.mappings.length !== variants.length ||
  new Set(proposal.mappings.map((mapping) => mapping.variant_id)).size !==
    variants.length
)
  throw new Error("Incomplete or mismatched template audit.");
const order_items = variants.map(({ product, variant }) => {
  const mapping = proposal.mappings.find(
    (entry) => entry.variant_id === variant.id,
  );
  if (
    !mapping ||
    mapping.store_id !== storeId ||
    !Number.isSafeInteger(mapping.product_template_id) ||
    mapping.product_template_id <= 0 ||
    !Number.isSafeInteger(mapping.catalog_variant_id) ||
    mapping.catalog_variant_id <= 0
  )
    throw new Error(`Invalid template reference for ${variant.id}`);
  shippingPlacements(mapping.shipping_placements);
  return {
    source: "product_template",
    external_id: variant.id,
    catalog_variant_id: mapping.catalog_variant_id,
    product_template_id: mapping.product_template_id,
    quantity: 1,
    retail_price: (product.price / 100).toFixed(2),
    name: `VALIDATION ONLY - ${product.title} / ${variant.title}`,
  };
});
const recipient = {
  name: "Bascik API validation - DO NOT FULFILL",
  address1: "19749 Dearborn St",
  city: "Chatsworth",
  state_code: "CA",
  country_code: "US",
  zip: "91311",
};
const externalId = "bascik-v2-audit-19022802";
interface Draft {
  id: number;
  store_id: number;
  external_id: string;
  status: string;
  costs: { calculation_status: string };
}
let draft: Draft | undefined;
try {
  draft = await printful<Draft>(env, `/orders/@${externalId}`);
} catch (error) {
  if (!(error instanceof ProviderError) || error.status !== 404) throw error;
}
if (!draft) {
  draft = await printful<Draft>(env, "/orders", {
    external_id: externalId,
    recipient,
    order_items,
    shipping: "STANDARD",
    retail_costs: { currency: "USD" },
  });
}
if (
  !Number.isSafeInteger(draft.id) ||
  draft.store_id !== storeId ||
  draft.external_id !== externalId ||
  draft.status !== "draft"
)
  throw new Error(
    "Validation order is not the expected unconfirmed draft; inspect it before proceeding.",
  );
await mkdir(".local", { recursive: true, mode: 0o700 });
await writeFile(
  ".local/printful-validation-draft.json",
  JSON.stringify(draft, null, 2),
  { mode: 0o600 },
);
for (
  let attempt = 0;
  draft.costs.calculation_status === "calculating" && attempt < 20;
  ++attempt
) {
  await new Promise((resolve) => setTimeout(resolve, 3000));
  draft = await printful<Draft>(env, `/orders/${draft.id}`);
  if (
    draft.status !== "draft" ||
    draft.store_id !== storeId ||
    draft.external_id !== externalId
  )
    throw new Error(
      "Validation draft changed unexpectedly; inspect the provider dashboard.",
    );
}
if (draft.costs.calculation_status !== "done")
  throw new Error(
    `Draft ${draft.id}: cost calculation ${draft.costs.calculation_status}. No confirmation was sent.`,
  );
interface DraftItem {
  external_id: string;
  source: string;
  catalog_variant_id: number;
  quantity: number;
  placements: {
    placement: string;
    technique: string;
    status: string;
    status_explanation: string;
    layers: {
      type: string;
      position: { width: number; height: number; top: number; left: number };
    }[];
  }[];
}
const items = await printfulList<DraftItem>(
  env,
  `/orders/${draft.id}/order-items`,
);
if (items.length !== proposal.mappings.length)
  throw new Error("Validation draft has unexpected item count.");
for (const mapping of proposal.mappings) {
  const matches = items.filter(
    (item) => item.external_id === mapping.variant_id,
  );
  if (
    matches.length !== 1 ||
    matches[0].source !== "product_template" ||
    matches[0].catalog_variant_id !== mapping.catalog_variant_id ||
    matches[0].quantity !== 1 ||
    matches[0].placements.length !== mapping.shipping_placements.length ||
    !mapping.shipping_placements.every((expected) =>
      matches[0].placements.some(
        (placement) =>
          placement.placement === expected.placement &&
          placement.technique === expected.technique &&
          (placement.status === "ok" ||
            (placement.status === "" && placement.status_explanation === "")) &&
          Array.isArray(placement.layers) &&
          placement.layers.length > 0 &&
          placement.layers.every(
            (layer) =>
              layer.type === "file" &&
              layer.position &&
              ["width", "height", "top", "left"].every((key) =>
                Number.isFinite(
                  layer.position[key as keyof typeof layer.position],
                ),
              ) &&
              layer.position.width > 0 &&
              layer.position.height > 0,
          ),
      ),
    )
  )
    throw new Error(
      `Draft design validation failed for ${mapping.variant_id}; no mappings verified.`,
    );
}
const unspecifiedPlacementStatuses = items
  .flatMap((item) => item.placements)
  .filter((placement) => placement.status === "").length;
if (unspecifiedPlacementStatuses)
  console.warn(
    `Printful returned ${unspecifiedPlacementStatuses} blank template placement statuses. Cost calculation succeeded. Exact owner-prepared templates remain the design source; blank fields are not explicit provider artwork approval.`,
  );
const rates = await printful<
  { shipping: string; rate: string; currency: string }[]
>(env, "/shipping-rates", {
  recipient,
  currency: "USD",
  order_items: order_items.map((item) => ({
    source: "catalog",
    catalog_variant_id: item.catalog_variant_id,
    quantity: item.quantity,
    retail_price: item.retail_price,
    placements: proposal.mappings.find(
      (mapping) => mapping.variant_id === item.external_id,
    )!.shipping_placements,
  })),
});
if (
  !Array.isArray(rates) ||
  !rates.length ||
  rates.some((rate) => rate.currency !== "USD")
)
  throw new Error("Draft shipping validation failed.");
await writeFile(
  ".local/printful-validation-draft.json",
  JSON.stringify(
    {
      draft,
      items,
      rates,
      unspecifiedPlacementStatuses,
      designSource: "owner-prepared-product-templates",
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  JSON.stringify({
    storeId,
    draftId: draft.id,
    externalId,
    status: draft.status,
    variantsValidated: items.length,
    shippingServices: rates.map((rate) => rate.shipping),
    unspecifiedPlacementStatuses,
    mappingsVerified: false,
    confirmationSent: false,
  }),
);
