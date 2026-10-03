package main

import (
	"fmt"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type questionPackageInput struct {
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Subject     string   `json:"subject"`
	QuestionIDs []string `json:"questionIds"`
	ClassIDs    []string `json:"classIds"`
	StudentIDs  []string `json:"studentIds"`
}

type questionPackageUpdateInput struct {
	Title       string    `json:"title"`
	Description string    `json:"description"`
	Subject     string    `json:"subject"`
	QuestionIDs *[]string `json:"questionIds"`
}

type questionPackageRecord struct {
	QuestionPackage
	QuestionCount   int      `json:"questionCount"`
	AssignmentCount int      `json:"assignmentCount"`
	ClassIDs        []string `json:"classIds"`
	StudentIDs      []string `json:"studentIds"`
}

type questionPackageDetail struct {
	QuestionPackage
	Questions   []Question          `json:"questions"`
	Assignments []PackageAssignment `json:"assignments"`
}

func normalizeQuestionPackageInput(input *questionPackageInput) error {
	input.Title = strings.TrimSpace(input.Title)
	input.Description = strings.TrimSpace(input.Description)
	input.Subject = strings.TrimSpace(input.Subject)
	if len([]rune(input.Title)) > 160 {
		return fiber.NewError(fiber.StatusBadRequest, "Judul paket maksimal 160 karakter")
	}
	if len([]rune(input.Description)) > 5000 {
		return fiber.NewError(fiber.StatusBadRequest, "Deskripsi paket maksimal 5.000 karakter")
	}
	if len([]rune(input.Subject)) > 120 {
		return fiber.NewError(fiber.StatusBadRequest, "Mata pelajaran maksimal 120 karakter")
	}
	var err error
	if input.QuestionIDs, err = normalizedUniqueIDs(input.QuestionIDs, 500, "Daftar soal"); err != nil {
		return err
	}
	if input.ClassIDs, err = normalizedUniqueIDs(input.ClassIDs, 200, "Daftar kelas"); err != nil {
		return err
	}
	if input.StudentIDs, err = normalizedUniqueIDs(input.StudentIDs, 2000, "Daftar siswa"); err != nil {
		return err
	}
	if len(input.ClassIDs) > 0 && len(input.StudentIDs) > 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Pilih penugasan berdasarkan kelas atau siswa tertentu, jangan keduanya sekaligus")
	}
	return nil
}

