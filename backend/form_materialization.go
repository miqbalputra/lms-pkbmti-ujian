package main

import (
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"strings"
)

// Sources are cloned once per stable card. Deleted cards leave their draft in
// the bank; every materialized question, order and assignment commits together.
func (s *Server) materializeForm(tx *gorm.DB, a CBTAccount, d *FormDocument, content FormDraft) error {
	if err := s.validateFormHeader(tx, *d, content.Settings, false); err != nil {
		return err
	}
	bindings := map[string]string{}
	_ = json.Unmarshal([]byte(d.MaterializedJSON), &bindings)
	if err := validatePackageTargets(tx, content.Settings.ClassIDs, content.Settings.StudentIDs); err != nil {
		return err
	}
	var owner CBTAccount
	if err := tx.First(&owner, "id = ?", d.OwnerID).Error; err != nil {
		return err
	}
	targetClasses := append([]string{}, content.Settings.ClassIDs...)
	for _, id := range content.Settings.StudentIDs {
		var student MasterPeserta
		if err := tx.First(&student, "id = ?", id).Error; err != nil {
			return err
		}
		targetClasses = append(targetClasses, student.KelasID)
	}
	for _, classID := range targetClasses {
		var class MasterKelas
		if tx.First(&class, "id = ?", classID).Error != nil {
			return fiber.NewError(400, "Kelas tidak ditemukan")
		}
		if a.Role != "admin" && owner.Role == "guru" && class.WaliKelasID != "" && class.WaliKelasID != owner.TutorID {
			return fiber.NewError(403, "Kelas berada di luar kewenangan tutor")
		}
	}
	cards := orderedCards(content)
	questionIDs := []string{}
	for i, card := range cards {
		var q Question
		id := bindings[card.ID]
		if id != "" {
			if err := tx.First(&q, "id = ?", id).Error; err != nil {
				return err
			}
		} else {
			q = Question{OwnerID: d.OwnerID, Status: "draft"}
			if card.SourceID != "" {
				var source Question
				if tx.First(&source, "id = ? AND trashed_at IS NULL", card.SourceID).Error != nil {
					return fiber.NewError(400, "Soal sumber tidak ditemukan")
				}
				if !staffCanWrite(a, source.OwnerID) && source.OwnerID != d.OwnerID {
					return fiber.NewError(403, "Soal sumber bukan milik tutor")
				}
				q.Program, q.Phase, q.Mode, q.Domain, q.Topic, q.Curriculum, q.Tags = source.Program, source.Phase, source.Mode, source.Domain, source.Topic, source.Curriculum, source.Tags
			}
		}
		config := map[string]any{}
		for k, v := range card.Config {
			config[k] = v
		}
		if len(card.PromptRich) > 0 {
			config["promptRich"] = card.PromptRich
		}
		config["required"], config["sectionId"], config["stimulusGroupId"] = card.Required, card.SectionID, card.StimulusGroupID
		stimulus := "[]"
		if group, ok := content.Stimuli[card.StimulusGroupID]; ok {
			stimulus = marshalJSON(group.Blocks)
		}
		if err := s.validateFormMedia(tx, *d, stimulus, marshalJSON(config), false); err != nil {
			return err
		}
		q.Title, q.Prompt, q.Type, q.Description, q.Points, q.ConfigJSON, q.StimulusJSON, q.InternalExplanation, q.Subject, q.Grade, q.Competency = firstNonEmpty(strings.TrimSpace(card.Prompt), "Pertanyaan tanpa judul"), card.Prompt, card.Type, card.Description, card.Points, marshalJSON(config), stimulus, card.Explanation, card.Subject, card.Grade, card.Competency
		q.AnswerJSON = "null"
		q.RubricJSON = "[]"
		if rubrik, ok := config["rubrik"]; ok {
			q.RubricJSON = marshalJSON(rubrik)
		}
		q.Status = "draft"
		q.Revision++
		q.TemplatePlaceholder = false
		if d.ResourceType == "package" {
			q.PackageID, q.PackagePosition = d.ResourceID, i+1
		}
		questionStore := tx
		if d.ResourceType != "package" {
			questionStore = tx.Omit("PackageID", "Package")
		}
		if err := questionStore.Save(&q).Error; err != nil {
			return err
		}
		bindings[card.ID] = q.ID
		questionIDs = append(questionIDs, q.ID)
	}
	if d.ResourceType == "package" {
		if err := tx.Model(&QuestionPackage{}).Where("id = ? AND status = 'draft'", d.ResourceID).Updates(map[string]any{"title": firstNonEmpty(content.Title, "Paket tanpa judul"), "description": content.Description, "subject": content.Settings.SubjectID}).Error; err != nil {
			return err
		}
		if err := tx.Model(&Question{}).Where("package_id = ? AND id NOT IN ?", d.ResourceID, append(questionIDs, "__none__")).Updates(map[string]any{"package_id": nil, "package_position": 0}).Error; err != nil {
			return err
		}
		if err := replacePackageAssignments(tx, d.ResourceID, content.Settings.ClassIDs, content.Settings.StudentIDs); err != nil {
			return err
		}
	} else {
		var row Assessment
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ?", d.ResourceID).Error; err != nil {
			return err
		}
		if row.Status != "draft" {
			return fiber.NewError(409, "Versi terbit tidak dapat diubah")
		}
		settings := content.Settings
		row.Title, row.Description, row.Kind, row.SubjectID, row.Instructions = firstNonEmpty(content.Title, "Paket tanpa judul"), content.Description, settings.Kind, settings.SubjectID, settings.Instructions
		row.ClassID = ""
		if len(settings.ClassIDs) > 0 {
			row.ClassID = settings.ClassIDs[0]
		} else if len(settings.StudentIDs) > 0 {
			var student MasterPeserta
			_ = tx.First(&student, "id = ?", settings.StudentIDs[0]).Error
			row.ClassID = student.KelasID
		}
		row.DurationMinute, row.MaxAttempts, row.PassScore, row.StartsAt, row.EndsAt = settings.DurationMinute, settings.MaxAttempts, settings.PassScore, settings.StartsAt, settings.EndsAt
		row.Randomize, row.RandomizeOptions, row.ShowResult, row.ShowReview, row.ResultsPolicy, row.ProgressBar, row.ConfirmationMessage = settings.Randomize, settings.RandomizeOptions, settings.ShowResult, settings.ShowReview, settings.ResultsPolicy, settings.ProgressBar, settings.ConfirmationMessage
		row.ThemeJSON = marshalJSON(map[string]any{"color": settings.ThemeColor, "font": settings.Font})
		row.SectionsJSON = marshalJSON(content.Sections)
		row.Revision++
		if err := s.setAssessmentAccessCode(&row, &settings.AccessCode); err != nil {
			return err
		}
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		if err := tx.Where("assessment_id = ?", row.ID).Delete(&AssessmentItem{}).Error; err != nil {
			return err
		}
		for i, id := range questionIDs {
			var q Question
			if err := tx.First(&q, "id = ?", id).Error; err != nil {
				return err
			}
			if err := tx.Create(&AssessmentItem{Base: Base{ID: cards[i].ID}, AssessmentID: row.ID, QuestionID: id, Position: i + 1, Weight: q.Points, SnapshotJSON: questionSnapshotJSON(q)}).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("assessment_id = ?", row.ID).Delete(&AssessmentAssignment{}).Error; err != nil {
			return err
		}
		for _, id := range settings.StudentIDs {
			if err := tx.Create(&AssessmentAssignment{AssessmentID: row.ID, StudentID: id}).Error; err != nil {
				return err
			}
		}
		if err := tx.Where("assessment_id = ?", row.ID).Delete(&AssessmentClassTarget{}).Error; err != nil {
			return err
		}
		for _, id := range settings.ClassIDs {
			if err := tx.Create(&AssessmentClassTarget{AssessmentID: row.ID, ClassID: id}).Error; err != nil {
				return err
			}
		}
	}
	d.MaterializedJSON = marshalJSON(bindings)
	return nil
}
func (s *Server) publishForm(c *fiber.Ctx) error {
	a := currentAccount(c)
	_, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	var in struct {
		Revision int `json:"revision"`
	}
	if c.BodyParser(&in) != nil {
		return fiber.NewError(400, "Versi draf diperlukan")
	}
	// The collaboration host freezes writes and flushes the CRDT before calling
	// publishFormDocument. A direct HTTP publish cannot prove pending edits absent.
	return fiber.NewError(409, "Terbitkan melalui editor setelah semua kolaborator tersinkron")
}
func (s *Server) publishFormDocument(a CBTAccount, d FormDocument, revision int) (FormVersion, error) {
	var version FormVersion
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&d, "id = ?", d.ID).Error; err != nil {
			return err
		}
		if s.formRole(tx, a, d) != "owner" {
			return fiber.NewError(403, "Hanya pemilik dapat menerbitkan")
		}
		if d.Frozen || d.Revision != revision {
			return fiber.NewError(409, "Sinkronkan semua perubahan sebelum menerbitkan")
		}
		var content FormDraft
		if json.Unmarshal([]byte(d.ContentJSON), &content) != nil {
			return fiber.NewError(400, "Dokumen tidak valid")
		}
		if err := validateForm(content, true); err != nil {
			return err
		}
		if err := s.validateFormHeader(tx, d, content.Settings, true); err != nil {
			return err
		}
		for _, card := range orderedCards(content) {
			stimulus := "[]"
			if group, ok := content.Stimuli[card.StimulusGroupID]; ok {
				stimulus = marshalJSON(group.Blocks)
			}
			if err := s.validateFormMedia(tx, d, stimulus, marshalJSON(card.Config), true); err != nil {
				return err
			}
		}
		if d.ResourceType == "assessment" {
			settings := content.Settings
			if !settings.AcceptResponses || settings.DurationMinute < 1 || settings.DurationMinute > 1440 || settings.MaxAttempts < 1 || settings.MaxAttempts > 20 || (settings.Kind != "ujian_online" && settings.Kind != "simulasi") || strings.TrimSpace(settings.AccessCode) == "" || (len(settings.ClassIDs) == 0 && len(settings.StudentIDs) == 0) {
				return fiber.NewError(400, "Lengkapi kode, peserta, durasi, dan batas respons")
			}
			if settings.StartsAt != nil && settings.EndsAt != nil && !settings.StartsAt.Before(*settings.EndsAt) {
				return fiber.NewError(400, "Jadwal tidak valid")
			}
		}
		if err := s.materializeForm(tx, a, &d, content); err != nil {
			return err
		}
		version = FormVersion{DocumentID: d.ID, Revision: d.Revision, ContentJSON: d.ContentJSON, Checksum: hash(d.ContentJSON), PublishedBy: a.ID}
		if err := tx.Create(&version).Error; err != nil {
			return err
		}
		if d.ResourceType == "assessment" {
			var row Assessment
			if err := tx.First(&row, "id = ?", d.ResourceID).Error; err != nil {
				return err
			}
			row.Status = "published"
			row.FormVersionID = version.ID
			row.Revision++
			if err := s.validatePublishedSchedule(tx, row); err != nil {
				return err
			}
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
		} else {
			if err := tx.Model(&QuestionPackage{}).Where("id = ?", d.ResourceID).Update("status", "published").Error; err != nil {
				return err
			}
		}
		bindings := map[string]string{}
		_ = json.Unmarshal([]byte(d.MaterializedJSON), &bindings)
		for _, card := range orderedCards(content) {
			if err := tx.Model(&Question{}).Where("id = ?", bindings[card.ID]).Update("status", "published").Error; err != nil {
				return err
			}
		}
		d.Frozen = true
		if err := tx.Save(&d).Error; err != nil {
			return err
		}
		return tx.Create(&AuditLog{ActorID: a.ID, Action: "publish_form_version", Resource: version.ID}).Error
	})
	if err != nil {
		return version, err
	}
	return version, nil
}
