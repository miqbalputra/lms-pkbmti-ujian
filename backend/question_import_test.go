package main

import (
	"strings"
	"testing"
)

func TestQuestionImportTemplatesRoundTripAsSupportedFiles(t *testing.T) {
	tests := []struct {
		name string
		make func() ([]byte, error)
	}{
		{"csv", buildQuestionImportCSV},
		{"xlsx", buildQuestionImportXLSX},
		{"docx", buildQuestionImportDOCX},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			content, err := test.make()
			if err != nil {
				t.Fatal(err)
			}
			rows, err := parseQuestionImportRows("template."+test.name, content)
			if err != nil {
				t.Fatal(err)
			}
			imports, failures := parseQuestionImportRecords(rows)
			if len(failures) != 0 || len(imports) != 1 {
				t.Fatalf("template import produced %d questions and failures %v", len(imports), failures)
			}
			if imports[0].Input.Points != 2 || imports[0].Input.Type != "pg_tunggal" || imports[0].Input.Status != "draft" {
				t.Fatalf("template fields changed: %#v", imports[0].Input)
			}
			if imports[0].Input.EstimatedMinutes != 2 || imports[0].Input.Curriculum != "CP Matematika Fase A — Bilangan" {
				t.Fatalf("template metadata changed: estimated=%d curriculum=%q", imports[0].Input.EstimatedMinutes, imports[0].Input.Curriculum)
			}
		})
	}
}

func TestQuestionImportBuildsValidConfigurationForAllFifteenTypes(t *testing.T) {
	tests := []struct {
		name   string
		record map[string]string
	}{
		{"pg_tunggal", map[string]string{"type": "Pilihan ganda", "options": "Merah|Biru", "key": "2"}},
		{"pg_kompleks", map[string]string{"type": "Pilihan ganda kompleks", "options": "Merah|Biru|Hijau", "key": "1|3"}},
		{"dropdown", map[string]string{"type": "Dropdown", "options": "sayur|buku", "key": "1"}},
		{"benar_salah", map[string]string{"type": "Benar / salah", "options": "Air membeku pada suhu rendah|Matahari terbit dari barat", "key": "Benar|Salah"}},
		{"menjodohkan", map[string]string{"type": "Menjodohkan", "options": "Kucing|Sapi", "columns": "Ikan|Rumput", "key": "1|2"}},
		{"isian_singkat", map[string]string{"type": "Jawaban singkat", "key": "42|empat puluh dua"}},
		{"uraian", map[string]string{"type": "Paragraf / uraian", "options": "Ketepatan:3|Penjelasan:2"}},
		{"susun_urutan", map[string]string{"type": "Susun urutan", "options": "Kedua|Pertama|Ketiga", "key": "2|1|3"}},
		{"kisi_pg", map[string]string{"type": "Kisi pilihan tunggal", "options": "Langit siang|Malam", "columns": "Terang|Gelap", "key": "1|2"}},
		{"kisi_checkbox", map[string]string{"type": "Kisi kotak centang", "options": "Matahari|Batu bara", "columns": "Terbarukan|Tidak terbarukan", "key": "1|2"}},
		{"skala_linear", map[string]string{"type": "Skala linear", "options": "1|5|Rendah|Tinggi", "key": "4"}},
		{"rating", map[string]string{"type": "Rating", "key": "4"}},
		{"tanggal", map[string]string{"type": "Tanggal", "key": "1945-11-10"}},
		{"waktu", map[string]string{"type": "Waktu / durasi", "key": "07:30"}},
		{"unggah_berkas", map[string]string{"type": "Unggah berkas", "options": "pdf|png|jpg", "columns": "2|5"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			record := map[string]string{"title": "Contoh " + test.name, "prompt": "Pertanyaan contoh"}
			for key, value := range test.record {
				record[key] = value
			}
			question, err := questionFromImportRecord(record)
			if err != nil {
				t.Fatal(err)
			}
			if question.Type != test.name || !validQuestionForPublish(questionSnapshot{Type: question.Type, ConfigJSON: question.ConfigJSON, AnswerJSON: question.AnswerJSON, RubricJSON: question.RubricJSON}) {
				t.Fatalf("import generated incomplete question: %#v", question)
			}
		})
	}
}

