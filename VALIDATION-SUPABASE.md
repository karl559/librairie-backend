# Valider Supabase depuis ton PC, avant de déployer

Le but : faire tourner **ton serveur local** avec la **vraie base** et le **vrai stockage** Supabase, pour vérifier que tout marche avant de mettre quoi que ce soit en ligne. Aucun argent n'est utilisé (paiement simulé).

## 1. Créer le projet Supabase (gratuit)
1. Compte sur supabase.com, puis **New project**. Donnez un nom (ex. `libris`).
2. Choisissez un **mot de passe de base de données** solide et **notez-le** (vous ne le reverrez pas).
3. Région : la plus proche de vos clients proposée (Europe, par exemple Francfort).
Limites de l'offre gratuite (d'après les sources consultées) : 500 Mo de base, 1 Go de fichiers, **mise en pause après 7 jours sans activité**, **aucune sauvegarde automatique**. Vérifiez aussi la taille maximale d'un fichier envoyé.

## 2. Créer les tables
Menu **SQL Editor** > New query > collez tout le contenu de `schema-production.sql` > **Run**.
Ce fichier crée les 4 tables **et active leur protection** : sans elle, la clé publique du projet pourrait lire les adresses e-mail et numéros de vos clients depuis Internet.

## 3. Créer les deux compartiments de fichiers
Menu **Storage** > New bucket :
- `books` : **laissez « Public » décoché** (ce sont vos livres vendus : ils ne doivent jamais être téléchargeables sans payer) ;
- `covers` : **cochez « Public »** (images de couverture affichées sur le site).

## 4. Récupérer les trois informations
- **SUPABASE_URL** : Project Settings > API (ex. `https://abcdxyz.supabase.co`).
- **SUPABASE_SERVICE_KEY** : la clé **secrète** (« service_role » ou « sb_secret_… »). **Révélez-la avant de la copier** (comme pour SingPay, une valeur masquée ne marche pas). Ne la montrez à personne et ne la mettez jamais dans une page web.
- **DATABASE_URL** : bouton **Connect** > **Session pooler** > copiez l'adresse et remplacez `[YOUR-PASSWORD]` par le mot de passe de l'étape 1. Utilisez bien le **pooler** : l'adresse directe est en IPv6 et échoue souvent depuis un PC ou Render.

## 5. Les ajouter à ton `.env`
```
STORAGE=supabase
SUPABASE_URL=https://abcdxyz.supabase.co
SUPABASE_SERVICE_KEY=la-cle-secrete-revelee
DATABASE_URL=postgresql://postgres.abcdxyz:MOTDEPASSE@aws-0-...pooler.supabase.com:5432/postgres
DATABASE_SSL=1
PAYMENT_PROVIDER=mock
```
Gardez `PAYMENT_PROVIDER=mock` pour ce test (aucun argent). Si le mot de passe contient `@`, `:` ou `/`, changez-le dans Supabase pour un mot de passe sans ces signes.

## 6. Diagnostic automatique
```
node scripts/supabase-check.js
```
Il vérifie la clé, les deux compartiments (privé / public), l'écriture et la lecture de fichiers, la connexion à la base, les tables et leur protection. Chaque ligne est **OK** ou **ÉCHEC** avec une piste. Tant qu'il reste un ÉCHEC, ne continuez pas.

## 7. Essai de bout en bout
1. `npm start` : la première ligne doit contenir `stockage : supabase`.
2. `/admin` : ajoutez un livre, envoyez son **image** et son **fichier**. Dans Supabase > Storage, les fichiers `1.jpg` (covers) et `1.epub` (books) doivent apparaître.
3. Achetez ce livre sur la boutique (paiement simulé) avec une adresse e-mail qui existe, puis ouvrez le lien reçu : le livre se télécharge.
4. **Arrêtez le serveur et relancez-le** : le livre et son image doivent toujours être là. C'est l'avantage du stockage distant.

## 8. Après la validation
Remettez `PAYMENT_PROVIDER=singpay`. Ne déployez jamais avec `mock`. Étape suivante : `DEPLOIEMENT-RENDER-SUPABASE.md`.