func normalizedUniqueIDs(values []string, maximum int, label string) ([]string, error) {
	if len(values) > maximum {
		return nil, fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("%s melebihi batas %d", label, maximum))
	}
	seen := make(map[string]struct{}, len(values))
	result := make([]string, 0, len(values))
	for _, raw := range values {
		value := strings.TrimSpace(raw)
		if value == "" {
			return nil, fiber.NewError(fiber.StatusBadRequest, label+" memuat ID kosong")
		}
		if _, exists := seen[value]; exists {
			return nil, fiber.NewError(fiber.StatusBadRequest, label+" memuat ID duplikat")
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result, nil
}

func (s *Server) listQuestionPackages(c *fiber.Ctx) error {
	account := currentAccount(c)
	query := s.db.Model(&QuestionPackage{})
	if account.Role == "guru" {
		query = query.Where("created_by = ?", account.ID)
	}
	status := strings.TrimSpace(c.Query("tab"))
	if status == "" || status == "all" {
		status = strings.TrimSpace(c.Query("status"))
	}
	if status != "" && status != "all" {
		if status != "draft" && status != "published" && status != "archived" {
			return fiber.NewError(fiber.StatusBadRequest, "Filter status paket tidak valid")
		}
		query = query.Where("status = ?", status)
	}
	if search := strings.TrimSpace(c.Query("search")); search != "" {
		query = query.Where("(strpos(lower(title), lower(?)) > 0 OR strpos(lower(description), lower(?)) > 0)", search, search)
	}
	if subject := strings.TrimSpace(c.Query("subject")); subject != "" {
		query = query.Where("lower(subject) = lower(?)", subject)
	}
	if classID := strings.TrimSpace(c.Query("classId")); classID != "" {
		studentsInClass := s.db.Model(&MasterPeserta{}).Select("id").Where("kelas_id = ?", classID)
		query = query.Where(`EXISTS (
			SELECT 1 FROM package_assignments pa WHERE pa.package_id = question_packages.id AND
			((pa.target_type = 'class' AND pa.class_id = ?) OR
			 (pa.target_type = 'student' AND pa.student_id IN (?)))
		)`, classID, studentsInClass)
	}
	if raw := strings.TrimSpace(c.Query("createdFrom")); raw != "" {
		date, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "Tanggal mulai filter tidak valid")
		}
		query = query.Where("created_at >= ?", date.UTC())
	}
	if raw := strings.TrimSpace(c.Query("createdTo")); raw != "" {
		date, err := time.Parse("2006-01-02", raw)
		if err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "Tanggal akhir filter tidak valid")
		}
		query = query.Where("created_at < ?", date.AddDate(0, 0, 1).UTC())
	}
	var packages []QuestionPackage
	if err := query.Order("created_at DESC, id DESC").Limit(1000).Find(&packages).Error; err != nil {
		return err
	}
	if len(packages) == 0 {
		return c.JSON([]questionPackageRecord{})
	}
	ids := make([]string, len(packages))
	for index := range packages {
		ids[index] = packages[index].ID
	}
	type groupedCount struct {
		PackageID string
		Count     int
	}
	var questionCounts, assignmentCounts []groupedCount
	if err := s.db.Model(&Question{}).Select("package_id AS package_id, COUNT(*) AS count").Where("package_id IN ? AND trashed_at IS NULL", ids).Group("package_id").Scan(&questionCounts).Error; err != nil {
		return err
	}
	if err := s.db.Model(&PackageAssignment{}).Select("package_id AS package_id, COUNT(*) AS count").Where("package_id IN ?", ids).Group("package_id").Scan(&assignmentCounts).Error; err != nil {
		return err
	}
	var assignments []PackageAssignment
	if err := s.db.Where("package_id IN ?", ids).Find(&assignments).Error; err != nil {
		return err
	}
	questionsByID := make(map[string]int, len(questionCounts))
	assignmentsByID := make(map[string]int, len(assignmentCounts))
	for _, item := range questionCounts {
		questionsByID[item.PackageID] = item.Count
	}
	for _, item := range assignmentCounts {
		assignmentsByID[item.PackageID] = item.Count
	}
	resultByID := make(map[string]int, len(packages))
	result := make([]questionPackageRecord, len(packages))
	for index, row := range packages {
		result[index] = questionPackageRecord{QuestionPackage: row, QuestionCount: questionsByID[row.ID], AssignmentCount: assignmentsByID[row.ID], ClassIDs: []string{}, StudentIDs: []string{}}
		resultByID[row.ID] = index
	}
	for _, assignment := range assignments {
		index, exists := resultByID[assignment.PackageID]
		if !exists {
			continue
		}
		if assignment.TargetType == "class" {
			result[index].ClassIDs = append(result[index].ClassIDs, assignment.TargetID)
		} else if assignment.TargetType == "student" {
			result[index].StudentIDs = append(result[index].StudentIDs, assignment.TargetID)
		}
	}
	return c.JSON(result)
}

func (s *Server) getQuestionPackage(c *fiber.Ctx) error {
	row, err := s.loadQuestionPackage(currentAccount(c), c.Params("id"))
	if err != nil {
		return err
	}
	return c.JSON(row)
}

func (s *Server) loadQuestionPackage(account CBTAccount, id string) (questionPackageDetail, error) {
	var row QuestionPackage
	if err := s.db.First(&row, "id = ?", id).Error; err != nil {
		return questionPackageDetail{}, fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
	}
	if account.Role == "guru" && row.OwnerID != account.ID {
		return questionPackageDetail{}, fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
	}
	var questions []Question
	if err := s.db.Where("package_id = ? AND trashed_at IS NULL", row.ID).Order("package_position, created_at, id").Find(&questions).Error; err != nil {
		return questionPackageDetail{}, err
	}
	var assignments []PackageAssignment
	if err := s.db.Where("package_id = ?", row.ID).Order("target_type, target_id").Find(&assignments).Error; err != nil {
		return questionPackageDetail{}, err
	}
	return questionPackageDetail{QuestionPackage: row, Questions: questions, Assignments: assignments}, nil
}

