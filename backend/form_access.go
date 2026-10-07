package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"strings"
	"time"
)

func (s *Server) resolveFormLink(token string) (Assessment, string, error) {
	var link FormAccessLink
	var row Assessment
	if token == "" || s.db.First(&link, "token_hash = ? AND revoked = false", hash(token)).Error != nil || link.ExpiresAt != nil && !time.Now().Before(*link.ExpiresAt) {
		return row, "", fiber.NewError(403, "Tautan sudah kedaluwarsa atau dicabut")
	}
	var doc FormDocument
	if s.db.First(&doc, "id = ? AND frozen = true AND resource_type = 'assessment'", link.DocumentID).Error != nil || s.db.First(&row, "id = ?", doc.ResourceID).Error != nil || !assessmentOpen(row, time.Now()) {
		return row, "", fiber.NewError(403, "Asesmen belum tersedia")
	}
	return row, link.ID, nil
}

func (s *Server) formLinks(c *fiber.Ctx) error {
	a := currentAccount(c)
	d, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	if d.ResourceType != "assessment" || s.formRole(s.db, a, d) != "owner" {
		return fiber.NewError(403, "Hanya pemilik asesmen mengelola akses peserta")
	}
	if c.Method() == "GET" {
		var rows []FormAccessLink
		if err := s.db.Where("document_id = ?", d.ID).Order("created_at desc").Find(&rows).Error; err != nil {
			return err
		}
		var assessment Assessment
		_ = s.db.First(&assessment, "id = ?", d.ResourceID).Error
		return c.JSON(fiber.Map{"links": rows, "paused": assessment.ResponsesPaused})
	}
	if c.Method() == "DELETE" {
		result := s.db.Model(&FormAccessLink{}).Where("id = ? AND document_id = ?", c.Params("linkId"), d.ID).Update("revoked", true)
		if result.Error != nil {
			return result.Error
		}
		if result.RowsAffected == 0 {
			return fiber.NewError(404, "Tautan tidak ditemukan")
		}
		s.audit(a.ID, "revoke_form_link", c.Params("linkId"))
		return c.JSON(fiber.Map{"revoked": true})
	}
	if !d.Frozen {
		return fiber.NewError(409, "Terbitkan asesmen sebelum membuat tautan peserta")
	}
	var in struct {
		ExpiresAt *time.Time     `json:"expiresAt"`
		Prefill   map[string]any `json:"prefill"`
	}
	if c.BodyParser(&in) != nil {
		return fiber.NewError(400, "Masa berlaku tidak valid")
	}
	if in.ExpiresAt != nil && (!time.Now().Before(*in.ExpiresAt) || in.ExpiresAt.After(time.Now().AddDate(1, 0, 0))) {
		return fiber.NewError(400, "Masa berlaku harus di masa depan, maksimal satu tahun")
	}
	if len(in.Prefill) > 500 || len(marshalJSON(in.Prefill)) > 200000 {
		return fiber.NewError(400, "Isian awal terlalu besar")
	}
	var draft FormDraft
	if json.Unmarshal([]byte(d.ContentJSON), &draft) != nil {
		return fiber.NewError(500, "Dokumen tidak dapat dibaca")
	}
	for id, value := range in.Prefill {
		card, ok := draft.Cards[id]
		if !ok || card.Deleted || card.Type == "unggah_berkas" {
			return fiber.NewError(400, "Soal isian awal tidak tersedia atau tidak boleh berkas")
		}
		q := questionSnapshot{Type: card.Type, ConfigJSON: marshalJSON(card.Config)}
		if err := validateResponse(q, value, false); err != nil {
			return err
		}
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return err
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	link := FormAccessLink{DocumentID: d.ID, TokenHash: hash(token), ExpiresAt: in.ExpiresAt, PrefillJSON: marshalJSON(in.Prefill)}
	if err := s.db.Create(&link).Error; err != nil {
		return err
	}
	s.audit(a.ID, "create_form_link", link.ID)
	c.Set("Cache-Control", "no-store")
	return c.Status(201).JSON(fiber.Map{"link": link, "url": strings.TrimRight(s.cfg.PublicBaseURL, "/") + "/akses/" + token})
}

func (s *Server) materializePrefill(tx *gorm.DB, linkID string, assessment Assessment, attempt Attempt, items []AttemptItem) error {
	if linkID == "" {
		return nil
	}
	var link FormAccessLink
	if tx.First(&link, "id = ? AND revoked = false", linkID).Error != nil || link.ExpiresAt != nil && !time.Now().Before(*link.ExpiresAt) {
		return fiber.NewError(403, "Tautan isian awal tidak berlaku")
	}
	var doc FormDocument
	if tx.First(&doc, "id = ? AND resource_id = ? AND resource_type = 'assessment'", link.DocumentID, assessment.ID).Error != nil {
		return fiber.NewError(403, "Tautan bukan untuk asesmen ini")
	}
	var values map[string]any
	if json.Unmarshal([]byte(firstNonEmpty(link.PrefillJSON, "{}")), &values) != nil {
		return fiber.NewError(500, "Isian awal tidak dapat dibaca")
	}
	for _, item := range items {
		if value, ok := values[item.AssessmentItemID]; ok && hasValue(value) {
			var q questionSnapshot
			_ = json.Unmarshal([]byte(item.SnapshotJSON), &q)
			if q.Type == "unggah_berkas" {
				return fiber.NewError(400, "Berkas tidak boleh diisi awal")
			}
			if err := validateResponse(q, value, false); err != nil {
				return err
			}
			answer := Answer{AttemptID: attempt.ID, AttemptItemID: item.ID, ValueJSON: marshalJSON(value), Revision: 1}
			if err := tx.Create(&answer).Error; err != nil {
				return err
			}
			if err := tx.Create(&AttemptAnswerRevision{AttemptID: attempt.ID, AttemptItemID: item.ID, Source: "form_prefill", Revision: 1, ValueJSON: answer.ValueJSON}).Error; err != nil {
				return err
			}
		}
	}
	return tx.Create(&AuditLog{Action: "apply_form_prefill", Resource: attempt.ID, Detail: link.ID}).Error
}
func (s *Server) formResponseAcceptance(c *fiber.Ctx) error {
	a := currentAccount(c)
	d, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	if d.ResourceType != "assessment" || s.formRole(s.db, a, d) != "owner" {
		return fiber.NewError(403, "Hanya pemilik mengatur penerimaan peserta")
	}
	var in struct {
		Paused bool `json:"paused"`
	}
	if c.BodyParser(&in) != nil {
		return fiber.NewError(400, "Pengaturan tidak valid")
	}
	if err := s.db.Model(&Assessment{}).Where("id = ?", d.ResourceID).Update("responses_paused", in.Paused).Error; err != nil {
		return err
	}
	s.audit(a.ID, "change_form_acceptance", d.ID)
	return c.JSON(fiber.Map{"paused": in.Paused, "activeAttemptsUnchanged": true})
}

func (s *Server) formResultRelease(c *fiber.Ctx) error {
	a := currentAccount(c)
	doc, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	if doc.ResourceType != "assessment" {
		return fiber.NewError(400, "Paket bank tidak memiliki nilai peserta")
	}
	var row Assessment
	if err := s.db.First(&row, "id = ?", doc.ResourceID).Error; err != nil {
		return err
	}
	if c.Method() != "GET" {
		if s.formRole(s.db, a, doc) != "owner" {
			return fiber.NewError(403, "Hanya pemilik merilis nilai")
		}
		if !doc.Frozen || row.FormVersionID == "" {
			return fiber.NewError(409, "Asesmen belum diterbitkan")
		}
		now := time.Now().UTC()
		// Repeat release only when a newer response revision has been submitted.
		updated := s.db.Model(&Assessment{}).Where("id = ? AND (results_released_at IS NULL OR results_released_at < (SELECT MAX(submitted_at) FROM attempts WHERE assessment_id = ?))", row.ID, row.ID).Updates(map[string]any{"results_released_at": now, "results_released_by": a.ID})
		if updated.Error != nil {
			return updated.Error
		}
		if err := s.db.First(&row, "id = ?", row.ID).Error; err != nil {
			return err
		}
		if updated.RowsAffected > 0 {
			s.audit(a.ID, "release_form_results", doc.ID)
		}
	}
	return c.JSON(fiber.Map{"releasedAt": row.ResultsReleasedAt, "policy": row.ResultsPolicy, "showResult": row.ShowResult})
}
