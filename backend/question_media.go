package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
)

const maxQuestionMediaBytes = 5 << 20

type questionMediaUploadType struct {
	extension   string
	contentType string
	kind        string
}

func inspectQuestionMedia(extension string, data []byte) (questionMediaUploadType, error) {
	extension = strings.TrimPrefix(strings.ToLower(extension), ".")
	if len(data) == 0 || len(data) > maxQuestionMediaBytes {
		return questionMediaUploadType{}, errors.New("Berkas media kosong atau melebihi batas 5 MB")
	}
	image := ""
	switch {
	case len(data) >= 8 && string(data[:8]) == "\x89PNG\r\n\x1a\n":
		image = "png"
	case len(data) >= 3 && data[0] == 0xff && data[1] == 0xd8 && data[2] == 0xff:
		image = "jpg"
	case len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WEBP":
		image = "webp"
	}
	if image != "" {
		if extension != image && !(image == "jpg" && extension == "jpeg") {
			return questionMediaUploadType{}, errors.New("Isi gambar tidak sesuai dengan ekstensi file")
		}
		contentType := map[string]string{"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp"}[image]
		return questionMediaUploadType{extension: image, contentType: contentType, kind: "image"}, nil
	}
	if extension == "mp3" && (string(data[:min(3, len(data))]) == "ID3" || len(data) >= 2 && data[0] == 0xff && data[1]&0xe0 == 0xe0) {
		return questionMediaUploadType{extension: extension, contentType: "audio/mpeg", kind: "audio"}, nil
	}
	if extension == "wav" && len(data) >= 12 && string(data[:4]) == "RIFF" && string(data[8:12]) == "WAVE" {
		return questionMediaUploadType{extension: extension, contentType: "audio/wav", kind: "audio"}, nil
	}
	if (extension == "mp4" || extension == "m4a") && len(data) >= 12 && string(data[4:8]) == "ftyp" {
		kind, contentType := "video", "video/mp4"
		if extension == "m4a" {
			kind, contentType = "audio", "audio/mp4"
		}
		return questionMediaUploadType{extension: extension, contentType: contentType, kind: kind}, nil
	}
	if extension == "webm" && len(data) >= 4 && data[0] == 0x1a && data[1] == 0x45 && data[2] == 0xdf && data[3] == 0xa3 {
		return questionMediaUploadType{extension: extension, contentType: "video/webm", kind: "video"}, nil
	}
	return questionMediaUploadType{}, errors.New("Format media tidak didukung atau isi file tidak cocok. Gunakan JPG, PNG, WebP, MP3, WAV, M4A, MP4, atau WebM")
}

func (s *Server) uploadQuestionMedia(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" || !staffCanWrite(account, account.ID) {
		return fiber.NewError(fiber.StatusForbidden, "Akun ini hanya dapat membaca soal")
	}
	file, err := c.FormFile("file")
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Pilih gambar, audio, atau video terlebih dahulu")
	}
	if file.Size <= 0 || file.Size > maxQuestionMediaBytes {
		return fiber.NewError(fiber.StatusRequestEntityTooLarge, "Media harus berukuran maksimal 5 MB setelah kompresi")
	}
	opened, err := file.Open()
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, "File media tidak dapat dibaca")
	}
	defer opened.Close()
	data, err := io.ReadAll(io.LimitReader(opened, maxQuestionMediaBytes+1))
	if err != nil || int64(len(data)) != file.Size {
		return fiber.NewError(fiber.StatusBadRequest, "File media kosong atau tidak dapat dibaca")
	}
	mediaType, err := inspectQuestionMedia(filepath.Ext(filepath.Base(file.Filename)), data)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	id := uuid.NewString()
	storedName := id + "." + mediaType.extension
	directory := filepath.Join(s.cfg.UploadsDir, "questions")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	path := filepath.Join(directory, storedName)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	digest := sha256.Sum256(data)
	media := QuestionMedia{Base: Base{ID: id}, OwnerID: account.ID, StoredName: storedName, OriginalName: filepath.Base(file.Filename), ContentType: mediaType.contentType, Kind: mediaType.kind, Size: int64(len(data)), SHA256: hex.EncodeToString(digest[:])}
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&media).Error; err != nil {
			return err
		}
		return tx.Create(&AuditLog{ActorID: account.ID, Action: "upload_question_media", Resource: media.ID, Detail: fmt.Sprintf("kind=%s;size=%d", media.Kind, media.Size)}).Error
	}); err != nil {
		_ = os.Remove(path)
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"id": media.ID, "url": "/api/question-media/" + media.ID, "kind": media.Kind, "contentType": media.ContentType, "size": media.Size, "originalName": media.OriginalName})
}

