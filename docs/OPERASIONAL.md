# Panduan Operasional CBT

Dokumen ini untuk operator aplikasi CBT mandiri. CBT dan LMS memakai database terpisah; backup/restore berikut hanya menyentuh database CBT. Jangan menyalin password atau secret ke tiket, chat, URL, atau browser.

## Sebelum rilis

1. Pastikan perubahan database bersifat aditif, image/container sehat, domain HTTPS valid, dan `JWT_SECRET` serta HMAC berisi secret kuat dari password manager.
2. Ambil backup CBT yang sudah diverifikasi; backup LMS secara terpisah sebelum perubahan integrasi atau cutover.
3. Cocokkan `LMS_INTEGRATION_KEY_ID`/`LMS_INTEGRATION_HMAC_SECRET` di CBT dengan `CBT_INTEGRATION_KEY_ID`/`CBT_INTEGRATION_HMAC_SECRET` di LMS. Key ID harus sama di kedua sisi dan secret minimal 32 karakter. Jangan mengirim nilainya melalui frontend.
4. Pastikan `/health` sehat, dashboard Sinkronisasi menunjukkan satu batch sukses, cursor bergerak, serta jumlah master masuk akal. Kalau gagal, jangan menghapus cursor atau record; periksa pesan dan log kedua aplikasi.
5. Jalankan tes otomatis pada build kandidat. Jangan lakukan tes tulis terhadap database produksi; gunakan akun dan database staging yang dapat dibuang.

## Backup PostgreSQL CBT

`scripts/backup-postgres.sh` menjalankan `pg_dump` format custom, memeriksa arsip melalui `pg_restore --list`, menghasilkan SHA-256, lalu baru memindahkan berkas ke lokasi final. Konfigurasikan `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `BACKUP_DIR` ke volume backup persisten yang dibatasi akses operator, serta `BACKUP_RETENTION_DAYS` (default 365). Jalankan melalui cron/Coolify terjadwal dan pantau log/ruang disk. File dump mengandung data pribadi dan harus dienkripsi saat disalin keluar.

Contoh pemanggilan di container backup yang mempunyai `postgresql-client`:

```sh
PGHOST=db PGDATABASE=cbt PGUSER=cbt PGPASSWORD="$CBT_DB_PASSWORD" BACKUP_DIR=/backups scripts/backup-postgres.sh
scripts/verify-backup.sh /backups/cbt-YYYYMMDDTHHMMSSZ.dump
```

Gunakan secret manager untuk variabel, bukan menyimpan nilai contoh tersebut pada file repository.

## Restore dan drill

Verifikasi checksum dan arsip lebih dahulu. `scripts/restore-drill.sh` menolak nama database yang tidak berawalan `cbt_restore_drill_`, menolak database yang sudah ada, membuat database baru, lalu memulihkannya dalam satu transaksi. Skrip tidak menghapus database drill setelahnya agar operator dapat memeriksa hasil.

```sh
RESTORE_DRILL_DATABASE=cbt_restore_drill_20261003 PGHOST=db PGUSER=cbt PGPASSWORD="$CBT_DB_PASSWORD" scripts/restore-drill.sh /backups/cbt-YYYYMMDDTHHMMSSZ.dump
```

Untuk pemulihan insiden, hentikan perubahan aplikasi, siapkan database CBT tujuan baru/terisolasi, pulihkan backup terverifikasi, periksa tabel/record dan lampiran volume, lalu alihkan `DATABASE_URL` hanya setelah persetujuan pemilik layanan. Jangan pernah memakai prosedur drill untuk menimpa database aktif. Restore database tanpa volume `/app/uploads` tidak memulihkan lampiran.

## Akun dan peran

- Admin CBT membuat akun staf/siswa melalui Manajemen Akun; gunakan username unik dan password kuat yang diserahkan secara privat.
- Untuk siswa, pastikan akun terhubung ke satu peserta didik aktif yang sudah tersinkron. Menonaktifkan peserta pada LMS akan menonaktifkan akun CBT setelah sinkron berikutnya.
- Guru hanya mengelola asesmen/soal miliknya; kepala sekolah baca-saja; siswa hanya dapat mengakses attempt-nya sendiri.
- Perubahan peran/identitas master dikelola di LMS. Password lokal CBT tidak disalin dari LMS.

## Troubleshooting sinkronisasi

1. Buka tab **Sinkronisasi** dan baca status terbaru, waktu batch sukses terakhir, hitungan, serta 10 percobaan terakhir.
2. HTTP 401/403: cocokkan key ID dan secret HMAC di kedua aplikasi. HTTP 503 dari LMS: pastikan environment integrasi LMS terisi dan backend LMS sudah dirilis. HTTP 502/timeout: cek domain/port, DNS, TLS, dan koneksi server-ke-server.
3. Jalankan **Sinkronkan sekarang** setelah perbaikan konfigurasi. Keberhasilan harus ditunjukkan respons aktual; pesan sukses tidak boleh dibuat manual.
4. Jika sinkron gagal, data master terakhir tetap dipakai. Jangan mengosongkan cursor, menghapus akun, atau mengedit database secara manual.

Konflik master diputuskan oleh LMS: identitas siswa/tutor, kelas, mapel, peran, dan status aktif berasal dari LMS. CBT mengelola kredensial login CBT dan konten/hasil asesmen CBT. Hasil CBT dikirim ulang melalui outbox idempoten jika LMS belum menerima.

## Pemeriksaan operasional dan latihan

- Periksa `/health`, error rate dan restart container, ruang database/unggahan/backup, status sinkronisasi, serta usia backup terakhir tiap hari kerja.
- Lakukan restore drill terisolasi berkala dan catat tanggal, checksum, durasi, jumlah tabel inti, pemeriksa, dan tindak lanjut. Uji drill pertama belum boleh ditandai lulus sebelum operator benar-benar menjalankannya.
- Jalankan `node scripts/load-test.mjs` hanya pada staging dengan 200 token siswa uji. Uji ini hanya mengirim pembacaan portal, bukan jawaban/submit; untuk simulasi tulis, jalankan Playwright pada database staging khusus setelah snapshot.
- Pilot usability perlu melibatkan sedikitnya 3 tutor dan 3 siswa; ukur tugas buat soal, terbit, mulai, autosave, lanjut, submit, membaca hasil, dan memfilter/mengunduh laporan. Catat berhasil/tidak, waktu, bantuan yang dibutuhkan, perangkat, dan tindak lanjut. Jangan mengklaim skor 90% sebelum data pilot dicatat.

## Batas rilis yang masih harus ditutup

Probe integrasi produksi sebelumnya mendapat HTTP 503, database disposable/restore drill dan akun test produksi belum tersedia, tes tulis belum dijalankan terhadap PostgreSQL staging, lampiran volume deployment belum diverifikasi, serta pilot manusia dan beban staging 200 akun belum dilakukan. Karena itu dokumen ini bukan persetujuan cutover atau klaim bahwa semua acceptance operasional telah lulus.
