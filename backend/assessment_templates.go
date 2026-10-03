package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

type assessmentTemplate struct {
	ID                  string `json:"id"`
	Title               string `json:"title"`
	Description         string `json:"description"`
	Kind                string `json:"kind"`
	DurationMinute      int    `json:"durationMinute"`
	QuestionCount       int    `json:"questionCount"`
	MultipleChoiceCount int    `json:"multipleChoiceCount"`
	EssayCount          int    `json:"essayCount"`
}

var assessmentTemplates = []assessmentTemplate{
	{ID: "semester-40-pg-5-esai", Title: "Ujian Semester", Description: "40 pilihan ganda + 5 esai · 90 menit", Kind: "ujian_online", DurationMinute: 90, QuestionCount: 45, MultipleChoiceCount: 40, EssayCount: 5},
	{ID: "tryout-20-pg", Title: "Try-out", Description: "20 pilihan ganda · 60 menit", Kind: "ujian_online", DurationMinute: 60, QuestionCount: 20, MultipleChoiceCount: 20},
	{ID: "kuis-10-pg", Title: "Kuis", Description: "10 pilihan ganda · 30 menit", Kind: "ujian_online", DurationMinute: 30, QuestionCount: 10, MultipleChoiceCount: 10},
}

func assessmentTemplateByID(id string) (assessmentTemplate, bool) {
	for _, template := range assessmentTemplates {
		if template.ID == id {
			return template, true
		}
	}
	return assessmentTemplate{}, false
}

func templateQuestion(template assessmentTemplate, ownerID string, position int) Question {
	typeQuestion := "pg_tunggal"
	points := float64(1)
	config := map[string]any{
		"choices":    []map[string]string{{"id": "pilihan-a", "text": "Pilihan A (ubah)"}, {"id": "pilihan-b", "text": "Pilihan B (ubah)"}},
		"correctIds": []string{},
	}
	answer := "[]"
	rubric := "[]"
	if position > template.MultipleChoiceCount {
		typeQuestion = "uraian"
		points = 10
		config = map[string]any{"rubrik": []any{}, "textMinLength": 0, "textMaxLength": 5000}
	}
	configJSON, _ := json.Marshal(config)
	return Question{
		OwnerID:             ownerID,
		Title:               fmt.Sprintf("Contoh soal %d — ganti sebelum digunakan", position),
		Program:             "Paket A/B/C",
		Type:                typeQuestion,
		Prompt:              fmt.Sprintf("Tulis pertanyaan %s ke-%d di sini.", map[bool]string{true: "uraian", false: "pilihan ganda"}[typeQuestion == "uraian"], position),
		Description:         "Soal contoh dari template. Ganti dengan materi dan pertanyaan yang sesuai sebelum asesmen diterbitkan.",
		ConfigJSON:          string(configJSON),
		AnswerJSON:          answer,
		RubricJSON:          rubric,
		Points:              points,
		Difficulty:          "sedang",
		EstimatedMinutes:    defaultEstimatedMinutes(typeQuestion, fmt.Sprintf("Tulis pertanyaan ke-%d di sini.", position)),
		Curriculum:          "Belum dipetakan",
		Status:              "draft",
		TemplatePlaceholder: true,
		Revision:            1,
	}
}

func (s *Server) listAssessmentTemplates(c *fiber.Ctx) error {
	return c.JSON(assessmentTemplates)
}

