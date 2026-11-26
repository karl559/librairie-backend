require("dotenv").config();
const express = require("express"), { Pool } = require("pg");
const storage = require("./lib/storage"), { sendMail } = require("./lib/mailer");
const sharp = require("sharp"), crypto = require("crypto"), path = require("path"), fs = require("fs"), rateLimit = require("express-rate-limit");
const { PORT = 3000, DATABASE_URL, BASE_URL = "http://localhost:3000", SMTP_HOST, SMTP_PORT = 587, SMTP_USER, SMTP_PASS,
  MAIL_FROM, PAYMENT_PROVIDER = "mock", PAYMENT_SECRET = "", ADMIN_KEY = "" } = process.env;

// DATABASE_SSL=1 pour Supabase (connexion chiffrée obligatoire) ; utilisez l'adresse « pooler » de Supabase (IPv4)
const db = new Pool({
  connectionString: DATABASE_URL, ssl: process.env.DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined,
  max: +process.env.DB_POOL_MAX || 5,       // peu de connexions : les offres gratuites en limitent le nombre
  idleTimeoutMillis: 30_000, keepAlive: true
});
// Le pooler (Supabase, Render...) coupe les connexions inactives : sans ce gestionnaire, le serveur s'arrêterait net.
db.on("error", e => console.error("Connexion à la base coupée (elle sera rétablie automatiquement) :", e.message));
const SHOP_NAME = process.env.SHOP_NAME || "Libris", MAIL_REPLY_TO = process.env.MAIL_REPLY_TO || undefined;
const ah = fn => (req, res, next) => fn(req, res, next).catch(e => { console.error(e); res.status(500).json({ error: "Erreur serveur" }); });
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// ---- Numéros gabonais : 9 chiffres avec le 0 initial (accepte +241 et les espaces) ----
const normPhone = s => {
  let d = String(s || "").replace(/\D/g, "");
  if (d.startsWith("241") && d.length >= 11) d = d.slice(3);
  if (d.length === 8) d = "0" + d;
  return /^0\d{8}$/.test(d) ? d : null;
};

// ---- SingPay (Mobile Money Gabon : Airtel = 74, Moov = 62) ----
const SP = {
  id: process.env.SINGPAY_CLIENT_ID, secret: process.env.SINGPAY_CLIENT_SECRET, wallet: process.env.SINGPAY_WALLET,
  base: (process.env.SINGPAY_BASE_URL || "https://gateway.singpay.ga/v1").replace(/\/$/, ""),
  okStatus: process.env.SINGPAY_SUCCESS_STATUS || "Terminate",     // d'après SingPay : status = Terminate ET result = Success
  okResult: process.env.SINGPAY_SUCCESS_RESULT || "Success",
  testMode: process.env.SINGPAY_TEST_MODE === "1",
  timeoutMs: +process.env.SINGPAY_TIMEOUT_MS || 20000,
  notFoundMs: Math.max(0, +(process.env.SINGPAY_NOTFOUND_MINUTES || 3)) * 60_000
};
const spCall = async (method, p, body) => {
  const r = await fetch(SP.base + p, {
    method, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(SP.timeoutMs),
    headers: { "Content-Type": "application/json", "x-client-id": SP.id, "x-client-secret": SP.secret, "x-wallet": SP.wallet }
  });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
  return { http: r.status, data };
};

