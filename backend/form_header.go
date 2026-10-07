package main

import (
	"encoding/json"
	"strings"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

// Only an uploaded private image may become a form header. No arbitrary URL,
// HTML or CSS can be injected through the display settings.
type FormHeaderImage struct {
	AssetID string `json:"assetId"`
	Alt     string `json:"alt"`
}

func (s *Server) validateFormHeader(tx *gorm.DB, d FormDocument, settings FormSettings, publishing bool) error {
	h := settings.HeaderImage
	if h == nil {
		return nil
	}
	var media QuestionMedia
	if tx.First(&media, "id = ? AND deleted_at IS NULL", h.AssetID).Error != nil || media.Kind != "image" || !strings.HasPrefix(media.ContentType, "image/") {
		return fiber.NewError(400, "Header harus memakai gambar unggahan yang tersedia")
	}
	return s.validateFormMedia(tx, d, "[]", marshalJSON(map[string]any{"assetId": h.AssetID, "kind": "image", "alt": h.Alt}), publishing)
}

// An account sees a header only through its own immutable attempt version,
// not merely because an image ID occurs somewhere in a question's free text.
func (s *Server) studentCanReadFormHeader(c *fiber.Ctx, account CBTAccount, mediaID string) (bool, error) {
	var versions []FormVersion
	query := s.db.Table("form_versions").Select("form_versions.*").Joins("JOIN attempts ON attempts.form_version_id = form_versions.id").Where("attempts.student_id = ? AND form_versions.content_json LIKE ?", account.PesertaDidikID, "%"+mediaID+"%")
	if scope, _ := c.Locals("assessmentScope").([]string); len(scope) > 0 {
		query = query.Where("attempts.assessment_id IN ?", scope)
	}
	if err := query.Find(&versions).Error; err != nil {
		return false, err
	}
	for _, version := range versions {
		var draft FormDraft
		if json.Unmarshal([]byte(version.ContentJSON), &draft) == nil && draft.Settings.HeaderImage != nil && draft.Settings.HeaderImage.AssetID == mediaID {
			return true, nil
		}
	}
	return false, nil
}