func (s *Server) createQuestionPackage(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(fiber.StatusForbidden, "Kepala sekolah hanya dapat melihat")
	}
	var input questionPackageInput
	if c.BodyParser(&input) != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Data paket soal tidak valid")
	}
	if err := normalizeQuestionPackageInput(&input); err != nil {
		return err
	}
	if input.Title == "" {
		input.Title = "Paket soal tanpa judul"
	}
	var created QuestionPackage
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		created = QuestionPackage{OwnerID: account.ID, Title: input.Title, Description: input.Description, Subject: input.Subject, Status: "draft"}
		if err := tx.Create(&created).Error; err != nil {
			return err
		}
		if err := s.replaceQuestionPackageQuestions(tx, account, created.ID, input.QuestionIDs); err != nil {
			return err
		}
		return replacePackageAssignments(tx, created.ID, input.ClassIDs, input.StudentIDs)
	}); err != nil {
		return err
	}
	s.audit(account.ID, "create_question_package", created.ID)
	return c.Status(fiber.StatusCreated).JSON(created)
}

func (s *Server) updateQuestionPackage(c *fiber.Ctx) error {
	account := currentAccount(c)
	var input questionPackageUpdateInput
	if c.BodyParser(&input) != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Data paket soal tidak valid")
	}
	input.Title = strings.TrimSpace(input.Title)
	input.Description = strings.TrimSpace(input.Description)
	input.Subject = strings.TrimSpace(input.Subject)
	if input.Title == "" || len([]rune(input.Title)) > 160 || len([]rune(input.Description)) > 5000 || len([]rune(input.Subject)) > 120 {
		return fiber.NewError(fiber.StatusBadRequest, "Judul paket wajib diisi; judul maksimal 160, deskripsi maksimal 5.000, dan mapel maksimal 120 karakter")
	}
	if input.QuestionIDs != nil {
		ids, err := normalizedUniqueIDs(*input.QuestionIDs, 500, "Daftar soal")
		if err != nil {
			return err
		}
		input.QuestionIDs = &ids
	}
	var updated QuestionPackage
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var row QuestionPackage
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
		}
		if !staffCanWrite(account, row.OwnerID) {
			return fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat mengubah paket soal ini")
		}
		if row.Status != "draft" {
			return fiber.NewError(fiber.StatusConflict, "Paket terbit atau arsip tidak dapat diedit. Duplikasi paket untuk membuat versi baru.")
		}
		row.Title, row.Description, row.Subject = input.Title, input.Description, input.Subject
		if input.QuestionIDs != nil {
			if err := s.replaceQuestionPackageQuestions(tx, account, row.ID, *input.QuestionIDs); err != nil {
				return err
			}
		}
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		updated = row
		return nil
	}); err != nil {
		return err
	}
	s.audit(account.ID, "update_question_package", updated.ID)
	return c.JSON(updated)
}

