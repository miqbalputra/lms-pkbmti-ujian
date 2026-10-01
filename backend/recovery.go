package main

import (
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type recoveryAnswerInput struct {
	ItemID string          `json:"itemId"`
	Value  json.RawMessage `json:"value"`
}

type recoveryPayload struct {
	Answers []recoveryAnswerInput `json:"answers"`
}

func validateRecoveryPayload(raw []byte, itemIDs map[string]bool) ([]recoveryAnswerInput, error) {
	if len(raw) == 0 || len(raw) > 2*1024*1024 || !json.Valid(raw) {
		return nil, fiber.NewError(400, "Data pemulihan tidak valid atau terlalu besar")
	}
	var payload recoveryPayload
	if err := json.Unmarshal(raw, &payload); err != nil || len(payload.Answers) == 0 {
		return nil, fiber.NewError(400, "Data jawaban pemulihan kosong atau tidak valid")
	}
	seen := map[string]bool{}
	for _, answer := range payload.Answers {
		if answer.ItemID == "" || !itemIDs[answer.ItemID] || seen[answer.ItemID] || len(answer.Value) == 0 || !json.Valid(answer.Value) {
			return nil, fiber.NewError(400, "Data pemulihan memuat soal atau jawaban yang tidak valid")
		}
		seen[answer.ItemID] = true
	}
	return payload.Answers, nil
}

func (s *Server) submitLateRecovery(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ? AND student_id = ?", c.Params("id"), account.PesertaDidikID).Error; err != nil {
		return fiber.NewError(404, "Percobaan tidak ditemukan")
	}
	if attempt.DeadlineAt == nil || time.Now().Before(*attempt.DeadlineAt) {
		return fiber.NewError(409, "Pemulihan hanya tersedia setelah tenggat asesmen")
	}
	var body recoveryPayload
	if err := c.BodyParser(&body); err != nil {
		return fiber.NewError(400, "Data pemulihan tidak valid")
	}
	raw, err := json.Marshal(body)
	if err != nil {
		return fiber.NewError(400, "Data pemulihan tidak dapat diproses")
	}
	var items []AttemptItem
	if err := s.db.Where("attempt_id = ?", attempt.ID).Find(&items).Error; err != nil {
		return err
	}
	allowed := make(map[string]bool, len(items))
	for _, item := range items {
		allowed[item.ID] = true
	}
	if _, err := validateRecoveryPayload(raw, allowed); err != nil {
		return err
	}
	var recovery AttemptRecovery
	err = s.db.Transaction(func(tx *gorm.DB) error {
		var locked Attempt
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&locked, "id = ? AND student_id = ?", attempt.ID, account.PesertaDidikID).Error; err != nil {
			return fiber.NewError(404, "Percobaan tidak ditemukan")
		}
		if locked.DeadlineAt == nil || time.Now().Before(*locked.DeadlineAt) {
			return fiber.NewError(409, "Pemulihan hanya tersedia setelah tenggat asesmen")
		}
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("attempt_id = ?", locked.ID).First(&recovery).Error
		if errors.Is(err, gorm.ErrRecordNotFound) {
			recovery = AttemptRecovery{AttemptID: locked.ID, StudentID: locked.StudentID, PayloadJSON: string(raw), Status: "pending", SubmittedAt: time.Now()}
			return tx.Create(&recovery).Error
		}
		if err != nil {
			return err
		}
		if recovery.Status != "pending" {
			return fiber.NewError(409, "Pemulihan ini sudah ditinjau tutor")
		}
		recovery.PayloadJSON = string(raw)
		recovery.SubmittedAt = time.Now()
		return tx.Save(&recovery).Error
	})
	if err != nil {
		return err
	}
	s.audit(account.ID, "submit_late_answer_recovery", recovery.ID)
	return c.Status(202).JSON(fiber.Map{"id": recovery.ID, "status": recovery.Status, "message": "Jawaban dikirim untuk ditinjau tutor dan belum mengubah nilai."})
}

func (s *Server) listAttemptRecoveries(c *fiber.Ctx) error {
	account := currentAccount(c)
	var rows []AttemptRecovery
	if err := s.db.Order("submitted_at desc").Limit(500).Find(&rows).Error; err != nil {
		return err
	}
	output := make([]fiber.Map, 0, len(rows))
	for _, row := range rows {
		var attempt Attempt
		var assessment Assessment
		if s.db.First(&attempt, "id = ?", row.AttemptID).Error != nil || s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error != nil {
			continue
		}
		if !staffCanWrite(account, assessment.OwnerID) && account.Role != "kepala_sekolah" {
			continue
		}
		var student MasterPeserta
		_ = s.db.First(&student, "id = ?", attempt.StudentID).Error
		output = append(output, fiber.Map{"id": row.ID, "attemptId": row.AttemptID, "assessmentId": assessment.ID, "assessmentTitle": assessment.Title, "studentId": row.StudentID, "studentName": student.Nama, "classId": attempt.ClassIDAtAttempt, "status": row.Status, "submittedAt": row.SubmittedAt, "reviewedAt": row.ReviewedAt, "comment": row.Comment, "answers": json.RawMessage(row.PayloadJSON)})
	}
	return c.JSON(output)
}

