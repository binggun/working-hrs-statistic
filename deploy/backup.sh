#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL securely}"
: "${BACKUP_BUCKET:?Set private BACKUP_BUCKET}"
backup_file=$(mktemp /tmp/pawhub-backup.XXXXXX)
trap 'rm -f "$backup_file"' EXIT
pg_dump --dbname="$DATABASE_URL" --format=custom --file="$backup_file"
aws s3 cp "$backup_file" "s3://$BACKUP_BUCKET/database/$(date -u +%Y-%m-%dT%H-%M-%SZ).dump" --sse AES256
