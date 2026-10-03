package main

import (
	"encoding/json"
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type questionVersionView struct {
	ID        string    `json:"id"`
	Revision  int       `json:"revision"`
	ChangedBy string    `json:"changedBy"`
	CreatedAt time.Time `json:"createdAt"`
}

func (s *Server) questionHistory(c *fiber.Ctx) error {
	account := currentAccount(c)
	var question Question
	if err := s.db.First(&question, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Soal tidak ditemukan")
	}
	if !staffCanWrite(account, question.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Anda tidak dapat melihat riwayat soal ini")
	}
	var versions []QuestionVersion
	if err := s.db.Where("question_id = ?", question.ID).Order("revision desc").Limit(100).Find(&versions).Error; err != nil {
		return err
	}
	result := make([]questionVersionView, 0, len(versions))
	for _, version := range versions {
		result = append(result, questionVersionView{ID: version.ID, Revision: version.Revision, ChangedBy: version.ChangedBy, CreatedAt: version.CreatedAt})
	}
	return c.JSON(fiber.Map{"currentRevision": question.Revision, "versions": result})
}

func (s *Server) restoreQuestionVersion(c *fiber.Ctx) error {
	account := currentAccount(c)
	var input struct {
		Revision int `json:"revision"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Permintaan pemulihan versi tidak valid")
	}
	var restored Question
	err := s.db.Transaction(func(tx *gorm.DB) error {
		var current Question
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&current, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(404, "Soal tidak ditemukan")
		}
		if !staffCanWrite(account, current.OwnerID) {
			return fiber.NewError(403, "Anda tidak dapat memulihkan soal ini")
		}
		if current.Status != "draft" || current.ArchivedAt != nil || current.TrashedAt != nil {
			return fiber.NewError(409, "Hanya draf aktif yang dapat dipulihkan. Buat revisi terlebih dahulu untuk soal terbit.")
		}
		if input.Revision > 0 && input.Revision != current.Revision {
			return fiber.NewError(409, "Soal berubah di sesi lain. Muat ulang riwayat sebelum memulihkan versi.")
		}
		var version QuestionVersion
		if err := tx.First(&version, "id = ? AND question_id = ?", c.Params("versionId"), current.ID).Error; err != nil {
			return fiber.NewError(404, "Versi soal tidak ditemukan")
		}
		var previous Question
		if err := json.Unmarshal([]byte(version.SnapshotJSON), &previous); err != nil || previous.ID != current.ID {
			return fiber.NewError(409, "Snapshot versi soal tidak valid")
		}
		if err := tx.Create(&QuestionVersion{QuestionID: current.ID, Revision: current.Revision, ChangedBy: account.ID, SnapshotJSON: questionSnapshotJSON(current)}).Error; err != nil {
			return err
		}
		current = restoreQuestionContent(current, previous)
		current.Revision++
		if err := tx.Save(&current).Error; err != nil {
			return err
		}
		restored = current
		return nil
	})
	if err != nil {
		return err
	}
	s.audit(account.ID, "restore_question_version", restored.ID)
	return c.JSON(restored)
}