func (s *Server) reviewAttemptRecovery(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah memiliki akses baca-saja")
	}
	var input struct {
		Decision string `json:"decision"`
		Comment  string `json:"comment"`
	}
	if c.BodyParser(&input) != nil || (input.Decision != "approve" && input.Decision != "reject") {
		return fiber.NewError(400, "Keputusan peninjauan tidak valid")
	}
	var recovery AttemptRecovery
	if err := s.db.First(&recovery, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Data pemulihan tidak ditemukan")
	}
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ?", recovery.AttemptID).Error; err != nil {
		return fiber.NewError(404, "Percobaan tidak ditemukan")
	}
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, assessment.OwnerID) {
		return fiber.NewError(403, "Anda tidak berwenang meninjau asesmen ini")
	}
	var updatedAttempt Attempt
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&recovery, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(404, "Data pemulihan tidak ditemukan")
		}
		if recovery.Status != "pending" {
			return fiber.NewError(409, "Data pemulihan sudah ditinjau")
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&updatedAttempt, "id = ?", recovery.AttemptID).Error; err != nil {
			return fiber.NewError(404, "Percobaan tidak ditemukan")
		}
		now := time.Now()
		if input.Decision == "approve" {
			if updatedAttempt.Status == "started" {
				if updatedAttempt.DeadlineAt == nil || now.Before(*updatedAttempt.DeadlineAt) {
					return fiber.NewError(409, "Percobaan belum melewati tenggat")
				}
				if err := finalizeAttemptTx(tx, &updatedAttempt, now); err != nil {
					return err
				}
			}
			if updatedAttempt.Status != "completed" && updatedAttempt.Status != "pending_grade" {
				return fiber.NewError(409, "Status percobaan tidak dapat menerima pemulihan")
			}
			var attemptItems []AttemptItem
			if err := tx.Where("attempt_id = ?", updatedAttempt.ID).Find(&attemptItems).Error; err != nil {
				return err
			}
			allowed := make(map[string]bool, len(attemptItems))
			for _, item := range attemptItems {
				allowed[item.ID] = true
			}
			answers, err := validateRecoveryPayload([]byte(recovery.PayloadJSON), allowed)
			if err != nil {
				return err
			}
			itemByID := make(map[string]AttemptItem, len(attemptItems))
			for _, item := range attemptItems {
				itemByID[item.ID] = item
			}
			for _, recovered := range answers {
				item := itemByID[recovered.ItemID]
				var answer Answer
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&answer, "attempt_id = ? AND attempt_item_id = ?", updatedAttempt.ID, item.ID).Error; err != nil {
					return err
				}
				value := strings.TrimSpace(string(recovered.Value))
				if answer.ValueJSON == value {
					continue
				}
				var snapshot questionSnapshot
				_ = json.Unmarshal([]byte(item.SnapshotJSON), &snapshot)
				correct, score, manual := grade(snapshot, value, item.Weight)
				if err := tx.Create(&AttemptAnswerRevision{AttemptID: updatedAttempt.ID, AttemptItemID: item.ID, ActorID: account.ID, Source: "approved_late_recovery", Revision: answer.Revision + 1, ValueJSON: value}).Error; err != nil {
					return err
				}
				answer.ValueJSON, answer.Correct, answer.AutoScore = value, correct, score
				answer.ManualScore, answer.Comment, answer.Revision = nil, "", answer.Revision+1
				if err := tx.Save(&answer).Error; err != nil {
					return err
				}
				_ = manual
			}
			var saved []Answer
			if err := tx.Where("attempt_id = ?", updatedAttempt.ID).Find(&saved).Error; err != nil {
				return err
			}
			updatedAttempt.Score, updatedAttempt.NeedsManual = 0, false
			for _, answer := range saved {
				if answer.ManualScore != nil {
					updatedAttempt.Score += *answer.ManualScore
				} else {
					updatedAttempt.Score += answer.AutoScore
				}
				if answer.Correct == nil && answer.ManualScore == nil {
					updatedAttempt.NeedsManual = true
				}
			}
			if updatedAttempt.NeedsManual {
				updatedAttempt.Status = "pending_grade"
			} else {
				updatedAttempt.Status = "completed"
			}
			if err := tx.Save(&updatedAttempt).Error; err != nil {
				return err
			}
			recovery.Status = "approved"
		} else {
			recovery.Status = "rejected"
		}
		recovery.Comment = strings.TrimSpace(input.Comment)
		recovery.ReviewedBy, recovery.ReviewedAt = account.ID, &now
		return tx.Save(&recovery).Error
	})
	if err != nil {
		return err
	}
	s.audit(account.ID, "review_late_answer_recovery_"+input.Decision, recovery.ID)
	if input.Decision == "approve" {
		_ = s.enqueueAttemptResult(updatedAttempt.ID)
	}
	return c.JSON(fiber.Map{"id": recovery.ID, "status": recovery.Status, "attemptStatus": updatedAttempt.Status, "score": updatedAttempt.Score})
}
