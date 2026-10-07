package main

import (
	"errors"
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// reopenPublishedDocumentTx creates a new editable draft generation while
// leaving every FormVersion immutable. IndexedDB from before cancellation is
// invalidated so a stale browser cannot overwrite the published snapshot.
func reopenPublishedDocumentTx(tx *gorm.DB, account CBTAccount, resourceType, resourceID string) error {
	var doc FormDocument
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&doc, "resource_type = ? AND resource_id = ?", resourceType, resourceID).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil
		}
		return err
	}
	if !staffCanWrite(account, doc.OwnerID) || !doc.Frozen {
		return fiber.NewError(fiber.StatusConflict, "Status dokumen kolaboratif tidak cocok dengan status terbit. Muat ulang dan periksa dokumen.")
	}
	doc.Frozen = false
	doc.Revision++
	doc.SyncEpoch++
	return tx.Save(&doc).Error
}

func unpublishQuestionTx(tx *gorm.DB, account CBTAccount, id string) (Question, error) {
	var row Question
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ?", id).Error; err != nil {
		return row, fiber.NewError(fiber.StatusNotFound, "Soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return row, fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat membatalkan penerbitan soal ini")
	}
	if row.Status != "published" || row.ArchivedAt != nil || row.TrashedAt != nil {
		return row, fiber.NewError(fiber.StatusConflict, "Hanya soal terbit yang masih aktif dapat dibatalkan penerbitannya")
	}
	if row.PackageID != "" {
		return row, fiber.NewError(fiber.StatusConflict, "Soal ini bagian dari paket. Batalkan penerbitan dari halaman paket agar seluruh isinya tetap konsisten.")
	}
	if err := tx.Create(&QuestionVersion{QuestionID: row.ID, Revision: row.Revision, ChangedBy: account.ID, SnapshotJSON: questionSnapshotJSON(row)}).Error; err != nil {
		return row, err
	}
	row.Status = "draft"
	row.Revision++
	if err := tx.Save(&row).Error; err != nil {
		return row, err
	}
	if err := tx.Create(&AuditLog{ActorID: account.ID, Action: "unpublish_question", Resource: row.ID}).Error; err != nil {
		return row, err
	}
	return row, nil
}

func (s *Server) unpublishQuestion(c *fiber.Ctx) error {
	account := currentAccount(c)
	var updated Question
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var err error
		updated, err = unpublishQuestionTx(tx, account, c.Params("id"))
		return err
	}); err != nil {
		return err
	}
	return c.JSON(updated)
}

func unpublishQuestionPackageTx(tx *gorm.DB, account CBTAccount, id string) (QuestionPackage, error) {
	var row QuestionPackage
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ?", id).Error; err != nil {
		return row, fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return row, fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat membatalkan penerbitan paket soal ini")
	}
	if row.Status != "published" {
		return row, fiber.NewError(fiber.StatusConflict, "Hanya paket soal terbit yang dapat dibatalkan penerbitannya")
	}
	if err := reopenPublishedDocumentTx(tx, account, "package", row.ID); err != nil {
		return row, err
	}
	var questions []Question
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("package_id = ? AND status = ? AND archived_at IS NULL AND trashed_at IS NULL", row.ID, "published").Find(&questions).Error; err != nil {
		return row, err
	}
	for i := range questions {
		question := &questions[i]
		if err := tx.Create(&QuestionVersion{QuestionID: question.ID, Revision: question.Revision, ChangedBy: account.ID, SnapshotJSON: questionSnapshotJSON(*question)}).Error; err != nil {
			return row, err
		}
		question.Status = "draft"
		question.Revision++
		if err := tx.Save(question).Error; err != nil {
			return row, err
		}
		if err := tx.Create(&AuditLog{ActorID: account.ID, Action: "unpublish_question_source", Resource: question.ID}).Error; err != nil {
			return row, err
		}
	}
	row.Status = "draft"
	if err := tx.Save(&row).Error; err != nil {
		return row, err
	}
	if err := tx.Create(&AuditLog{ActorID: account.ID, Action: "unpublish_question_package", Resource: row.ID}).Error; err != nil {
		return row, err
	}
	return row, nil
}

func (s *Server) unpublishQuestionPackage(c *fiber.Ctx) error {
	account := currentAccount(c)
	var updated QuestionPackage
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var err error
		updated, err = unpublishQuestionPackageTx(tx, account, c.Params("id"))
		return err
	}); err != nil {
		return err
	}
	detail, err := s.loadQuestionPackage(account, updated.ID)
	if err != nil {
		return err
	}
	return c.JSON(detail)
}

func unpublishAssessmentTx(tx *gorm.DB, account CBTAccount, id string) (Assessment, error) {
	var row Assessment
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ?", id).Error; err != nil {
		return row, fiber.NewError(fiber.StatusNotFound, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return row, fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat membatalkan penerbitan asesmen ini")
	}
	if row.Status != "published" || row.TrashedAt != nil {
		return row, fiber.NewError(fiber.StatusConflict, "Hanya asesmen terbit yang dapat dibatalkan penerbitannya")
	}
	var active int64
	if err := tx.Model(&Attempt{}).Where("assessment_id = ? AND status = ? AND (deadline_at IS NULL OR deadline_at > ?)", row.ID, "started", time.Now()).Count(&active).Error; err != nil {
		return row, err
	}
	if active > 0 {
		return row, fiber.NewError(fiber.StatusConflict, "Masih ada siswa yang sedang mengerjakan. Jeda peserta baru dan tunggu percobaan aktif selesai sebelum membatalkan penerbitan.")
	}
	if err := reopenPublishedDocumentTx(tx, account, "assessment", row.ID); err != nil {
		return row, err
	}
	if err := tx.Model(&FormAccessLink{}).Where("document_id IN (SELECT id FROM form_documents WHERE resource_type = ? AND resource_id = ?)", "assessment", row.ID).Update("revoked", true).Error; err != nil {
		return row, err
	}
	row.Status = "draft"
	row.Revision++
	if err := tx.Save(&row).Error; err != nil {
		return row, err
	}
	if err := tx.Create(&AuditLog{ActorID: account.ID, Action: "unpublish_assessment", Resource: row.ID}).Error; err != nil {
		return row, err
	}
	return row, nil
}

func (s *Server) unpublishAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var updated Assessment
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var err error
		updated, err = unpublishAssessmentTx(tx, account, c.Params("id"))
		return err
	}); err != nil {
		return err
	}
	return c.JSON(updated)
}

func (s *Server) unpublishFormResource(c *fiber.Ctx) error {
	account := currentAccount(c)
	kind, id := c.Params("kind"), c.Params("id")
	doc, err := s.loadForm(account, kind, id)
	if err != nil {
		return err
	}
	if !doc.Frozen || s.formRole(s.db, account, doc) != "owner" {
		return fiber.NewError(fiber.StatusConflict, "Hanya pemilik dapat membatalkan penerbitan dokumen yang sudah terbit")
	}
	if kind != "package" && kind != "assessment" {
		return fiber.NewError(fiber.StatusBadRequest, "Jenis dokumen tidak didukung")
	}
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if kind == "package" {
			_, err := unpublishQuestionPackageTx(tx, account, id)
			return err
		}
		_, err := unpublishAssessmentTx(tx, account, id)
		return err
	}); err != nil {
		return err
	}
	return c.JSON(fiber.Map{"unpublished": true, "id": id, "kind": kind, "status": "draft"})
}
