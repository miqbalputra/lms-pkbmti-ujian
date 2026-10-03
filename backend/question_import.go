package main

import (
	"archive/zip"
	"bytes"
	_ "embed"
	"encoding/csv"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"math"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

//go:embed question_import_example.csv
var questionImportExampleCSV []byte

const (
	maxQuestionImportBytes = 5 << 20
	maxQuestionImportRows  = 500
	maxImportArchiveBytes  = 20 << 20
)

var questionImportHeaders = []string{
	"Judul", "Jenis", "Pertanyaan", "Petunjuk", "Opsi atau baris", "Kolom (opsional)", "Kunci / jawaban", "Poin",
	"Jenjang", "Kelas", "Mode", "Mapel", "Domain", "Topik", "Kompetensi", "Level kognitif", "Kesulitan", "Estimasi waktu (menit)", "Tag kurikulum/CP", "Tag",
	"Jenis bahan", "Judul bahan", "Isi bahan", "Alt teks bahan", "Pembahasan internal",
}

type questionImportReport struct {
	Imported int      `json:"imported"`
	Failed   int      `json:"failed"`
	Errors   []string `json:"errors"`
}

type questionImportRow struct {
	Input      questionInput
	SourceLine int
}

func (s *Server) downloadQuestionImportTemplate(c *fiber.Ctx) error {
	format := strings.ToLower(c.Params("format"))
	filename := "template-soal-cbt." + format
	var body []byte
	var contentType string
	var err error
	switch format {
	case "csv":
		body, err = buildQuestionImportCSV()
		contentType = "text/csv; charset=utf-8"
	case "xlsx":
		body, err = buildQuestionImportXLSX()
		contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	case "docx":
		body, err = buildQuestionImportDOCX()
		contentType = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	default:
		return fiber.NewError(fiber.StatusNotFound, "Format template tidak ditemukan")
	}
	if err != nil {
		return err
	}
	c.Set(fiber.HeaderContentType, contentType)
	c.Set(fiber.HeaderContentDisposition, `attachment; filename="`+filename+`"`)
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Send(body)
}

func (s *Server) downloadQuestionImportExample(c *fiber.Ctx) error {
	c.Set(fiber.HeaderContentType, "text/csv; charset=utf-8")
	c.Set(fiber.HeaderContentDisposition, `attachment; filename="contoh-20-soal-cbt.csv"`)
	c.Set(fiber.HeaderCacheControl, "no-store")
	return c.Send(questionImportExampleCSV)
}

func (s *Server) importQuestions(c *fiber.Ctx) error {
	account := currentAccount(c)
	if !staffCanWrite(account, account.ID) {
		return fiber.NewError(fiber.StatusForbidden, "Akun ini hanya dapat membaca Bank Soal")
	}
	file, err := c.FormFile("file")
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Pilih file CSV, Excel (.xlsx), atau Word (.docx) terlebih dahulu")
	}
	if file.Size <= 0 || file.Size > maxQuestionImportBytes {
		return fiber.NewError(fiber.StatusRequestEntityTooLarge, "Ukuran file impor maksimal 5 MB")
	}
	opened, err := file.Open()
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "File tidak dapat dibaca")
	}
	defer opened.Close()
	content, err := io.ReadAll(io.LimitReader(opened, maxQuestionImportBytes+1))
	if err != nil || len(content) == 0 || len(content) > maxQuestionImportBytes {
		return fiber.NewError(fiber.StatusBadRequest, "Isi file tidak dapat dibaca atau melebihi 5 MB")
	}
	rows, err := parseQuestionImportRows(file.Filename, content)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	imports, failures := parseQuestionImportRecords(rows)
	report := questionImportReport{Errors: failures, Failed: len(failures)}
	for _, imported := range imports {
		input := imported.Input
		row := Question{
			OwnerID: account.ID, Title: input.Title, Program: input.Program, Grade: input.Grade, Phase: input.Phase, Mode: input.Mode,
			Subject: input.Subject, Domain: input.Domain, Topic: input.Topic, Competency: input.Competency,
			CognitiveLevel: input.CognitiveLevel, Difficulty: input.Difficulty, EstimatedMinutes: input.EstimatedMinutes, Curriculum: input.Curriculum, Tags: input.Tags, Type: input.Type,
			Prompt: input.Prompt, Description: input.Description, StimulusJSON: input.StimulusJSON, ConfigJSON: input.ConfigJSON,
			AnswerJSON: input.AnswerJSON, RubricJSON: input.RubricJSON, InternalExplanation: input.InternalExplanation,
			Points: input.Points, Status: "draft", Revision: 1,
		}
		err := s.db.Transaction(func(tx *gorm.DB) error {
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			return tx.Create(&AuditLog{ActorID: account.ID, Action: "import_question", Resource: row.ID, Detail: fmt.Sprintf("row=%d", imported.SourceLine)}).Error
		})
		if err != nil {
			report.Errors = append(report.Errors, fmt.Sprintf("Baris %d: gagal disimpan; tidak ada perubahan pada soal ini", imported.SourceLine))
			report.Failed++
			continue
		}
		report.Imported++
	}
	return c.JSON(report)
}

