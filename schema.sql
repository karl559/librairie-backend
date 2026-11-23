CREATE TABLE books (
  id SERIAL PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL,
  category TEXT NOT NULL, price INT NOT NULL CHECK (price > 0), active BOOLEAN NOT NULL DEFAULT true
);
CREATE TABLE orders (
  id SERIAL PRIMARY KEY, ref TEXT UNIQUE NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
  operator TEXT NOT NULL CHECK (operator IN ('airtel','moov')), total INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','paid','delivered','failed')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), paid_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ
);
CREATE TABLE order_items (
  order_id INT NOT NULL REFERENCES orders(id), book_id INT NOT NULL REFERENCES books(id),
  PRIMARY KEY (order_id, book_id)
);
CREATE TABLE downloads (
  token TEXT PRIMARY KEY, order_id INT NOT NULL REFERENCES orders(id), book_id INT NOT NULL REFERENCES books(id),
  expires_at TIMESTAMPTZ NOT NULL, count INT NOT NULL DEFAULT 0
);
CREATE INDEX ON orders(email);
INSERT INTO books (id,title,author,category,price) VALUES
(1,'L’Alchimiste','Paulo Coelho','Romans',7500),
(2,'Une si longue lettre','Mariama Bâ','Afrique',6000),
(3,'Le Monde s’effondre','Chinua Achebe','Afrique',8000),
(4,'Un rien peut tout changer','James Clear','Développement perso',12500),
(5,'Père riche, père pauvre','Robert Kiyosaki','Développement perso',9000),
(6,'Sapiens','Yuval Noah Harari','Sciences',14000),
(7,'Le Petit Prince','A. de Saint-Exupéry','Jeunesse',5000),
(8,'L’Étranger','Albert Camus','Romans',5500),
(9,'Clean Code','Robert C. Martin','Informatique',32000),
(10,'Designing Data-Intensive Applications','Martin Kleppmann','Informatique',38000),
(11,'Une brève histoire du temps','Stephen Hawking','Sciences',11000),
(12,'Les Misérables','Victor Hugo','Romans',10500),
(13,'Pensez et devenez riche','Napoleon Hill','Développement perso',8500),
(14,'Le Roi Lion — Contes d’Afrique','Collectif','Jeunesse',6500);
SELECT setval('books_id_seq',14);

-- À lancer UNE fois sur une base existante : psql -h localhost -U libris -d libris -f migration.sql
ALTER TABLE books ADD COLUMN IF NOT EXISTS old_price INT;
ALTER TABLE books ADD COLUMN IF NOT EXISTS hue INT NOT NULL DEFAULT 200;
UPDATE books SET
 old_price = CASE id WHEN 1 THEN 9500 WHEN 3 THEN 9500 WHEN 4 THEN 15000 WHEN 6 THEN 16500 WHEN 9 THEN 38000 WHEN 11 THEN 13000 WHEN 13 THEN 10000 END,
 hue = CASE id WHEN 1 THEN 28 WHEN 2 THEN 340 WHEN 3 THEN 12 WHEN 4 THEN 200 WHEN 5 THEN 150 WHEN 6 THEN 20 WHEN 7 THEN 215
   WHEN 8 THEN 45 WHEN 9 THEN 265 WHEN 10 THEN 175 WHEN 11 THEN 235 WHEN 12 THEN 0 WHEN 13 THEN 50 WHEN 14 THEN 95 ELSE 200 END
WHERE id <= 14 AND old_price IS NULL AND hue = 200;
