package main

import (
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"testing"
)

func TestPostgresEditorCopyKeepsOnlyExplicitSharedMediaAfterRevocation(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	editor := CBTAccount{Username: "copy-editor", Role: "guru", Active: true}
	if err := s.db.Create(&editor).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Create(&FormCollaborator{DocumentID: doc.ID, AccountID: editor.ID, Role: "editor"}).Error; err != nil {
		t.Fatal(err)
	}
	media := QuestionMedia{OwnerID: owner.ID, StoredName: uuid.NewString() + ".png", ContentType: "image/png", Kind: "image"}
	private := QuestionMedia{OwnerID: owner.ID, StoredName: uuid.NewString() + ".png", ContentType: "image/png", Kind: "image"}
	if err := s.db.Create(&media).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Create(&private).Error; err != nil {
		t.Fatal(err)
	}
	gid := uuid.NewString()
	draft.Stimuli[gid] = FormStimulus{ID: gid, Title: "Gambar", Blocks: []map[string]any{{"id": uuid.NewString(), "type": "image", "assetId": media.ID, "contentType": "image/png", "alt": "Gambar untuk soal"}}}
	card := orderedCards(draft)[0]
	card.StimulusGroupID = gid
	draft.Cards[card.ID] = card
	if _, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft}); err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error { c.Locals("account", editor); return c.Next() })
	app.Post("/forms/:kind/:id/copy", s.copyForm)
	path := "/forms/assessment/" + doc.ResourceID + "/copy"
	malicious := forkFormContent(draft)
	for id, group := range malicious.Stimuli {
		group.Blocks[0]["assetId"] = private.ID
		malicious.Stimuli[id] = group
	}
	if status, _ := formTestCall(t, app, "POST", path, marshalJSON(map[string]any{"content": malicious})); status != 403 {
		t.Fatal("unshared owner's upload copied", status)
	}
	status, p := formTestCall(t, app, "POST", path, `{}`)
	if status != 201 {
		t.Fatal(status, p)
	}
	var copyDoc FormDocument
	if err := s.db.First(&copyDoc, "id = ?", p["id"]).Error; err != nil {
		t.Fatal(err)
	}
	if copyDoc.OwnerID != editor.ID || copyDoc.SourceDocumentID != doc.ID {
		t.Fatal("wrong copy ownership")
	}
	var content FormDraft
	if err := json.Unmarshal([]byte(copyDoc.ContentJSON), &content); err != nil {
		t.Fatal(err)
	}
	if len(content.Settings.ClassIDs) > 0 || len(content.Settings.StudentIDs) > 0 {
		t.Fatal("borrowed class authority")
	}
	if err := s.db.Model(&FormCollaborator{}).Where("document_id = ? AND account_id = ?", doc.ID, editor.ID).Update("revoked", true).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveFormDocument(editor, copyDoc.ID, formSaveInput{Revision: copyDoc.Revision, Content: content}); err != nil {
		t.Fatal("private copy lost its media after source revocation", err)
	}
	var count int64
	_ = s.db.Model(&FormMediaGrant{}).Where("document_id = ? AND media_id = ?", copyDoc.ID, private.ID).Count(&count).Error
	if count != 0 {
		t.Fatal("entire upload library granted")
	}
}
