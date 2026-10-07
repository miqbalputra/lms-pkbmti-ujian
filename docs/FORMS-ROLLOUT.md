# Editor kolaboratif dan ruang siswa TKA — rilis bertahap

Implementasi ini hanya berada di repository `lms-pkbmti-ujian`. LMS tetap
menjadi sumber identitas dan penerima replika hasil. Tidak ada perintah yang
menghapus database LMS, presensi, nilai, atau snapshot percobaan lama.

## Alur yang ditambahkan

- Bank Soal, Ujian Online, dan Simulasi memiliki daftar masing-masing. Buka
  paket untuk memakai kanvas Pertanyaan / Respons (Penggunaan untuk bank) /
  Setelan; pertanyaan baru kosong, template dipilih secara eksplisit.
- Lima belas tipe memakai registry bersama. Editor visual mendukung opsi,
  kunci, poin, rubrik, validasi, bagian, percabangan, stimulus bersama,
  pengacakan, multi-kelas / siswa, tema dan bawaan tutor.
- Kanvas tersimpan di PostgreSQL melalui layanan kolaborasi, termasuk state
  Yjs biner dan materialisasi tabel dalam transaksi yang sama. Status
  **Tersimpan** berarti server mengakui penyimpanan permanen, bukan hanya
  IndexedDB. Kolaborator: pemilik, editor, penilai dan pembaca.
- Penyuntingan teks, penanda kehadiran/posisi, format tebal/miring/garis bawah,
  reorder dan undo pribadi memakai CRDT. Tombol pindah menjadi alternatif
  keyboard/sentuh untuk semua daftar yang dapat diseret.
- Pertanyaan disunting langsung dengan format terlihat di tempat, pemilihan
  teks dan pintasan Ctrl/Cmd+B/I/U. Tempelan HTML menjadi teks aman. Pilihan
  **Gunakan teks sederhana** tetap menyediakan textarea. Posisi kursor
  dipertahankan ketika tutor lain menyisipkan teks; undo dikelompokkan per
  bidang dan tidak menghapus pekerjaan tutor lain.
- Bagian diselingi pertanyaan dalam urutan kanvas. Memindahkan bagian membawa
  pertanyaannya; memindahkan soal melewati batas bagian memperbarui keanggotaannya.
  Penghapusan bahan bersama meminta konfirmasi dan dapat di-undo tanpa
  menghapus perubahan teks sebelumnya. Unggahan tertunda menghalangi publikasi.
- Panel Tema menyediakan header gambar JPG/PNG/WebP, teks alternatif dan
  penghapusan. Header tampil pada kanvas, pratinjau dan pengerjaan tanpa
  menutupi identitas PKBM atau navigasi. Versi terbit membekukan header; media
  diambil dengan token pengguna, bukan melalui URL publik. Salinan hanya mendapat
  izin ke gambar yang benar-benar dibagikan pada dokumen sumber.
- Mobile/tablet memakai area editor yang dapat digulir dan toolbar bawah pada
  ruang terpisah, bukan menutupi kontrol soal. Di desktop, panel pengerjaan
  membagi ruang tersisa sehingga navigasi tetap terlihat meski header dipasang.
- Pratinjau memakai renderer siswa yang sama, di tab baru, tanpa mencatat
  percobaan. Semua cabang dapat diperiksa. Tautan isian awal dibuat dari
  jawaban pratinjau pada asesmen terbit; unggahan tidak dapat diisi awal.
- Siswa: tautan/kode → paket tersedia → NISN + kode → identitas roster LMS →
  konfirmasi tes → jawaban → tinjauan kosong/bertanda → kirim → hasil.
  Kode salah/penugasan salah/jadwal tidak berlaku ditolak sebelum sesi terbit.
- Hasil baru memiliki versi form, konteks kelas, seed, snapshot soal/stimulus
  dan jejak revisi. Kebijakan nilai setelah peninjauan memerlukan rilis tutor.
  Edit respons setelah kirim hanya jika diizinkan dan belum melewati tenggat;
  respons sebelumnya tetap berada di ledger dan nilai revisi ditahan kembali.
- Tab Respons: ringkasan, analisis pertanyaan dan individu, penilaian manual,
  unduh berkas privat, CSV/XLSX/PDF. Cabang yang dilewati tidak dihitung sebagai
  kosong/salah dan tidak masuk denominator statistik butir.

