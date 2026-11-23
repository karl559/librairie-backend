// Stockage des livres (privés) et des couvertures (publiques).
//   STORAGE=disk      : dossiers locaux private/books et covers (développement sur ton PC)
//   STORAGE=supabase  : Supabase Storage (en ligne : le disque de Render est effacé à chaque redémarrage)
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, "..");
const MODE = process.env.STORAGE === "supabase" ? "supabase" : "disk";
const SB = {
  url: (process.env.SUPABASE_URL || "").replace(/\/$/, ""), key: process.env.SUPABASE_SERVICE_KEY || "",
  books: process.env.SUPABASE_BOOKS_BUCKET || "books", covers: process.env.SUPABASE_COVERS_BUCKET || "covers"
};
const TYPES = { pdf: "application/pdf", epub: "application/epub+zip" };
const BOOKS_DIR = path.join(ROOT, "private", "books"), COVERS_DIR = path.join(ROOT, "covers");
const api = p => `${SB.url}/storage/v1${p}`;
const auth = extra => ({ Authorization: `Bearer ${SB.key}`, apikey: SB.key, ...extra });
const idx = { covers: new Map(), books: new Map() };      // mode supabase : id -> version / id -> Set("pdf","epub")

// ---------- Lecture (synchrone : lit le disque, ou l'index mis à jour toutes les minutes) ----------
const bookPath = (id, f) => path.join(BOOKS_DIR, `${id}.${f}`);
const coverUrl = id => {
  if (MODE === "supabase") return idx.covers.has(+id) ? `${api(`/object/public/${SB.covers}/${id}.jpg`)}?v=${idx.covers.get(+id)}` : null;
  try { return `/covers/${id}.jpg?v=${Math.floor(fs.statSync(path.join(COVERS_DIR, `${id}.jpg`)).mtimeMs)}`; } catch { return null; }
};
const formatsOf = id => MODE === "supabase"
  ? ["pdf", "epub"].filter(f => (idx.books.get(+id) || new Set()).has(f))
  : ["pdf", "epub"].filter(f => fs.existsSync(bookPath(id, f)));
// Un livre n'est vendable que s'il a une vraie image ET au moins un fichier à livrer
const missing = id => [!coverUrl(id) && "image", !formatsOf(id).length && "fichier"].filter(Boolean);

// ---------- Supabase Storage (API REST) ----------
const call = async (p, o = {}) => {
  const r = await fetch(api(p), { ...o, signal: AbortSignal.timeout(30000) });
  return r;
};
async function listBucket(bucket) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const r = await call(`/object/list/${bucket}`, { method: "POST", headers: auth({ "Content-Type": "application/json" }),
      body: JSON.stringify({ prefix: "", limit: 1000, offset, sortBy: { column: "name", order: "asc" } }) });
    if (!r.ok) throw new Error(`Supabase Storage « ${bucket} » : HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
    const page = await r.json(); out.push(...page);
    if (page.length < 1000) return out;
  }
}
async function refresh() {
  const [cv, bk] = await Promise.all([listBucket(SB.covers), listBucket(SB.books)]);
  const covers = new Map(), books = new Map();
  for (const o of cv) { const m = /^(\d+)\.jpg$/.exec(o.name || ""); if (m) covers.set(+m[1], String(Date.parse(o.updated_at || o.created_at) || 1)); }
  for (const o of bk) { const m = /^(\d+)\.(pdf|epub)$/.exec(o.name || ""); if (m) { if (!books.has(+m[1])) books.set(+m[1], new Set()); books.get(+m[1]).add(m[2]); } }
  idx.covers = covers; idx.books = books;
}
async function put(bucket, name, buf, type) {
  const r = await call(`/object/${bucket}/${name}`, { method: "POST", body: buf,
    headers: auth({ "x-upsert": "true", "content-type": type, "cache-control": "max-age=3600" }) });
  if (!r.ok) throw new Error(`Supabase Storage : envoi refusé (HTTP ${r.status}) ${(await r.text()).slice(0, 200)}`);
}

// ---------- Écriture ----------
async function saveCover(id, buf) {
  if (MODE === "supabase") { await put(SB.covers, `${id}.jpg`, buf, "image/jpeg"); idx.covers.set(+id, String(Date.now())); return; }
  await fs.promises.mkdir(COVERS_DIR, { recursive: true });
  await fs.promises.writeFile(path.join(COVERS_DIR, `${id}.jpg`), buf);
}
async function saveBook(id, f, buf) {
  if (MODE === "supabase") {
    await put(SB.books, `${id}.${f}`, buf, TYPES[f]);
    if (!idx.books.has(+id)) idx.books.set(+id, new Set());
    idx.books.get(+id).add(f); return;
  }
  await fs.promises.mkdir(BOOKS_DIR, { recursive: true });
  await fs.promises.writeFile(bookPath(id, f), buf);
}
// Retourne { path } (disque), { buffer } (Supabase) ou null si le fichier n'existe pas
async function openBook(id, f) {
  if (MODE === "supabase") {
    const r = await call(`/object/${SB.books}/${id}.${f}`, { headers: auth() });
    if (r.status === 404 || r.status === 400) return null;
    if (!r.ok) throw new Error(`Supabase Storage : lecture impossible (HTTP ${r.status})`);
    return { buffer: Buffer.from(await r.arrayBuffer()) };
  }
  return fs.existsSync(bookPath(id, f)) ? { path: bookPath(id, f) } : null;
}

// ---------- Démarrage ----------
function mountCovers(app, express) { if (MODE === "disk") app.use("/covers", express.static(COVERS_DIR, { maxAge: "7d" })); }
async function init() {
  if (MODE === "disk") { fs.mkdirSync(COVERS_DIR, { recursive: true }); fs.mkdirSync(BOOKS_DIR, { recursive: true }); return; }
  if (!SB.url || !SB.key) throw new Error("STORAGE=supabase : renseignez SUPABASE_URL et SUPABASE_SERVICE_KEY");
  await refresh();   // échoue tout de suite, avec un message clair, si l'adresse, la clé ou les compartiments sont faux
  setInterval(() => refresh().catch(e => console.error("Index du stockage non actualisé :", e.message)), 60_000).unref();
  console.log(`Stockage : Supabase (${idx.covers.size} couverture(s), ${idx.books.size} livre(s))`);
}

module.exports = { MODE, coverUrl, formatsOf, missing, saveCover, saveBook, openBook, mountCovers, init };
