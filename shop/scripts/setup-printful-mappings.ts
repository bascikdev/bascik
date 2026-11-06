import { readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { products } from "../src/lib/catalog.ts";
import { templateFingerprint } from "./template-fingerprint.ts";
import {
  shippingPlacements,
  type PrintfulShippingPlacement,
} from "../src/lib/printful-design.ts";

const proposal: {
  store: { id: number };
  mappings: {
    variant_id: string;
    store_id: number;
    catalog_variant_id: number;
    product_template_id: number;
    shipping_placements: PrintfulShippingPlacement[];
  }[];
} = JSON.parse(
  await readFile(".local/printful-template-mappings.json", "utf8"),
);
const validation = JSON.parse(
  await readFile(".local/printful-validation-draft.json", "utf8"),
);
const variants = products.flatMap((product) => product.variants);
if (
  proposal.store.id !== 19022802 ||
  proposal.mappings.length !== variants.length ||
  new Set(proposal.mappings.map((mapping) => mapping.variant_id)).size !==
    variants.length ||
  validation.draft?.store_id !== 19022802 ||
  validation.draft.status !== "draft" ||
  validation.proposalFingerprint !== templateFingerprint(proposal.mappings) ||
  validation.draft.external_id !==
    `bascik-audit-${validation.proposalFingerprint.slice(0, 19)}` ||
  validation.draft.costs?.calculation_status !== "done" ||
  validation.items?.length !== variants.length
)
  throw new Error(
    "A complete validated API-store template draft is required before mapping setup.",
  );
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const statements = proposal.mappings.map((mapping) => {
  const item = validation.items.find(
    (entry: { external_id: string }) =>
      entry.external_id === mapping.variant_id,
  );
  if (
    !variants.some((variant) => variant.id === mapping.variant_id) ||
    mapping.store_id !== 19022802 ||
    !Number.isSafeInteger(mapping.catalog_variant_id) ||
    mapping.catalog_variant_id <= 0 ||
    !Number.isSafeInteger(mapping.product_template_id) ||
    mapping.product_template_id <= 0 ||
    item?.source !== "product_template" ||
    item.catalog_variant_id !== mapping.catalog_variant_id ||
    item.quantity !== 1
  )
    throw new Error(`Validated variant mismatch for ${mapping.variant_id}`);
  const design = shippingPlacements(mapping.shipping_placements);
  if (
    item.placements.length !== design.length ||
    !design.every((expected) =>
      item.placements.some(
        (actual: { placement: string; technique: string }) =>
          actual.placement === expected.placement &&
          actual.technique === expected.technique,
      ),
    )
  )
    throw new Error(`Validated technique mismatch for ${mapping.variant_id}`);
  return `INSERT INTO printful_template_mappings(variant_id,store_id,catalog_variant_id,product_template_id,shipping_placements,verified) VALUES (${quote(mapping.variant_id)},19022802,${mapping.catalog_variant_id},${mapping.product_template_id},${quote(JSON.stringify(design))},1) ON CONFLICT(variant_id) DO UPDATE SET store_id=excluded.store_id,catalog_variant_id=excluded.catalog_variant_id,product_template_id=excluded.product_template_id,shipping_placements=excluded.shipping_placements,verified=1;`;
});
await writeFile(
  ".local/printful-template-mappings.sql",
  statements.join("\n"),
  { mode: 0o600 },
);
if (process.argv.includes("--write")) {
  const config = JSON.parse(await readFile(".output/wrangler.json", "utf8"));
  if (
    config.name !== "bascik-shop-sandbox" ||
    config.d1_databases?.find(
      (database: { binding: string; database_id: string }) =>
        database.binding === "DB",
    )?.database_id !== "17c831f5-82a4-4094-ad10-5489830c6ae2"
  )
    throw new Error(
      "Mapping setup is restricted to the provisioned sandbox database.",
    );
  const result = spawnSync(
    "yarn",
    [
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--remote",
      "--config",
      ".output/wrangler.json",
      "--file",
      ".local/printful-template-mappings.sql",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error("Remote template mapping setup failed.");
  console.log(
    `Installed ${statements.length} owner-approved template mappings in sandbox D1. Checkout and fulfillment remain disabled.`,
  );
} else {
  console.log(
    `Prepared ${statements.length} validated mappings. Use --write to install in sandbox D1.`,
  );
}
