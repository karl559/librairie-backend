# Déployer sur Render (serveur) + Supabase (base et fichiers)

À faire **après** `VALIDATION-SUPABASE.md`. Les pages de la boutique sont servies par le même serveur : **Vercel n'est pas nécessaire** (et son offre gratuite interdit l'usage commercial).

## Ce qu'il faut savoir sur Render gratuit (documentation officielle de Render)
- Le service **s'endort après 15 minutes sans visite** et met environ une minute à se réveiller. Tant qu'il dort, la vérification des paiements en attente s'arrête.
- Son disque est **effacé à chaque redémarrage** : c'est pourquoi les fichiers sont dans Supabase.
- Les ports **SMTP (25, 465, 587) sont bloqués** : Gmail par SMTP ne marchera pas. Utilisez une API d'e-mail : `BREVO_API_KEY` ou `RESEND_API_KEY` (Resend exige un nom de domaine vérifié).
Pour une boutique qui encaisse, l'offre payante de Render (quelques dollars par mois) supprime la mise en veille et le blocage SMTP : vérifiez le prix actuel.

## 1. Mettre le code sur GitHub
Créez un dépôt **privé** et envoyez-y le projet. Le fichier `.gitignore` fourni exclut déjà `.env`, `private/`, `covers/` et `node_modules` : **ne mettez jamais `.env` sur GitHub**.

## 2. Créer le service sur Render
New > **Blueprint** (il lit `render.yaml`) ou New > Web Service (build : `npm ci --omit=dev`, start : `node server.js`, health check : `/healthz`). Choisissez la région Francfort. Renseignez les variables marquées « à remplir » (voir `deploy/env.render.example`).
Variables clés : `STORAGE=supabase`, `DATABASE_SSL=1`, `PAYMENT_PROVIDER=singpay`, `SINGPAY_TEST_MODE=0`, **`SALES_OPEN=0`** tant que SingPay n'a pas activé la production, `BASE_URL` = l'adresse Render du service.

## 3. Garder le service éveillé
Un moniteur gratuit (par exemple UptimeRobot) qui appelle `https://VOTRE-SERVICE.onrender.com/healthz` toutes les 5 minutes évite la mise en veille. Cela entretient aussi l'activité de la base (Supabase gratuit s'arrête après 7 jours sans activité).

## 4. Vérifier
Ouvrez l'adresse Render : la boutique s'affiche avec le bandeau « ventes bientôt ». `/admin` fonctionne. Ajoutez vos livres. Lancez `node scripts/supabase-check.js` depuis votre PC avec les mêmes valeurs.

## 5. Sauvegardes
Supabase gratuit n'en fait pas. Régulièrement, depuis votre PC : `pg_dump "VOTRE_DATABASE_URL" > sauvegarde.sql`. Et téléchargez vos fichiers sources de livres : gardez toujours une copie locale.

## 6. Ouvrir les ventes
Même liste de contrôle que `DEPLOIEMENT.md` (production SingPay, droits des livres, pages légales complètes), puis `SALES_OPEN=1` et un premier achat réel de petit montant.
