package main

import (
	"encoding/json"
	"errors"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestPublishedQuestionRequiresRevisionBeforeEditing(t *testing.T) {
	err := editableQuestionStatus("published")
	var fiberErr *fiber.Error
	if !errors.As(err, &fiberErr) || fiberErr.Code != fiber.StatusConflict {
		t.Fatalf("published question should be locked with HTTP 409, got %v", err)
	}
	if err := editableQuestionStatus("draft"); err != nil {
		t.Fatalf("draft question should remain editable: %v", err)
	}
	if err := editableQuestionStatus("archived"); err == nil {
		t.Fatal("archived question should require restoration before editing")
	}
}

func TestDraftQuestionRevisionPreservesContentWithoutChangingSourceIdentity(t *testing.T) {
	source := Question{
		Base: Base{ID: "source-id"}, OwnerID: "teacher-id", Title: "Bilangan bulat", Status: "published", Revision: 7,
		Prompt: "Hitung 2 + 2", ConfigJSON: `{"correctIds":["a"]}`, AnswerJSON: `"a"`, Points: 3,
	}
	revision := draftQuestionRevision(source)
	if source.ID != "source-id" || source.Status != "published" || source.Revision != 7 {
		t.Fatalf("source question was mutated: %+v", source)
	}
	if revision.ID != "" || revision.OwnerID != source.OwnerID || revision.Title != "Bilangan bulat (revisi)" || revision.Status != "draft" || revision.Revision != 1 {
		t.Fatalf("unexpected draft revision lifecycle fields: %+v", revision)
	}
	if revision.Prompt != source.Prompt || revision.ConfigJSON != source.ConfigJSON || revision.AnswerJSON != source.AnswerJSON || revision.Points != source.Points {
		t.Fatalf("revision did not preserve the original question content: %+v", revision)
	}
}

func TestRestoreQuestionContentKeepsCurrentIdentityAndDraftLifecycle(t *testing.T) {
	current := Question{Base: Base{ID: "current-id"}, OwnerID: "current-owner", Status: "draft", Revision: 9, Title: "Newer title", Prompt: "Newer prompt"}
	previous := Question{Base: Base{ID: "current-id"}, OwnerID: "old-owner", Status: "published", Revision: 3, Title: "Older title", Prompt: "Older prompt", AnswerJSON: `"a"`}
	restored := restoreQuestionContent(current, previous)
	if restored.ID != current.ID || restored.OwnerID != current.OwnerID || restored.Status != current.Status || restored.Revision != current.Revision {
		t.Fatalf("restore changed identity or lifecycle fields: %+v", restored)
	}
	if restored.Title != previous.Title || restored.Prompt != previous.Prompt || restored.AnswerJSON != previous.AnswerJSON {
		t.Fatalf("previous content was not restored: %+v", restored)
	}
}

func TestQuestionHistorySnapshotCanBeDecodedWithoutLosingRevision(t *testing.T) {
	question := Question{Base: Base{ID: "question-id"}, OwnerID: "teacher-id", Title: "Versioned", Status: "draft", Revision: 6, Prompt: "Question", AnswerJSON: `"key"`}
	var decoded Question
	if err := json.Unmarshal([]byte(questionSnapshotJSON(question)), &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded.ID != question.ID || decoded.Revision != question.Revision || decoded.AnswerJSON != question.AnswerJSON {
		t.Fatalf("snapshot round trip failed: %+v", decoded)
	}
}
