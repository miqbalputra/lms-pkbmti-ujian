package main

import (
	"encoding/json"
	"os"
	"strings"

	"gorm.io/gorm"
)

const developmentSeedTopic = "__contoh_cbt_pengembangan_v1__"

type seedQuestion struct {
	Title, Program, Mode, Subject, Domain, Topic, Type, Prompt, Description, Stimulus, Config, Key, Rubric string
	Grade                                                                                                  int
	Points                                                                                                 float64
	Package                                                                                                int
}

func (s *Server) seedDevelopmentExamples() error {
	if s.cfg.Env == "production" && !strings.EqualFold(strings.TrimSpace(os.Getenv("SEED_SIMULASI_ON_START")), "true") {
		return nil
	}
	var existing int64
	if err := s.db.Model(&Question{}).Where("topic = ?", developmentSeedTopic).Count(&existing).Error; err != nil {
		return err
	}
	if existing > 0 {
		return nil
	}
	var admin CBTAccount
	if err := s.db.Where("role = ?", "admin").Order("created_at").First(&admin).Error; err != nil {
		return err
	}
	questions := []seedQuestion{
		{Title: "Menemukan informasi pada pengumuman", Program: "Paket A", Grade: 6, Mode: "akm", Subject: "Literasi Membaca", Domain: "Menemukan informasi", Type: "pg_tunggal", Prompt: "Pada pengumuman kegiatan kebun, pukul berapa peserta diminta berkumpul?", Stimulus: `[{"type":"text","title":"Kegiatan Kebun Belajar","content":"Sabtu, 12 Oktober. Peserta berkumpul pukul 08.00 di halaman balai warga. Bawalah botol minum dan topi."}]`, Config: `{"choices":[{"id":"a","text":"07.30"},{"id":"b","text":"08.00"},{"id":"c","text":"08.30"}],"correctIds":["b"]}`, Key: `"b"`, Points: 2, Package: 0},
		{Title: "Memilih informasi penting", Program: "Paket A", Grade: 6, Mode: "akm", Subject: "Literasi Membaca", Domain: "Memahami teks", Type: "pg_kompleks", Prompt: "Pilih semua benda yang perlu dibawa peserta.", Stimulus: `[{"type":"text","title":"Kegiatan Kebun Belajar","content":"Sabtu, 12 Oktober. Peserta berkumpul pukul 08.00 di halaman balai warga. Bawalah botol minum dan topi."}]`, Config: `{"choices":[{"id":"a","text":"Botol minum"},{"id":"b","text":"Topi"},{"id":"c","text":"Sepeda"}],"correctIds":["a","b"],"partialScoring":"proportional"}`, Key: `["a","b"]`, Points: 2, Package: 0},
		{Title: "Menilai pernyataan dari teks", Program: "Paket B", Grade: 9, Mode: "akm", Subject: "Literasi Membaca", Domain: "Mengevaluasi informasi", Type: "benar_salah", Prompt: "Tentukan benar atau salah berdasarkan pengumuman.", Stimulus: `[{"type":"text","title":"Kegiatan Kebun Belajar","content":"Sabtu, 12 Oktober. Peserta berkumpul pukul 08.00 di halaman balai warga. Bawalah botol minum dan topi."}]`, Config: `{"statements":[{"id":"s1","text":"Peserta berkumpul di halaman balai warga.","correct":true},{"id":"s2","text":"Kegiatan dimulai hari Minggu.","correct":false}],"partialScoring":"proportional"}`, Key: `{"s1":true,"s2":false}`, Points: 2, Package: 0},
		{Title: "Memasangkan peran dan tugas", Program: "Paket B", Grade: 9, Mode: "tka", Subject: "Bahasa Indonesia", Domain: "Memahami hubungan informasi", Type: "menjodohkan", Prompt: "Pasangkan peran dengan tugas yang sesuai.", Config: `{"left":[{"id":"l1","text":"Pencatat"},{"id":"l2","text":"Penyiram"}],"right":[{"id":"r1","text":"Mencatat pertumbuhan tanaman"},{"id":"r2","text":"Memberi air sesuai jadwal"}],"pairs":{"l1":"r1","l2":"r2"},"partialScoring":"proportional"}`, Key: `{"l1":"r1","l2":"r2"}`, Points: 2, Package: 0},
		{Title: "Menulis informasi waktu", Program: "Paket C", Grade: 12, Mode: "tka", Subject: "Bahasa Indonesia", Domain: "Mengolah informasi", Type: "isian_singkat", Prompt: "Tuliskan waktu berkumpul sesuai pengumuman.", Stimulus: `[{"type":"text","title":"Kegiatan Kebun Belajar","content":"Sabtu, 12 Oktober. Peserta berkumpul pukul 08.00 di halaman balai warga. Bawalah botol minum dan topi."}]`, Config: `{"acceptedAnswers":["08.00","pukul 08.00","08:00"]}`, Key: `null`, Points: 2, Package: 0},
		{Title: "Menjelaskan manfaat kegiatan", Program: "Paket C", Grade: 12, Mode: "tka", Subject: "Bahasa Indonesia", Domain: "Merefleksi isi", Type: "uraian", Prompt: "Jelaskan satu manfaat kegiatan kebun belajar bagi warga. Sertakan alasan yang masuk akal.", Config: `{"rubrik":[{"id":"r1","text":"Manfaat sesuai konteks","points":3},{"id":"r2","text":"Alasan dijelaskan dengan jelas","points":2}]}`, Key: `null`, Rubric: `[{"id":"r1","text":"Manfaat sesuai konteks","points":3},{"id":"r2","text":"Alasan dijelaskan dengan jelas","points":2}]`, Points: 5, Package: 0},
		{Title: "Memilih lokasi kegiatan", Program: "Paket A", Grade: 6, Mode: "latihan", Subject: "Literasi Membaca", Domain: "Informasi tersurat", Type: "dropdown", Prompt: "Peserta berkumpul di …", Stimulus: `[{"type":"text","title":"Kegiatan Kebun Belajar","content":"Sabtu, 12 Oktober. Peserta berkumpul pukul 08.00 di halaman balai warga. Bawalah botol minum dan topi."}]`, Config: `{"choices":[{"id":"a","text":"halaman balai warga"},{"id":"b","text":"tepi sungai"}],"correctIds":["a"]}`, Key: `"a"`, Points: 1, Package: 0},
		{Title: "Mengurutkan langkah menanam", Program: "Paket B", Grade: 9, Mode: "latihan", Subject: "Literasi Membaca", Domain: "Mengurutkan prosedur", Type: "susun_urutan", Prompt: "Susun langkah menanam berikut dari awal hingga akhir.", Config: `{"choices":[{"id":"a","text":"Menutup benih dengan tanah"},{"id":"b","text":"Membuat lubang kecil"},{"id":"c","text":"Meletakkan benih di lubang"}],"correctOrder":["b","c","a"],"partialScoring":"proportional"}`, Key: `null`, Points: 3, Package: 0},
		{Title: "Membaca tabel harga", Program: "Paket A", Grade: 6, Mode: "akm", Subject: "Matematika", Domain: "Bilangan", Type: "kisi_pg", Prompt: "Pilih harga yang sesuai untuk setiap barang.", Stimulus: `[{"type":"table","title":"Daftar Harga","content":"[[\"Barang\",\"Harga\"],[\"Pensil\",\"Rp2.000\"],[\"Buku\",\"Rp5.000\"]]"}]`, Config: `{"rows":[{"id":"r1","text":"Pensil"},{"id":"r2","text":"Buku"}],"columns":[{"id":"c1","text":"Rp2.000"},{"id":"c2","text":"Rp5.000"}],"gridCorrect":{"r1":"c1","r2":"c2"},"partialScoring":"proportional"}`, Key: `null`, Points: 2, Package: 1},
		{Title: "Memilih ciri bangun", Program: "Paket B", Grade: 9, Mode: "tka", Subject: "Matematika", Domain: "Geometri", Type: "kisi_checkbox", Prompt: "Pilih semua ciri yang sesuai pada tiap bangun.", Config: `{"rows":[{"id":"r1","text":"Persegi"}],"columns":[{"id":"c1","text":"Empat sisi sama panjang"},{"id":"c2","text":"Memiliki tiga sudut"}],"gridMultiCorrect":{"r1":["c1"]},"partialScoring":"proportional"}`, Key: `null`, Points: 2, Package: 1},
		{Title: "Mengukur pemahaman pecahan", Program: "Paket A", Grade: 6, Mode: "latihan", Subject: "Matematika", Domain: "Bilangan", Type: "skala_linear", Prompt: "Pilih nilai pecahan yang sama dengan satu setengah.", Config: `{"scaleMin":1,"scaleMax":5,"scaleMinLabel":"Belum paham","scaleMaxLabel":"Sangat paham","correctNumber":3}`, Key: `3`, Points: 1, Package: 1},
		{Title: "Memberi rating ketelitian", Program: "Paket B", Grade: 9, Mode: "latihan", Subject: "Matematika", Domain: "Pengukuran", Type: "rating", Prompt: "Nilai ketelitian hasil pengukuran yang kamu peroleh.", Config: `{"ratingMax":5,"correctNumber":5}`, Key: `5`, Points: 1, Package: 1},
		{Title: "Mencatat tanggal pengamatan", Program: "Paket A", Grade: 6, Mode: "latihan", Subject: "Matematika", Domain: "Pengukuran", Type: "tanggal", Prompt: "Pilih tanggal pengamatan pada lembar kegiatan.", Config: `{"acceptedAnswers":["2026-10-12"]}`, Key: `null`, Points: 1, Package: 1},
		{Title: "Mencatat waktu pengamatan", Program: "Paket B", Grade: 9, Mode: "latihan", Subject: "Matematika", Domain: "Pengukuran", Type: "waktu", Prompt: "Tuliskan waktu berkumpul sesuai jadwal kegiatan.", Config: `{"acceptedAnswers":["08:00","08:00:00"]}`, Key: `null`, Points: 1, Package: 1},
		{Title: "Melampirkan cara menghitung", Program: "Paket C", Grade: 12, Mode: "latihan", Subject: "Matematika", Domain: "Pemecahan masalah", Type: "unggah_berkas", Prompt: "Unggah satu berkas yang menunjukkan cara kamu menyelesaikan perhitungan.", Config: `{"allowedFileTypes":["pdf","png","jpg","jpeg"],"maxFiles":1,"maxFileSizeMB":5}`, Key: `null`, Points: 4, Package: 1},
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&Question{}).Where("topic = ?", developmentSeedTopic).Count(&existing).Error; err != nil {
			return err
		}
		if existing > 0 {
			return nil
		}
		created := make([]Question, len(questions))
		for index, row := range questions {
			created[index] = Question{OwnerID: admin.ID, Title: row.Title, Program: row.Program, Grade: row.Grade, Mode: row.Mode, Subject: row.Subject, Domain: row.Domain, Topic: developmentSeedTopic, Type: row.Type, Prompt: row.Prompt, Description: row.Description, StimulusJSON: row.Stimulus, ConfigJSON: row.Config, AnswerJSON: row.Key, RubricJSON: row.Rubric, Points: row.Points, Status: "draft", Revision: 1}
			if err := tx.Create(&created[index]).Error; err != nil {
				return err
			}
		}
		for packageIndex, title := range []string{"Contoh · Literasi Membaca dan Bahasa Indonesia", "Contoh · Numerasi dan Matematika"} {
			row := Assessment{OwnerID: admin.ID, Kind: "simulasi", Title: title, Description: "Contoh pengembangan berisi soal orisinal untuk melihat tipe dan pengalaman CBT.", Instructions: "Baca setiap pertanyaan dengan teliti. Ini adalah data contoh lingkungan nonproduksi.", Status: "draft", DurationMinute: 45, MaxAttempts: 1, ResultsPolicy: "after_review", Revision: 1}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			for index, question := range questions {
				if question.Package != packageIndex {
					continue
				}
				item := created[index]
				snapshot, err := json.Marshal(questionSnapshot{ID: item.ID, Title: item.Title, Program: item.Program, Grade: item.Grade, Mode: item.Mode, Subject: item.Subject, Domain: item.Domain, Topic: item.Topic, Type: item.Type, Prompt: item.Prompt, Description: item.Description, StimulusJSON: item.StimulusJSON, ConfigJSON: item.ConfigJSON, AnswerJSON: item.AnswerJSON, RubricJSON: item.RubricJSON, Points: item.Points})
				if err != nil {
					return err
				}
				if err := tx.Create(&AssessmentItem{AssessmentID: row.ID, QuestionID: item.ID, Position: index + 1, Weight: item.Points, SnapshotJSON: string(snapshot)}).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
}
