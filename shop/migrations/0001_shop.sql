CREATE TABLE quotes (
  id TEXT PRIMARY KEY,
  snapshot TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE variant_mappings (
  variant_id TEXT PRIMARY KEY,
  sync_variant_id INTEGER NOT NULL UNIQUE,
  catalog_variant_id INTEGER NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0, 1))
);
CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  quote_id TEXT NOT NULL UNIQUE REFERENCES quotes(id),
  shipping_id TEXT NOT NULL,
  snapshot TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  stripe_session TEXT UNIQUE,
  printful_id INTEGER UNIQUE,
  shipments TEXT NOT NULL DEFAULT '[]',
  token_revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX orders_work ON orders(status, retry_at, updated_at);
CREATE TABLE payment_events (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX payment_events_order ON payment_events(order_id);
CREATE TABLE notifications (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  retry_at INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE rate_limits (
  id TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL
);