// ---- Fournisseur de paiement (Mobile Money) ----
const providers = {
  // Test local : simule un paiement réussi après 3 s, pour essayer toute la chaîne sans argent.
  mock: { async initiate(o) { setTimeout(() => markPaid(o.ref).catch(console.error), 3000); } },
  singpay: {
    async initiate({ ref, amount, phone, operator }) {
      let r;
      try {
        r = await spCall("POST", `/${operator === "airtel" ? "74" : "62"}/paiement`,
          { amount, reference: ref, client_msisdn: phone, portefeuille: SP.wallet, isTransfer: false });
      } catch (e) {
        // Délai dépassé / coupure : la demande a peut-être atteint SingPay. Ne JAMAIS conclure à un échec ici.
        throw Object.assign(new Error("SingPay injoignable : " + ((e.cause && e.cause.code) || e.name)), { ambiguous: true });
      }
      if (r.http !== 200 || !(r.data && r.data.status && r.data.status.success))
        throw new Error("SingPay a refusé le paiement : HTTP " + r.http + " " + JSON.stringify(r.data).slice(0, 300));
    },
    // Source de vérité : on interroge SingPay lui-même (jamais le navigateur, jamais le seul contenu d'un rappel).
    // Retourne "paid", "failed" ou "pending". En cas de doute : "pending", donc aucune livraison.
    async check(o) {
      const r = await spCall("GET", `/transaction/api/search/by-reference/${encodeURIComponent(o.ref)}`);
      if ((r.http === 404 || r.http === 400) && /not found/i.test(typeof r.data === "string" ? r.data : JSON.stringify(r.data))) return "notfound";
      if (r.http !== 200) return "pending";
      let t = r.data;
      if (Array.isArray(t)) t = t.find(x => x && x.reference === o.ref);
      if (t && t.transaction) t = t.transaction;
      if (!t || t.reference !== o.ref || Number(t.amount) !== Number(o.total)) { console.error("SingPay : réponse incohérente pour", o.ref); return "pending"; }
      if (t.status === SP.okStatus) {   // transaction terminée : payée seulement si le résultat est « Success »
        if (t.result === SP.okResult) return "paid";
        if (/fail|error|cancel|reject|timeout|expire|insufficient|denied/i.test(String(t.result || ""))) return "failed";
        return "pending";               // résultat pas encore connu : on ne livre pas, on revérifie
      }
      // Portefeuille de TEST uniquement : SingPay confirme (result = Success) puis rembourse aussitôt.
      const isTestWallet = /^TEST/.test(String((t.portefeuille && t.portefeuille.merchant_code) || ""));
      if (SP.testMode && isTestWallet && t.result === "Success") return "paid";
      if (t.status === "Refund" || /^(fail|cancel|error|expire|reject)/i.test(String(t.status || ""))) return "failed";
      return "pending";
    }
  }
};
if (!providers[PAYMENT_PROVIDER]) { console.error("PAYMENT_PROVIDER invalide : " + PAYMENT_PROVIDER + " (mock ou singpay)"); process.exit(1); }
// Garde-fou : le paiement simulé livrerait les livres SANS paiement. Interdit sur un serveur en ligne (Render, NODE_ENV=production).
if (PAYMENT_PROVIDER === "mock" && (process.env.RENDER || process.env.NODE_ENV === "production") && process.env.ALLOW_MOCK_PAYMENTS !== "1") {
  console.error("ARRÊT : PAYMENT_PROVIDER=mock est interdit en ligne, il livrerait les livres SANS paiement. Mettez PAYMENT_PROVIDER=singpay.");
  process.exit(1);
}
if (PAYMENT_PROVIDER === "mock") console.warn("ATTENTION : paiement SIMULÉ (mock). Les livres sont livrés sans paiement : réservé aux essais sur votre PC.");
if (PAYMENT_PROVIDER === "singpay") {
  if (!(SP.id && SP.secret && SP.wallet)) { console.error("SingPay : renseignez SINGPAY_CLIENT_ID, SINGPAY_CLIENT_SECRET et SINGPAY_WALLET dans .env"); process.exit(1); }
  if (SP.id === SP.secret) { console.error("SingPay : SINGPAY_CLIENT_ID et SINGPAY_CLIENT_SECRET sont identiques (erreur de copie ?)"); process.exit(1); }
}

// ---- Livraison ----
async function markPaid(ref) {
  const r = await db.query("UPDATE orders SET status='paid', paid_at=now() WHERE ref=$1 AND status='pending' RETURNING *", [ref]);
  if (!r.rowCount) return; // déjà traité : jamais deux envois
  await deliver(r.rows[0]).catch(e => console.error("Envoi e-mail échoué (commande payée, renvoi possible) :", ref, e.message));
}