func parseQuestionImportRows(filename string, data []byte) ([][]string, error) {
	if len(data) == 0 || len(data) > maxQuestionImportBytes {
		return nil, errors.New("File impor kosong atau melebihi batas 5 MB")
	}
	var rows [][]string
	switch strings.ToLower(filepath.Ext(filepath.Base(filename))) {
	case ".csv":
		reader := csv.NewReader(bytes.NewReader(data))
		reader.FieldsPerRecord = -1
		reader.TrimLeadingSpace = true
		reader.ReuseRecord = false
		parsed, err := reader.ReadAll()
		if err != nil {
			return nil, fmt.Errorf("CSV tidak valid: %w", err)
		}
		rows = parsed
	case ".xlsx":
		parsed, err := parseQuestionImportXLSX(data)
		if err != nil {
			return nil, fmt.Errorf("Excel tidak dapat dibaca: %w", err)
		}
		rows = parsed
	case ".docx":
		parsed, err := parseQuestionImportDOCX(data)
		if err != nil {
			return nil, fmt.Errorf("Word tidak dapat dibaca: %w", err)
		}
		rows = parsed
	default:
		return nil, errors.New("Format belum didukung. Gunakan file .csv, .xlsx, atau .docx")
	}
	if len(rows) < 2 {
		return nil, errors.New("File belum berisi baris soal di bawah judul kolom")
	}
	if len(rows) > maxQuestionImportRows+1 {
		return nil, fmt.Errorf("Maksimal %d soal per file", maxQuestionImportRows)
	}
	return rows, nil
}

func canonicalQuestionImportHeader(value string) string {
	value = strings.TrimPrefix(strings.TrimSpace(value), "\uFEFF")
	var normalized strings.Builder
	for _, char := range strings.ToLower(value) {
		if unicode.IsLetter(char) || unicode.IsDigit(char) {
			normalized.WriteRune(char)
		}
	}
	return normalized.String()
}

var questionImportHeaderKeys = map[string]string{
	"judul": "title", "title": "title", "jenis": "type", "tipe": "type", "type": "type",
	"pertanyaan": "prompt", "soal": "prompt", "question": "prompt", "petunjuk": "description", "deskripsi": "description",
	"opsiataubaris": "options", "opsi": "options", "pilihan": "options", "rows": "options",
	"kolomopsional": "columns", "kolom": "columns", "columns": "columns",
	"kuncijawaban": "key", "jawaban": "key", "kunci": "key", "key": "key",
	"poin": "points", "skor": "points", "points": "points", "jenjang": "program", "program": "program",
	"kelas": "grade", "grade": "grade", "mode": "mode", "mapel": "subject", "matapelajaran": "subject", "subject": "subject",
	"domain": "domain", "topik": "topic", "topic": "topic", "kompetensi": "competency", "competency": "competency",
	"levelkognitif": "cognitive", "level": "cognitive", "kesulitan": "difficulty", "difficulty": "difficulty", "estimasiwaktu": "estimatedMinutes", "estimasiwaktumenit": "estimatedMinutes", "waktumenit": "estimatedMinutes", "estimatedminutes": "estimatedMinutes", "tagkurikulum": "curriculum", "tagkurikulumcp": "curriculum", "kurikulum": "curriculum", "cp": "curriculum", "capaianpembelajaran": "curriculum",
	"tag": "tags", "tags": "tags", "jenisbahan": "stimulusType", "stimulustype": "stimulusType",
	"jud ulbahan": "stimulusTitle", "judulbahan": "stimulusTitle", "stimulustitle": "stimulusTitle",
	"isibahan": "stimulusContent", "stimulus": "stimulusContent", "stimuluscontent": "stimulusContent",
	"altteksbahan": "stimulusAlt", "alt": "stimulusAlt", "pembahasaninternal": "explanation", "pembahasan": "explanation", "explanation": "explanation",
}

