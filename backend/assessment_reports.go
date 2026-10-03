package main

import (
	"archive/zip"
	"bytes"
	"encoding/csv"
	"encoding/xml"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

type resultFilters struct {
	ClassID   string
	StudentID string
	Status    string
	From      *time.Time
	To        *time.Time
}

func parseResultFilters(c *fiber.Ctx) (resultFilters, error) {
	filters := resultFilters{ClassID: strings.TrimSpace(c.Query("classId")), StudentID: strings.TrimSpace(c.Query("studentId")), Status: strings.TrimSpace(c.Query("status"))}
	if filters.Status != "" && !map[string]bool{"started": true, "submitted": true, "completed": true, "pending_grade": true, "expired": true}[filters.Status] {
		return filters, fiber.NewError(400, "Filter status hasil tidak valid")
	}
	parseDate := func(raw string, endOfDay bool) (*time.Time, error) {
		if raw == "" {
			return nil, nil
		}
		value, err := time.Parse("2006-01-02", raw)
		if err != nil {
			value, err = time.Parse(time.RFC3339, raw)
		}
		if err != nil {
			return nil, fiber.NewError(400, "Gunakan tanggal laporan yang valid")
		}
		if endOfDay && len(raw) == len("2006-01-02") {
			value = value.Add(24*time.Hour - time.Nanosecond)
		}
		return &value, nil
	}
	var err error
	if filters.From, err = parseDate(c.Query("from"), false); err != nil {
		return filters, err
	}
	if filters.To, err = parseDate(c.Query("to"), true); err != nil {
		return filters, err
	}
	if filters.From != nil && filters.To != nil && filters.From.After(*filters.To) {
		return filters, fiber.NewError(400, "Tanggal awal laporan harus sebelum tanggal akhir")
	}
	return filters, nil
}

func filteredAttemptQuery(db *gorm.DB, assessmentID string, filters resultFilters) *gorm.DB {
	query := db.Where("assessment_id = ?", assessmentID)
	if filters.ClassID != "" {
		query = query.Where("class_id_at_attempt = ?", filters.ClassID)
	}
	if filters.StudentID != "" {
		query = query.Where("student_id = ?", filters.StudentID)
	}
	if filters.Status != "" {
		query = query.Where("status = ?", filters.Status)
	}
	if filters.From != nil {
		query = query.Where("started_at >= ?", filters.From)
	}
	if filters.To != nil {
		query = query.Where("started_at <= ?", filters.To)
	}
	return query
}

func (s *Server) assessmentReportRows(db *gorm.DB, assessment Assessment, filters resultFilters) ([][]string, error) {
	var attempts []Attempt
	if err := filteredAttemptQuery(db, assessment.ID, filters).Order("started_at asc").Find(&attempts).Error; err != nil {
		return nil, err
	}
	rows := [][]string{{"Nama asesmen", "ID percobaan", "ID siswa", "Nama siswa", "ID kelas saat ujian", "Status", "Nilai", "Perlu penilaian manual", "Mulai", "Kirim"}}
	for _, attempt := range attempts {
		var student MasterPeserta
		if err := db.First(&student, "id = ?", attempt.StudentID).Error; err != nil && err != gorm.ErrRecordNotFound {
			return nil, err
		}
		started, submitted := "", ""
		if attempt.StartedAt != nil {
			started = attempt.StartedAt.Format(time.RFC3339)
		}
		if attempt.SubmittedAt != nil {
			submitted = attempt.SubmittedAt.Format(time.RFC3339)
		}
		rows = append(rows, []string{assessment.Title, attempt.ID, attempt.StudentID, student.Nama, attempt.ClassIDAtAttempt, attempt.Status, strconv.FormatFloat(attempt.Score, 'f', 2, 64), strconv.FormatBool(attempt.NeedsManual), started, submitted})
	}
	return rows, nil
}

func spreadsheetSafe(value string) string {
	trimmed := strings.TrimLeft(value, " \t\r\n")
	if trimmed != "" && strings.ContainsRune("=+-@", rune(trimmed[0])) {
		return "'" + value
	}
	return value
}

func reportFileName(title, extension string) string {
	name := strings.NewReplacer("/", "-", "\\", "-", "\r", "", "\n", "").Replace(strings.TrimSpace(title))
	if name == "" {
		name = "hasil-asesmen"
	}
	return name + "-hasil." + extension
}

func (s *Server) exportAssessmentReport(c *fiber.Ctx, format string) error {
	account := currentAccount(c)
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ? AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, assessment.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Akses ditolak")
	}
	filters, err := parseResultFilters(c)
	if err != nil {
		return err
	}
	rows, err := s.assessmentReportRows(s.db, assessment, filters)
	if err != nil {
		return err
	}
	filename := reportFileName(assessment.Title, format)
	var body []byte
	switch format {
	case "csv":
		var buffer bytes.Buffer
		writer := csv.NewWriter(&buffer)
		for index, row := range rows {
			if index > 0 {
				copyRow := append([]string(nil), row...)
				for column := range copyRow {
					copyRow[column] = spreadsheetSafe(copyRow[column])
				}
				row = copyRow
			}
			if err := writer.Write(row); err != nil {
				return err
			}
		}
		writer.Flush()
		if err := writer.Error(); err != nil {
			return err
		}
		body = buffer.Bytes()
		c.Set(fiber.HeaderContentType, "text/csv; charset=utf-8")
	case "xlsx":
		body, err = buildAssessmentXLSX(rows)
		if err != nil {
			return err
		}
		c.Set(fiber.HeaderContentType, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	case "pdf":
		body = buildAssessmentPDF(assessment.Title, rows)
		c.Set(fiber.HeaderContentType, "application/pdf")
	default:
		return fiber.NewError(http.StatusNotFound, "Format laporan tidak tersedia")
	}
	return sendReport(c, filename, body)
}

func sendReport(c *fiber.Ctx, filename string, body []byte) error {
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf("attachment; filename=%q", filename))
	return c.Send(body)
}

