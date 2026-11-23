// Vérifie ta configuration Supabase (stockage + base de données) SANS lancer le site.
// Usage : node scripts/supabase-check.js
require("dotenv").config();
const { Pool } = require("pg");
const { SUPABASE_URL = "", SUPABASE_SERVICE_KEY = "", DATABASE_URL, DATABASE_SSL,
  SUPABASE_BOOKS_BUCKET = "books", SUPABASE_COVERS_BUCKET = "covers" } = process.env;
const base = SUPABASE_URL.replace(/\/$/, ""), api = p => `${base}/storage/v1${p}`;
const auth = x => ({ Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, apikey: SUPABASE_SERVICE_KEY, ...x });
let failed = 0;
const ok = m => console.log("OK      " + m);
const ko = (m, hint) => { failed++; console.log("ÉCHEC   " + m); if (hint) console.log("        Piste : " + hint); };
const net = e => (e.cause && e.cause.code) || e.code || e.name;
const get = (url, o = {}) => fetch(url, { ...o, signal: AbortSignal.timeout(20000) });

function keyKind(k) {
  if (/^sb_secret_/.test(k)) return "secret";
  if (/^sb_publishable_/.test(k)) return "publique";
  const p = k.split(".");
  if (p.length === 3) { try { const r = JSON.parse(Buffer.from(p[1], "base64url").toString("utf8")).role; return r === "service_role" ? "secret" : r === "anon" ? "publique" : "inconnue"; } catch {} }
  return "inconnue";
}

async function bucketTests(list, name, wantPublic) {
  const b = list.find(x => x.name === name || x.id === name);
  if (!b) return ko(`Compartiment « ${name} » introuvable`, `Dans Supabase : Storage > New bucket > nom « ${name} » (${wantPublic ? "cochez Public" : "laissez Public décoché"}).`);
  if (!!b.public === wantPublic) ok(`Compartiment « ${name} » : ${b.public ? "public" : "privé"} (comme attendu)`);
  else ko(`Compartiment « ${name} » est ${b.public ? "PUBLIC" : "privé"} alors qu'il doit être ${wantPublic ? "public" : "privé"}`,
    wantPublic ? "Storage > le compartiment > Edit > cochez Public (ce sont des images de couverture)." : "ATTENTION : n'importe qui pourrait télécharger vos livres sans payer. Storage > le compartiment > Edit > décochez Public.");
  const f = `_diagnostic-${Date.now()}.txt`;
  try {
    let r = await get(api(`/object/${name}/${f}`), { method: "POST", headers: auth({ "x-upsert": "true", "content-type": "text/plain" }), body: "ok" });
    if (!r.ok) return ko(`Envoi d'un fichier de test dans « ${name} » refusé (HTTP ${r.status})`, "Vérifiez que SUPABASE_SERVICE_KEY est la clé secrète (service_role).");
    r = await get(api(`/object/${name}/${f}`), { headers: auth() });
    (r.ok && (await r.text()) === "ok") ? ok(`Écriture et lecture dans « ${name} »`) : ko(`Relecture du fichier de test dans « ${name} » impossible (HTTP ${r.status})`);
    r = await get(api(`/object/public/${name}/${f}`));
    if (wantPublic) (r.ok ? ok(`Les fichiers de « ${name} » sont lisibles publiquement (couvertures)`) : ko(`« ${name} » n'est pas lisible publiquement (HTTP ${r.status})`, "Les images de couverture ne s'afficheraient pas : cochez Public."));
    else (r.ok ? ko(`Un fichier de « ${name} » est téléchargeable SANS authentification`, "Décochez Public sur ce compartiment immédiatement.") : ok(`Les fichiers de « ${name} » ne sont pas accessibles publiquement`));
    await get(api(`/object/${name}`), { method: "DELETE", headers: auth({ "content-type": "application/json" }), body: JSON.stringify({ prefixes: [f] }) });
  } catch (e) { ko(`Échec réseau sur « ${name} » (${net(e)})`, "Vérifiez votre connexion et SUPABASE_URL."); }
}