func parseQuestionImportRecords(rows [][]string) ([]questionImportRow, []string) {
	headers := make(map[string]int)
	for index, header := range rows[0] {
		key := questionImportHeaderKeys[canonicalQuestionImportHeader(header)]
		if key != "" {
			headers[key] = index
		}
	}
	for _, required := range []string{"title", "type", "prompt"} {
		if _, exists := headers[required]; !exists {
			return nil, []string{fmt.Sprintf("Kolom wajib %q tidak ditemukan pada baris judul", requiredQuestionImportLabel(required))}
		}
	}
	var imports []questionImportRow
	var failures []string
	for index, row := range rows[1:] {
		record := make(map[string]string, len(headers))
		nonEmpty := false
		for key, cell := range headers {
			if cell < len(row) {
				record[key] = strings.TrimSpace(row[cell])
				if record[key] != "" {
					nonEmpty = true
				}
			}
		}
		if !nonEmpty {
			continue
		}
		question, err := questionFromImportRecord(record)
		if err != nil {
			failures = append(failures, fmt.Sprintf("Baris %d: %s", index+2, err.Error()))
			continue
		}
		imports = append(imports, questionImportRow{Input: question, SourceLine: index + 2})
	}
	return imports, failures
}

func requiredQuestionImportLabel(key string) string {
	switch key {
	case "title":
		return "Judul"
	case "type":
		return "Jenis"
	default:
		return "Pertanyaan"
	}
}

func importParts(value string) []string {
	parts := strings.Split(value, "|")
	clean := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			clean = append(clean, part)
		}
	}
	return clean
}

func importType(value string) (string, error) {
	normalized := canonicalQuestionImportHeader(value)
	aliases := map[string]string{
		"pili hanganda": "pg_tunggal", "pilihanganda": "pg_tunggal", "pili hangandatunggal": "pg_tunggal", "pgtunggal": "pg_tunggal", "pg": "pg_tunggal",
		"pilihangandakompleks": "pg_kompleks", "pgkompleks": "pg_kompleks", "checkbox": "pg_kompleks",
		"dropdown": "dropdown", "benarsalah": "benar_salah", "menjodohkan": "menjodohkan", "jawabansingkat": "isian_singkat", "isiansingkat": "isian_singkat",
		"paragrafuraian": "uraian", "uraian": "uraian", "susunurutan": "susun_urutan", "kisipilihantunggal": "kisi_pg", "kisipg": "kisi_pg",
		"kisikotakcentang": "kisi_checkbox", "kisicheckbox": "kisi_checkbox", "skalalinear": "skala_linear", "rating": "rating", "tanggal": "tanggal", "waktudurasi": "waktu", "waktu": "waktu", "unggahberkas": "unggah_berkas",
	}
	if questionType, ok := aliases[normalized]; ok {
		return questionType, nil
	}
	if supportedQuestionTypes[value] {
		return value, nil
	}
	return "", errors.New("jenis soal tidak dikenali; pilih dari template yang disediakan")
}

func parseIndexedAnswers(raw string, values []string, allowMany bool, idPrefix string) ([]string, error) {
	parts := importParts(raw)
	if len(parts) == 0 {
		return nil, errors.New("kunci jawaban wajib diisi")
	}
	if !allowMany && len(parts) != 1 {
		return nil, errors.New("jenis soal ini hanya menerima satu kunci")
	}
	ids := make([]string, 0, len(parts))
	seen := make(map[string]bool)
	for _, part := range parts {
		index, err := strconv.Atoi(part)
		var matched string
		if err == nil {
			if index < 1 || index > len(values) {
				return nil, fmt.Errorf("nomor kunci %q tidak ada di daftar pilihan", part)
			}
			matched = values[index-1]
		} else {
			for _, value := range values {
				if strings.EqualFold(strings.TrimSpace(value), part) {
					matched = value
					break
				}
			}
			if matched == "" {
				return nil, fmt.Errorf("kunci %q tidak cocok dengan pilihan mana pun", part)
			}
		}
		for idx, value := range values {
			if value == matched {
				id := fmt.Sprintf("%s-%d", idPrefix, idx+1)
				if seen[id] {
					return nil, errors.New("kunci jawaban yang sama ditulis lebih dari sekali")
				}
				seen[id] = true
				ids = append(ids, id)
				break
			}
		}
	}
	return ids, nil
}

func newImportRows(prefix string, values []string) []map[string]any {
	rows := make([]map[string]any, len(values))
	for index, value := range values {
		rows[index] = map[string]any{"id": fmt.Sprintf("%s-%d", prefix, index+1), "text": value}
	}
	return rows
}

func jsonString(value any) string {
	encoded, _ := json.Marshal(value)
	return string(encoded)
}