async function markFailed(ref) {
  await db.query("UPDATE orders SET status='failed' WHERE ref=$1 AND status='pending'", [ref]);
}
// Demande à l'agrégateur où en est une commande en attente (au plus une fois toutes les 3 s, 10 min si elle est ancienne)
const lastCheck = new Map();
async function checkOrder(o, force) {
  const p = providers[PAYMENT_PROVIDER];
  if (!p.check || o.status !== "pending") return;
  const gap = Date.now() - new Date(o.created_at) > 20 * 60_000 ? 600_000 : 3000;
  if (!force && Date.now() - (lastCheck.get(o.ref) || 0) < gap) return;
  lastCheck.set(o.ref, Date.now());
  let v;
  try { v = await p.check(o); } catch (e) { console.error("Vérification du paiement impossible (réessai automatique) :", o.ref, e.message); return; }
  if (v === "paid") await markPaid(o.ref); else if (v === "failed") await markFailed(o.ref);
  // SingPay n'a jamais reçu la demande : on ne conclut à l'échec qu'après un délai, au cas où elle soit encore en route
  else if (v === "notfound" && Date.now() - new Date(o.created_at) > SP.notFoundMs) await markFailed(o.ref);
}

async function deliver(o) {
  const items = (await db.query("SELECT b.id,b.title FROM order_items oi JOIN books b ON b.id=oi.book_id WHERE oi.order_id=$1", [o.id])).rows;
  const books = [];
  for (const b of items) {
    const t = crypto.randomBytes(24).toString("hex");
    await db.query("INSERT INTO downloads(token,order_id,book_id,expires_at) VALUES($1,$2,$3,now()+interval '7 days')", [t, o.id, b.id]);
    const fmts = storage.formatsOf(b.id);
    books.push({ title: b.title, links: fmts.map(f => ({ label: f.toUpperCase(), url: `${BASE_URL}/dl/${t}?f=${f}` })) });
  }
  const total = o.total.toLocaleString("fr-FR");
  const waiting = "fichier en préparation, nous vous l'envoyons très vite";
  const li = b => `<li style="margin-bottom:12px"><b>${esc(b.title)}</b><br>` +
    (b.links.map(l => `<a href="${l.url}">Télécharger le ${l.label}</a>`).join(" &nbsp;·&nbsp; ") || `<i>${waiting}</i>`) + "</li>";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#222;max-width:560px">
<p>Bonjour,</p>
<p>Merci pour votre achat sur ${esc(SHOP_NAME)}. Voici vos livres (commande <b>${o.ref}</b>, ${total} FCFA) :</p>
<ul style="padding-left:18px">${books.map(li).join("")}</ul>
<p>Ces liens personnels sont valables 7 jours. Si vous ne les retrouvez plus, répondez à cet e-mail avec votre numéro de commande.</p>
<p style="color:#666;font-size:12px">Vous recevez ce message parce qu'une commande a été passée avec cette adresse sur ${esc(BASE_URL)}. Si vous n'êtes pas à l'origine de cette commande, ignorez ce message.</p></div>`;
  const text = `Bonjour,\n\nMerci pour votre achat sur ${SHOP_NAME}. Voici vos livres (commande ${o.ref}, ${total} FCFA) :\n\n` +
    books.map(b => `${b.title}\n` + (b.links.map(l => `  ${l.label} : ${l.url}`).join("\n") || `  ${waiting}`)).join("\n\n") +
    `\n\nCes liens personnels sont valables 7 jours. Si vous ne les retrouvez plus, répondez à cet e-mail avec votre numéro de commande.\n\n` +
    `Vous recevez ce message parce qu'une commande a été passée avec cette adresse sur ${BASE_URL}. Si vous n'êtes pas à l'origine de cette commande, ignorez ce message.\n`;
  await sendMail({ to: o.email, subject: `Vos livres ${SHOP_NAME} (commande ${o.ref})`, text, html });
  await db.query("UPDATE orders SET status='delivered', delivered_at=now() WHERE id=$1", [o.id]);
}

