package main

import (
	"strings"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

type questionFolderInput struct {
	Name     string `json:"name"`
	Subject  string `json:"subject"`
	ParentID string `json:"parentId"`
}

func normalizeFolderInput(input *questionFolderInput) error {
	input.Name = strings.TrimSpace(input.Name)
	input.Subject = strings.TrimSpace(input.Subject)
	input.ParentID = strings.TrimSpace(input.ParentID)
	if input.Name == "" || len([]rune(input.Name)) > 100 {
		return fiber.NewError(400, "Nama folder wajib diisi (maksimal 100 karakter)")
	}
	if len([]rune(input.Subject)) > 120 {
		return fiber.NewError(400, "Nama mapel maksimal 120 karakter")
	}
	return nil
}

func (s *Server) listQuestionFolders(c *fiber.Ctx) error {
	account := currentAccount(c)
	query := s.db.Model(&QuestionFolder{})
	if account.Role == "guru" {
		query = query.Where("owner_id = ?", account.ID)
	}
	var rows []QuestionFolder
	if err := query.Order("subject ASC, name ASC").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}

func (s *Server) createQuestionFolder(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	var input questionFolderInput
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Data folder tidak valid")
	}
	if err := normalizeFolderInput(&input); err != nil {
		return err
	}
	if err := validateFolderParent(s.db, account, account.ID, "", input.ParentID); err != nil {
		return err
	}
	var count int64
	if err := s.db.Model(&QuestionFolder{}).Where("owner_id = ? AND parent_id = ? AND lower(name) = ?", account.ID, input.ParentID, strings.ToLower(input.Name)).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return fiber.NewError(409, "Folder dengan nama yang sama sudah ada di lokasi ini")
	}
	folder := QuestionFolder{OwnerID: account.ID, Name: input.Name, Subject: input.Subject, ParentID: input.ParentID}
	if err := s.db.Create(&folder).Error; err != nil {
		return err
	}
	s.audit(account.ID, "create_question_folder", folder.ID)
	return c.Status(201).JSON(folder)
}

func (s *Server) updateQuestionFolder(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	var input questionFolderInput
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Data folder tidak valid")
	}
	if err := normalizeFolderInput(&input); err != nil {
		return err
	}
	var folder QuestionFolder
	if err := s.db.First(&folder, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Folder tidak ditemukan")
	}
	if !staffCanWrite(account, folder.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat mengubah folder ini")
	}
	if err := validateFolderParent(s.db, account, folder.OwnerID, folder.ID, input.ParentID); err != nil {
		return err
	}
	var count int64
	if err := s.db.Model(&QuestionFolder{}).Where("owner_id = ? AND id <> ? AND parent_id = ? AND lower(name) = ?", folder.OwnerID, folder.ID, input.ParentID, strings.ToLower(input.Name)).Count(&count).Error; err != nil {
		return err
	}
	if count > 0 {
		return fiber.NewError(409, "Folder dengan nama yang sama sudah ada di lokasi ini")
	}
	folder.Name, folder.Subject, folder.ParentID = input.Name, input.Subject, input.ParentID
	if err := s.db.Save(&folder).Error; err != nil {
		return err
	}
	s.audit(account.ID, "update_question_folder", folder.ID)
	return c.JSON(folder)
}

func (s *Server) deleteQuestionFolder(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	var folder QuestionFolder
	if err := s.db.First(&folder, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Folder tidak ditemukan")
	}
	if !staffCanWrite(account, folder.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat menghapus folder ini")
	}
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		// Keep questions and child folders; only detach their folder metadata.
		if err := tx.Model(&Question{}).Where("folder_id = ?", folder.ID).Update("folder_id", "").Error; err != nil {
			return err
		}
		if err := tx.Model(&QuestionFolder{}).Where("parent_id = ?", folder.ID).Update("parent_id", "").Error; err != nil {
			return err
		}
		return tx.Delete(&QuestionFolder{}, "id = ?", folder.ID).Error
	}); err != nil {
		return err
	}
	s.audit(account.ID, "delete_question_folder_keep_questions", folder.ID)
	return c.SendStatus(204)
}

