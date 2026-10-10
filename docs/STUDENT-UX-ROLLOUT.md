# UX siswa CBT dan tata letak media

## Cakupan dan batas data

Perubahan ini hanya pada repository CBT mandiri. Tidak ada migrasi skema, penghapusan data, akses database LMS, atau penulisan ulang snapshot, jawaban, maupun nilai historis. Respons hasil menambah `kind` dan `submittedAt` yang sudah disimpan di server; pemeriksaan kepemilikan dan kebijakan rilis tetap berlaku.

Alur: kode/tautan → pilihan asesmen → NISN → identitas LMS/token → persiapan → pengerjaan → periksa/kirim → bukti pengumpulan → hasil. Upaya aktif dapat dilanjutkan. URL `/siswa/upaya/:id?soal=n` memulihkan nomor soal, `/siswa/hasil/:id?tampilan=bukti` membuka bukti server. Token tidak ditulis ke URL atau penyimpanan lokal. Setelah reload sebelum mulai, token perlu diverifikasi kembali; ini tidak membuat upaya baru. Bukti hanya menyatakan berhasil jika server telah mengirim waktu pengumpulan.

Desktop ≥1024 px menggunakan dua panel 50:50 dengan posisi gulir bahan berdasarkan kelompok stimulus. Di bawah 1024 px, bahan diikuti pertanyaan dan jawaban dalam satu halaman, dengan tombol lompat yang memindahkan fokus. Navigasi bawah dan timer tetap terjangkau. Soal tanpa stimulus memakai satu panel. Ukuran teks 15/18/22 px tersimpan di perangkat (bawaan 18 px).

Gambar stimulus, pilihan, dan header memakai konteks terpisah, rasio alami, dan tidak dipotong. Penampil gambar menyediakan fit, zoom 100–400%, geser, panah keyboard, Escape, serta pemulihan fokus. Membuka gambar tidak memilih jawaban. Judul/alt berasal dari tutor, bukan deskripsi otomatis. Gambar menjodohkan berada di kartu yang sesuai. Tabel lebar memiliki area gulir lokal; kisi memakai kartu di mobile/tablet.

Cache media privat hanya berupa blob dalam memori sesi autentikasi; permintaan memakai bearer token dan `no-store`. Tidak masuk IndexedDB/service worker. Cache dibersihkan dan blob dicabut saat sesi berubah/berakhir. Antrean jawaban tetap menyimpan hanya perubahan yang belum diakui server. Pemulihan terlambat tidak mengubah nilai otomatis. Saat halaman aktif/koneksi pulih, waktu/tenggat diselaraskan kembali tanpa mengganti jawaban lokal.

## Aktivasi dan rollback

1. Deploy backend/frontend CBT bersama dengan backup dan verifikasi staging. Bawaan `.env.example` dan Compose adalah `CBT_STUDENT_UX_ENABLED=false`.
2. Di environment aplikasi CBT (bukan LMS), aktifkan `CBT_STUDENT_UX_ENABLED=true`, restart/redeploy, lalu pastikan `GET /api/public/config` mengembalikan `studentUxEnabled:true`.
3. Flag ini tidak mengaktifkan editor Forms. Kombinasi `CBT_FORMS_ENABLED=false` dengan flag siswa aktif juga didukung.
4. Untuk rollback, set flag siswa `false` lalu restart/reload. UI mengikuti jalur lama yang dikendalikan flag Forms; data dan antrean tidak dihapus. Jangan membersihkan IndexedDB saat rollback.
5. Service worker cache versi `pkbm-cbt-shell-v3-student-ux` tidak menyimpan respons API autentikasi. Reload setelah deployment untuk memuat konfigurasi.

## Verifikasi otomatis

Jalankan dari backend: `go test ./...`, `go vet ./...`. Dari frontend: `npm run lint`, `npm run build`, `npm run test:e2e -- --workers=2`.

`tests/student-ux.spec.ts` memakai fixture API, gambar horizontal/vertikal/persegi dengan diagram teks kecil, gambar opsi dan menjodohkan, serta seluruh 15 tipe. Mencakup alur awal sampai hasil, flag independen, resume, antrean offline/reconnect, waktu habis, kebijakan nilai, retry media, fokus dialog, navigasi URL, dan reflow. Viewport: 375×812, 768×1024, 1440×900, 812×375, dan 320×812. Tes lama memakai flag siswa nonaktif untuk regresi.