(async () => {
  console.log("=== Stockage Supabase ===");
  if (!/^https?:\/\/[^/\s]+$/.test(base)) { ko("SUPABASE_URL absente ou mal écrite", "Elle ressemble à https://abcdxyz.supabase.co (Project Settings > API)."); }
  else if (!SUPABASE_SERVICE_KEY) ko("SUPABASE_SERVICE_KEY absente", "Project Settings > API Keys > clé secrète (service_role).");
  else {
    const kind = keyKind(SUPABASE_SERVICE_KEY);
    if (kind === "publique") ko("SUPABASE_SERVICE_KEY est la clé PUBLIQUE", "Il faut la clé secrète (service_role / sb_secret_...). Ne la mettez jamais dans une page web.");
    else ok(`Format de la clé : ${kind === "secret" ? "clé secrète" : "inconnu (on teste quand même)"}`);
    if (kind !== "publique") {
      try {
        const r = await get(api("/bucket"), { headers: auth() });
        if (r.status === 401 || r.status === 403) ko(`Clé refusée par Supabase (HTTP ${r.status})`, "Recopiez la clé secrète sans espace, depuis le bon projet.");
        else if (!r.ok) ko(`Liste des compartiments impossible (HTTP ${r.status})`);
        else { const list = await r.json(); ok("Connexion au stockage et clé acceptées"); await bucketTests(list, SUPABASE_BOOKS_BUCKET, false); await bucketTests(list, SUPABASE_COVERS_BUCKET, true); }
      } catch (e) { ko(`Supabase injoignable (${net(e)})`, "Vérifiez SUPABASE_URL et votre connexion internet."); }
    }
  }

  console.log("\n=== Base de données ===");
  if (!DATABASE_URL) ko("DATABASE_URL absente", "Supabase > Connect > Session pooler : copiez l'adresse (avec votre mot de passe).");
  else {
    const db = new Pool({ connectionString: DATABASE_URL, ssl: DATABASE_SSL === "1" ? { rejectUnauthorized: false } : undefined, connectionTimeoutMillis: 15000 });
    try {
      await db.query("SELECT 1"); ok("Connexion à la base acceptée");
      const need = ["books", "orders", "order_items", "downloads"];
      const t = await db.query("SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='r' AND c.relname = ANY($1)", [need]);
      const have = t.rows.map(r => r.relname), lack = need.filter(x => !have.includes(x));
      if (lack.length) ko(`Tables manquantes : ${lack.join(", ")}`, "Collez schema-production.sql dans le SQL Editor de Supabase, puis Run.");
      else {
        ok("Les 4 tables existent");
        const open = t.rows.filter(r => !r.relrowsecurity).map(r => r.relname);
        open.length ? ko(`Protection (RLS) NON activée sur : ${open.join(", ")}`, "ATTENTION : la clé publique du projet pourrait lire vos commandes. Relancez schema-production.sql (il active la protection).") : ok("Protection RLS activée sur toutes les tables");
        const n = await db.query("SELECT count(*)::int AS n FROM books"); ok(`${n.rows[0].n} livre(s) dans le catalogue`);
      }
    } catch (e) {
      const m = String(e.message || "");
      const hint = /ENOTFOUND|ENETUNREACH|ETIMEDOUT|EHOSTUNREACH|ECONNREFUSED/.test(net(e) + m) ? "Utilisez l'adresse « Session pooler » (compatible IPv4) et non la connexion directe. Vérifiez aussi DATABASE_SSL=1."
        : /password authentication failed/i.test(m) ? "Mot de passe de la base incorrect (Project Settings > Database > Reset password)."
        : /Tenant or user not found/i.test(m) ? "Avec le pooler, l'utilisateur s'écrit postgres.IDENTIFIANT_DU_PROJET (recopiez l'adresse proposée par Supabase)."
        : /SSL|TLS|certificate/i.test(m) ? "Ajoutez DATABASE_SSL=1 dans .env." : "";
      ko(`Connexion à la base impossible : ${m.slice(0, 160)}`, hint);
    } finally { await db.end().catch(() => {}); }
  }
  console.log(failed ? `\n${failed} problème(s) à corriger avant de déployer.` : "\nTout est prêt : stockage et base de données fonctionnent.");
  process.exit(failed ? 1 : 0);
})();
