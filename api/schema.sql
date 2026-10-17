-- Stall: agent-shoppable stalls for WhatsApp/Instagram sellers
CREATE TABLE IF NOT EXISTS stalls (
  id TEXT PRIMARY KEY,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  whatsapp TEXT NOT NULL,
  wallet TEXT NOT NULL,
  city TEXT,
  bio TEXT,
  edit_key_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  title TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL,
  stock INTEGER NOT NULL DEFAULT 1,
  photo_url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS products_stall ON products(stall_id);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  stall_id TEXT NOT NULL REFERENCES stalls(id),
  qty INTEGER NOT NULL,
  amount_atomic TEXT NOT NULL,
  note TEXT,
  contact TEXT,
  status TEXT NOT NULL DEFAULT 'awaiting_payment',
  tx_hash TEXT,
  start_block INTEGER,
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX IF NOT EXISTS orders_stall ON orders(stall_id);

CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  query TEXT,
  product_id TEXT,
  max_cents INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