## Kontrak draf dan keamanan

- REST membawa `revision`; konflik mengembalikan 409. Penggantian dokumen
  menaikkan `syncEpoch`; room dan IndexedDB dibedakan berdasarkan epoch supaya
  state lama tidak menimpa penggantian server.
- Pada konflik, simpan lokal sebagai salinan atau muat versi server. Memuat
  server mencadangkan draf lokal di perangkat; pemulihan membuat paket terpisah.
  Salinan editor tidak mewarisi kewenangan kelas. Hanya media yang secara
  eksplisit dibagikan/diunggah sendiri diberikan ke salinan, bukan seluruh bank.
- Penerbitan memakai barrier seluruh editor terhubung; state vector yang belum
  diakui menggagalkan publikasi. Versi terbit immutable. Edit harus lewat salinan.
- Jawaban siswa memakai revisi, idempotency receipt, transaksi dan scoped JWT.
  Antrean lokal berisi perubahan belum diakui; deadline divalidasi server.
  Pemulihan lewat tenggat memerlukan keputusan tutor, tidak otomatis menaikkan nilai.
- Layar pemulihan menunggu pembacaan antrean lokal sebelum kontrol jawaban
  diaktifkan. Kegagalan IndexedDB tidak dianggap antrean kosong: siswa dapat
  mencoba lagi dan jawaban lokal tidak dihapus. Respons permintaan yang sudah
  digantikan tidak menimpa percobaan yang sedang dibuka.
- Kunci/rubrik/cabang penentu tidak diserialisasi ke payload pengerjaan siswa.
  Berkas/media membutuhkan bearer JWT dan pemeriksaan dokumen/percobaan.
- Tautan berisi token acak yang di-hash, bukan kode akses atau jawaban default.
  Revoke/jeda menghentikan peserta baru, tidak membatalkan percobaan aktif.
- API terautentikasi dan WebSocket tidak masuk cache service worker.

## Menjalankan dan deploy

1. Backup PostgreSQL CBT **dan** LMS beserta volume unggahan, lalu uji restore.
2. Deploy aplikasi Go/React seperti sebelumnya (port 8080). PostgreSQL tetap 16;
   seluruh tabel form tambahan di-AutoMigrate. Jangan menghapus volume lama.
3. Deploy `collaboration/Dockerfile` dengan build context root repository.
   Node 24, port 1234; layanan ini tidak memiliki kredensial database langsung.
   Isi `CBT_INTERNAL_URL=http://<nama-layanan-go>:8080`.
4. Go dan Node memakai `CBT_COLLABORATION_SECRET` yang sama, minimal 32 karakter,
   **berbeda** dari JWT, SSO dan HMAC integrasi LMS. Jangan letakkan di Vite/browser.
5. Reverse proxy Coolify harus meneruskan WebSocket `/realtime` ke Node:1234,
   atau gunakan domain WSS terpisah dengan TLS. `COLLABORATION_PUBLIC_URL` pada
   Go berisi endpoint WSS publik itu; CSP hanya mengizinkan origin tersebut.
   Route Node `/health` menjadi health check, bukan root WebSocket.
6. Bila memakai Compose, aktifkan profile `forms`. Pakai **satu instance Node**;
   horizontal scaling memerlukan koordinasi dokumen lintas instance yang belum
   termasuk implementasi ini.
7. Embed nonaktif secara default. Bila perlu, isi `CBT_EMBED_ALLOWED_ORIGINS`
   dengan origin HTTPS yang dipercaya (dipisahkan koma). Wildcard tidak diterima;
   staf/API tetap tidak boleh dibingkai. Siswa tetap harus diverifikasi.
8. Pertahankan `CBT_FORMS_ENABLED=false` sampai seluruh gate staging/pilot lulus,
   lalu aktifkan untuk CBT. Ini bukan perintah cutover/redirect LMS.

## Verifikasi lokal dan CI

PostgreSQL harus disposable, versi 16, hostname lokal dan database bernama
`cbt_test*`. Tes menolak database produksi dan membuat schema unik per test.

```powershell
$env:PG_TEST_DATABASE_URL='postgres://<user>:<password>@127.0.0.1:5432/cbt_test?sslmode=disable'
$env:CBT_LOAD_TEST_SESSIONS='200'
go test -count=1 ./...
go vet ./...
```

