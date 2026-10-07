package main

import (
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"strings"
)

// Membership is scoped to this document, never to the uploader's entire bank.
func (s *Server) validateFormMedia(tx *gorm.DB, d FormDocument, stimulus, config string, publishing bool) error {
	if !publishing {
		// Drafts may contain an unfinished image alt or empty media block. Keep the
		// owner/ID checks; accessibility/completeness remains a publication gate.
		clean := func(raw string) string {
			var value any
			if json.Unmarshal([]byte(raw), &value) != nil {
				return raw
			}
			var visit func(any)
			visit = func(v any) {
				switch n := v.(type) {
				case map[string]any:
					if asString(n["assetId"]) != "" && asString(n["alt"]) == "" {
						n["alt"] = "Draf belum diberi teks alternatif"
					}
					for _, child := range n {
						visit(child)
					}
				case []any:
					for _, child := range n {
						visit(child)
					}
				}
			}
			visit(value)
			return marshalJSON(value)
		}
		stimulus, config = clean(stimulus), clean(config)
	}
	ids, err := questionMediaReferences(stimulus, config)
	if err != nil {
		return fiber.NewError(400, err.Error())
	}
	for _, id := range ids {
		var media QuestionMedia
		if tx.First(&media, "id = ? AND deleted_at IS NULL", id).Error != nil {
			return fiber.NewError(400, "Media belum tersedia")
		}
		if media.OwnerID == d.OwnerID {
			continue
		}
		var grant FormMediaGrant
		if tx.First(&grant, "document_id = ? AND media_id = ?", d.ID, id).Error == nil {
			continue
		}
		var uploader CBTAccount
		if tx.First(&uploader, "id = ? AND active = true", media.OwnerID).Error != nil || !formEditable(s.formRole(tx, uploader, d)) {
			return fiber.NewError(403, "Media tidak dibagikan untuk dokumen ini")
		}
	}
	return nil
}

func (s *Server) canReadAssessment(tx *gorm.DB, a CBTAccount, row Assessment) bool {
	if staffCanWrite(a, row.OwnerID) || a.Role == "kepala_sekolah" {
		return true
	}
	var d FormDocument
	return tx.First(&d, "resource_type = 'assessment' AND resource_id = ?", row.ID).Error == nil && s.formRole(tx, a, d) != ""
}
func (s *Server) canGradeAssessment(tx *gorm.DB, a CBTAccount, row Assessment) bool {
	if staffCanWrite(a, row.OwnerID) {
		return true
	}
	var d FormDocument
	if tx.First(&d, "resource_type = 'assessment' AND resource_id = ?", row.ID).Error != nil {
		return false
	}
	role := s.formRole(tx, a, d)
	return role == "grader" || role == "editor"
}

// Legacy endpoints stay available for legacy resources, but cannot mutate the
// tables behind a live CRDT document or bypass its immutable publication.
func (s *Server) protectFormAdapter(c *fiber.Ctx) error {
	if c.Method() == "GET" {
		return c.Next()
	}
	path, id := c.Path(), c.Params("id")
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if id == "" && len(parts) > 3 {
		id = parts[3]
	}
	kind := ""
	if id != "" {
		switch {
		case strings.HasPrefix(path, "/api/staff/assessments/"):
			kind = "assessment"
		case strings.HasPrefix(path, "/api/staff/question-packages/"):
			kind = "package"
		}
	}
	if kind != "" && (strings.HasSuffix(path, "/draft") || strings.HasSuffix(path, "/publish") || strings.HasSuffix(path, "/items/order") || strings.HasSuffix(path, "/assignments") || strings.HasSuffix(path, "/questions") || path == "/api/staff/assessments/"+id || path == "/api/staff/question-packages/"+id) {
		var count int64
		if err := s.db.Model(&FormDocument{}).Where("resource_type = ? AND resource_id = ?", kind, id).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return fiber.NewError(409, "Paket ini menggunakan editor kolaboratif. Ubah melalui kanvas agar semua perangkat tetap sinkron.")
		}
	}
	if id != "" && strings.HasPrefix(path, "/api/staff/questions/") && !strings.HasSuffix(path, "/revision") {
		var count int64
		if err := s.db.Model(&FormDocument{}).Where("materialized_json LIKE ?", "%\""+id+"\"%").Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return fiber.NewError(409, "Soal ini dikelola kanvas kolaboratif. Edit di paket atau buat salinan revisi.")
		}
	}
	return c.Next()
}
