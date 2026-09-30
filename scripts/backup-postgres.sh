#!/bin/sh
set -eu

: "${PGHOST:=db}"
: "${PGPORT:=5432}"
: "${PGDATABASE:=cbt}"
: "${PGUSER:=cbt}"
: "${PGPASSWORD:?PGPASSWORD wajib diisi}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_RETENTION_DAYS:=14}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$BACKUP_DIR/cbt-$stamp.dump"
pg_dump --format=custom --no-owner --no-acl --file="$target"
find "$BACKUP_DIR" -type f -name 'cbt-*.dump' -mtime +"$BACKUP_RETENTION_DAYS" -delete
echo "Backup CBT selesai: $target"