Pada `frontend`: `npm ci`, `npm run lint`, `npm run build`,
`npm run test:e2e`. Pada `collaboration`: `npm ci`, `npm test`.
Untuk browser nyata, siapkan fixture dengan `CBT_E2E_DATABASE_URL` menunjuk DB
disposable, jalankan `go test -run '^TestE2EPrepareFixture$' -count=1 ./backend`,
lalu jalankan API dan Node lokal dengan feature flag aktif. Setelah itu:
`npm run test:integration` di collaboration dan
`npx playwright test --config playwright.real.config.ts` di frontend.

CI menjalankan gate ini di `.github/workflows/cbt-quality.yml`. Screenshot
375×812, 768×1024, 1440×900 disimpan sebagai artefak untuk pemeriksaan visual.
Uji 200 siswa lokal merupakan regresi koneksi/transaksi, **bukan** pengganti
uji 200 sesi melalui reverse proxy, jaringan dan infrastruktur staging.
Tes migrasi PostgreSQL menjalankan migrasi dua kali, membandingkan checksum
roster, snapshot, percobaan, jawaban dan nilai lama, serta memeriksa constraint
identitas sumber. Perubahan indeks dan AutoMigrate berlangsung dalam satu
transaksi; tes ini tidak dijalankan terhadap database LMS/produksi.

### Rekaman verifikasi — 7 Oktober 2026

Seluruh pemeriksaan berikut dijalankan pada kode lokal, bukan produksi:

- `go test -count=1 ./...` dan `go vet ./...` lulus dengan PostgreSQL 16
  disposable; regresi 200 sesi siswa dan pelestarian data migrasi ikut dijalankan.
- Frontend: lint tanpa warning, build lulus, 48 tes Playwright regresi lulus.
- Tujuh skenario Playwright dengan Go, PostgreSQL dan kolaborasi nyata lulus,
  termasuk seluruh 15 tipe, branching, konflik, kolaborasi dua tutor, rich text,
  stimulus dan header gambar privat. Browser mengawasi exception serta warning
  lifecycle React pada sesi tutor, tutor kedua, pratinjau dan siswa.
- Layanan kolaborasi: 11 tes unit CRDT dan satu tes integrasi nyata lulus,
  termasuk penolakan flush tidak valid, retry, restart, revoke dan publikasi.
- Screenshot diperiksa pada 375×812, 768×1024 dan 1440×900. Tes memastikan
  toolbar mobile tidak menutupi area editor, pilihan jawaban tetap dapat dipakai,
  dan navigasi desktop tetap berada dalam viewport saat header gambar dipasang.
- `npm audit --omit=dev --audit-level=high` pada frontend dan collaboration
  melaporkan nol kerentanan saat pemeriksaan; bukan jaminan keamanan menyeluruh.
- `git diff --check` lulus. Tidak ada push, deploy, cutover, atau perubahan
  database produksi LMS/CBT dalam verifikasi ini.

Pemeriksaan ini tidak menggantikan gate staging dan pilot berikut.

## Gate yang tidak boleh dinyatakan sudah selesai tanpa bukti

- Snapshot regression lintas platform/browser yang disetujui, audit WCAG 2.2 AA
  dengan teknologi bantu, dan pilot tutor/siswa tanpa bantuan.
- 200 sesi siswa melalui staging; TLS/WebSocket/restart Coolify nyata; backup dan
  restore kedua sistem serta rekonsiliasi master/hasil/file produksi.
- Kesamaan visual/interaksi dengan referensi perlu persetujuan. Penyuntingan
  rich text in-place, kursor kolaboratif, bagian dan stimulus diuji di Chromium;
  IME, Firefox/WebKit dan teknologi bantu masih memerlukan verifikasi.
- Keseluruhan template impor bagian/aturan perlu penyempurnaan tambahan;
  jangan nyatakan paritas penuh Google Forms.
- E2E nyata mengawasi exception browser dan peringatan lifecycle React pada
  halaman utama, tab pratinjau, tutor kedua dan siswa. Ini bukan audit semua dependensi/perangkat
  atau bukti nol masalah UI di produksi.

Tidak ada klaim “100% sama” atau izin rilis produksi dari dokumen ini.