func (s *Server) moveQuestionFolder(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	var input struct {
		Revision int    `json:"revision"`
		FolderID string `json:"folderId"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Pilihan folder tidak valid")
	}
	input.FolderID = strings.TrimSpace(input.FolderID)
	var updated Question
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var question Question
		if err := tx.First(&question, "id = ? AND archived_at IS NULL AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
			return fiber.NewError(404, "Soal tidak ditemukan")
		}
		if !staffCanWrite(account, question.OwnerID) {
			return fiber.NewError(403, "Anda tidak dapat memindahkan soal ini")
		}
		if question.Status != "draft" {
			return fiber.NewError(409, "Soal terbit perlu dibuatkan revisi sebelum dipindahkan")
		}
		if input.Revision > 0 && input.Revision != question.Revision {
			return fiber.NewError(409, "Soal telah berubah di sesi lain. Muat ulang sebelum memindahkannya.")
		}
		if err := validateQuestionFolder(tx, account, input.FolderID, question.OwnerID); err != nil {
			return err
		}
		if err := tx.Create(&QuestionVersion{QuestionID: question.ID, Revision: question.Revision, ChangedBy: account.ID, SnapshotJSON: questionSnapshotJSON(question)}).Error; err != nil {
			return err
		}
		question.FolderID = input.FolderID
		question.Revision++
		if err := tx.Save(&question).Error; err != nil {
			return err
		}
		updated = question
		return nil
	}); err != nil {
		return err
	}
	s.audit(account.ID, "move_question_folder", updated.ID)
	return c.JSON(updated)
}

func validateQuestionFolder(db *gorm.DB, account CBTAccount, folderID, questionOwnerID string) error {
	folderID = strings.TrimSpace(folderID)
	if folderID == "" {
		return nil
	}
	var folder QuestionFolder
	if err := db.First(&folder, "id = ?", folderID).Error; err != nil {
		return fiber.NewError(400, "Folder soal tidak ditemukan")
	}
	if account.Role == "guru" && (folder.OwnerID != account.ID || folder.OwnerID != questionOwnerID) {
		return fiber.NewError(403, "Guru hanya dapat menggunakan folder miliknya")
	}
	if account.Role != "admin" && account.Role != "guru" {
		return fiber.NewError(403, "Akun ini tidak dapat mengatur folder soal")
	}
	return nil
}

func validateFolderParent(db *gorm.DB, account CBTAccount, ownerID, currentID, parentID string) error {
	parentID = strings.TrimSpace(parentID)
	if parentID == "" {
		return nil
	}
	seen := map[string]bool{}
	for id := parentID; id != ""; {
		if id == currentID || seen[id] {
			return fiber.NewError(400, "Folder tidak boleh menjadi induk bagi dirinya sendiri atau membentuk lingkaran")
		}
		seen[id] = true
		var folder QuestionFolder
		if err := db.First(&folder, "id = ?", id).Error; err != nil {
			return fiber.NewError(400, "Folder induk tidak ditemukan")
		}
		if !staffCanWrite(account, folder.OwnerID) || folder.OwnerID != ownerID {
			return fiber.NewError(403, "Folder induk harus berada pada pustaka yang sama")
		}
		id = folder.ParentID
	}
	return nil
}

func normalizeQuestionTags(raw string) string {
	parts := strings.Split(raw, ",")
	seen := map[string]bool{}
	clean := make([]string, 0, len(parts))
	for _, part := range parts {
		tag := strings.Join(strings.Fields(strings.TrimSpace(part)), " ")
		if tag == "" || len([]rune(tag)) > 40 {
			continue
		}
		key := strings.ToLower(tag)
		if seen[key] {
			continue
		}
		seen[key] = true
		clean = append(clean, tag)
		if len(clean) == 20 {
			break
		}
	}
	return strings.Join(clean, ", ")
}

func questionHasTag(raw, requested string) bool {
	wanted := strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(requested)), " "))
	if wanted == "" {
		return true
	}
	for _, tag := range strings.Split(raw, ",") {
		if strings.ToLower(strings.Join(strings.Fields(strings.TrimSpace(tag)), " ")) == wanted {
			return true
		}
	}
	return false
}