func questionFromImportRecord(record map[string]string) (questionInput, error) {
	get := func(key string) string { return strings.TrimSpace(record[key]) }
	prompt := get("prompt")
	if prompt == "" {
		return questionInput{}, errors.New("pertanyaan tidak boleh kosong")
	}
	title := get("title")
	if title == "" {
		runes := []rune(prompt)
		if len(runes) > 72 {
			runes = runes[:72]
		}
		title = strings.TrimSpace(string(runes))
	}
	kind, err := importType(get("type"))
	if err != nil {
		return questionInput{}, err
	}
	points := 1.0
	if get("points") != "" {
		points, err = strconv.ParseFloat(get("points"), 64)
		if err != nil || math.IsNaN(points) || math.IsInf(points, 0) || points < 0 {
			return questionInput{}, errors.New("poin harus angka nol atau lebih")
		}
	}
	grade := 0
	if get("grade") != "" {
		grade, err = strconv.Atoi(get("grade"))
		if err != nil || grade < 0 || grade > 12 {
			return questionInput{}, errors.New("kelas harus berupa angka 1–12 atau dikosongkan")
		}
	}
	mode := get("mode")
	if mode == "" {
		mode = "akm"
	}
	options, columns, answerText := importParts(get("options")), importParts(get("columns")), get("key")
	config := map[string]any{}
	var answer any
	var rubric []map[string]any
	switch kind {
	case "pg_tunggal", "pg_kompleks", "dropdown":
		if len(options) < 2 {
			return questionInput{}, errors.New("isi minimal dua pilihan pada kolom Opsi atau baris")
		}
		correctIDs, keyErr := parseIndexedAnswers(answerText, options, kind == "pg_kompleks", "opsi")
		if keyErr != nil {
			return questionInput{}, keyErr
		}
		config = map[string]any{"choices": newImportRows("opsi", options), "correctIds": correctIDs}
		answer = correctIDs
	case "benar_salah":
		keys := importParts(answerText)
		if len(options) == 0 || len(keys) != len(options) {
			return questionInput{}, errors.New("isi satu kunci Benar/Salah untuk setiap pernyataan")
		}
		statements := newImportRows("pernyataan", options)
		answers := make(map[string]any, len(keys))
		for index, key := range keys {
			var correct bool
			switch canonicalQuestionImportHeader(key) {
			case "benar", "b", "true", "1":
				correct = true
			case "salah", "s", "false", "0":
			default:
				return questionInput{}, fmt.Errorf("kunci pernyataan %d harus Benar atau Salah", index+1)
			}
			statements[index]["correct"] = correct
			answers[fmt.Sprintf("pernyataan-%d", index+1)] = correct
		}
		config = map[string]any{"statements": statements}
		answer = answers
	case "menjodohkan":
		if len(options) == 0 || len(columns) == 0 {
			return questionInput{}, errors.New("isi daftar kiri di Opsi atau baris dan daftar kanan di Kolom")
		}
		keys := importParts(answerText)
		if len(keys) != len(options) {
			return questionInput{}, errors.New("Kunci harus memuat nomor pasangan kanan untuk setiap item kiri")
		}
		pairs := make(map[string]string, len(keys))
		for index, key := range keys {
			right, parseErr := parseIndexedAnswers(key, columns, false, "kolom")
			if parseErr != nil {
				return questionInput{}, fmt.Errorf("pasangan kiri %d: %w", index+1, parseErr)
			}
			pairs[fmt.Sprintf("opsi-%d", index+1)] = right[0]
		}
		config = map[string]any{"left": newImportRows("opsi", options), "right": newImportRows("kolom", columns), "pairs": pairs}
		answer = pairs
	case "susun_urutan":
		if len(options) < 2 {
			return questionInput{}, errors.New("isi minimal dua langkah pada kolom Opsi atau baris")
		}
		ids, keyErr := parseIndexedAnswers(answerText, options, true, "opsi")
		if keyErr != nil || len(ids) != len(options) {
			return questionInput{}, errors.New("Kunci urutan harus mencantumkan setiap nomor pilihan tepat satu kali")
		}
		config = map[string]any{"choices": newImportRows("opsi", options), "correctOrder": ids}
		answer = ids
	case "kisi_pg", "kisi_checkbox":
		if len(options) == 0 || len(columns) < 2 {
			return questionInput{}, errors.New("isi baris di Opsi atau baris dan minimal dua pilihan pada Kolom")
		}
		keys := strings.Split(answerText, "|")
		if len(keys) != len(options) {
			return questionInput{}, errors.New("Kunci harus memuat jawaban untuk setiap baris kisi")
		}
		if kind == "kisi_pg" {
			correct := make(map[string]string, len(keys))
			for index, key := range keys {
				selected, keyErr := parseIndexedAnswers(key, columns, false, "kolom")
				if keyErr != nil {
					return questionInput{}, fmt.Errorf("kisi baris %d: %w", index+1, keyErr)
				}
				correct[fmt.Sprintf("opsi-%d", index+1)] = selected[0]
			}
			config = map[string]any{"rows": newImportRows("opsi", options), "columns": newImportRows("kolom", columns), "gridCorrect": correct}
			answer = correct
		} else {
			correct := make(map[string][]string, len(keys))
			for index, key := range keys {
				selected, keyErr := parseIndexedAnswers(strings.ReplaceAll(key, "+", "|"), columns, true, "kolom")
				if keyErr != nil {
					return questionInput{}, fmt.Errorf("kisi baris %d: %w", index+1, keyErr)
				}
				correct[fmt.Sprintf("opsi-%d", index+1)] = selected
			}
			config = map[string]any{"rows": newImportRows("opsi", options), "columns": newImportRows("kolom", columns), "gridMultiCorrect": correct}
			answer = correct
		}
	case "isian_singkat", "tanggal", "waktu":
		accepted := importParts(answerText)
		if len(accepted) == 0 {
			return questionInput{}, errors.New("isi minimal satu jawaban yang diterima")
		}
		config = map[string]any{"acceptedAnswers": accepted, "textMinLength": 0, "textMaxLength": 2000}
		answer = accepted
	case "uraian":
		for index, item := range importParts(get("options")) {
			label, points, found := strings.Cut(item, ":")
			if !found || strings.TrimSpace(label) == "" {
				return questionInput{}, fmt.Errorf("rubrik ke-%d harus berformat kriteria:poin, misalnya Ketepatan:3", index+1)
			}
			value, parseErr := strconv.ParseFloat(strings.TrimSpace(points), 64)
			if parseErr != nil || value < 0 || math.IsNaN(value) || math.IsInf(value, 0) {
				return questionInput{}, fmt.Errorf("poin rubrik ke-%d harus berupa angka nol atau lebih", index+1)
			}
			rubric = append(rubric, map[string]any{"id": fmt.Sprintf("rubrik-%d", index+1), "text": strings.TrimSpace(label), "points": value})
		}
		if len(rubric) == 0 {
			rubric = []map[string]any{{"id": "rubrik-1", "text": "Ketepatan jawaban", "points": 5}}
		}
		config = map[string]any{"rubrik": rubric, "textMinLength": 0, "textMaxLength": 2000}
		answer = nil
	case "skala_linear", "rating":
		values := importParts(get("options"))
		min, max, minLabel, maxLabel := 1.0, 5.0, "", ""
		if len(values) > 0 {
			if len(values) < 2 {
				return questionInput{}, errors.New("rentang skala harus ditulis min|max|label minimum|label maksimum")
			}
			min, err = strconv.ParseFloat(values[0], 64)
			if err == nil {
				max, err = strconv.ParseFloat(values[1], 64)
			}
			if err != nil || math.IsNaN(min) || math.IsNaN(max) || math.IsInf(min, 0) || math.IsInf(max, 0) || min >= max {
				return questionInput{}, errors.New("rentang skala tidak valid")
			}
			if len(values) > 2 {
				minLabel = values[2]
			}
			if len(values) > 3 {
				maxLabel = values[3]
			}
		}
		correct, parseErr := strconv.ParseFloat(answerText, 64)
		if parseErr != nil || math.IsNaN(correct) || math.IsInf(correct, 0) || correct < min || correct > max {
			return questionInput{}, errors.New("kunci skala harus berupa angka di dalam rentang")
		}
		if kind == "rating" {
			config = map[string]any{"ratingMax": max, "correctNumber": correct}
		} else {
			config = map[string]any{"scaleMin": min, "scaleMax": max, "scaleMinLabel": minLabel, "scaleMaxLabel": maxLabel, "correctNumber": correct}
		}
		answer = correct
	case "unggah_berkas":
		allowed := importParts(get("options"))
		if len(allowed) == 0 {
			allowed = []string{"pdf", "png", "jpg", "jpeg"}
		}
		maxFiles, maxSize := 1.0, 10.0
		if get("columns") != "" {
			limits := importParts(get("columns"))
			if len(limits) != 2 {
				return questionInput{}, errors.New("batas berkas harus berformat jumlah|ukuranMB")
			}
			maxFiles, err = strconv.ParseFloat(limits[0], 64)
			if err == nil {
				maxSize, err = strconv.ParseFloat(limits[1], 64)
			}
			if err != nil || maxFiles < 1 || maxFiles > 10 || maxSize < 1 || maxSize > 20 {
				return questionInput{}, errors.New("batas berkas di luar rentang (1–10 file, 1–20 MB)")
			}
		}
		config = map[string]any{"allowedFileTypes": allowed, "maxFiles": maxFiles, "maxFileSizeMB": maxSize}
		answer = nil
	}
	configJSON := jsonString(config)
	answerJSON := jsonString(answer)
	rubricJSON := jsonString(rubric)
	stimulusJSON, err := importStimulusJSON(get("stimulusType"), get("stimulusTitle"), get("stimulusContent"), get("stimulusAlt"))
	if err != nil {
		return questionInput{}, err
	}
	question := questionInput{
		Title: title, Program: get("program"), Grade: grade, Mode: mode, Subject: get("subject"), Domain: get("domain"), Topic: get("topic"),
		Competency: get("competency"), CognitiveLevel: get("cognitive"), Difficulty: get("difficulty"), Curriculum: get("curriculum"), Tags: get("tags"), Type: kind,
		Prompt: prompt, Description: get("description"), StimulusJSON: stimulusJSON, ConfigJSON: configJSON, AnswerJSON: answerJSON,
		RubricJSON: rubricJSON, InternalExplanation: get("explanation"), Points: points, Status: "draft",
	}
	if question.Difficulty == "" {
		question.Difficulty = "sedang"
	}
	if rawMinutes := strings.TrimSpace(get("estimatedMinutes")); rawMinutes != "" {
		if question.EstimatedMinutes, err = strconv.Atoi(rawMinutes); err != nil {
			return questionInput{}, errors.New("estimasi waktu harus berupa angka menit")
		}
	}
	if err := normalizeQuestionInput(&question); err != nil {
		return questionInput{}, err
	}
	if !validQuestionForPublish(questionSnapshot{Type: kind, ConfigJSON: configJSON, AnswerJSON: answerJSON, RubricJSON: rubricJSON}) {
		return questionInput{}, errors.New("konfigurasi atau kunci jawaban belum lengkap untuk diterbitkan")
	}
	return question, nil
}

