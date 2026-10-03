#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
	echo "Penggunaan: RESTORE_DRILL_DATABASE=cbt_restore_drill_YYYYMMDD scripts/restore-drill.sh /backups/cbt-....dump" >&2
	exit 2
fi
: "${PGHOST:=db}"
: "${PGPORT:=5432}"
: "${PGUSER:=cbt}"
: "${PGPASSWORD:?PGPASSWORD wajib diisi}"
: "${PGCONNECT_TIMEOUT:=15}"
: "${RESTORE_DRILL_DATABASE:?RESTORE_DRILL_DATABASE wajib berupa database disposable baru}"
export PGHOST PGPORT PGUSER PGPASSWORD PGCONNECT_TIMEOUT

case "$RESTORE_DRILL_DATABASE" in
	cbt_restore_drill_*) ;;
	*) echo "Restore drill hanya boleh memakai nama database berawalan cbt_restore_drill_" >&2; exit 2 ;;
esac
case "$RESTORE_DRILL_DATABASE" in
	*[!a-z0-9_]*) echo "RESTORE_DRILL_DATABASE hanya boleh berisi huruf kecil, angka, dan underscore" >&2; exit 2 ;;
esac
if [ "$RESTORE_DRILL_DATABASE" = "cbt_restore_drill_" ]; then
	echo "Nama database restore drill memerlukan suffix unik" >&2
	exit 2
fi

backup="$1"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)"
"$script_dir/verify-backup.sh" "$backup"

# Refuse existing names. This script never drops or overwrites a database.
existing="$(psql --no-psqlrc --tuples-only --no-align --dbname=postgres --command="SELECT 1 FROM pg_database WHERE datname = '$RESTORE_DRILL_DATABASE'")"
if [ "$existing" = "1" ]; then
	echo "Database $RESTORE_DRILL_DATABASE sudah ada; tidak disentuh. Pilih suffix baru." >&2
	exit 2
fi

createdb --maintenance-db=postgres --template=template0 "$RESTORE_DRILL_DATABASE"
pg_restore --exit-on-error --single-transaction --no-owner --no-acl --dbname="$RESTORE_DRILL_DATABASE" "$backup"

tables="$(psql --no-psqlrc --tuples-only --no-align --dbname="$RESTORE_DRILL_DATABASE" --command="SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'")"
if [ "${tables:-0}" -lt 3 ]; then
	echo "Restore selesai tetapi hanya ditemukan $tables tabel; database disposable dipertahankan untuk inspeksi" >&2
	exit 1
fi
for table in questions assessments attempts; do
	exists="$(psql --no-psqlrc --tuples-only --no-align --dbname="$RESTORE_DRILL_DATABASE" --command="SELECT to_regclass('public.$table') IS NOT NULL")"
	if [ "$exists" != "t" ]; then
		echo "Restore drill tidak memiliki tabel inti $table; database dipertahankan untuk inspeksi" >&2
		exit 1
	fi
done

echo "Restore drill berhasil ke database disposable $RESTORE_DRILL_DATABASE ($tables tabel). Database dipertahankan; hapus hanya setelah hasil ditinjau dan dengan persetujuan operator."
