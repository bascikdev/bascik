CREATE TABLE printful_template_mappings (
  variant_id TEXT PRIMARY KEY,
  store_id INTEGER NOT NULL CHECK (store_id > 0),
  catalog_variant_id INTEGER NOT NULL CHECK (catalog_variant_id > 0),
  product_template_id INTEGER NOT NULL CHECK (product_template_id > 0),
  shipping_placements TEXT NOT NULL CHECK (json_valid(shipping_placements)),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))
);