func buildAssessmentXLSX(rows [][]string) ([]byte, error) {
	var buffer bytes.Buffer
	archive := zip.NewWriter(&buffer)
	files := []struct{ name, body string }{
		{"[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`},
		{"_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`},
		{"xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Hasil Asesmen" sheetId="1" r:id="rId1"/></sheets></workbook>`},
		{"xl/_rels/workbook.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`},
	}
	for _, file := range files {
		writer, err := archive.Create(file.name)
		if err != nil {
			return nil, err
		}
		if _, err := io.WriteString(writer, file.body); err != nil {
			return nil, err
		}
	}
	writer, err := archive.Create("xl/worksheets/sheet1.xml")
	if err != nil {
		return nil, err
	}
	if _, err := io.WriteString(writer, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>`); err != nil {
		return nil, err
	}
	for rowIndex, row := range rows {
		if _, err := fmt.Fprintf(writer, `<row r="%d">`, rowIndex+1); err != nil {
			return nil, err
		}
		for columnIndex, value := range row {
			if rowIndex > 0 {
				value = spreadsheetSafe(value)
			}
			cell, err := xml.Marshal(struct {
				XMLName xml.Name `xml:"is"`
				Text    string   `xml:"t"`
			}{Text: value})
			if err != nil {
				return nil, err
			}
			if _, err := fmt.Fprintf(writer, `<c r="%s%d" t="inlineStr">%s</c>`, excelColumn(columnIndex+1), rowIndex+1, cell); err != nil {
				return nil, err
			}
		}
		if _, err := io.WriteString(writer, `</row>`); err != nil {
			return nil, err
		}
	}
	if _, err := io.WriteString(writer, `</sheetData></worksheet>`); err != nil {
		return nil, err
	}
	if err := archive.Close(); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func excelColumn(number int) string {
	var output string
	for number > 0 {
		number--
		output = string(rune('A'+number%26)) + output
		number /= 26
	}
	return output
}

func buildAssessmentPDF(title string, rows [][]string) []byte {
	lines := []string{"Laporan hasil asesmen: " + title, "Dibuat " + time.Now().Format("02-01-2006 15:04 MST"), strings.Join(rows[0], " | ")}
	for _, row := range rows[1:] {
		lines = append(lines, strings.Join(row, " | "))
	}
	wrapped := make([]string, 0, len(lines))
	for _, line := range lines {
		for len(line) > 105 {
			cut := strings.LastIndex(line[:105], " ")
			if cut < 1 {
				cut = 105
			}
			wrapped = append(wrapped, line[:cut])
			line = strings.TrimSpace(line[cut:])
		}
		wrapped = append(wrapped, line)
	}
	const linesPerPage = 48
	pageCount := (len(wrapped) + linesPerPage - 1) / linesPerPage
	objects := make([]string, 3+pageCount*2)
	objects[0] = `<< /Type /Catalog /Pages 2 0 R >>`
	objects[2] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>`
	kids := make([]string, 0, pageCount)
	for page := 0; page < pageCount; page++ {
		pageObject := 4 + page*2
		contentObject := pageObject + 1
		kids = append(kids, fmt.Sprintf("%d 0 R", pageObject))
		objects[pageObject-1] = fmt.Sprintf(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>`, contentObject)
		var stream strings.Builder
		stream.WriteString("BT /F1 9 Tf 36 756 Td 13 TL\n")
		start := page * linesPerPage
		end := start + linesPerPage
		if end > len(wrapped) {
			end = len(wrapped)
		}
		for _, line := range wrapped[start:end] {
			stream.WriteByte('(')
			stream.WriteString(pdfEscape(line))
			stream.WriteString(") Tj T*\n")
		}
		stream.WriteString("ET")
		content := stream.String()
		objects[contentObject-1] = fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(content), content)
	}
	objects[1] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), pageCount)
	var output bytes.Buffer
	output.WriteString("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")
	offsets := make([]int, len(objects)+1)
	for index, object := range objects {
		offsets[index+1] = output.Len()
		fmt.Fprintf(&output, "%d 0 obj\n%s\nendobj\n", index+1, object)
	}
	xref := output.Len()
	fmt.Fprintf(&output, "xref\n0 %d\n0000000000 65535 f \n", len(offsets))
	for _, offset := range offsets[1:] {
		fmt.Fprintf(&output, "%010d 00000 n \n", offset)
	}
	fmt.Fprintf(&output, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(offsets), xref)
	return output.Bytes()
}

func pdfEscape(value string) string {
	var output strings.Builder
	for _, character := range value {
		if character < 32 || character > 126 {
			character = '?'
		}
		if character == '(' || character == ')' || character == '\\' {
			output.WriteByte('\\')
		}
		output.WriteRune(character)
	}
	return output.String()
}
