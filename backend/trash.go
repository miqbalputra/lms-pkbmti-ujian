package main

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

type trashSnapshot struct {
	Questions   []Question   `json:"questions"`
	Assessments []Assessment `json:"assessments"`
}

type archiveSnapshot struct {
	Questions   []Question   `json:"questions"`
	Assessments []Assessment `json:"assessments"`
}

func (s *Server) listTrash(c *fiber.Ctx) error {
	account := currentAccount(c)
	questionQuery := s.db.Where("trashed_at IS NOT NULL")
	assessmentQuery := s.db.Where("trashed_at IS NOT NULL")
	if account.Role == "guru" {
		questionQuery = questionQuery.Where("owner_id = ?", account.ID)
		assessmentQuery = assessmentQuery.Where("owner_id = ?", account.ID)
	}
	var result trashSnapshot
	if err := questionQuery.Order("trashed_at desc").Find(&result.Questions).Error; err != nil {
		return err
	}
	if err := assessmentQuery.Order("trashed_at desc").Find(&result.Assessments).Error; err != nil {
		return err
	}
	return c.JSON(result)
}

func (s *Server) listArchive(c *fiber.Ctx) error {
	account := currentAccount(c)
	questionQuery := s.db.Where("archived_at IS NOT NULL AND trashed_at IS NULL")
	assessmentQuery := s.db.Where("status = ? AND trashed_at IS NULL", "archived")
	if account.Role == "guru" {
		questionQuery = questionQuery.Where("owner_id = ?", account.ID)
		assessmentQuery = assessmentQuery.Where("owner_id = ?", account.ID)
	}
	var result archiveSnapshot
	if err := questionQuery.Order("archived_at desc").Find(&result.Questions).Error; err != nil {
		return err
	}
	if err := assessmentQuery.Order("archived_at desc").Find(&result.Assessments).Error; err != nil {
		return err
	}
	return c.JSON(result)
}

func (s *Server) trashQuestion(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Question
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat memindahkan soal ini ke Trash")
	}
	if row.TrashedAt != nil {
		return fiber.NewError(409, "Soal sudah berada di Trash")
	}
	now := time.Now().UTC()
	if err := s.db.Model(&row).Update("trashed_at", now).Error; err != nil {
		return err
	}
	s.audit(account.ID, "trash_question", row.ID)
	return c.SendStatus(204)
}

func (s *Server) restoreQuestion(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Question
	if err := s.db.First(&row, "id = ? AND trashed_at IS NOT NULL", c.Params("id")).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return fiber.NewError(404, "Soal di Trash tidak ditemukan")
		}
		return err
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat memulihkan soal ini")
	}
	if err := s.db.Model(&row).Update("trashed_at", nil).Error; err != nil {
		return err
	}
	s.audit(account.ID, "restore_question", row.ID)
	return c.SendStatus(204)
}

func (s *Server) unarchiveQuestion(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Question
	if err := s.db.First(&row, "id = ? AND archived_at IS NOT NULL AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return fiber.NewError(404, "Soal arsip tidak ditemukan")
		}
		return err
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat memulihkan arsip soal ini")
	}
	row.ArchivedAt = nil
	row.Status = row.ArchivedFromStatus
	if row.Status == "" || row.Status == "archived" {
		row.Status = "draft"
	}
	row.ArchivedFromStatus = ""
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "unarchive_question", row.ID)
	return c.SendStatus(204)
}

func (s *Server) archiveAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ? AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Paket asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat mengarsipkan paket ini")
	}
	if row.Status == "archived" {
		return fiber.NewError(409, "Paket sudah diarsipkan")
	}
	row.ArchivedFromStatus = row.Status
	row.Status = "archived"
	now := time.Now().UTC()
	row.ArchivedAt = &now
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "archive_assessment", row.ID)
	return c.JSON(row)
}

func (s *Server) unarchiveAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ? AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Paket asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat memulihkan arsip ini")
	}
	if row.Status != "archived" {
		return fiber.NewError(409, "Paket ini bukan arsip")
	}
	row.Status = row.ArchivedFromStatus
	if row.Status == "" || row.Status == "archived" {
		row.Status = "draft"
	}
	row.ArchivedFromStatus = ""
	row.ArchivedAt = nil
	row.Revision++
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "unarchive_assessment", row.ID)
	return c.JSON(row)
}

func (s *Server) trashAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ? AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Paket asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat memindahkan paket ini ke Trash")
	}
	var activeAttempts int64
	if err := s.db.Model(&Attempt{}).Where("assessment_id = ? AND status = ?", row.ID, "started").Count(&activeAttempts).Error; err != nil {
		return err
	}
	if activeAttempts > 0 {
		return fiber.NewError(409, "Paket masih memiliki siswa yang sedang mengerjakan. Arsipkan setelah percobaan aktif selesai.")
	}
	now := time.Now().UTC()
	if err := s.db.Model(&row).Update("trashed_at", now).Error; err != nil {
		return err
	}
	s.audit(account.ID, "trash_assessment", row.ID)
	return c.SendStatus(204)
}

func (s *Server) restoreAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ? AND trashed_at IS NOT NULL", c.Params("id")).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return fiber.NewError(404, "Paket asesmen di Trash tidak ditemukan")
		}
		return err
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat memulihkan paket ini")
	}
	if err := s.db.Model(&row).Update("trashed_at", nil).Error; err != nil {
		return err
	}
	s.audit(account.ID, "restore_assessment", row.ID)
	return c.SendStatus(204)
}
