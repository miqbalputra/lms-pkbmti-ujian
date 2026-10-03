package main

import (
	"encoding/json"
	"strings"

	"github.com/gofiber/fiber/v2"
)

func editableQuestionStatus(status string) error {
	if status == "published" {
		return fiber.NewError(fiber.StatusConflict, "Soal terbit tidak dapat diedit langsung. Buat revisi agar snapshot ujian tetap aman.")
	}
	if status != "draft" {
		return fiber.NewError(fiber.StatusConflict, "Hanya soal draf yang dapat diedit.")
	}
	return nil
}

func draftQuestionRevision(source Question) Question {
	source.Base = Base{}
	// A revision of a package question starts loose in the reusable bank. The
	// published package remains an immutable grouping until the revision is
	// explicitly selected into a new draft package.
	source.PackageID = ""
	source.PackagePosition = 0
	source.Package = nil
	source.Title = strings.TrimSpace(source.Title) + " (revisi)"
	source.Status = "draft"
	source.Revision = 1
	source.ArchivedAt = nil
	source.ArchivedFromStatus = ""
	source.TrashedAt = nil
	return source
}

func applyQuestionInput(row *Question, input questionInput) {
	row.Title, row.FolderID, row.Program, row.Grade, row.Phase = input.Title, input.FolderID, input.Program, input.Grade, input.Phase
	row.Mode, row.Subject, row.Domain, row.Topic = input.Mode, input.Subject, input.Domain, input.Topic
	row.Competency, row.CognitiveLevel, row.Difficulty, row.Tags = input.Competency, input.CognitiveLevel, input.Difficulty, input.Tags
	row.EstimatedMinutes, row.Curriculum = input.EstimatedMinutes, input.Curriculum
	row.Type, row.Prompt, row.Description = input.Type, input.Prompt, input.Description
	row.StimulusJSON, row.ConfigJSON, row.AnswerJSON = input.StimulusJSON, input.ConfigJSON, input.AnswerJSON
	row.RubricJSON, row.InternalExplanation, row.Points = input.RubricJSON, input.InternalExplanation, input.Points
	row.Status = input.Status
	row.TemplatePlaceholder = false
}

func questionSnapshotJSON(row Question) string {
	data, _ := json.Marshal(row)
	return string(data)
}

func restoreQuestionContent(current, previous Question) Question {
	current.Title, current.FolderID, current.Program, current.Grade, current.Phase = previous.Title, previous.FolderID, previous.Program, previous.Grade, previous.Phase
	current.Mode, current.Subject, current.Domain, current.Topic = previous.Mode, previous.Subject, previous.Domain, previous.Topic
	current.Competency, current.CognitiveLevel, current.Difficulty, current.Tags = previous.Competency, previous.CognitiveLevel, previous.Difficulty, previous.Tags
	current.EstimatedMinutes, current.Curriculum = previous.EstimatedMinutes, previous.Curriculum
	current.Type, current.Prompt, current.Description = previous.Type, previous.Prompt, previous.Description
	current.StimulusJSON, current.ConfigJSON, current.AnswerJSON = previous.StimulusJSON, previous.ConfigJSON, previous.AnswerJSON
	current.RubricJSON, current.InternalExplanation, current.Points = previous.RubricJSON, previous.InternalExplanation, previous.Points
	return current
}