func (s *Server) replaceQuestionPackageQuestions(tx *gorm.DB, account CBTAccount, packageID string, ids []string) error {
	if len(ids) > 500 {
		return fiber.NewError(fiber.StatusBadRequest, "Paket maksimal berisi 500 soal")
	}
	if len(ids) > 0 {
		var rows []Question
		if err := tx.Where("id IN ?", ids).Find(&rows).Error; err != nil {
			return err
		}
		if len(rows) != len(ids) {
			return fiber.NewError(fiber.StatusBadRequest, "Salah satu soal tidak ditemukan")
		}
		for _, row := range rows {
			if !staffCanWrite(account, row.OwnerID) {
				return fiber.NewError(fiber.StatusForbidden, "Paket hanya dapat memakai soal yang menjadi kewenangan Anda")
			}
			if row.TrashedAt != nil || row.ArchivedAt != nil {
				return fiber.NewError(fiber.StatusConflict, "Pulihkan soal yang diarsipkan atau berada di Trash sebelum memasukkannya ke paket")
			}
			if row.PackageID != "" && row.PackageID != packageID {
				return fiber.NewError(fiber.StatusConflict, "Soal sudah menjadi bagian paket lain. Duplikasi soal terlebih dahulu agar paket asal tetap aman.")
			}
		}
	}
	if len(ids) == 0 {
		if err := tx.Model(&Question{}).Where("package_id = ?", packageID).Updates(map[string]any{"package_id": "", "package_position": 0}).Error; err != nil {
			return err
		}
	} else if err := tx.Model(&Question{}).Where("package_id = ? AND id NOT IN ?", packageID, ids).Updates(map[string]any{"package_id": "", "package_position": 0}).Error; err != nil {
		return err
	}
	for position, id := range ids {
		if err := tx.Model(&Question{}).Where("id = ?", id).Updates(map[string]any{"package_id": packageID, "package_position": position + 1}).Error; err != nil {
			return err
		}
	}
	return nil
}

func validatePackageTargets(tx *gorm.DB, classIDs, studentIDs []string) error {
	if len(classIDs) > 0 && len(studentIDs) > 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Pilih kelas atau siswa tertentu, jangan keduanya sekaligus")
	}
	if len(classIDs) > 0 {
		var count int64
		if err := tx.Model(&MasterKelas{}).Where("id IN ? AND active = ?", classIDs, true).Count(&count).Error; err != nil {
			return err
		}
		if count != int64(len(classIDs)) {
			return fiber.NewError(fiber.StatusBadRequest, "Satu atau beberapa kelas tidak aktif atau tidak ditemukan")
		}
	}
	if len(studentIDs) > 0 {
		var count int64
		if err := tx.Model(&MasterPeserta{}).Where("id IN ? AND active = ?", studentIDs, true).Count(&count).Error; err != nil {
			return err
		}
		if count != int64(len(studentIDs)) {
			return fiber.NewError(fiber.StatusBadRequest, "Satu atau beberapa siswa tidak aktif atau tidak ditemukan")
		}
	}
	return nil
}

func replacePackageAssignments(tx *gorm.DB, packageID string, classIDs, studentIDs []string) error {
	if err := validatePackageTargets(tx, classIDs, studentIDs); err != nil {
		return err
	}
	if err := tx.Where("package_id = ?", packageID).Delete(&PackageAssignment{}).Error; err != nil {
		return err
	}
	rows := make([]PackageAssignment, 0, len(classIDs)+len(studentIDs))
	for _, id := range classIDs {
		classID := id
		rows = append(rows, PackageAssignment{PackageID: packageID, TargetType: "class", TargetID: id, ClassID: &classID})
	}
	for _, id := range studentIDs {
		studentID := id
		rows = append(rows, PackageAssignment{PackageID: packageID, TargetType: "student", TargetID: id, StudentID: &studentID})
	}
	if len(rows) == 0 {
		return nil
	}
	return tx.Create(&rows).Error
}

