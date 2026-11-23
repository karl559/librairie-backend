# Libris — librairie numérique automatique

Parcours : le client choisit ses livres, saisit e-mail + numéro Mobile Money, valide le paiement sur son téléphone,
et reçoit **automatiquement** ses liens de téléchargement (PDF + EPUB) par e-mail.

## 1. Installer
0. Les icônes (Lucide, licence ISC) et la police Inter sont incluses : aucun service externe n'est appelé par les pages.
1. PostgreSQL : `createdb libris` puis `psql libris -f schema.sql`
2. Déposer les fichiers dans `private/books/` : `1.pdf`, `1.epub`, `2.pdf`… (le numéro = l'id du livre dans la table `books`). Ce dossier n'est jamais public.
3. `cp .env.example .env` et remplir (base, SMTP, secrets)
4. `npm install` puis `npm start` → http://localhost:3000

## Espace admin
Ouvrez `http://localhost:3000/admin` et entrez la valeur de `ADMIN_KEY` de votre `.env` (choisissez une clé longue et aléatoire).
- **Livres** : ajouter, modifier titre/auteur/catégorie/prix/ancien prix, masquer un livre (« En vente » décoché), envoyer sa **vraie image de couverture** et ses fichiers PDF et EPUB.
- **Règle de la boutique** : un livre n'est visible et achetable que s'il a une image de couverture ET au moins un fichier à livrer. L'admin indique ce qui manque. Les images (JPEG, PNG ou WebP, 200 × 250 px minimum) sont automatiquement redimensionnées et converties en JPEG léger (dossier `covers/`, à sauvegarder avec `private/books/`).
- **Commandes** : chiffre d'affaires, statut de chaque commande, bouton « Renvoyer l'e-mail ».
Plus besoin de SQL pour gérer le catalogue. Les fichiers envoyés sont vérifiés (un faux PDF/EPUB est refusé).

**Base existante ?** Lancez une fois `psql -h localhost -U libris -d libris -f migration.sql` (ajoute prix barré et couleur de couverture).

## 2. Tester sans argent
Avec `PAYMENT_PROVIDER=mock`, le paiement est simulé après 3 s : vous testez la commande, l'e-mail et le téléchargement de bout en bout.

## 3. Paiement Mobile Money avec SingPay
1. Créez votre compte sur `client.singpay.ga` et notez, dans votre espace, l'**identifiant client**, la **clé secrète** et l'**identifiant du portefeuille**. Copiez les vraies valeurs (pas les points ou étoiles qui masquent la clé) dans `.env` : `SINGPAY_CLIENT_ID`, `SINGPAY_CLIENT_SECRET`, `SINGPAY_WALLET`. Le serveur refuse de démarrer si l'identifiant client et la clé secrète sont identiques.
2. **Test** : `PAYMENT_PROVIDER=singpay` et `SINGPAY_TEST_MODE=1`. Le portefeuille de test débite puis rembourse aussitôt (statut `Refund`) : en mode test, et seulement si le code marchand du portefeuille commence par `TEST`, le serveur considère le paiement comme réussi (`result = Success`) pour que vous puissiez essayer toute la chaîne jusqu'à l'e-mail.
3. **Production** : mettez `SINGPAY_TEST_MODE=0`, faites passer le portefeuille en production avec SingPay (champ `goLive`), puis confirmez avec eux la valeur exacte du statut « paiement confirmé » (le serveur attend `status = Terminate` ET `result = Success`, d'après SingPay ; modifiable avec `SINGPAY_SUCCESS_STATUS` et `SINGPAY_SUCCESS_RESULT`).
4. **Sécurité** : le serveur ne livre un livre que si SingPay confirme, pour la bonne référence ET le bon montant. Il interroge lui-même SingPay (tous les 3 s pendant que le client attend, puis toutes les 15 s pour les commandes en attente des dernières 24 h) ; un rappel (webhook) n'est jamais cru sur parole. En cas de doute ou de coupure réseau, la commande reste « en attente » et rien n'est livré. Si la demande de paiement dépasse le délai, la commande n'est **pas** déclarée échouée (la demande a pu arriver) : le serveur demande à SingPay ce qu'il en est, et ne conclut à l'échec que si SingPay ne connaît pas la référence au bout de 3 minutes.

## Pages légales et ouverture des ventes
Les pages `/p/mentions-legales`, `/p/conditions-de-vente`, `/p/remboursement`, `/p/confidentialite` et `/p/contact` sont des **modèles** (dossier `legal/`) complétés par les variables `LEGAL_NAME`, `LEGAL_STATUS`, `LEGAL_ID`, `ADDRESS`, `CONTACT_EMAIL`, `CONTACT_PHONE`, `HOST_INFO`, `REFUND_DAYS`, `REFUND_DELAY`, `RETENTION` et `LAW_AND_COURT` de votre `.env`. Tout champ non renseigné s'affiche en jaune « À COMPLÉTER » : ne publiez pas tant qu'il en reste. Ces textes sont un point de départ, pas un avis juridique : faites-les relire et adaptez la politique de remboursement à votre situation.
Avec `SALES_OPEN=0`, la boutique affiche un bandeau « Les ventes ouvriront très bientôt » et refuse les paiements. Le client doit cocher l'acceptation des conditions de vente pour commander.

## E-mails : arriver dans la boîte de réception, pas dans les indésirables
**Pour démarrer (sans nom de domaine)** : utilisez une adresse Gmail dédiée à la boutique (pas votre compte personnel), avec un mot de passe d'application, `SMTP_HOST=smtp.gmail.com`, port 587, et `MAIL_FROM` égal à **exactement** cette adresse. Gmail gratuit est limité (environ 500 envois par jour) et reste un pis-aller : une adresse gratuite comme expéditeur est filtrée plus sévèrement.

**Pour vendre durablement** : un nom de domaine + un service d'envoi comme Brevo (offre gratuite : 300 e-mails par jour, sans carte bancaire).
1. Dans Brevo : identifiant SMTP = l'e-mail de votre compte Brevo, mot de passe = la **clé SMTP** (pas le mot de passe de connexion).
2. Authentifiez votre domaine dans Brevo (SPF, DKIM, DMARC) en ajoutant les enregistrements DNS qu'il indique. Sans cela, Brevo remplace votre adresse d'expéditeur par une adresse à lui : c'est un palliatif, pas une solution.
3. Mettez `MAIL_FROM="Libris <livres@votre-domaine.com>"` et `MAIL_REPLY_TO` avec une vraie adresse de support.

**Vérifier** : `node scripts/email-test.js votre@adresse.com` teste la connexion et l'envoi, et signale un expéditeur mal configuré. Avant le lancement, envoyez-vous un vrai achat sur une adresse Gmail, une Outlook et une Yahoo, et regardez où il arrive. Un outil de test de délivrabilité en ligne (par exemple mail-tester.com) donne une note.

**Déjà prévu dans l'application** : liens de téléchargement (jamais de pièces jointes), version texte et HTML, objet sans emoji avec le numéro de commande, explication de la raison de réception, adresse de réponse, délais d'attente du serveur d'e-mail, relance automatique pendant 24 h et bouton « Renvoyer l'e-mail » dans l'admin.

## 4. Mettre en ligne
Un petit serveur Node avec HTTPS (VPS, Render, Railway…) et un nom de domaine. L'e-mail passe par un SMTP (Brevo, Mailjet…). Configurer SPF/DKIM du domaine pour éviter les spams.

## Sécurité déjà prévue
Relance automatique de l'e-mail toutes les 5 min (24 h max) si l'envoi a échoué · `RETRY_SECONDS` pour changer le délai · admin protégé par clé + limite de requêtes · 
Prix recalculés côté serveur · une commande payée n'est livrée qu'une fois · liens de téléchargement uniques, 7 jours, 10 essais · limite de requêtes · renvoi admin : `curl -X POST -H "x-admin-key: ..." BASE_URL/api/admin/resend/REF`.
# librairie-backend
