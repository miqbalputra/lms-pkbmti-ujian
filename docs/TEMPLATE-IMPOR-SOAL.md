# Panduan impor Bank Soal

Di Bank Soal, buka **Impor soal dari CSV, Excel, atau Word**, unduh template yang sesuai, lalu pilih file. Tombol **Unduh contoh 20 soal** menyediakan data demo yang telah tervalidasi dan sesuai dengan bobot/kunci pada contoh. Setiap baris menjadi satu soal **draf** milik tutor yang sedang masuk. Impor sebagian tetap diperbolehkan: baris valid disimpan, baris lain ditampilkan dengan nomor dan alasan agar dapat diperbaiki.

Batas file adalah 5 MB dan 500 soal. Sistem memeriksa tipe jawaban, kunci, poin, jenjang, bahan, serta tautan sebelum menyimpan. File tidak dapat menerbitkan soal atau mengubah paket/hasil yang sudah ada. Guru hanya dapat membuat soal untuk akunnya; kepala sekolah hanya-baca tidak dapat mengimpor.

## Kolom template

Template CSV, XLSX, dan DOCX memakai urutan kolom yang sama. Jangan menghapus baris judul kolom. Kolom wajib adalah **Judul**, **Jenis**, dan **Pertanyaan**; bila Judul kosong, judul diambil dari awal Pertanyaan.

| Kolom | Isi |
|---|---|
| Judul, Jenis, Pertanyaan, Petunjuk | Identitas dan teks soal yang dibaca siswa. Jenis memakai label pada template atau ID jenis soal. |
| Opsi atau baris | Pilihan jawaban, pernyataan, item kiri, baris kisi, langkah urutan, kriteria rubrik `teks:poin`, atau ekstensi berkas—bergantung pada jenis. |
| Kolom (opsional) | Item kanan untuk menjodohkan, kolom kisi, rentang/label skala `min|max|label rendah|label tinggi`, atau batas unggah `jumlah|ukuranMB`. |
| Kunci / jawaban | Nomor pilihan mulai dari 1 atau teks pilihan yang cocok persis. Pisahkan daftar dengan `|`; aturan khusus dijelaskan di bawah. |
| Poin | Poin soal. Jika kosong, nilainya 1. Nilai harus nol atau lebih. |
| Jenjang, Kelas, Mode, Mapel, Domain, Topik, Kompetensi, Level kognitif, Kesulitan, Estimasi waktu (menit), Tag kurikulum/CP, Tag | Metadata soal. Kelas berupa angka 1–12; kesukaran default Sedang, waktu otomatis mengikuti tipe soal, dan CP default “Belum dipetakan”. Tag bebas dapat dipisahkan koma. |
| Jenis bahan, Judul bahan, Isi bahan, Alt teks bahan | Stimulus opsional. Jenis bahan: teks, tabel, gambar, atau media. URL gambar/media harus HTTPS. |
| Pembahasan internal | Catatan staf; tidak ditampilkan kepada siswa. |

## Kunci menurut jenis soal

- **Pilihan ganda / dropdown:** Opsi `3|4|5`, Kunci `2` atau `4` (teks yang cocok). Pilihan ganda kompleks menerima beberapa kunci, misalnya `1|3`.
- **Benar/salah:** Opsi berisi pernyataan `Pernyataan A|Pernyataan B`; Kunci `Benar|Salah` (juga menerima B/S).
- **Menjodohkan:** Opsi berisi sisi kiri, Kolom berisi sisi kanan, Kunci berisi nomor sisi kanan untuk setiap item kiri, misalnya `2|1`.
- **Susun urutan:** Opsi berisi langkah; Kunci berisi semua nomor langkah dalam urutan yang benar, misalnya `2|1|3`.
- **Kisi pilihan tunggal:** Opsi berisi baris, Kolom berisi pilihan, Kunci berisi satu nomor kolom per baris: `1|2`.
- **Kisi kotak centang:** Kunci satu kelompok per baris, misalnya `1+2|2` (dua pilihan untuk baris pertama, pilihan kedua untuk baris berikutnya).
- **Jawaban singkat, tanggal, waktu:** Kunci berisi satu atau beberapa jawaban diterima. Tanggal gunakan `YYYY-MM-DD`; waktu `JJ:MM`.
- **Paragraf/uraian:** Opsi dapat berisi rubrik seperti `Ketepatan:3|Penjelasan:2`. Jika kosong, sistem memberi satu kriteria awal 5 poin yang harus disesuaikan tutor.
- **Skala linear/rating:** Kunci berupa satu angka. Rentang skala opsional ditulis di Kolom sebagai `1|5|Rendah|Tinggi`; rating menggunakan batas 1 sampai jumlah rating maksimal.
- **Unggah berkas:** Opsi berisi ekstensi yang diizinkan, misalnya `pdf|png|jpg`; Kolom opsional `jumlah|ukuranMB`, misalnya `2|5`.

Untuk tabel stimulus, isi Isi bahan dengan sel dipisahkan `|` dan baris dipisahkan `;`, misalnya `Nama|Jumlah;Apel|3;Jeruk|4`. Isi tabel/media tidak menerima skrip/HTML.

CSV menggunakan delimiter koma standar dan dapat dibuka lewat Excel. XLSX memakai sheet pertama. DOCX harus menyimpan soal sebagai tabel pertama dengan baris pertama berisi judul kolom dari template—teks bebas/paragraph Word tidak otomatis ditebak menjadi soal. Jangan gunakan karakter pemisah `|` atau `;` di dalam nilai yang sama dengan kolom terkait.

## Hasil dan keamanan

Setelah unggah, layar menampilkan jumlah berhasil/gagal dan alasan seperti `Baris 4: kunci jawaban wajib diisi`. Perbaiki baris tersebut lalu impor kembali; soal valid yang sudah dibuat tetap berupa draf dan tidak terduplikasi otomatis. Tautan media yang bukan HTTPS ditolak. File diproses di memori, tidak diekstrak ke direktori publik, dibatasi ukuran arsip terdekompresi, dan tidak menjalankan macro/formula.

Tutor juga dapat memakai aksi **Isi nilai bawaan pada draf** untuk melengkapi metadata lama yang kosong. Aksi ini hanya memengaruhi soal draf miliknya, menyimpan versi sebelum perubahan dan menaikkan nomor revisi. Soal terbit tidak pernah diubah massal; soal tersebut perlu dibuatkan revisi terlebih dahulu.

Impor belum memakai database lokal disposable pada checkout ini; route penyimpanan dan audit perlu diverifikasi lagi setelah PostgreSQL CBT tersedia. Jangan memakai produksi untuk pengujian impor.