func importStimulusJSON(kind, title, content, alt string) (string, error) {
	if kind == "" && content == "" && title == "" && alt == "" {
		return "", nil
	}
	switch canonicalQuestionImportHeader(kind) {
	case "teks":
		kind = "text"
	case "tabel":
		kind = "table"
	case "gambar":
		kind = "image"
	case "media", "video":
		kind = "media"
	default:
		if kind != "text" && kind != "table" && kind != "image" && kind != "media" {
			return "", errors.New("jenis bahan harus teks, tabel, gambar, atau media")
		}
	}
	if strings.TrimSpace(content) == "" {
		return "", errors.New("isi bahan wajib diisi bila jenis bahan dipilih")
	}
	if kind == "table" {
		var rows [][]string
		for _, row := range strings.Split(content, ";") {
			rows = append(rows, strings.Split(row, "|"))
		}
		content = jsonString(rows)
	}
	raw := jsonString([]map[string]string{{"type": kind, "title": title, "content": content, "alt": alt}})
	if !validStimulusJSON(raw) {
		return "", errors.New("bahan tidak valid; tautan gambar/media harus HTTPS dan tanpa user/password")
	}
	return raw, nil
}

func openSafeImportArchive(data []byte) (*zip.Reader, error) {
	reader, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, errors.New("file arsip bukan XLSX/DOCX yang valid")
	}
	total := uint64(0)
	for _, file := range reader.File {
		total += file.UncompressedSize64
		if file.UncompressedSize64 > maxImportArchiveBytes || total > maxImportArchiveBytes {
			return nil, errors.New("isi file terkompresi terlalu besar")
		}
	}
	return reader, nil
}

