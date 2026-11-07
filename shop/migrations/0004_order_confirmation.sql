ALTER TABLE orders ADD COLUMN payment_tax INTEGER;
ALTER TABLE orders ADD COLUMN payment_total INTEGER;
ALTER TABLE notifications ADD COLUMN message_id TEXT;
ALTER TABLE notifications ADD COLUMN sent_at INTEGER;
