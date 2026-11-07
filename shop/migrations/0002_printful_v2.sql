CREATE TABLE printful_v2_mappings (
  variant_id TEXT PRIMARY KEY,
  catalog_variant_id INTEGER NOT NULL CHECK (catalog_variant_id > 0),
  placements TEXT NOT NULL CHECK (json_valid(placements)),
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))
);
