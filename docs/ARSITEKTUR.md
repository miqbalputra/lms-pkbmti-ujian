# Arsitektur Aplikasi CBT

Dokumen ini memetakan implementasi di repo mandiri `lms-pkbmti-ujian` (bukan database LMS). Ditinjau dari source pada 3 Oktober 2026. Status verifikasi lokal dicatat terpisah agar dokumentasi tidak mengesankan alur yang belum pernah dijalankan.

## Stack, susunan repo, dan cara menjalankan

- **Backend:** Go 1.25, Fiber v2, GORM, PostgreSQL. Entrypoint `backend/main.go`; model dan AutoMigrate ada di `backend/models.go`; otentikasi/RBAC di `backend/auth.go`; sinkronisasi master/outbox HMAC di `backend/integration.go`; penilaian di `backend/grading.go`.
- **Frontend:** React 19 + TypeScript, Vite 8, Tailwind CSS 4, lucide-react. Entrypoint `frontend/src/main.tsx`, aplikasi/login/workspace di `frontend/src/App.tsx`, editor tutor di `frontend/src/QuestionEditor.tsx`, portal dan renderer siswa di `StudentPortal.tsx`, `QuestionAnswerControl.tsx` dan `questionTypes.ts`.
- **Operasi:** Dockerfile multi-stage di root, Compose untuk pengembangan, `/health` untuk health check, port aplikasi default 8080, volume unggahan `/app/uploads`. Variabel lokal dicontohkan di `.env.example`; jangan menyimpan secret di `VITE_*`.
- **Lokal:** siapkan PostgreSQL terpisah, isi `.env` berdasarkan `.env.example`, lalu di root jalankan `go run ./backend`. Di terminal lain, `cd frontend`, `npm ci`, `npm run dev`. Tes backend: `go test ./...`, `go vet ./...`; frontend: `npm run lint`, `npm run build`, dan `npm run test:e2e` (server dan data uji harus tersedia). Aplikasi CBT tidak membuka koneksi database LMS.

Untuk mengurangi kebingungan staf, beranda kini memulai dengan satu aksi utama dan peta tiga langkah (susun pertanyaan → pilih peserta → pratinjau/terbitkan). Navigasi dikelompokkan menjadi Mulai, Pantau & Nilai, serta Koneksi. Halaman asesmen menaruh pembuatan kosong sebagai jalur utama; pengaturan lengkap dan template ditempatkan sebagai pilihan lanjutan. Ini memakai pola yang familier dari pembuat formulir, tetapi bukan replika penuh Google Forms dan tetap mempertahankan kebutuhan CBT seperti penugasan kelas, kode akses, jadwal, identitas siswa, dan kebijakan nilai.

## Model data utama

Semua tabel berikut dimigrasikan secara aditif lewat GORM `AutoMigrate` ketika backend start; tidak ada migrasi yang menulis ulang tabel LMS.

| Area | Model/tabel | Fungsi |
|---|---|---|
| Akun & master LMS | `CBTAccount`, `MasterKelas`, `MasterPeserta`, `MasterTutor`, `MasterMapel` | Akun lokal CBT dan salinan identitas/kelas/mapel dari LMS; `source_user_id` menjaga kaitan akun staf. Password LMS tidak disalin. Jika metadata kelas belum tersinkron tetapi roster siswa tersedia, staf dapat memberi label sementara pada ID kelas sumber yang sudah punya peserta aktif; sinkronisasi sukses berikutnya mengganti label tersebut dengan data resmi LMS. |
| Bank soal & Paket Soal | `Question`, `QuestionVersion`, `QuestionPackage`, `PackageAssignment` | Soal individual tetap menjadi butir reusable; Paket Soal mengelompokkan dan mengurutkan beberapa butir, dengan target kelas atau siswa. Kunci/rubrik internal, revisi, status, arsip, dan snapshot versi sebelumnya tetap melekat pada butir. Paket terbit dikunci; gunakan “Buat Ujian Online” atau “Buat Simulasi” untuk menyalin butir dan target yang kompatibel ke draf asesmen yang dapat dikerjakan siswa. |
| Asesmen | `Assessment`, `AssessmentItem`, `AssessmentAssignment` | Paket Ujian Online/Simulasi, jadwal/kebijakan, ruang, urutan/bobot, snapshot soal, penugasan siswa. |
| Pengerjaan & nilai | `Attempt`, `AttemptItem`, `Answer`, `AttemptAttachment`, `AttemptRecovery`, `AttemptAnswerRevision` | Percobaan dengan kelas saat ujian, urutan/seed, jawaban, lampiran, pemulihan, histori revisi. |
| Operasional | `AuditLog`, `SyncState`, `IntegrationNonce`, `IntegrationOutbox`, `MigrationBatch` | Audit, cursor sinkronisasi, pencegahan replay, pengiriman hasil tertunda, serta batch impor legacy. |

