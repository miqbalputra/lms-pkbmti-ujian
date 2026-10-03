#!/bin/sh
set -eu

: "${PGHOST:=db}"
: "${PGPORT:=5432}"
: "${PGDATABASE:=cbt}"
: "${PGUSER:=cbt}"
: "${PGPASSWORD:?PGPASSWORD wajib diisi}"
: "${PGCONNECT_TIMEOUT:=15}"
: "${BACKUP_DIR:=/backups}"
: "${BACKUP_RETENTION_DAYS:=365}"
export PGHOST PGPORT PGDATABASE PGUSER PGPASSWORD PGCONNECT_TIMEOUT

case "$BACKUP_RETENTION_DAYS" in
	''|*[!0-9]*) echo "BACKUP_RETENTION_DAYS harus berupa bilangan hari" >&2; exit 2 ;;
esac
if [ "$BACKUP_RETENTION_DAYS" -lt 1 ]; then
	echo "BACKUP_RETENTION_DAYS minimal 1 hari" >&2
	exit 2
fi

mkdir -p "$BACKUP_DIR"
backup_root="$(cd "$BACKUP_DIR" && pwd -P)"
if [ "$backup_root" = "/" ]; then
	echo "BACKUP_DIR tidak boleh menjadi root filesystem" >&2
	exit 2
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_root/cbt-$stamp.dump"
temporary="$backup_root/.cbt-$stamp-$$.partial"
checksum_temporary="$target.sha256.partial"
trap 'rm -f "$temporary" "$checksum_temporary"' EXIT HUP INT TERM

pg_dump --format=custom --no-owner --no-acl --file="$temporary"
if [ ! -s "$temporary" ]; then
	echo "pg_dump selesai tetapi file backup kosong" >&2
	exit 1
fi
pg_restore --list "$temporary" >/dev/null
mv "$temporary" "$target"
(cd "$backup_root" && sha256sum "$(basename "$target")" >"$checksum_temporary")
mv "$checksum_temporary" "$target.sha256"

# Prune only CBT dump files in the explicitly configured backup directory, and
# do it only after a new dump has passed both archive and checksum generation.
find "$backup_root" -type f -name 'cbt-*.dump' -mtime +"$BACKUP_RETENTION_DAYS" -exec sh -c 'rm -f -- "$1" "$1.sha256"' sh {} \;
echo "Backup CBT selesai: $target"