func readImportArchiveFile(reader *zip.Reader, name string) ([]byte, error) {
	for _, file := range reader.File {
		if file.Name != name {
			continue
		}
		opened, err := file.Open()
		if err != nil {
			return nil, err
		}
		defer opened.Close()
		content, err := io.ReadAll(io.LimitReader(opened, maxImportArchiveBytes+1))
		if err != nil || len(content) > maxImportArchiveBytes {
			return nil, errors.New("isi arsip melebihi batas aman")
		}
		return content, nil
	}
	return nil, fmt.Errorf("file arsip tidak memiliki %s", name)
}

func parseQuestionImportXLSX(data []byte) ([][]string, error) {
	reader, err := openSafeImportArchive(data)
	if err != nil {
		return nil, err
	}
	var shared []string
	if content, readErr := readImportArchiveFile(reader, "xl/sharedStrings.xml"); readErr == nil {
		var stringsXML struct {
			Items []struct {
				Text string `xml:"t"`
				Runs []struct {
					Text string `xml:"t"`
				} `xml:"r"`
			} `xml:"si"`
		}
		if err := xml.Unmarshal(content, &stringsXML); err != nil {
			return nil, errors.New("shared strings pada XLSX rusak")
		}
		for _, item := range stringsXML.Items {
			value := item.Text
			if len(item.Runs) > 0 {
				value = ""
				for _, run := range item.Runs {
					value += run.Text
				}
			}
			shared = append(shared, value)
		}
	}
	sheet, err := readImportArchiveFile(reader, "xl/worksheets/sheet1.xml")
	if err != nil {
		return nil, err
	}
	var worksheet struct {
		Rows []struct {
			Cells []struct {
				Reference string `xml:"r,attr"`
				Type      string `xml:"t,attr"`
				Value     string `xml:"v"`
				Inline    struct {
					Text string `xml:"t"`
					Runs []struct {
						Text string `xml:"t"`
					} `xml:"r"`
				} `xml:"is"`
			} `xml:"c"`
		} `xml:"sheetData>row"`
	}
	if err := xml.Unmarshal(sheet, &worksheet); err != nil {
		return nil, errors.New("sheet pertama pada XLSX rusak")
	}
	rows := make([][]string, len(worksheet.Rows))
	for rowIndex, row := range worksheet.Rows {
		values := make(map[int]string)
		maxColumn := -1
		for _, cell := range row.Cells {
			column, err := importColumnIndex(cell.Reference)
			if err != nil {
				continue
			}
			value := cell.Value
			if cell.Type == "s" {
				sharedIndex, parseErr := strconv.Atoi(value)
				if parseErr != nil || sharedIndex < 0 || sharedIndex >= len(shared) {
					return nil, errors.New("indeks teks pada XLSX tidak valid")
				}
				value = shared[sharedIndex]
			} else if cell.Type == "inlineStr" {
				value = cell.Inline.Text
				for _, run := range cell.Inline.Runs {
					value += run.Text
				}
			}
			values[column] = value
			if column > maxColumn {
				maxColumn = column
			}
		}
		rows[rowIndex] = make([]string, maxColumn+1)
		for column, value := range values {
			rows[rowIndex][column] = value
		}
	}
	return rows, nil
}