func (s *Server) validateQuestionMediaOwner(account CBTAccount, input questionInput) error {
	ids, err := questionMediaReferences(input.StimulusJSON, input.ConfigJSON)
	if err != nil {
		return fiber.NewError(fiber.StatusBadRequest, err.Error())
	}
	for _, id := range ids {
		var media QuestionMedia
		if err := s.db.First(&media, "id = ? AND deleted_at IS NULL", id).Error; err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "Salah satu media soal tidak tersedia. Unggah kembali sebelum menyimpan.")
		}
		if account.Role != "admin" && media.OwnerID != account.ID {
			return fiber.NewError(fiber.StatusForbidden, "Media hanya dapat digunakan oleh pengunggahnya")
		}
	}
	return nil
}

func questionMediaIDs(jsonValues ...string) []string {
	ids, _ := questionMediaReferences(jsonValues...)
	return ids
}

func questionMediaReferences(jsonValues ...string) ([]string, error) {
	seen := make(map[string]bool)
	var ids []string
	var referenceError error
	var visit func(any)
	visit = func(value any) {
		if referenceError != nil {
			return
		}
		switch node := value.(type) {
		case map[string]any:
			if rawID, exists := node["assetId"]; exists {
				id, ok := rawID.(string)
				if !ok || strings.TrimSpace(id) == "" {
					referenceError = errors.New("Referensi media soal tidak valid. Unggah ulang media ini.")
					return
				}
				if _, err := uuid.Parse(id); err != nil {
					referenceError = errors.New("Referensi media soal tidak valid. Unggah ulang media ini.")
					return
				}
				contentType, _ := node["contentType"].(string)
				alt, _ := node["alt"].(string)
				kind, _ := node["kind"].(string)
				if (strings.HasPrefix(contentType, "image/") || kind == "image") && strings.TrimSpace(alt) == "" {
					referenceError = errors.New("Tambahkan teks alternatif untuk gambar soal atau opsi jawaban.")
					return
				}
				if !seen[id] {
					seen[id] = true
					ids = append(ids, id)
				}
			}
			for _, child := range node {
				visit(child)
			}
		case []any:
			for _, child := range node {
				visit(child)
			}
		}
	}
	for _, raw := range jsonValues {
		if strings.TrimSpace(raw) == "" {
			continue
		}
		var parsed any
		if json.Unmarshal([]byte(raw), &parsed) != nil {
			return nil, errors.New("Referensi media soal tidak valid. Unggah ulang media ini.")
		}
		visit(parsed)
	}
	return ids, referenceError
}

func (s *Server) downloadQuestionMedia(c *fiber.Ctx) error {
	account := currentAccount(c)
	var media QuestionMedia
	if err := s.db.First(&media, "id = ? AND deleted_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "Media tidak ditemukan")
	}
	allowed := account.Role == "admin" || account.Role == "kepala_sekolah" || account.Role == "guru" && account.ID == media.OwnerID
	if !allowed && account.Role == "guru" {
		var docs []FormDocument
		if err := s.db.Where("content_json LIKE ?", "%"+media.ID+"%").Find(&docs).Error; err != nil {
			return err
		}
		for _, d := range docs {
			if s.formRole(s.db, account, d) != "" {
				allowed = true
				break
			}
		}
	}
	if account.Role == "siswa" {
		var count int64
		query := s.db.Table("attempt_items").Joins("JOIN attempts ON attempts.id = attempt_items.attempt_id").Where("attempts.student_id = ? AND attempt_items.snapshot_json LIKE ?", account.PesertaDidikID, "%"+media.ID+"%")
		if scope, _ := c.Locals("assessmentScope").([]string); len(scope) > 0 {
			query = query.Where("attempts.assessment_id IN ?", scope)
		}
		if err := query.Count(&count).Error; err != nil {
			return err
		}
		allowed = count > 0
		if !allowed {
			var err error
			allowed, err = s.studentCanReadFormHeader(c, account, media.ID)
			if err != nil {
				return err
			}
		}
	}
	if !allowed {
		return fiber.NewError(fiber.StatusForbidden, "Akses media ditolak")
	}
	path := filepath.Join(s.cfg.UploadsDir, "questions", filepath.Base(media.StoredName))
	if _, err := os.Stat(path); err != nil {
		return fiber.NewError(fiber.StatusNotFound, "File media tidak ditemukan")
	}
	c.Set(fiber.HeaderContentType, media.ContentType)
	c.Set(fiber.HeaderContentDisposition, "inline")
	c.Set(fiber.HeaderCacheControl, "private, no-store")
	c.Set("X-Content-Type-Options", "nosniff")
	return c.SendFile(path)
}
