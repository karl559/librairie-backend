// Essai de SingPay (portefeuille de test) - version 2 : ne s'arrête plus à la première coupure réseau.
// Aucune de tes clés n'est affichée. Usage :
//   node scripts/singpay-test.js airtel 077123456 100
//   node scripts/singpay-test.js moov   062123456 100
require("dotenv").config();
const { SINGPAY_CLIENT_ID, SINGPAY_CLIENT_SECRET, SINGPAY_WALLET, SINGPAY_DISBURSEMENT,
  SINGPAY_BASE_URL = "https://gateway.singpay.ga/v1", POLL_MS = "4000", TOTAL_MS = "150000" } = process.env;

const [operator, phoneArg, amountArg] = process.argv.slice(2);
const code = { airtel: "74", moov: "62" }[operator];
const digits = String(phoneArg || "").replace(/\D/g, "");
const msisdn = digits.length === 8 ? "0" + digits : digits;
const amount = parseInt(amountArg || "100", 10);

if (!SINGPAY_CLIENT_ID || !SINGPAY_CLIENT_SECRET || !SINGPAY_WALLET) {
  console.error("Remplissez SINGPAY_CLIENT_ID, SINGPAY_CLIENT_SECRET et SINGPAY_WALLET dans le fichier .env"); process.exit(1);
}
if (!code || msisdn.length !== 9 || !(amount > 0)) {
  console.error("Usage : node scripts/singpay-test.js airtel|moov NUMERO MONTANT\nExemple : node scripts/singpay-test.js airtel 077123456 100"); process.exit(1);
}

const headers = { "Content-Type": "application/json", "x-client-id": SINGPAY_CLIENT_ID, "x-client-secret": SINGPAY_CLIENT_SECRET, "x-wallet": SINGPAY_WALLET };
// Un échec réseau ne fait jamais planter le script : il est simplement signalé (http = 0).
const call = async (method, path, body) => {
  try {
    const r = await fetch(SINGPAY_BASE_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { http: r.status, data };
  } catch (e) { return { http: 0, data: "échec réseau (" + ((e.cause && e.cause.code) || e.name) + ")" }; }
};
const show = (title, o) => console.log(`\n=== ${title} (HTTP ${o.http}) ===\n` + (typeof o.data === "string" ? o.data : JSON.stringify(o.data, null, 2)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const hhmmss = () => new Date().toLocaleTimeString("fr-FR");

(async () => {
  const reference = "TEST" + Date.now();
  console.log(`Lancement d'un paiement ${operator} de ${amount} FCFA vers ${msisdn} (réf. ${reference})…`);
  const pay = await call("POST", `/${code}/paiement`, {
    amount, reference, client_msisdn: msisdn, portefeuille: SINGPAY_WALLET, isTransfer: false,
    ...(SINGPAY_DISBURSEMENT ? { disbursement: SINGPAY_DISBURSEMENT } : {})
  });
  show("Réponse au lancement du paiement", pay);

  const id = pay.data && pay.data.transaction && pay.data.transaction.id;
  if (!id) { console.log("\nAucun identifiant de transaction reçu : copiez la réponse ci-dessus et envoyez-la moi."); return; }

  console.log(`\nIdentifiant de transaction : ${id}`);
  console.log(">>> REGARDEZ VOTRE TÉLÉPHONE : si une demande de code PIN arrive, confirmez-la maintenant. <<<");
  console.log(`Suivi du statut pendant ${Math.round(+TOTAL_MS / 1000)} secondes (seuls les changements sont affichés)…`);
  let last = "";
  const end = Date.now() + +TOTAL_MS;
  while (Date.now() < end) {
    await sleep(+POLL_MS);
    const s = await call("GET", `/transaction/api/status/${encodeURIComponent(id)}`);
    const t = s.http === 200 && s.data && s.data.transaction;
    const line = t ? `statut : ${t.status}` + (s.data.status ? ` | ${s.data.status.message} (${s.data.status.result_code})` : "")
                   : `(HTTP ${s.http}) ${typeof s.data === "string" ? s.data : JSON.stringify(s.data)}`;
    if (line !== last) { console.log(`[${hhmmss()}] ${line}`); last = line; }
  }
  show("Transaction retrouvée par référence", await call("GET", `/transaction/api/search/by-reference/${encodeURIComponent(reference)}`));
  console.log("\nTerminé. Copiez tout ce qui est affiché ci-dessus (vos clés n'apparaissent pas ; vous pouvez masquer les numéros de téléphone).");
})().catch(e => { console.error("Erreur :", e.message); process.exit(1); });
