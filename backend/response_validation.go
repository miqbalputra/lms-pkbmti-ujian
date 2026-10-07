package main

import (
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"math"
	"net/mail"
	"net/url"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// Structural validation never consults the answer key. Autosave permits a
// partially filled grid; submission additionally enforces every required row.
func validateResponse(q questionSnapshot, value any, complete bool) error {
	c := configObject(q.ConfigJSON)
	required := complete && c["required"] == true
	invalid := func() error {
		return fiber.NewError(400, "Jawaban tidak sesuai jenis soal atau batas yang ditetapkan tutor")
	}
	if !hasValue(value) {
		if required {
			return fiber.NewError(400, "Masih ada soal wajib yang belum dijawab")
		}
		return nil
	}
	validChoice := func(v string, allowed []string) bool {
		return containsString(allowed, v) || (q.Type == "pg_tunggal" || q.Type == "pg_kompleks" || q.Type == "dropdown") && c["otherOption"] == true && strings.HasPrefix(v, "__other__:") && (!complete || strings.TrimSpace(strings.TrimPrefix(v, "__other__:")) != "") && len(v) <= 2000
	}
	validArray := func(v any, allowed []string) bool {
		rows, ok := v.([]any)
		if !ok {
			return false
		}
		seen := map[string]bool{}
		for _, row := range rows {
			id, ok := row.(string)
			if !ok || seen[id] || !validChoice(id, allowed) {
				return false
			}
			seen[id] = true
		}
		return true
	}
	switch q.Type {
	case "pg_tunggal", "dropdown":
		text, ok := value.(string)
		if !ok || !validChoice(text, stringSliceFromObjects(c["choices"])) {
			return invalid()
		}
	case "pg_kompleks", "susun_urutan":
		allowed := stringSliceFromObjects(c["choices"])
		if !validArray(value, allowed) {
			return invalid()
		}
		if q.Type == "susun_urutan" && len(stringSlice(value)) != len(allowed) {
			return invalid()
		}
		if complete && q.Type == "pg_kompleks" {
			count := float64(len(stringSlice(value)))
			if min, ok := numberValue(c["minChoices"]); ok && count < min {
				return invalid()
			}
			if max, ok := numberValue(c["maxChoices"]); ok && max > 0 && count > max {
				return invalid()
			}
		}
	case "benar_salah", "menjodohkan", "kisi_pg", "kisi_checkbox":
		rows, ok := value.(map[string]any)
		if !ok {
			return invalid()
		}
		field := "rows"
		if q.Type == "benar_salah" {
			field = "statements"
		}
		if q.Type == "menjodohkan" {
			field = "left"
		}
		allowed := stringSliceFromObjects(c[field])
		for id, v := range rows {
			if !containsString(allowed, id) {
				return invalid()
			}
			switch q.Type {
			case "benar_salah":
				if _, ok := v.(bool); !ok {
					return invalid()
				}
			case "menjodohkan":
				if !containsString(stringSliceFromObjects(c["right"]), asString(v)) {
					return invalid()
				}
			case "kisi_pg":
				if !containsString(stringSliceFromObjects(c["columns"]), asString(v)) {
					return invalid()
				}
			case "kisi_checkbox":
				if !validArray(v, stringSliceFromObjects(c["columns"])) {
					return invalid()
				}
			}
		}
		if required {
			for _, id := range allowed {
				if !hasValue(rows[id]) {
					return fiber.NewError(400, "Lengkapi setiap baris soal wajib")
				}
			}
		}
	case "skala_linear", "rating":
		n, ok := numberValue(value)
		min, max := 1.0, 5.0
		if v, ok := numberValue(c["scaleMin"]); ok && q.Type != "rating" {
			min = v
		}
		if v, ok := numberValue(c["scaleMax"]); ok {
			max = v
		}
		if v, ok := numberValue(c["ratingMax"]); ok && q.Type == "rating" {
			max = v
		}
		if !ok || math.IsNaN(n) || math.IsInf(n, 0) || math.Trunc(n) != n || n < min || n > max {
			return invalid()
		}
	case "isian_singkat", "uraian", "tanggal", "waktu":
		text, ok := value.(string)
		if !ok || len(text) > 200000 {
			return invalid()
		}
		if max, ok := numberValue(c["textMaxLength"]); ok && max > 0 && float64(utf8.RuneCountInString(text)) > max {
			return invalid()
		}
		if min, ok := numberValue(c["textMinLength"]); complete && ok && float64(utf8.RuneCountInString(text)) < min {
			return invalid()
		}
		if complete {
			switch asString(c["validationKind"]) {
			case "email":
				address, err := mail.ParseAddress(strings.TrimSpace(text))
				if err != nil || address.Address != strings.TrimSpace(text) {
					return invalid()
				}
			case "url":
				link, err := url.Parse(strings.TrimSpace(text))
				if err != nil || link.Scheme != "https" || link.Hostname() == "" || link.User != nil {
					return invalid()
				}
			case "number":
				n, err := strconv.ParseFloat(strings.ReplaceAll(strings.TrimSpace(text), ",", "."), 64)
				if err != nil || math.IsInf(n, 0) || math.IsNaN(n) {
					return invalid()
				}
				if min, ok := numberValue(c["numberMin"]); ok && n < min {
					return invalid()
				}
				if max, ok := numberValue(c["numberMax"]); ok && n > max {
					return invalid()
				}
			case "contains":
				if !strings.Contains(strings.ToLower(text), strings.ToLower(asString(c["textContains"]))) {
					return invalid()
				}
			}
		}
		format := ""
		if q.Type == "tanggal" {
			format = "2006-01-02"
		}
		if q.Type == "waktu" {
			format = "15:04"
		}
		if format != "" {
			if _, err := time.Parse(format, text); err != nil {
				return invalid()
			}
		}
	case "unggah_berkas":
		files, ok := value.([]any)
		maxFiles := 1.0
		if n, ok := numberValue(c["maxFiles"]); ok {
			maxFiles = n
		}
		if !ok || float64(len(files)) > maxFiles {
			return invalid()
		}
		seen := map[string]bool{}
		for _, file := range files {
			id := asString(mapFrom(file)["id"])
			if id == "" || seen[id] {
				return invalid()
			}
			seen[id] = true
		}
	default:
		return invalid()
	}
	return nil
}

// File metadata submitted by the browser is not proof of ownership. Only the
// private attachment belonging to this precise student/attempt/item is valid.
func validateResponseAttachments(tx *gorm.DB, item AttemptItem, q questionSnapshot, value any) error {
	if q.Type != "unggah_berkas" || !hasValue(value) {
		return nil
	}
	var attempt Attempt
	if err := tx.First(&attempt, "id = ?", item.AttemptID).Error; err != nil {
		return err
	}
	files, ok := value.([]any)
	if !ok {
		return fiber.NewError(400, "Daftar berkas tidak valid")
	}
	for _, file := range files {
		var attachment AttemptAttachment
		if tx.First(&attachment, "id = ? AND attempt_id = ? AND attempt_item_id = ? AND student_id = ? AND deleted_at IS NULL", asString(mapFrom(file)["id"]), item.AttemptID, item.ID, attempt.StudentID).Error != nil {
			return fiber.NewError(400, "Berkas jawaban belum diunggah atau tidak dimiliki percobaan ini")
		}
	}
	return nil
}
