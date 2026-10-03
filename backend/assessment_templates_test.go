package main

import (
	"encoding/json"
	"testing"
)

func TestAssessmentTemplatesCreateExpectedDraftQuestionMix(t *testing.T) {
	want := map[string]struct {
		count, multipleChoice, essay, duration int
	}{
		"semester-40-pg-5-esai": {45, 40, 5, 90},
		"tryout-20-pg":          {20, 20, 0, 60},
		"kuis-10-pg":            {10, 10, 0, 30},
	}
	if len(assessmentTemplates) != len(want) {
		t.Fatalf("expected %d ready-to-use templates, got %d", len(want), len(assessmentTemplates))
	}
	for _, template := range assessmentTemplates {
		expected, ok := want[template.ID]
		if !ok {
			t.Fatalf("unexpected template ID %q", template.ID)
		}
		if template.QuestionCount != expected.count || template.MultipleChoiceCount != expected.multipleChoice || template.EssayCount != expected.essay || template.DurationMinute != expected.duration {
			t.Errorf("template %s = %#v, want count/pg/essay/duration %d/%d/%d/%d", template.ID, template, expected.count, expected.multipleChoice, expected.essay, expected.duration)
		}
		questions := assessmentTemplateQuestionRows(template, "owner-1")
		if len(questions) != expected.count {
			t.Fatalf("template %s generated %d questions; want %d", template.ID, len(questions), expected.count)
		}
		for index, question := range questions {
			wantType := "pg_tunggal"
			wantPoints := float64(1)
			if index >= expected.multipleChoice {
				wantType, wantPoints = "uraian", 10
			}
			if question.Type != wantType || question.Points != wantPoints || question.Status != "draft" || !question.TemplatePlaceholder || question.OwnerID != "owner-1" {
				t.Errorf("template %s question %d has unsafe/incorrect defaults: %#v", template.ID, index+1, question)
			}
			if !validateQuestionConfig(question.Type, question.ConfigJSON) {
				t.Errorf("template %s question %d has invalid editor configuration %q", template.ID, index+1, question.ConfigJSON)
			}
			var snapshot questionSnapshot
			if err := json.Unmarshal([]byte(questionSnapshotJSON(question)), &snapshot); err != nil {
				t.Fatalf("template question snapshot is invalid: %v", err)
			}
			if validQuestionForPublish(snapshot) {
				t.Errorf("template question %d could publish without being completed", index+1)
			}
		}
	}
}

func TestEditingQuestionClearsTemplatePlaceholderMarker(t *testing.T) {
	row := Question{TemplatePlaceholder: true}
	applyQuestionInput(&row, questionInput{Title: "Pertanyaan baru", Type: "pg_tunggal", Prompt: "Apa jawabannya?", Status: "draft"})
	if row.TemplatePlaceholder {
		t.Fatal("saving an edited template question should clear its placeholder marker")
	}
}

func TestQuestionFromSnapshotCreatesOwnedDraftWithoutChangingSnapshotContent(t *testing.T) {
	source := questionSnapshot{ID: "old-id", Title: "Soal lama", Type: "pg_tunggal", Prompt: "Tanya?", ConfigJSON: `{"choices":[]}`, AnswerJSON: `"a"`, Points: 2, TemplatePlaceholder: true}
	question := questionFromSnapshot(source, "new-owner")
	if question.ID != "" || question.OwnerID != "new-owner" || question.Status != "draft" || question.Revision != 1 || !question.TemplatePlaceholder {
		t.Fatalf("duplicate question should be a fresh owned draft: %#v", question)
	}
	if question.Title != source.Title || question.Prompt != source.Prompt || question.AnswerJSON != source.AnswerJSON || question.ConfigJSON != source.ConfigJSON {
		t.Fatal("draft duplication should preserve the source snapshot's question content and grading key")
	}
}
