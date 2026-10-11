#!/usr/bin/env bash
# Backup the dnd_stats PostgreSQL database
#
# Usage:
#   ./backup-db.sh                  # backup dnd_stats (default)
#   ./backup-db.sh dnd_stats_dev    # backup a different database
#
# Output: ~/backups/dnd_stats-YYYY-MM-DD_HH-MM-SS.sql.gz
#
# Keeps the 14 most recent backups for each database, deletes older.

set -euo pipefail

DB_NAME="${1:-dnd_stats}"
DB_USER="foundry"
BACKUP_DIR="$HOME/backups"
KEEP_COUNT=14

# PGPASSWORD avoids the password prompt. If you'd rather not embed it,
# create ~/.pgpass with: localhost:5432:dnd_stats:foundry:ilovejamie
# then chmod 600 ~/.pgpass and remove the line below.
export PGPASSWORD="ilovejamie"

mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
OUT_FILE="$BACKUP_DIR/${DB_NAME}-${TIMESTAMP}.sql.gz"

echo "Backing up $DB_NAME → $OUT_FILE"
pg_dump -h localhost -U "$DB_USER" -d "$DB_NAME" --no-owner --no-acl \
  | gzip -9 > "$OUT_FILE"

SIZE=$(du -h "$OUT_FILE" | cut -f1)
echo "✔ Backup complete ($SIZE)"

# Rotate — keep only the most recent $KEEP_COUNT backups for this database
OLD_COUNT=$(find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}-*.sql.gz" -type f | wc -l)
if [ "$OLD_COUNT" -gt "$KEEP_COUNT" ]; then
  REMOVE=$((OLD_COUNT - KEEP_COUNT))
  echo "Pruning $REMOVE old backup(s)"
  find "$BACKUP_DIR" -maxdepth 1 -name "${DB_NAME}-*.sql.gz" -type f -printf '%T@ %p\n' \
    | sort -n | head -n "$REMOVE" | cut -d' ' -f2- | xargs -r rm -v
fi

ls -lh "$BACKUP_DIR"/${DB_NAME}-*.sql.gz | tail -5