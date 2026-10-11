#!/usr/bin/env bash
# Restore a dnd_stats backup
#
# Usage:
#   ./restore-db.sh ~/backups/dnd_stats-2026-06-13_12-00-00.sql.gz
#   ./restore-db.sh <backup-file> [target_db_name]
#
# WARNING: This DROPS the target database and recreates it from the backup.

set -euo pipefail

BACKUP_FILE="${1:?Usage: $0 <backup-file> [target_db_name]}"
DB_NAME="${2:-dnd_stats}"
DB_USER="foundry"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "✘ Backup file not found: $BACKUP_FILE"
  exit 1
fi

export PGPASSWORD="ilovejamie"

echo "═══════════════════════════════════════════════════"
echo "  WARNING: this will DROP and replace database: $DB_NAME"
echo "  From backup: $BACKUP_FILE"
echo "═══════════════════════════════════════════════════"
read -p "Type 'yes' to continue: " confirm
[ "$confirm" = "yes" ] || { echo "Cancelled."; exit 0; }

echo "Stopping PM2 processes that use the database..."
pm2 stop foundry-stats || true
pm2 stop foundry-stats-dev || true

echo "Dropping and recreating $DB_NAME..."
sudo -u postgres psql <<SQL
DROP DATABASE IF EXISTS $DB_NAME;
CREATE DATABASE $DB_NAME OWNER $DB_USER;
\c $DB_NAME
GRANT ALL ON SCHEMA public TO $DB_USER;
SQL

echo "Restoring from $BACKUP_FILE..."
gunzip -c "$BACKUP_FILE" | psql -h localhost -U "$DB_USER" -d "$DB_NAME"

echo "Restarting PM2..."
pm2 start foundry-stats || true
pm2 start foundry-stats-dev || true

echo "✔ Restored $DB_NAME from $(basename "$BACKUP_FILE")"