#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
	echo "Penggunaan: verify-backup.sh /backups/cbt-YYYYMMDDTHHMMSSZ.dump" >&2
	exit 2
fi

backup="$1"
if [ ! -f "$backup" ] || [ -L "$backup" ]; then
	echo "File backup harus ada dan bukan symbolic link" >&2
	exit 2
fi
checksum="$backup.sha256"
if [ ! -f "$checksum" ] || [ -L "$checksum" ]; then
	echo "File checksum tidak ditemukan: $checksum" >&2
	exit 2
fi

backup_dir="$(cd "$(dirname "$backup")" && pwd -P)"
backup_name="$(basename "$backup")"
(cd "$backup_dir" && sha256sum -c "$(basename "$checksum")")
pg_restore --list "$backup" >/dev/null
echo "Backup valid dan arsip PostgreSQL dapat dibaca: $backup_name"