func importColumnIndex(reference string) (int, error) {
	index := 0
	found := false
	for _, char := range strings.ToUpper(reference) {
		if char < 'A' || char > 'Z' {
			break
		}
		found = true
		index = index*26 + int(char-'A'+1)
	}
	if !found {
		return -1, errors.New("referensi kolom tidak valid")
	}
	return index - 1, nil
}

func parseQuestionImportDOCX(data []byte) ([][]string, error) {
	reader, err := openSafeImportArchive(data)
	if err != nil {
		return nil, err
	}
	document, err := readImportArchiveFile(reader, "word/document.xml")
	if err != nil {
		return nil, err
	}
	decoder := xml.NewDecoder(bytes.NewReader(document))
	var rows [][]string
	for {
		token, tokenErr := decoder.Token()
		if tokenErr == io.EOF {
			break
		}
		if tokenErr != nil {
			return nil, errors.New("XML tabel DOCX rusak")
		}
		start, ok := token.(xml.StartElement)
		if !ok || start.Name.Local != "tr" {
			continue
		}
		row, rowErr := readDOCXTableRow(decoder)
		if rowErr != nil {
			return nil, rowErr
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, errors.New("DOCX harus memuat tabel dengan satu soal per baris dan kolom sesuai template")
	}
	return rows, nil
}

func readDOCXTableRow(decoder *xml.Decoder) ([]string, error) {
	var cells []string
	for {
		token, err := decoder.Token()
		if err != nil {
			return nil, errors.New("baris tabel DOCX tidak tertutup")
		}
		switch typed := token.(type) {
		case xml.StartElement:
			if typed.Name.Local == "tc" {
				cell, err := readDOCXTableCell(decoder)
				if err != nil {
					return nil, err
				}
				cells = append(cells, strings.TrimSpace(cell))
			}
		case xml.EndElement:
			if typed.Name.Local == "tr" {
				return cells, nil
			}
		}
	}
}

func readDOCXTableCell(decoder *xml.Decoder) (string, error) {
	var text strings.Builder
	for {
		token, err := decoder.Token()
		if err != nil {
			return "", errors.New("sel tabel DOCX tidak tertutup")
		}
		switch typed := token.(type) {
		case xml.StartElement:
			if typed.Name.Local == "t" {
				var value string
				if err := decoder.DecodeElement(&value, &typed); err != nil {
					return "", errors.New("teks sel DOCX rusak")
				}
				text.WriteString(value)
			}
		case xml.EndElement:
			if typed.Name.Local == "tc" {
				return text.String(), nil
			}
		}
	}
}

func buildQuestionImportCSV() ([]byte, error) {
	var output bytes.Buffer
	writer := csv.NewWriter(&output)
	if err := writer.Write(questionImportHeaders); err != nil {
		return nil, err
	}
	if err := writer.Write([]string{"Contoh: Penjumlahan", "Pilihan ganda", "Berapakah 2 + 2?", "Pilih satu jawaban", "3|4|5", "", "2", "2", "Paket A", "4", "AKM", "Matematika", "Bilangan", "Operasi hitung", "Menjumlahkan bilangan", "Memahami", "Mudah", "2", "CP Matematika Fase A — Bilangan", "contoh, bilangan", "text", "Stimulus contoh", "Gunakan untuk mengganti dengan bahan soal sendiri", "", ""}); err != nil {
		return nil, err
	}
	writer.Flush()
	return output.Bytes(), writer.Error()
}

func buildQuestionImportXLSX() ([]byte, error) {
	return buildSimpleXLSX([][]string{questionImportHeaders, {"Contoh: Penjumlahan", "Pilihan ganda", "Berapakah 2 + 2?", "Pilih satu jawaban", "3|4|5", "", "2", "2", "Paket A", "4", "AKM", "Matematika", "Bilangan", "Operasi hitung", "Menjumlahkan bilangan", "Memahami", "Mudah", "2", "CP Matematika Fase A — Bilangan", "contoh, bilangan", "text", "Stimulus contoh", "Gunakan untuk mengganti dengan bahan soal sendiri", "", ""}})
}

func buildSimpleXLSX(rows [][]string) ([]byte, error) {
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	files := map[string]string{
		"[Content_Types].xml":        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`,
		"_rels/.rels":                `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
		"xl/workbook.xml":            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Soal" sheetId="1" r:id="rId1"/></sheets></workbook>`,
		"xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
	}
	var sheet strings.Builder
	sheet.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`)
	for rowIndex, row := range rows {
		sheet.WriteString(fmt.Sprintf(`<row r="%d">`, rowIndex+1))
		for columnIndex, value := range row {
			var escaped bytes.Buffer
			if err := xml.EscapeText(&escaped, []byte(value)); err != nil {
				return nil, err
			}
			sheet.WriteString(fmt.Sprintf(`<c r="%s%d" t="inlineStr"><is><t xml:space="preserve">%s</t></is></c>`, importColumnName(columnIndex), rowIndex+1, escaped.String()))
		}
		sheet.WriteString(`</row>`)
	}
	sheet.WriteString(`</sheetData></worksheet>`)
	files["xl/worksheets/sheet1.xml"] = sheet.String()
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := file.Write([]byte(content)); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func importColumnName(index int) string {
	var result string
	for index >= 0 {
		result = string(rune('A'+index%26)) + result
		index = index/26 - 1
	}
	return result
}

func buildQuestionImportDOCX() ([]byte, error) {
	var document strings.Builder
	document.WriteString(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Isi satu soal per baris tabel. Pertahankan baris judul kolom dari template.</w:t></w:r></w:p><w:tbl><w:tblPr/><w:tblGrid>`)
	for range questionImportHeaders {
		document.WriteString(`<w:gridCol w:w="2200"/>`)
	}
	document.WriteString(`</w:tblGrid>`)
	rows := [][]string{questionImportHeaders, {"Contoh: Penjumlahan", "Pilihan ganda", "Berapakah 2 + 2?", "Pilih satu jawaban", "3|4|5", "", "2", "2", "Paket A", "4", "AKM", "Matematika", "Bilangan", "Operasi hitung", "Menjumlahkan bilangan", "Memahami", "Mudah", "2", "CP Matematika Fase A — Bilangan", "contoh, bilangan", "text", "Stimulus contoh", "Gunakan untuk mengganti dengan bahan soal sendiri", "", ""}}
	for _, row := range rows {
		document.WriteString(`<w:tr>`)
		for _, value := range row {
			var escaped bytes.Buffer
			if err := xml.EscapeText(&escaped, []byte(value)); err != nil {
				return nil, err
			}
			document.WriteString(`<w:tc><w:tcPr/><w:p><w:r><w:t xml:space="preserve">` + escaped.String() + `</w:t></w:r></w:p></w:tc>`)
		}
		document.WriteString(`</w:tr>`)
	}
	document.WriteString(`</w:tbl><w:sectPr/></w:body></w:document>`)
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	files := map[string]string{
		"[Content_Types].xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
		"_rels/.rels":         `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
		"word/document.xml":   document.String(),
	}
	for name, content := range files {
		file, err := writer.Create(name)
		if err != nil {
			return nil, err
		}
		if _, err := file.Write([]byte(content)); err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}