Snapshot di `AssessmentItem` menjaga isi soal yang diterbitkan tetap independen dari perubahan bank soal selanjutnya. Hasil dan attempt disimpan di PostgreSQL CBT; outbox mengirim replika hasil ke LMS.

Workspace paket soal menggunakan rute langsung `/soal`, `/soal/paket/:id`, `/soal/paket/:id/edit`, `/soal/paket/:id/penugasan`, dan `/soal/paket/:id/preview/:questionId` untuk pratinjau soal terpisah di tab baru. Pencarian/status/mapel/kelas/rentang tanggal berada di query URL agar dapat di-bookmark. Pratinjau menggunakan kontrol jawaban siswa; responsnya lokal dan tidak dikirim. Paket Soal adalah lapisan pengelompokan Bank Soal, bukan tabel attempt baru; siswa mengerjakan salinan draf Ujian Online atau Simulasi yang dibuat dari paket. Jika paket menargetkan lebih dari satu kelas, tutor memilih satu kelas pada builder karena satu asesmen CBT memiliki satu konteks kelas. Draft builder menyimpan salinan offline per ID asesmen agar perubahan lokal satu draf tidak menghalangi pembuatan paket baru.

Soal draf dapat diubah; perubahan signifikan merekam isi sebelumnya ke `QuestionVersion` di dalam transaksi yang sama. Soal berstatus terbit tidak dapat diperbarui langsung—tutor membuat record revisi draf baru. Pemulihan versi hanya berlaku untuk draf aktif, menyimpan kondisi aktif ke riwayat terlebih dahulu, dan menaikkan revision sehingga rollback pun dapat diaudit.

## Login, API, dan otorisasi

Layar login frontend memiliki tiga tab:

1. **NISN + kode:** `POST /api/public/ujian-online/cek` memeriksa peserta aktif dan hash kode terhadap Ujian Online terbit untuk kelas peserta. Identitas siswa diambil dari master peserta; nama bukan input bebas.
2. **Akun siswa:** `POST /api/auth/login` memakai akun CBT siswa yang ditautkan ke `PesertaDidik`.
3. **Tutor / Admin:** endpoint login yang sama, kemudian API staf memeriksa token dan peran. Admin penuh, guru dibatasi ke resource miliknya/kelas terkait, kepala sekolah baca-saja. Akun dibuat oleh admin CBT atau disinkronkan dari LMS sesuai kebijakan.

API pengerjaan berada di `/api/student/*`; workspace staf di `/api/staff/*`; manajemen akun khusus admin di `/api/admin/*`. Middleware memeriksa token dan status akun. Jawaban/hasil siswa memeriksa kepemilikan attempt; kunci dan pembahasan disimpan pada model internal dan tidak diserialisasi dalam respons siswa.

Jadwal staf tersedia melalui `/api/staff/schedule`, dengan filter kelas dan status. Jadwal yang akan dipublikasikan diperiksa dalam transaksi terhadap rentang waktu yang sama untuk kelas atau ruang yang sama; advisory lock PostgreSQL menserialkan perubahan jadwal yang berpotensi bertabrakan. Monitor `/api/staff/assessments/:id/monitor` hanya mengembalikan peserta, status, tenggat/sisa waktu, jumlah status dan waktu server—bukan jawaban. UI monitor melakukan refresh periodik 15 detik.

Laporan hasil staf menyediakan filter konteks kelas, siswa, status dan tanggal serta ekspor CSV/XLSX/PDF. Semua ekspor memakai kewenangan pemilik asesmen/admin/kepala sekolah, tidak memasukkan kunci jawaban, dan CSV menetralkan nilai yang dapat dieksekusi sebagai formula spreadsheet. `/api/staff/assessments/:id/results` menyediakan jawaban untuk staf berwenang saja.

## Sinkronisasi LMS dan aturan jadwal/kode

