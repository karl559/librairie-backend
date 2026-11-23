# Mettre Libris en ligne (guide pas à pas)

Ce guide installe la boutique sur un petit serveur Linux (VPS), avec HTTPS, démarrage automatique et sauvegardes.
Les commandes sont standard (Ubuntu 24.04 LTS) mais n'ont pas été essayées sur votre serveur : lisez chaque étape et copiez-moi toute erreur.

## 0. Ce qu'il faut avant de commencer
- **Un nom de domaine** (par exemple `mon-site.com`), acheté chez un registrar. Vérifiez le prix actuel et les moyens de paiement acceptés.
- **Un VPS Linux** : 1 processeur et 2 Go de mémoire suffisent. Choisissez Ubuntu 24.04 LTS. Vérifiez le prix et les moyens de paiement acceptés depuis le Gabon (carte internationale, carte prépayée...).
- **Un service d'e-mails** (Brevo, Mailjet...) : Gmail est limité et peut classer vos livres en courrier indésirable.
- Les **identifiants SingPay** (portefeuille de test d'abord).

## 1. Créer le serveur et s'y connecter
Chez l'hébergeur, créez un serveur Ubuntu 24.04. Notez son adresse IP (ex. `203.0.113.10`), puis depuis votre ordinateur :
```
ssh root@203.0.113.10
```

## 2. Sécuriser le serveur
```
apt update && apt upgrade -y
adduser libris                      # choisissez un mot de passe solide
usermod -aG sudo libris
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable
apt install -y unattended-upgrades  # mises à jour de sécurité automatiques
```
Reconnectez-vous ensuite avec `ssh libris@203.0.113.10` et travaillez avec cet utilisateur.

## 3. Pointer le domaine vers le serveur
Chez votre registrar, créez deux enregistrements DNS de type **A** : `@` et `www`, tous deux vers l'IP du serveur. La propagation peut prendre de quelques minutes à quelques heures.

## 4. Installer les logiciels
```
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs postgresql
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install -y caddy
```

## 5. La base de données
```
sudo -u postgres psql -c "CREATE USER libris WITH PASSWORD 'CHOISISSEZ_UN_MOT_DE_PASSE';"
sudo -u postgres createdb -O libris libris
```

## 6. Copier le projet
Depuis **votre ordinateur**, dans le dossier qui contient `librairie-backend` (sans node_modules ni .env) :
```
scp librairie-backend.zip libris@203.0.113.10:~
```
Puis sur le serveur :
```
sudo apt install -y unzip
unzip librairie-backend.zip && cd librairie-backend
npm ci --omit=dev
PGPASSWORD='VOTRE_MOT_DE_PASSE_BASE' psql -h localhost -U libris -d libris -f schema.sql
```

## 7. Configurer
```
cp deploy/env.production.example .env
openssl rand -hex 32     # lancez-le 2 fois : une valeur pour ADMIN_KEY, une pour PAYMENT_SECRET
nano .env
```
Remplissez toutes les lignes. Gardez **`SINGPAY_TEST_MODE=0`** et **`SALES_OPEN=0`** tant que SingPay n'a pas activé votre portefeuille en production.
Protégez le fichier : `chmod 600 .env`.

## 8. Démarrage automatique et HTTPS
```
sudo cp deploy/libris.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now libris
sudo systemctl status libris          # doit afficher "active (running)"
sudo nano /etc/caddy/Caddyfile        # collez le contenu de deploy/Caddyfile, avec votre domaine
sudo systemctl reload caddy
```
Ouvrez `https://votre-domaine.com` : la boutique doit s'afficher avec le cadenas. Journal en direct : `journalctl -u libris -f`.

## 9. Ajouter le catalogue
Allez sur `https://votre-domaine.com/admin`, connectez-vous avec votre `ADMIN_KEY`, ajoutez vos livres, leurs images et leurs fichiers. Un livre n'apparaît que s'il a une image et un fichier.

## 10. Sauvegardes (indispensable)
```
mkdir -p ~/backups && cp deploy/backup.sh ~/backup.sh
crontab -e     # ajoutez la ligne :   0 3 * * * /home/libris/backup.sh
```
Récupérez régulièrement `~/backups` sur votre ordinateur : une sauvegarde qui reste sur le même serveur ne protège pas d'une panne du serveur.

## 11. Ouvrir les ventes : liste de contrôle
1. SingPay a activé votre portefeuille en production (`goLive`) et vous a confirmé : le statut « payé » envoyé par l'API, les frais, et le mode de reversement de l'argent.
2. Vous avez les droits de vente de chaque livre.
3. Les pages légales existent (conditions de vente, remboursement des produits numériques, contact).
4. Mettez `SALES_OPEN=1` (et `SINGPAY_TEST_MODE=0`), puis `sudo systemctl restart libris`.
5. Faites **un achat réel d'un petit montant** : demande de code PIN, e-mail, téléchargement, statut « Livrée » dans l'admin.

## Mettre à jour plus tard
Remplacez les fichiers du projet (sans toucher à `.env`, `private/` et `covers/`), puis `npm ci --omit=dev` et `sudo systemctl restart libris`. Lancez `npm audit` de temps en temps.
