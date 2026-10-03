# CBT PKBM Tunas Ilmu

Aplikasi mandiri untuk Bank Soal, Ujian Online, Simulasi, penilaian, dan laporan.

## Menjalankan lokal

1. Salin `.env.example` menjadi `.env` dan isi nilai rahasia.
2. Jalankan PostgreSQL, lalu `go run ./backend`.
3. Pada folder `frontend`, jalankan `npm ci` lalu `npm run dev`.

CBT tidak memakai database LMS secara langsung. Data identitas ditarik melalui API integrasi bertanda tangan dan hasil baru dikirim ke LMS melalui outbox yang idempoten. Jangan mengisi `VITE_*` dengan secret: Vite mengekspos seluruh variabel berawalan itu ke browser.

## Coolify

Gunakan Dockerfile pada root repository dan tambahkan domain `ujian.pkbmtunasilmu.sch.id` (sesuaikan `PUBLIC_BASE_URL` dengan hostname Coolify yang aktif). Gunakan PostgreSQL terpisah, volume `uploadsdata`, backup database harian, serta secret integrasi yang sama dengan LMS. Tambahkan domain ujian ke konfigurasi Cloudflare Turnstile bila Turnstile diaktifkan.

### HTTPS dan reverse proxy

Aplikasi menambahkan CSP, `nosniff`, `X-Frame-Options`, Referrer-Policy, Permissions-Policy, HSTS, dan menghapus `X-Powered-By`. Agar aplikasi dapat membedakan HTTP dari HTTPS yang diterminasi oleh proxy, masukkan alamat IP/CIDR **proxy Coolify yang tersambung langsung ke container CBT** ke `TRUSTED_PROXY_IPS` (dipisahkan koma), lalu set `FORCE_HTTPS=true`. Jangan menebak alamat dari daftar IP Cloudflare dan jangan mempercayai `0.0.0.0/0`: header `X-Forwarded-Proto` hanya dipercaya dari alamat yang terdaftar. Saat `FORCE_HTTPS=true`, aplikasi menolak startup jika URL publik bukan HTTPS atau daftar proxy kosong. Endpoint `/health` dikecualikan agar health check internal HTTP tetap bekerja; atur redirect HTTP→HTTPS di domain/proxy Coolify juga sebagai lapisan tepi.

Sebelum mengaktifkan redirect, verifikasi remote IP proxy dari jaringan/container Coolify dan uji URL HTTP menghasilkan 301 ke host kanonis, URL HTTPS tetap 200, serta respons HTTPS memuat HSTS. HSTS disetel untuk host ini saja (tanpa `includeSubDomains`) agar tidak memberlakukan kebijakan ke subdomain lain yang mungkin dikelola terpisah.

Untuk integrasi ke LMS yang sekarang, set `LMS_BASE_URL=https://edu.pkbmtunasilmu.sch.id` (tanpa path `/api`). Pastikan di environment LMS, `CBT_INTEGRATION_KEY_ID` dan `CBT_INTEGRATION_HMAC_SECRET` sama persis dengan `LMS_INTEGRATION_KEY_ID` dan `LMS_INTEGRATION_HMAC_SECRET` di CBT. Jika sinkronisasi gagal dengan 502, cek URL ini dan log backend kedua aplikasi; perubahan file `.env.example` tidak memperbarui environment yang sudah tersimpan di Coolify.

Jalankan `sh scripts/backup-postgres.sh` sebagai scheduled job Coolify menggunakan image PostgreSQL 16, volume backup persisten, serta `PGPASSWORD`, `PGHOST`, `PGDATABASE`, dan `PGUSER` sebagai environment rahasia. Backup memakai format custom, ditulis secara atomik, diperiksa dengan `pg_restore --list`, memiliki checksum SHA-256, dan retensi default 365 hari (`BACKUP_RETENTION_DAYS`). Verifikasi file dengan `sh scripts/verify-backup.sh /backups/cbt-....dump`. Uji restore **hanya** ke nama DB disposable baru berawalan `cbt_restore_drill_` dengan `RESTORE_DRILL_DATABASE` dan `sh scripts/restore-drill.sh /backups/cbt-....dump`; skrip menolak nama lain, menolak menimpa DB yang ada, dan tidak menghapus DB hasil drill. Operator harus meninjau serta membersihkan DB drill secara eksplisit setelah bukti dicatat. Acceptance restore baru lulus setelah operator melaksanakan drill di environment uji dan mencatat waktu, dump/checksum, versi PostgreSQL, jumlah tabel, dan pemeriksaan data.

Jangan mengarahkan `CBT_PUBLIC_URL` pada LMS sampai sinkronisasi master, import, jumlah data, snapshot, nilai, dan lampiran sudah diverifikasi.
