import { createHash } from "node:crypto";
import {
  shippingPlacements,
  type PrintfulShippingPlacement,
} from "../src/lib/printful-design.ts";

export interface TemplateMapping {
  variant_id: string;
  store_id: number;
  catalog_variant_id: number;
  product_template_id: number;
  shipping_placements: PrintfulShippingPlacement[];
}

export function templateFingerprint(mappings: TemplateMapping[]): string {
  const normalized = mappings
    .map((mapping) => ({
      variant_id: mapping.variant_id,
      store_id: mapping.store_id,
      catalog_variant_id: mapping.catalog_variant_id,
      product_template_id: mapping.product_template_id,
      shipping_placements: shippingPlacements(mapping.shipping_placements).sort(
        (a, b) =>
          `${a.placement}:${a.technique}`.localeCompare(
            `${b.placement}:${b.technique}`,
          ),
      ),
    }))
    .sort((a, b) => a.variant_id.localeCompare(b.variant_id));
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}