func TestQuestionImportReportsErrorsUsingFileLineNumbers(t *testing.T) {
	rows := [][]string{
		questionImportHeaders,
		{"Tanpa kunci", "Pilihan ganda", "Pilih satu", "", "Ya|Tidak", "", "9", "1"},
	}
	imports, failures := parseQuestionImportRecords(rows)
	if len(imports) != 0 || len(failures) != 1 || !strings.HasPrefix(failures[0], "Baris 2:") {
		t.Fatalf("unexpected import report: imports=%d failures=%v", len(imports), failures)
	}
}

func TestQuestionImportExampleHasTwentyValidQuestionsWithExpectedKeysAndPoints(t *testing.T) {
	rows, err := parseQuestionImportRows("contoh-20-soal.csv", questionImportExampleCSV)
	if err != nil {
		t.Fatal(err)
	}
	imports, failures := parseQuestionImportRecords(rows)
	if len(failures) != 0 || len(imports) != 20 {
		t.Fatalf("contoh harus menghasilkan 20 soal tanpa gagal; berhasil=%d gagal=%v", len(imports), failures)
	}
	expected := []struct {
		title  string
		typeID string
		points float64
		answer string
	}{
		{"Jumlah jeruk", "pg_tunggal", 2, `["opsi-2"]`},
		{"Pecahan setengah", "pg_kompleks", 2, `["opsi-1","opsi-3"]`},
		{"Kata yang tepat", "dropdown", 1, `["opsi-1"]`},
		{"Pernyataan tentang air", "benar_salah", 2, `{"pernyataan-1":true,"pernyataan-2":false}`},
		{"Pasangan hewan dan makanan", "menjodohkan", 2, `{"opsi-1":"kolom-1","opsi-2":"kolom-2"}`},
		{"Hasil perkalian", "isian_singkat", 2, `["42","empat puluh dua"]`},
		{"Menghemat air", "uraian", 5, `null`},
		{"Urutan mencuci tangan", "susun_urutan", 3, `["opsi-2","opsi-1","opsi-3"]`},
		{"Ciri bangun datar", "kisi_pg", 2, `{"opsi-1":"kolom-1","opsi-2":"kolom-2"}`},
		{"Jenis sumber energi", "kisi_checkbox", 2, `{"opsi-1":["kolom-1"],"opsi-2":["kolom-2"]}`},
		{"Hasil pembagian", "skala_linear", 2, `4`},
		{"Penilaian pemahaman", "rating", 1, `5`},
		{"Hari Pahlawan", "tanggal", 1, `["1945-11-10"]`},
		{"Waktu mulai belajar", "waktu", 1, `["07:30"]`},
		{"Unggah langkah hitungan", "unggah_berkas", 3, `null`},
		{"Hasil penjumlahan dua puluh", "pg_tunggal", 2, `["opsi-2"]`},
		{"Kelipatan tiga", "pg_tunggal", 2, `["opsi-2"]`},
		{"Sinonim gembira", "pg_tunggal", 1, `["opsi-2"]`},
		{"Jumlah sisi segitiga", "pg_tunggal", 1, `["opsi-2"]`},
		{"Nilai tempat puluhan", "pg_tunggal", 2, `["opsi-2"]`},
	}
	for index, want := range expected {
		got := imports[index].Input
		if got.Title != want.title || got.Type != want.typeID || got.Points != want.points || got.AnswerJSON != want.answer {
			t.Errorf("soal ke-%d salah; judul=%q tipe=%s poin=%.2f kunci=%s; harap=%#v", index+1, got.Title, got.Type, got.Points, got.AnswerJSON, want)
		}
		if !validQuestionForPublish(questionSnapshot{Type: got.Type, ConfigJSON: got.ConfigJSON, AnswerJSON: got.AnswerJSON, RubricJSON: got.RubricJSON}) {
			t.Errorf("soal contoh %q tidak valid untuk dipublikasi", got.Title)
		}
		if imports[index].SourceLine != index+2 {
			t.Errorf("nomor baris tidak cocok: soal ke-%d tercatat baris %d", index+1, imports[index].SourceLine)
		}
	}
}