// ---- API ----
const app = express();
app.set("trust proxy", 1);
app.use(express.json());
app.get("/healthz", (req, res) => res.type("text/plain").send("ok"));   // pour Render et les moniteurs de disponibilité (ne touche pas la base)
// ---- Pages légales : modèles dans legal/, complétés par les variables LEGAL_* du .env ----
const LEGAL = { "mentions-legales": "Mentions légales", "conditions-de-vente": "Conditions de vente", "remboursement": "Remboursement", "confidentialite": "Confidentialité", "contact": "Contact" };
app.get("/p/:name", (req, res) => {
  const title = LEGAL[req.params.name];
  if (!title) return res.status(404).send("Page introuvable");
  const todo = new Set();
  const body = fs.readFileSync(path.join(__dirname, "legal", req.params.name + ".html"), "utf8").replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => {
    const v = k === "SHOP_NAME" ? SHOP_NAME : process.env[k];
    if (v && String(v).trim()) return esc(v);
    todo.add(k); return "";
  });
  const links = Object.entries(LEGAL).map(([k, t]) => `<a href="/p/${k}">${t}</a>`).join(" · ");
  res.type("html").send(`<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · ${esc(SHOP_NAME)}</title>
<style>body{margin:0;background:#f4f4f4;color:#222;font:15px/1.6 Inter,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
header{background:#fff;border-bottom:1px solid #e6e6e6;padding:14px 16px}header a{color:#ff6a00;font-weight:700;font-size:22px;text-decoration:none}
main{max-width:760px;margin:16px auto;background:#fff;border-radius:10px;padding:24px 28px}h1{margin-top:0}h2{font-size:17px;margin:22px 0 6px}
a{color:#e85f00}footer{max-width:760px;margin:0 auto 32px;padding:0 16px;color:#666;font-size:13px}
mark.todo{background:#fff3cd;color:#8a4b00;padding:1px 5px;border-radius:4px;font-weight:600}.alert{background:#fff3cd;border:1px solid #f0c36d;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#8a4b00}</style></head>
<body><header><a href="/">${esc(SHOP_NAME)}</a></header>
<main>${body}</main>;
});
app.get("/api/config", (req, res) => res.json({ shopName: SHOP_NAME, salesOpen: process.env.SALES_OPEN !== "0" }));
app.use(express.static(path.join(__dirname, "public")));
storage.mountCovers(app, express);

app.post("/api/checkout", rateLimit({ windowMs: 60_000, limit: +process.env.CHECKOUT_LIMIT || 10 }), async (req, res) => {
  try {
    // Interrupteur de sécurité : SALES_OPEN=0 ferme les ventes (par exemple avant la mise en production du paiement)
    if (process.env.SALES_OPEN === "0") return res.status(503).json({ error: "Les ventes ouvriront très bientôt. Merci de votre patience." });
    const { email, phone, operator, ids, accepted } = req.body || {};
    if (accepted !== true) return res.status(400).json({ error: "Vous devez accepter les conditions de vente pour commander." });
    const tel = normPhone(phone);
    if (!tel) return res.status(400).json({ error: "Numéro de téléphone invalide (ex. 077 65 58 32)" });
    if (!/^\S+@\S+\.\S+$/.test(email || "") || !["airtel", "moov"].includes(operator)
      || !Array.isArray(ids) || !ids.length || ids.length > 20) return res.status(400).json({ error: "Données invalides" });
    const b = await db.query("SELECT id,price FROM books WHERE id = ANY($1) AND active", [ids.map(Number).filter(Number.isInteger)]);
    const uniq = [...new Set(ids.map(Number).filter(Number.isInteger))], rows = b.rows.filter(x => !missing(x.id).length);
    if (!rows.length || rows.length !== uniq.length) return res.status(400).json({ error: "Un livre de votre panier n'est plus disponible. Actualisez la page." });
    const total = rows.reduce((s, x) => s + x.price, 0); // le prix vient TOUJOURS de la base, jamais du navigateur
    const ref = "L" + crypto.randomBytes(5).toString("hex").toUpperCase();
    const o = await db.query("INSERT INTO orders(ref,email,phone,operator,total) VALUES($1,$2,$3,$4,$5) RETURNING id", [ref, email.toLowerCase(), tel, operator, total]);
    for (const x of rows) await db.query("INSERT INTO order_items(order_id,book_id) VALUES($1,$2)", [o.rows[0].id, x.id]);
    try { await providers[PAYMENT_PROVIDER].initiate({ ref, amount: total, phone: tel, operator }); }
    catch (e) {
      console.error(e);
      if (e.ambiguous) return res.status(202).json({ ref, total, uncertain: true }); // la vérification automatique tranchera
      await db.query("UPDATE orders SET status='failed' WHERE ref=$1", [ref]);
      return res.status(502).json({ error: "Paiement indisponible" });
    }
    res.json({ ref, total });
  } catch (e) { console.error(e); res.status(500).json({ error: "Erreur serveur" }); }
});

app.get("/api/order/:ref", rateLimit({ windowMs: 60_000, limit: 240 }), ah(async (req, res) => {
  let r = await db.query("SELECT * FROM orders WHERE ref=$1", [req.params.ref]);
  if (r.rows[0] && r.rows[0].status === "pending") {
    await checkOrder(r.rows[0]);
    r = await db.query("SELECT status FROM orders WHERE ref=$1", [req.params.ref]);
  }
  res.json({ status: r.rows[0]?.status || "unknown" });
}));

// Rappel de l'agrégateur (facultatif : le serveur interroge déjà lui-même les paiements en attente).
// Avec SingPay, le contenu du rappel n'est jamais cru : on revérifie auprès de SingPay.
app.post("/api/webhook/payment", ah(async (req, res) => {
  if (!PAYMENT_SECRET || req.get("x-secret") !== PAYMENT_SECRET) return res.sendStatus(401);
  const { ref, status } = req.body || {};
  if (providers[PAYMENT_PROVIDER].check) {
    const r = await db.query("SELECT * FROM orders WHERE ref=$1", [String(ref || "")]);
    if (r.rows[0]) await checkOrder(r.rows[0], true);
  } else if (status === "SUCCESS") await markPaid(ref);
  else if (status === "FAILED") await markFailed(ref);
  res.sendStatus(200);
}));

app.get("/dl/:token", ah(async (req, res) => {
  const f = req.query.f === "epub" ? "epub" : "pdf";
  const r = await db.query("UPDATE downloads d SET count = d.count + 1 FROM books b WHERE b.id = d.book_id AND d.token=$1 AND d.expires_at>now() AND d.count<10 RETURNING d.book_id, b.title", [req.params.token]);
  if (!r.rowCount) return res.status(410).send("Lien expiré. Contactez la librairie avec votre numéro de commande.");
  let book;
  try { book = await storage.openBook(r.rows[0].book_id, f); }
  catch (e) {   // panne du stockage : ce n'est pas la faute du client, on ne consomme pas un de ses téléchargements
    console.error(e); await db.query("UPDATE downloads SET count = count - 1 WHERE token=$1", [req.params.token]);
    return res.status(502).send("Service momentanément indisponible, réessayez dans un instant.");
  }
  if (!book) return res.status(404).send("Fichier indisponible");
  const name = String(r.rows[0].title).replace(/[\\/:*?"<>|]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) + "." + f;
  if (book.path) return res.download(book.path, name);
  res.attachment(name); res.send(book.buffer);
}));

// ---- Images de couverture (JPEG 640 px max, normalisées à l'envoi) ----
const { coverUrl, formatsOf, missing } = storage;

// ---- Catalogue public ----
app.get("/api/books", ah(async (req, res) => {
  const r = await db.query(`SELECT b.id,b.title,b.author,b.category,b.price,b.old_price,b.hue,
    (SELECT count(*)::int FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE oi.book_id=b.id AND o.status IN ('paid','delivered')) AS sales
    FROM books b WHERE b.active ORDER BY b.id`);
  res.json(r.rows.filter(b => !missing(b.id).length).map(b => ({ ...b, cover: coverUrl(b.id), formats: formatsOf(b.id) })));
}));

// ---- Espace admin (page /admin, protégée par ADMIN_KEY) ----
const adminLimit = rateLimit({ windowMs: 60_000, limit: 120 });
const adminOnly = (req, res, next) => {
  const k = Buffer.from(String(req.get("x-admin-key") || "")), a = Buffer.from(ADMIN_KEY);
  return ADMIN_KEY && k.length === a.length && crypto.timingSafeEqual(k, a) ? next() : res.sendStatus(401);
};
const cleanBook = b => {
  const t = String(b.title || "").trim(), a = String(b.author || "").trim(), c = String(b.category || "").trim();
  const p = parseInt(b.price, 10), o = b.old_price ? parseInt(b.old_price, 10) : null;
  const h = Math.min(359, Math.max(0, Number.isInteger(parseInt(b.hue, 10)) ? parseInt(b.hue, 10) : 200));
  if (!t || !a || !c || t.length > 200 || !(p > 0) || (o !== null && !(o > p))) return null;
  return [t, a, c, p, o, h, b.active !== false];
};
app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("/api/admin/books", adminLimit, adminOnly, ah(async (req, res) => {
  const r = await db.query("SELECT * FROM books ORDER BY id");
  res.json(r.rows.map(b => ({ ...b, pdf: formatsOf(b.id).includes("pdf"), epub: formatsOf(b.id).includes("epub"),
    cover: coverUrl(b.id), missing: missing(b.id), visible: b.active && !missing(b.id).length })));
}));
app.post("/api/admin/books", adminLimit, adminOnly, ah(async (req, res) => {
  const v = cleanBook(req.body || {});
  if (!v) return res.status(400).json({ error: "Champs invalides (titre, auteur, catégorie, prix > 0, ancien prix > prix)" });
  const r = await db.query("INSERT INTO books(title,author,category,price,old_price,hue,active) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id", v);
  res.json({ id: r.rows[0].id });
}));
app.put("/api/admin/books/:id", adminLimit, adminOnly, ah(async (req, res) => {
  const v = cleanBook(req.body || {}), id = parseInt(req.params.id, 10);
  if (!v || !id) return res.status(400).json({ error: "Champs invalides (titre, auteur, catégorie, prix > 0, ancien prix > prix)" });
  const r = await db.query("UPDATE books SET title=$1,author=$2,category=$3,price=$4,old_price=$5,hue=$6,active=$7 WHERE id=$8", [...v, id]);
  r.rowCount ? res.json({ ok: true }) : res.status(404).json({ error: "Livre introuvable" });
}));
app.post("/api/admin/books/:id/file", adminLimit, adminOnly, express.raw({ type: () => true, limit: "100mb" }), ah(async (req, res) => {
  const f = req.query.f === "epub" ? "epub" : "pdf", id = parseInt(req.params.id, 10), buf = req.body;
  if (!id || !(await db.query("SELECT 1 FROM books WHERE id=$1", [id])).rowCount) return res.status(404).json({ error: "Livre introuvable" });
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "Fichier vide" });
  const magic = buf.subarray(0, 4).toString("latin1");
  if ((f === "pdf" && magic !== "%PDF") || (f === "epub" && !magic.startsWith("PK"))) return res.status(400).json({ error: "Ce fichier n'est pas un vrai " + f.toUpperCase() });
  try { await storage.saveBook(id, f, buf); } catch (e) { console.error(e); return res.status(502).json({ error: "Stockage indisponible, réessayez dans un instant" }); }
  res.json({ ok: true, size: buf.length });
}));
app.post("/api/admin/books/:id/cover", adminLimit, adminOnly, express.raw({ type: () => true, limit: "8mb" }), ah(async (req, res) => {
  const id = parseInt(req.params.id, 10), buf = req.body;
  if (!id || !(await db.query("SELECT 1 FROM books WHERE id=$1", [id])).rowCount) return res.status(404).json({ error: "Livre introuvable" });
  if (!Buffer.isBuffer(buf) || !buf.length) return res.status(400).json({ error: "Image vide" });
  let out;
  try {
    const m = await sharp(buf).metadata();
    if (!["jpeg", "png", "webp"].includes(m.format) || m.width < 200 || m.height < 250)
      return res.status(400).json({ error: "Image refusée : JPEG, PNG ou WebP, au moins 200 × 250 px" });
    out = await sharp(buf).rotate().resize({ width: 640, height: 880, fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" }).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
  } catch (e) { return res.status(400).json({ error: "Image illisible ou corrompue" }); }
  try { await storage.saveCover(id, out); } catch (e) { console.error(e); return res.status(502).json({ error: "Stockage indisponible, réessayez dans un instant" }); }
  res.json({ ok: true, cover: coverUrl(id) });
}));
app.get("/api/admin/orders", adminLimit, adminOnly, ah(async (req, res) => {
  const orders = (await db.query(`SELECT o.ref,o.email,o.phone,o.operator,o.total,o.status,o.created_at,
    (SELECT string_agg(b.title, ', ') FROM order_items oi JOIN books b ON b.id=oi.book_id WHERE oi.order_id=o.id) AS books
    FROM orders o ORDER BY o.id DESC LIMIT 200`)).rows;
  const stats = (await db.query(`SELECT COALESCE(SUM(total) FILTER (WHERE status IN ('paid','delivered')),0)::int AS revenue,
    (COUNT(*) FILTER (WHERE status IN ('paid','delivered')))::int AS paid, (COUNT(*) FILTER (WHERE status='pending'))::int AS pending,
    (COUNT(*) FILTER (WHERE status='paid'))::int AS undelivered FROM orders`)).rows[0];
  res.json({ stats, orders });
}));

app.post("/api/admin/resend/:ref", adminLimit, adminOnly, ah(async (req, res) => {
  const r = await db.query("SELECT * FROM orders WHERE ref=$1 AND status IN ('paid','delivered')", [req.params.ref]);
  if (!r.rowCount) return res.status(404).json({ error: "Commande introuvable ou non payée" });
  try { await deliver(r.rows[0]); } catch (e) { console.error(e); return res.status(502).json({ error: "Envoi impossible : " + e.message }); }
  res.json({ ok: true });
}));

process.on("unhandledRejection", e => console.error("Erreur non gérée :", e));

// Relance automatique : commandes payées dont l'e-mail n'est pas parti (panne SMTP...), pendant 24 h
const RETRY = Math.max(1, +(process.env.RETRY_SECONDS || 300));
setInterval(async () => {
  try {
    const r = await db.query("SELECT * FROM orders WHERE status='paid' AND paid_at < now() - ($1 * interval '1 second') AND paid_at > now() - interval '24 hours' ORDER BY id LIMIT 10", [RETRY]);
    for (const o of r.rows) await deliver(o).catch(e => console.error("Relance échouée :", o.ref, e.message));
  } catch (e) { console.error(e); }
}, RETRY * 1000).unref();

// Balayage : vérifie régulièrement les commandes en attente des dernières 24 h (le client a pu fermer la page)
if (providers[PAYMENT_PROVIDER].check) {
  setInterval(async () => {
    try {
      const r = await db.query("SELECT * FROM orders WHERE status='pending' AND created_at > now() - interval '24 hours' ORDER BY id DESC LIMIT 50");
      for (const o of r.rows) await checkOrder(o);
    } catch (e) { console.error(e); }
  }, 15_000).unref();
}

storage.init().then(() => {
  app.listen(PORT, () => console.log("Libris sur " + BASE_URL + " · paiement : " + PAYMENT_PROVIDER + (PAYMENT_PROVIDER === "singpay" && SP.testMode ? " (MODE TEST)" : "") + " · stockage : " + storage.MODE));
}).catch(e => { console.error("Démarrage impossible :", e.message); process.exit(1); });
