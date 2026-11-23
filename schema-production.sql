-- Schéma pour Supabase (ou toute base vide) : tables seulement, SANS livres de démonstration.
-- À coller dans « SQL Editor » de Supabase, puis « Run ».
CREATE TABLE IF NOT EXISTS books (
  id SERIAL PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, category TEXT NOT NULL,
  price INT NOT NULL CHECK (price > 0), old_price INT, hue INT NOT NULL DEFAULT 200, active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS orders (
  id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('airtel','moov')), total INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','delivered','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id INT NOT NULL REFERENCES orders(id), book_id INT NOT NULL REFERENCES books(id),
  PRIMARY KEY (order_id, book_id)
);
CREATE TABLE IF NOT EXISTS downloads (
  token TEXT PRIMARY KEY, order_id INT NOT NULL REFERENCES orders(id), book_id INT NOT NULL REFERENCES books(id),
  expires_at TIMESTAMPTZ NOT NULL, count INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS orders_email_idx ON orders(email);

-- SÉCURITÉ SUPABASE : sans cela, la clé publique du projet pourrait lire ou modifier ces tables depuis Internet
-- (adresses e-mail et numéros de vos clients !). Le site utilise une connexion directe qui n'est pas concernée.
ALTER TABLE books ENABLE ROW LEVEL SECURITY;
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE downloads ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON ALL TABLES IN SCHEMA public FROM anon, authenticated';
    EXECUTE 'REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM anon, authenticated';
  END IF;
END $$;