CBT menarik feed master cursor-based dari `LMS_BASE_URL/api/integrations/cbt/v1/master` dengan header `X-CBT-Key-ID`, timestamp, nonce, dan tanda tangan HMAC-SHA256. Worker mulai saat backend hidup lalu berjalan tiap `LMS_SYNC_INTERVAL` (default 5 menit). Setiap sinkronisasi mencoba hingga tiga kali dengan jeda 500 ms lalu 1 detik; request dibatasi timeout HTTP client 20 detik. Status/cursor disimpan pada `SyncState`, dan riwayat tiap percobaan beserta jumlah record batch, waktu, status, dan pesan ramah disimpan pada `SyncRun`. Guru/admin dapat memeriksa `/api/staff/sync/status`, `/api/staff/sync/history`, dan menjalankan `/api/staff/sync/run`. Kegagalan tidak memajukan cursor atau mengubah salinan master sebelumnya. Hasil asesmen dikirim asinkron melalui outbox.

Kode akses tidak disimpan plaintext: CBT menyimpan hash untuk verifikasi dan AES-GCM ciphertext untuk memulihkan nilai saat staf membuka draf lintas perangkat; keduanya dikecualikan dari JSON model umum. Endpoint detail staf hanya mengirim kode pulih ke pemilik/admin, tidak ke endpoint siswa. Enkripsi memakai turunan domain-separated dari `JWT_SECRET`, jadi secret ini harus stabil untuk mendekripsi kode yang sudah tersimpan. Record lama yang hanya memiliki hash tidak dapat dibalikkan secara kriptografis; nilainya dipertahankan dan UI meminta tutor menetapkan kode baru jika perlu menerbitkan ulang. Pemeriksaan NISN + kode membandingkan hash kode yang di-trim. Ujian Online wajib memiliki kode sebelum publish. Jadwal mulai/selesai diperiksa pada create, autosave draf, dan update (`EndsAt` harus setelah `StartsAt`); server menolak asesmen yang belum mulai atau sudah lewat tenggat, dan tenggat attempt dibatasi oleh `EndsAt`.

Apabila `/staff/master/classes` belum menghasilkan kelas tetapi `/staff/master/students` masih memiliki roster aktif, builder menyediakan fallback label kelas sementara. Endpoint `/staff/master/classes/manual-label` hanya menerima ID kelas yang benar-benar dipakai peserta aktif tersinkron; ia menolak membuat kelas tanpa roster dan menolak mengganti record kelas yang sudah ada. Bila siswa pun belum tersinkron, UI menautkan tutor ke halaman sinkronisasi dan tidak menawarkan kelas fiktif. Fallback ini dicatat ke audit log dan bukan pengganti permanen atas feed LMS; label baru diperbarui saat feed mengirim record resmi untuk ID tersebut.

## Hasil verifikasi lokal terakhir

- **Gerbang lokal terakhir (3 Oktober 2026):** `go test ./...`, `go vet ./...`, `npm run lint`, `npm run build`, dan `npm run test:e2e` (31 skenario Playwright lulus). Cakupan termasuk 15 template soal, autosave/recovery, revisi/riwayat, portal siswa, fallback kelas, trash/arsip, impor/media, folder/pencarian 500 soal, paket soal beserta tautan deep-link dan konversi ke draf asesmen, builder/jadwal/monitor live, sinkronisasi mock, analisis butir, filter/ekspor hasil, dan jalur onboarding tutor dari beranda sampai editor. Semua alur E2E staf dan pengujian browser menggunakan API mock.
- **Belum terverifikasi end-to-end:** login lokal CBT sampai membuat soal melalui service PostgreSQL. Lingkungan kerja tidak memiliki Docker/`psql`/service PostgreSQL dan koneksi `127.0.0.1:5432` ditolak. Tes unit tidak membuktikan transaksi migrasi/jadwal/laporan pada PostgreSQL. Jangan memakai database production untuk uji ini.
- **Catatan regresi:** `bug.md` sekarang tersedia di workspace utama. Pemetaan hasil reproduksi dan bukti untuk BUG-01–12 ada pada `docs/STATUS-PRD.md`. Seluruh tes staf memakai API mock; itu membuktikan perilaku UI, bukan penerimaan/perubahan pada deployment atau transaksi database produksi.
- **Probe integrasi produksi baca-saja:** CBT `/health` menjawab HTTP 200, sedangkan endpoint master LMS tanpa kredensial menjawab HTTP 503. Handler LMS saat ini memiliki jalur 503 jika environment integrasi belum lengkap; sinkronisasi bertanda tangan yang nyata masih harus dijalankan setelah variabel Coolify kedua layanan dicocokkan.
- **Gerbang operasional PRD belum lengkap:** `docs/OPERASIONAL.md` dan `scripts/load-test.mjs` tersedia, tetapi restore drill ke DB uji, 200 token siswa di staging, uji beban, audit eksternal, dan pilot tutor/siswa belum dijalankan. Status langkah dan batas bukti per Step 0–30 ada di `docs/STATUS-PRD.md`.
