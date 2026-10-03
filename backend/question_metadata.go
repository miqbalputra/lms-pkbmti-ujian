package main

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func defaultEstimatedMinutes(questionType, prompt string) int {
	minutes := 2
	switch questionType {
	case "uraian", "paragraf", "unggah_berkas":
		minutes = 5
	case "susun_urutan", "menjodohkan", "kisi_pg", "kisi_checkbox":
		minutes = 3
	}
	if len([]rune(strings.TrimSpace(prompt))) > 400 {
		minutes++
	}
	return minutes
}

func fillMissingQuestionMetadata(question *Question) bool {
	changed := false
	if strings.TrimSpace(question.Difficulty) == "" {
		question.Difficulty = "sedang"
		changed = true
	}
	if question.EstimatedMinutes <= 0 {
		question.EstimatedMinutes = defaultEstimatedMinutes(question.Type, question.Prompt)
		changed = true
	}
	if strings.TrimSpace(question.Curriculum) == "" {
		question.Curriculum = "Belum dipetakan"
		changed = true
	}
	return changed
}

func (s *Server) fillQuestionMetadataDefaults(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	updated := 0
	var skippedPublished int64
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		query := tx.Model(&Question{}).Where("status = ? AND archived_at IS NULL AND trashed_at IS NULL", "draft")
		if account.Role == "guru" {
			query = query.Where("owner_id = ?", account.ID)
		}
		var rows []Question
		if err := query.Clauses(clause.Locking{Strength: "UPDATE"}).Find(&rows).Error; err != nil {
			return err
		}
		for index := range rows {
			if fillMissingQuestionMetadata(&rows[index]) {
				if err := tx.Create(&QuestionVersion{QuestionID: rows[index].ID, Revision: rows[index].Revision, ChangedBy: account.ID, SnapshotJSON: questionSnapshotJSON(rows[index])}).Error; err != nil {
					return err
				}
				rows[index].Revision++
				if err := tx.Save(&rows[index]).Error; err != nil {
					return err
				}
				updated++
			}
		}
		published := tx.Model(&Question{}).Where("status = ? AND archived_at IS NULL AND trashed_at IS NULL AND (COALESCE(difficulty, '') = '' OR estimated_minutes <= 0 OR COALESCE(curriculum, '') = '')", "published")
		if account.Role == "guru" {
			published = published.Where("owner_id = ?", account.ID)
		}
		return published.Count(&skippedPublished).Error
	}); err != nil {
		return err
	}
	if updated > 0 {
		s.audit(account.ID, "fill_question_metadata_defaults", "question_bank")
	}
	return c.JSON(fiber.Map{
		"updatedCount":           updated,
		"publishedNeedsRevision": skippedPublished,
		"message":                "Metadata bawaan hanya mengisi bagian yang kosong pada soal draf. Soal terbit tidak diubah.",
	})
}