`tests/student-media-cache.spec.ts` memastikan media privat digunakan ulang dalam satu sesi saja, permintaan tetap terotorisasi dan `no-store`, semua URL dicabut saat sesi berakhir, serta respons terlambat tidak mengisi cache sesi berikutnya. Pratinjau paket lama dan editor Forms memakai perilaku media yang sama. Kegagalan memuat bukti setelah submit berhasil memiliki retry baca-saja dan tidak mengirim ulang jawaban.

Baseline screenshot Chromium Windows disimpan di `tests/student-ux.spec.ts-snapshots`. Timer dinamis dimask dan waktu pengumpulan fixture dibekukan. Bandingkan tanpa `--update-snapshots` untuk gerbang regresi; perbarui baseline hanya setelah inspeksi manual. Job `student-visual` di CI wajib membandingkan baseline Windows. Job Linux menjalankan seluruh skenario fungsional yang sama dan melampirkan screenshot untuk tinjauan, tanpa menerima baseline baru otomatis. Perbandingan golden Linux memerlukan baseline yang ditinjau terpisah; hasil Windows tidak membuktikan kesamaan visual lintas OS.

Tes API fixture tidak menggantikan gerbang PostgreSQL nyata. Jalankan suite PostgreSQL pada database disposable PostgreSQL 16 dengan `PG_TEST_DATABASE_URL` sesuai panduan Forms; jangan arahkan ke database produksi. Catat tes yang skipped, hasil staging, dan bukti sebelum rilis.

### Rekaman verifikasi lokal — 10 Oktober 2026

- `go test ./...`, `go vet ./...`, `npm run lint`, dan `npm run build` lulus.
- Suite Playwright Chromium Windows: 71 tes lulus tanpa skenario dilewati, termasuk 21 tes tambahan siswa/media dan regresi lama dengan flag nonaktif; 85 baseline screenshot dibandingkan. Percobaan aktif tetap dapat dilanjutkan dari riwayat meski paket tidak lagi ditampilkan untuk akses baru.
- Desktop, tablet, mobile, landscape pendek, serta lebar efektif 320 px diperiksa otomatis. Screenshot pengerjaan, pratinjau gambar, masuk, persiapan, bukti, hasil, kisi dan menjodohkan juga diinspeksi secara visual.
- Tes PostgreSQL baru `TestPostgresStudentReceiptRespectsPolicyOwnershipAndHistory` disiapkan untuk kebijakan rilis, IDOR, privasi kunci, dan histori, tetapi **skipped lokal** karena `PG_TEST_DATABASE_URL` tidak tersedia. Job PostgreSQL 16 CI akan menjalankannya; hasil CI/staging belum dinyatakan lulus dalam rekaman ini.
- Tidak ada push/deploy/cutover, aktivasi flag produksi, atau perubahan data LMS/CBT produksi dalam verifikasi ini.

## Pilot dan gerbang rilis yang belum boleh diasumsikan

Pilot manusia dan pemeriksaan pembaca layar/perangkat nyata tidak dapat digantikan screenshot otomatis. Rekrut minimal enam siswa: masing-masing Paket A/B/C satu desktop dan satu mobile. Catat setiap tugas tanpa bantuan: masuk, mengenali identitas, membaca bahan, memahami gambar, zoom/tutup, menjawab, mengubah ukuran teks, berpindah nomor, menandai, reconnect/resume, memeriksa/kirim, mengenali bukti serta status hasil.

| Peserta anonim | Paket | Perangkat | Tugas berhasil/total | Bantuan | Masalah kritis |
| --- | --- | --- | --- | --- | --- |
| A1 | A | Desktop | Belum diuji | — | — |
| A2 | A | Mobile | Belum diuji | — | — |
| B1 | B | Desktop | Belum diuji | — | — |
| B2 | B | Mobile | Belum diuji | — | — |
| C1 | C | Desktop | Belum diuji | — | — |
| C2 | C | Mobile | Belum diuji | — | — |

Seluruh tugas kritis harus selesai tanpa bantuan dan agregat tugas berhasil minimal 95%. Ketidakpahaman gambar, jawaban hilang, atau gagal mengirim menghentikan rilis. Uji pembaca layar: nama kontrol, urutan baca, fokus lompat/palet/dialog, dan timer tidak diumumkan setiap detik. Periksa kontras, zoom browser, safe-area serta keyboard virtual nyata. Acuan: [kontras WCAG](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html) dan [reflow](https://www.w3.org/WAI/WCAG22/Understanding/reflow.html). Jangan mengklaim sertifikasi WCAG atau “100%” sebelum audit dan pilot selesai.
