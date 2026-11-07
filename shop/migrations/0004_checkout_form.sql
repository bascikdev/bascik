CREATE TABLE checkout_forms (
  order_id TEXT PRIMARY KEY REFERENCES orders(id),
  revision INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  address_hash TEXT NOT NULL DEFAULT ''
);
