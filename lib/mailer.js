// Envoi d'e-mails : SMTP (par défaut) ou API web (Brevo, Resend).
// Sur Render (offre gratuite) les ports SMTP 25/465/587 sont bloqués : utilisez BREVO_API_KEY ou RESEND_API_KEY.
const nodemailer = require("nodemailer");
const env = () => process.env;
const provider = () => env().BREVO_API_KEY ? "brevo" : env().RESEND_API_KEY ? "resend" : "smtp";

let smtp;
const transport = () => smtp ||= nodemailer.createTransport({
  host: env().SMTP_HOST, port: +(env().SMTP_PORT || 587), secure: +(env().SMTP_PORT || 587) === 465,
  auth: { user: env().SMTP_USER, pass: env().SMTP_PASS },
  connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000   // jamais bloqué indéfiniment
});

// "Nom <adresse>" ou "adresse" -> { name, email }
function parseFrom(s) {
  const m = String(s || "").match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? { name: m[1].trim() || env().SHOP_NAME || "Libris", email: m[2].trim() } : { name: env().SHOP_NAME || "Libris", email: String(s || "").trim() };
}
const brevoUrl = () => (env().BREVO_API_URL || "https://api.brevo.com/v3").replace(/\/$/, "");
const resendUrl = () => (env().RESEND_API_URL || "https://api.resend.com").replace(/\/$/, "");
const json = async r => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };

async function sendMail({ to, subject, text, html }) {
  const from = env().MAIL_FROM, replyTo = env().MAIL_REPLY_TO || undefined, p = provider();
  if (p === "brevo") {
    const r = await fetch(`${brevoUrl()}/smtp/email`, { method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { "api-key": env().BREVO_API_KEY, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ sender: parseFrom(from), to: [{ email: to }], subject, htmlContent: html, textContent: text, ...(replyTo ? { replyTo: { email: replyTo } } : {}) }) });
    if (!r.ok) throw new Error(`Brevo (API) : HTTP ${r.status} ${JSON.stringify(await json(r)).slice(0, 200)}`);
    return `Brevo API : HTTP ${r.status}`;
  }
  if (p === "resend") {
    const r = await fetch(`${resendUrl()}/emails`, { method: "POST", signal: AbortSignal.timeout(20_000),
      headers: { authorization: `Bearer ${env().RESEND_API_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }) });
    if (!r.ok) throw new Error(`Resend (API) : HTTP ${r.status} ${JSON.stringify(await json(r)).slice(0, 200)}`);
    return `Resend API : HTTP ${r.status}`;
  }
  const info = await transport().sendMail({ from, replyTo, to, subject, text, html });
  return info.response;
}

// Vérifie que les identifiants fonctionnent, sans envoyer de message
async function verify() {
  const p = provider();
  if (p === "brevo") { const r = await fetch(`${brevoUrl()}/account`, { headers: { "api-key": env().BREVO_API_KEY }, signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw Object.assign(new Error(`Brevo (API) : clé refusée, HTTP ${r.status}`), { code: "EAUTH" }); return; }
  if (p === "resend") { const r = await fetch(`${resendUrl()}/domains`, { headers: { authorization: `Bearer ${env().RESEND_API_KEY}` }, signal: AbortSignal.timeout(20_000) }); if (!r.ok) throw Object.assign(new Error(`Resend (API) : clé refusée, HTTP ${r.status}`), { code: "EAUTH" }); return; }
  await transport().verify();
}
module.exports = { sendMail, verify, provider, parseFrom };
