#!/bin/bash
# Sauvegarde quotidienne : base de données + livres + couvertures. Garde 14 jours.
set -euo pipefail
APP=/home/libris/librairie-backend
OUT=/home/libris/backups/$(date +%F)
DB=$(grep '^DATABASE_URL=' "$APP/.env" | cut -d= -f2-)
mkdir -p "$OUT"
pg_dump "$DB" | gzip > "$OUT/base.sql.gz"
tar czf "$OUT/fichiers.tar.gz" -C "$APP" private covers
find /home/libris/backups -mindepth 1 -maxdepth 1 -mtime +14 -exec rm -rf {} +
echo "Sauvegarde terminée : $OUT"
