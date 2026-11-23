// Teste l'envoi d'e-mails avec les réglages de ton .env, sans lancer le site.
// Usage : node scripts/email-test.js adresse@exemple.com
require("dotenv").config();
const { sendMail, verify, provider } = require("../lib/mailer");
const { SMTP_HOST, SMTP_PORT = "587", SMTP_USER, SMTP_PASS, MAIL_FROM, MAIL_REPLY_TO, SHOP_NAME = "Libris" } = process.env;
const to = process.argv[2];

if (!to || !/^\S+@\S+\.\S+$/.test(to)) { console.error("Usage : node scripts/email-test.js adresse@exemple.com"); process.exit(1); }
const need = provider() === "smtp" ? ["SMTP_HOST", "SMTP_USER", "SMTP_PASS", "MAIL_FROM"] : ["MAIL_FROM"];
const missing = need.filter(k => !process.env[k]);
if (missing.length) { console.error("Manque dans .env : " + missing.join(", ")); process.exit(1); }

// Conseil de délivrabilité : une adresse gratuite comme expéditeur ne doit être utilisée qu'avec le service de cette même adresse
const from = (MAIL_FROM.match(/<([^>]+)>/) || [null, MAIL_FROM])[1].trim().toLowerCase();
const free = { "gmail.com": "smtp.gmail.com", "googlemail.com": "smtp.gmail.com", "outlook.com": "smtp-mail.outlook.com", "hotmail.com": "smtp-mail.outlook.com", "yahoo.com": "smtp.mail.yahoo.com" };
const fromDomain = from.split("@")[1] || "";
if (provider() !== "smtp" && free[fromDomain])
  console.log(`Remarque : l'expéditeur est une adresse gratuite (${fromDomain}). Avec ${provider()}, elle sera remplacée ou filtrée : authentifiez votre propre nom de domaine pour une bonne délivrabilité.\n`);
else if (free[fromDomain] && SMTP_HOST !== free[fromDomain])
  console.log(`ATTENTION : l'expéditeur est une adresse ${fromDomain} mais l'envoi passe par ${SMTP_HOST}. Ces messages seront rejetés ou classés en courrier indésirable. Utilisez un expéditeur à votre propre nom de domaine.\n`);
else if (free[fromDomain])
  console.log(`Remarque : l'expéditeur est une adresse gratuite (${fromDomain}). C'est acceptable pour démarrer en petit volume, pas pour durer : prévoyez un nom de domaine et un service d'envoi (SPF, DKIM, DMARC).\n`);

const explain = e => {
  const c = e.code || "", m = String(e.message || "");
  if (c === "EAUTH" || /535|Invalid login|Authentication/i.test(m)) return "Identifiants refusés. Gmail : utilisez un mot de passe d'application de 16 lettres, sans espaces. Brevo : utilisez la clé SMTP, pas votre mot de passe de connexion.";
  if (["ETIMEDOUT", "ESOCKET", "ECONNECTION", "ECONNREFUSED", "ENOTFOUND", "EDNS"].includes(c)) return "Connexion impossible : vérifiez internet, SMTP_HOST et le port (587, ou 465 / 2525 si le réseau bloque).";
  if (c === "EENVELOPE" || /sender|from|recipient|mailbox/i.test(m)) return "Adresse refusée : MAIL_FROM doit être l'adresse validée chez votre fournisseur d'envoi.";
  return "";
};

(async () => {
  console.log(provider() === "smtp" ? `Connexion à ${SMTP_HOST}:${SMTP_PORT}…` : `Vérification de la clé ${provider()} (envoi par API web)…`);
  try { await verify(); console.log("Connexion et identifiants acceptés."); }
  catch (e) { console.error("Échec de la connexion : " + e.message); const h = explain(e); if (h) console.error("Piste : " + h); process.exit(1); }
  try {
    const response = await sendMail({ to, subject: `Test d'envoi ${SHOP_NAME}`,
      text: `Bonjour,\n\nCeci est un message de test de ${SHOP_NAME}. S'il est arrivé, l'envoi fonctionne.\n`,
      html: `<p>Bonjour,</p><p>Ceci est un message de test de ${SHOP_NAME}. S'il est arrivé, l'envoi fonctionne.</p>` });
    console.log("Accepté par le service d'envoi : " + response);
    console.log(`\nRegardez maintenant la boîte de ${to} ET son dossier courrier indésirable.`);
  } catch (e) { console.error("Échec de l'envoi : " + e.message); const h = explain(e); if (h) console.error("Piste : " + h); process.exit(1); }
})();
