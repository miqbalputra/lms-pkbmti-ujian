# CBT PKBM Tunas Ilmu

Aplikasi mandiri untuk Bank Soal, Ujian Online, Simulasi, penilaian, dan laporan.

## Menjalankan lokal

1. Salin `.env.example` menjadi `.env` dan isi nilai rahasia.
2. Jalankan PostgreSQL, lalu `go run ./backend`.
3. Pada folder `frontend`, jalankan `npm ci` lalu `npm run dev`.

CBT tidak memakai database LMS secara langsung. Data identitas ditarik melalui API integrasi bertanda tangan dan hasil baru dikirim ke LMS melalui outbox yang idempoten. Jangan mengisi `VITE_*` dengan secret: Vite mengekspos seluruh variabel berawalan itu ke browser.

## Coolify

Gunakan Dockerfile pada root repository dan tambahkan domain `cbt.pkbmtunasilmu.web.id`. Gunakan PostgreSQL terpisah, volume `uploadsdata`, backup database harian, serta secret integrasi yang sama dengan LMS. Tambahkan domain CBT ke konfigurasi Cloudflare Turnstile bila Turnstile diaktifkan.

Jalankan `scripts/backup-postgres.sh` sebagai scheduled job Coolify menggunakan image PostgreSQL 16, volume backup persisten, dan `PGPASSWORD`, `PGHOST`, `PGDATABASE`, serta `PGUSER` sebagai secret. Lakukan restore drill berkala ke database disposable. Jangan mengarahkan `CBT_PUBLIC_URL` pada LMS sampai sinkronisasi master, import, jumlah data, snapshot, nilai, dan lampiran sudah diverifikasi.
