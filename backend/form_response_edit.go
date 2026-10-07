package main

import (
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"time"
)

// A before-edit ledger preserves the submitted answers and marking. Reopening
// never creates a new attempt, resets its seed, or extends its deadline.
type FormResponseRevision struct {
	Base
	AttemptID    string `gorm:"uniqueIndex:response_edit_request;index" json:"attemptId"`
	RequestID    string `gorm:"uniqueIndex:response_edit_request" json:"-"`
	ActorID      string `json:"actorId"`
	SnapshotJSON string `gorm:"type:text" json:"-"`
}

func canReopenFormResponse(tx *gorm.DB, attempt Attempt) bool {
	if attempt.FormVersionID == "" || (attempt.Status != "completed" && attempt.Status != "pending_grade" && attempt.Status != "submitted") || attempt.DeadlineAt == nil || !time.Now().Before(*attempt.DeadlineAt) {
		return false
	}
	var version FormVersion
	var draft FormDraft
	var assessment Assessment
	return tx.First(&version, "id = ?", attempt.FormVersionID).Error == nil && json.Unmarshal([]byte(version.ContentJSON), &draft) == nil && draft.Settings.AllowResponseEdit && tx.First(&assessment, "id = ?", attempt.AssessmentID).Error == nil && assessment.Status == "published" && !assessment.ResponsesPaused && (assessment.EndsAt == nil || time.Now().Before(*assessment.EndsAt))
}

func (s *Server) reopenFormResponse(c *fiber.Ctx) error {
	account := currentAccount(c)
	var input struct {
		RequestID string `json:"requestId"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Permintaan tidak valid")
	}
	if _, err := uuid.Parse(input.RequestID); err != nil {
		return fiber.NewError(400, "ID permintaan wajib unik")
	}
	var attempt Attempt
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&attempt, "id = ? AND student_id = ?", c.Params("id"), account.PesertaDidikID).Error != nil {
			return fiber.NewError(404, "Percobaan tidak ditemukan")
		}
		var count int64
		if err := tx.Model(&FormResponseRevision{}).Where("attempt_id = ? AND request_id = ?", attempt.ID, input.RequestID).Count(&count).Error; err != nil {
			return err
		}
		if count > 0 {
			return nil
		}
		if !canReopenFormResponse(tx, attempt) {
			return fiber.NewError(403, "Pengeditan respons tidak diizinkan atau tenggat telah berakhir")
		}
		var answers []Answer
		if err := tx.Where("attempt_id = ?", attempt.ID).Find(&answers).Error; err != nil {
			return err
		}
		if err := tx.Create(&FormResponseRevision{AttemptID: attempt.ID, RequestID: input.RequestID, ActorID: account.ID, SnapshotJSON: marshalJSON(map[string]any{"attempt": attempt, "answers": answers})}).Error; err != nil {
			return err
		}
		attempt.Status = "started"
		attempt.SubmittedAt = nil
		if err := tx.Save(&attempt).Error; err != nil {
			return err
		}
		return tx.Create(&AuditLog{ActorID: account.ID, Action: "reopen_form_response", Resource: attempt.ID, Detail: "Tenggat, seed, dan jawaban sebelumnya dipertahankan"}).Error
	})
	if err != nil {
		return err
	}
	return c.JSON(studentAttemptSummary(attempt))
}