func (s *Server) createAssessmentTemplateDraft(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(fiber.StatusForbidden, "Kepala sekolah hanya dapat melihat asesmen")
	}
	template, ok := assessmentTemplateByID(c.Params("templateId"))
	if !ok {
		return fiber.NewError(fiber.StatusNotFound, "Template asesmen tidak ditemukan")
	}
	var input struct {
		Kind      string `json:"kind"`
		ClassID   string `json:"classId"`
		SubjectID string `json:"subjectId"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Pengaturan awal template tidak valid")
	}
	if input.Kind == "" {
		input.Kind = template.Kind
	}
	if input.Kind != "ujian_online" && input.Kind != "simulasi" {
		return fiber.NewError(fiber.StatusBadRequest, "Jenis asesmen tidak valid")
	}
	assessment := Assessment{
		OwnerID: account.ID, Kind: input.Kind, Title: "Draf — " + template.Title,
		Description: template.Description, ClassID: strings.TrimSpace(input.ClassID), SubjectID: strings.TrimSpace(input.SubjectID),
		Status: "draft", DurationMinute: template.DurationMinute, MaxAttempts: 1, ResultsPolicy: "after_review",
		ProgressBar: true, ConfirmationMessage: "Jawabanmu sudah terkirim. Terima kasih.", Revision: 1,
	}
	createdCount := 0
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if assessment.ClassID != "" {
			var class MasterKelas
			if err := tx.First(&class, "id = ? AND active = ?", assessment.ClassID, true).Error; err != nil {
				return fiber.NewError(fiber.StatusBadRequest, "Kelas asesmen tidak tersedia atau tidak aktif")
			}
		}
		if err := tx.Create(&assessment).Error; err != nil {
			return err
		}
		for position := 1; position <= template.QuestionCount; position++ {
			question := templateQuestion(template, account.ID, position)
			if err := tx.Create(&question).Error; err != nil {
				return err
			}
			snapshot, err := json.Marshal(questionSnapshot{
				ID: question.ID, Title: question.Title, Program: question.Program, Type: question.Type, Prompt: question.Prompt,
				Description: question.Description, ConfigJSON: question.ConfigJSON, AnswerJSON: question.AnswerJSON,
				RubricJSON: question.RubricJSON, Points: question.Points, Difficulty: question.Difficulty, EstimatedMinutes: question.EstimatedMinutes, Curriculum: question.Curriculum, TemplatePlaceholder: true,
			})
			if err != nil {
				return err
			}
			if err := tx.Create(&AssessmentItem{AssessmentID: assessment.ID, QuestionID: question.ID, Position: position, Weight: question.Points, SnapshotJSON: string(snapshot)}).Error; err != nil {
				return err
			}
			createdCount++
		}
		return tx.Create(&AuditLog{ActorID: account.ID, Action: "create_assessment_from_template", Resource: assessment.ID, Detail: fmt.Sprintf("template=%s;questions=%d", template.ID, createdCount)}).Error
	}); err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"assessment": assessment, "template": template, "questionCount": createdCount})
}

func questionFromSnapshot(snapshot questionSnapshot, ownerID string) Question {
	return Question{
		OwnerID: ownerID, FolderID: snapshot.FolderID, Title: snapshot.Title, Program: snapshot.Program, Grade: snapshot.Grade, Phase: snapshot.Phase,
		Mode: snapshot.Mode, Subject: snapshot.Subject, Domain: snapshot.Domain, Topic: snapshot.Topic,
		Competency: snapshot.Competency, CognitiveLevel: snapshot.CognitiveLevel, Difficulty: snapshot.Difficulty, EstimatedMinutes: snapshot.EstimatedMinutes, Curriculum: snapshot.Curriculum, Tags: snapshot.Tags,
		Type: snapshot.Type, Prompt: snapshot.Prompt, Description: snapshot.Description, StimulusJSON: snapshot.StimulusJSON,
		ConfigJSON: snapshot.ConfigJSON, AnswerJSON: snapshot.AnswerJSON, RubricJSON: snapshot.RubricJSON,
		InternalExplanation: snapshot.InternalExplanation, Points: snapshot.Points, Status: "draft", Revision: 1,
		TemplatePlaceholder: snapshot.TemplatePlaceholder,
	}
}

func (s *Server) duplicateAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(fiber.StatusForbidden, "Kepala sekolah hanya dapat melihat asesmen")
	}
	var source Assessment
	if err := s.db.First(&source, "id = ? AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, source.OwnerID) {
		return fiber.NewError(fiber.StatusForbidden, "Anda tidak dapat menduplikasi asesmen ini")
	}
	var duplicate Assessment
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var items []AssessmentItem
		if err := tx.Where("assessment_id = ?", source.ID).Order("position").Find(&items).Error; err != nil {
			return err
		}
		duplicate = source
		duplicate.Base = Base{}
		duplicate.OwnerID = account.ID
		duplicate.Title = "Salinan draf — " + strings.TrimSpace(source.Title)
		if strings.TrimSpace(source.Title) == "" {
			duplicate.Title = "Salinan draf asesmen"
		}
		duplicate.Status = "draft"
		duplicate.ClassID = ""
		duplicate.AccessCodeHash = ""
		duplicate.AccessCodeCiphertext = ""
		duplicate.StartsAt = nil
		duplicate.EndsAt = nil
		duplicate.ArchivedAt = nil
		duplicate.ArchivedFromStatus = ""
		duplicate.TrashedAt = nil
		duplicate.Revision = 1
		if err := tx.Create(&duplicate).Error; err != nil {
			return err
		}
		for index, item := range items {
			var snapshot questionSnapshot
			if err := json.Unmarshal([]byte(item.SnapshotJSON), &snapshot); err != nil {
				return fiber.NewError(fiber.StatusConflict, "Snapshot soal tidak dapat dibaca; paket asli tetap utuh dan tidak diduplikasi")
			}
			question := questionFromSnapshot(snapshot, account.ID)
			if err := tx.Create(&question).Error; err != nil {
				return err
			}
			snapshot.ID = question.ID
			snapshotJSON, err := json.Marshal(snapshot)
			if err != nil {
				return err
			}
			if err := tx.Create(&AssessmentItem{AssessmentID: duplicate.ID, QuestionID: question.ID, Position: index + 1, Weight: item.Weight, SnapshotJSON: string(snapshotJSON)}).Error; err != nil {
				return err
			}
		}
		return tx.Create(&AuditLog{ActorID: account.ID, Action: "duplicate_assessment", Resource: duplicate.ID, Detail: fmt.Sprintf("source=%s;items=%d", source.ID, len(items))}).Error
	}); err != nil {
		return err
	}
	return c.Status(fiber.StatusCreated).JSON(fiber.Map{"assessment": duplicate})
}

func assessmentTemplateQuestionRows(template assessmentTemplate, ownerID string) []Question {
	rows := make([]Question, template.QuestionCount)
	for index := range rows {
		rows[index] = templateQuestion(template, ownerID, index+1)
	}
	return rows
}