func (s *Server) updateQuestionPackageAssignments(c *fiber.Ctx) error {
	account := currentAccount(c)
	var input struct {
		ClassIDs   []string `json:"classIds"`
		StudentIDs []string `json:"studentIds"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Penugasan paket tidak valid")
	}
	var err error
	if input.ClassIDs, err = normalizedUniqueIDs(input.ClassIDs, 200, "Daftar kelas"); err != nil {
		return err
	}
	if input.StudentIDs, err = normalizedUniqueIDs(input.StudentIDs, 2000, "Daftar siswa"); err != nil {
		return err
	}
	if len(input.ClassIDs) > 0 && len(input.StudentIDs) > 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Pilih penugasan berdasarkan kelas atau siswa tertentu, jangan keduanya sekaligus")
	}
	var row QuestionPackage
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat mengubah penugasan paket ini")
	}
	if row.Status == "archived" {
		return fiber.NewError(fiber.StatusConflict, "Pulihkan paket dari arsip sebelum mengubah penugasannya")
	}
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		return replacePackageAssignments(tx, row.ID, input.ClassIDs, input.StudentIDs)
	}); err != nil {
		return err
	}
	s.audit(account.ID, "assign_question_package", row.ID)
	updated, err := s.loadQuestionPackage(account, row.ID)
	if err != nil {
		return err
	}
	return c.JSON(updated)
}

func (s *Server) createQuestionInPackage(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(fiber.StatusForbidden, "Kepala sekolah hanya dapat melihat")
	}
	var input questionInput
	if c.BodyParser(&input) != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Data soal tidak valid")
	}
	if err := normalizeQuestionInput(&input); err != nil {
		return err
	}
	if input.Status == "published" {
		return fiber.NewError(fiber.StatusConflict, "Soal baru dalam paket harus disimpan sebagai draf")
	}
	if err := s.validateQuestionMediaOwner(account, input); err != nil {
		return err
	}
	if err := validateQuestionFolder(s.db, account, input.FolderID, ""); err != nil {
		return err
	}
	var created Question
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var pkg QuestionPackage
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&pkg, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
		}
		if !staffCanWrite(account, pkg.OwnerID) || pkg.Status != "draft" {
			return fiber.NewError(fiber.StatusForbidden, "Hanya pemilik paket draf yang dapat menambah soal")
		}
		var count int64
		if err := tx.Model(&Question{}).Where("package_id = ?", pkg.ID).Count(&count).Error; err != nil {
			return err
		}
		created = Question{OwnerID: account.ID, PackageID: pkg.ID, PackagePosition: int(count) + 1, FolderID: input.FolderID, Title: input.Title, Program: input.Program, Grade: input.Grade, Phase: input.Phase, Mode: input.Mode, Subject: input.Subject, Domain: input.Domain, Topic: input.Topic, Competency: input.Competency, CognitiveLevel: input.CognitiveLevel, Difficulty: input.Difficulty, EstimatedMinutes: input.EstimatedMinutes, Curriculum: input.Curriculum, Tags: input.Tags, Type: input.Type, Prompt: input.Prompt, Description: input.Description, StimulusJSON: input.StimulusJSON, ConfigJSON: input.ConfigJSON, AnswerJSON: input.AnswerJSON, RubricJSON: input.RubricJSON, InternalExplanation: input.InternalExplanation, Points: input.Points, Status: "draft", Revision: 1}
		return tx.Create(&created).Error
	}); err != nil {
		return err
	}
	s.audit(account.ID, "create_question_in_package", created.ID)
	return c.Status(fiber.StatusCreated).JSON(created)
}

func (s *Server) publishQuestionPackage(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row QuestionPackage
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat menerbitkan paket soal ini")
	}
	if row.Status != "draft" {
		return fiber.NewError(fiber.StatusConflict, "Hanya paket draf yang dapat diterbitkan")
	}
	if strings.TrimSpace(row.Title) == "" || strings.EqualFold(strings.TrimSpace(row.Title), "Paket soal tanpa judul") {
		return fiber.NewError(fiber.StatusBadRequest, "Beri judul paket sebelum menerbitkan")
	}
	var questions []Question
	if err := s.db.Where("package_id = ? AND trashed_at IS NULL AND archived_at IS NULL", row.ID).Order("package_position").Find(&questions).Error; err != nil {
		return err
	}
	if len(questions) == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Tambahkan minimal satu soal sebelum menerbitkan paket")
	}
	for index, question := range questions {
		snapshot := questionSnapshot{Type: question.Type, ConfigJSON: question.ConfigJSON, AnswerJSON: question.AnswerJSON, RubricJSON: question.RubricJSON, Points: question.Points, TemplatePlaceholder: question.TemplatePlaceholder}
		if question.TemplatePlaceholder || !validQuestionForPublish(snapshot) || question.Points <= 0 {
			return fiber.NewError(fiber.StatusBadRequest, fmt.Sprintf("Konfigurasi, kunci, rubrik, atau poin soal nomor %d belum lengkap", index+1))
		}
	}
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var current QuestionPackage
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&current, "id = ?", row.ID).Error; err != nil {
			return fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
		}
		if !staffCanWrite(account, current.OwnerID) || current.Status != "draft" {
			return fiber.NewError(fiber.StatusConflict, "Paket berubah. Muat ulang sebelum menerbitkan.")
		}
		for _, question := range questions {
			var source Question
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&source, "id = ? AND package_id = ?", question.ID, current.ID).Error; err != nil {
				return fiber.NewError(fiber.StatusConflict, "Daftar soal berubah saat penerbitan. Muat ulang paket.")
			}
			if source.Status == "published" {
				continue
			}
			if err := tx.Create(&QuestionVersion{QuestionID: source.ID, Revision: source.Revision, ChangedBy: account.ID, SnapshotJSON: questionSnapshotJSON(source)}).Error; err != nil {
				return err
			}
			source.Status = "published"
			source.Revision++
			if err := tx.Save(&source).Error; err != nil {
				return err
			}
		}
		current.Status = "published"
		return tx.Save(&current).Error
	}); err != nil {
		return err
	}
	s.audit(account.ID, "publish_question_package", row.ID)
	updated, err := s.loadQuestionPackage(account, row.ID)
	if err != nil {
		return err
	}
	return c.JSON(updated)
}

func (s *Server) archiveQuestionPackage(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row QuestionPackage
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat mengarsipkan paket soal ini")
	}
	if row.Status == "archived" {
		return fiber.NewError(fiber.StatusConflict, "Paket sudah diarsipkan")
	}
	row.ArchivedFromStatus = row.Status
	row.Status = "archived"
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "archive_question_package", row.ID)
	return c.JSON(row)
}

func (s *Server) unarchiveQuestionPackage(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row QuestionPackage
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "Paket soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat memulihkan paket soal ini")
	}
	if row.Status != "archived" {
		return fiber.NewError(fiber.StatusConflict, "Paket tidak berada di arsip")
	}
	row.Status = row.ArchivedFromStatus
	if row.Status != "published" {
		row.Status = "draft"
	}
	row.ArchivedFromStatus = ""
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "unarchive_question_package", row.ID)
	return c.JSON(row)
}

func (s *Server) duplicateQuestionPackage(c *fiber.Ctx) error {
	account := currentAccount(c)
	source, err := s.loadQuestionPackage(account, c.Params("id"))
	if err != nil {
		return err
	}
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(fiber.StatusForbidden, "Kepala sekolah hanya dapat melihat")
	}
	var created QuestionPackage
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		created = QuestionPackage{OwnerID: account.ID, Title: source.Title + " (salinan)", Description: source.Description, Subject: source.Subject, Status: "draft"}
		if len([]rune(created.Title)) > 160 {
			created.Title = string([]rune(source.Title)[:minInt(len([]rune(source.Title)), 149)]) + " (salinan)"
		}
		if err := tx.Create(&created).Error; err != nil {
			return err
		}
		for index, question := range source.Questions {
			copy := question
			copy.Base = Base{}
			copy.OwnerID = account.ID
			copy.Title = question.Title + " (salinan)"
			copy.PackageID = created.ID
			copy.PackagePosition = index + 1
			copy.Status = "draft"
			copy.Revision = 1
			copy.ArchivedAt = nil
			copy.ArchivedFromStatus = ""
			copy.TrashedAt = nil
			if len([]rune(copy.Title)) > 160 {
				copy.Title = string([]rune(question.Title)[:minInt(len([]rune(question.Title)), 149)]) + " (salinan)"
			}
			if err := tx.Create(&copy).Error; err != nil {
				return err
			}
		}
		return nil // assignments are intentionally not copied; they must be reviewed for the new draft.
	}); err != nil {
		return err
	}
	s.audit(account.ID, "duplicate_question_package", created.ID)
	updated, err := s.loadQuestionPackage(account, created.ID)
	if err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(updated)
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
