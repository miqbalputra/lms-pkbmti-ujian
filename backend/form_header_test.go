package main

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
)

func TestFormHeaderValidation(t *testing.T) {
	d := formFixture()
	d.Settings.HeaderImage = &FormHeaderImage{AssetID: "https://example.com/injected.png", Alt: "Header"}
	if validateForm(d, false) == nil {
		t.Fatal("arbitrary URL accepted")
	}
	d.Settings.HeaderImage.AssetID = uuid.NewString()
	d.Settings.HeaderImage.Alt = ""
	if err := validateForm(d, false); err != nil {
		t.Fatal(err)
	}
	if validateForm(d, true) == nil {
		t.Fatal("image without alt published")
	}
	d.Settings.HeaderImage.Alt = strings.Repeat("a", 1001)
	if validateForm(d, false) == nil {
		t.Fatal("oversized alt accepted")
	}
}

func TestPostgresPrivateHeaderSnapshotAndCopy(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	foreign := QuestionMedia{OwnerID: uuid.NewString(), Kind: "image", ContentType: "image/png", StoredName: "foreign.png"}
	header := QuestionMedia{OwnerID: owner.ID, Kind: "image", ContentType: "image/png", StoredName: "header.png"}
	audio := QuestionMedia{OwnerID: owner.ID, Kind: "audio", ContentType: "audio/mpeg", StoredName: "audio.mp3"}
	for _, media := range []*QuestionMedia{&foreign, &header, &audio} {
		if err := s.db.Create(media).Error; err != nil {
			t.Fatal(err)
		}
	}
	draft.Settings.HeaderImage = &FormHeaderImage{AssetID: foreign.ID, Alt: "Private"}
	if _, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft}); err == nil {
		t.Fatal("foreign header accepted")
	}
	draft.Settings.HeaderImage.AssetID = audio.ID
	if _, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft}); err == nil {
		t.Fatal("audio used as header")
	}
	draft.Settings.HeaderImage = &FormHeaderImage{AssetID: header.ID}
	saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.publishFormDocument(owner, saved, saved.Revision); err == nil {
		t.Fatal("missing header alt published")
	}
	draft.Settings.HeaderImage.Alt = "Sekolah Tunas Ilmu"
	saved, err = s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: saved.Revision, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	version, err := s.publishFormDocument(owner, saved, saved.Revision)
	if err != nil {
		t.Fatal(err)
	}
	studentID := uuid.NewString()
	attempt := Attempt{AssessmentID: doc.ResourceID, StudentID: studentID, Number: 1, Status: "started", FormVersionID: version.ID}
	if err := s.db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}
	display, err := attemptFormDisplay(s.db, attempt)
	if err != nil {
		t.Fatal(err)
	}
	if display["headerImage"].(*FormHeaderImage).AssetID != header.ID || strings.Contains(marshalJSON(display), "VALID123") {
		t.Fatal("display leaks secret or loses header")
	}
	s.cfg.UploadsDir = t.TempDir()
	student := CBTAccount{Role: "siswa", PesertaDidikID: studentID}
	scope := []string{doc.ResourceID}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("account", student)
		c.Locals("assessmentScope", scope)
		return c.Next()
	})
	app.Get("/media/:id", s.downloadQuestionMedia)
	app.Get("/permission/:id", func(c *fiber.Ctx) error {
		allowed, err := s.studentCanReadFormHeader(c, student, c.Params("id"))
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"allowed": allowed})
	})
	if _, result := formTestCall(t, app, "GET", "/permission/"+header.ID, ""); result["allowed"] != true {
		t.Fatal("own immutable header denied", result)
	}
	student.PesertaDidikID = uuid.NewString()
	if status, _ := formTestCall(t, app, "GET", "/media/"+header.ID, ""); status != 403 {
		t.Fatal("other student's header exposed", status)
	}
	student.PesertaDidikID = studentID
	scope = []string{uuid.NewString()}
	if status, _ := formTestCall(t, app, "GET", "/media/"+header.ID, ""); status != 403 {
		t.Fatal("assessment scope bypass", status)
	}
	scope = []string{doc.ResourceID}
	// A private media ID written into free text is not a media grant.
	decoy := draft
	decoy.Settings.HeaderImage = nil
	for id, card := range decoy.Cards {
		card.Prompt = foreign.ID
		decoy.Cards[id] = card
	}
	decoyVersion := FormVersion{DocumentID: doc.ID, Revision: 100, ContentJSON: marshalJSON(decoy)}
	if err := s.db.Create(&decoyVersion).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Model(&attempt).Update("form_version_id", decoyVersion.ID).Error; err != nil {
		t.Fatal(err)
	}
	if status, _ := formTestCall(t, app, "GET", "/media/"+foreign.ID, ""); status != 403 {
		t.Fatal("free-text media ID granted access", status)
	}
	editor := CBTAccount{Username: "header-editor", Role: "guru", Active: true}
	if err := s.db.Create(&editor).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Create(&FormCollaborator{DocumentID: doc.ID, AccountID: editor.ID, Role: "editor"}).Error; err != nil {
		t.Fatal(err)
	}
	privateHeader := QuestionMedia{OwnerID: owner.ID, Kind: "image", ContentType: "image/png", StoredName: "owner-private.png"}
	if err := s.db.Create(&privateHeader).Error; err != nil {
		t.Fatal(err)
	}
	copyApp := fiber.New(fiber.Config{ErrorHandler: apiError})
	copyApp.Use(func(c *fiber.Ctx) error { c.Locals("account", editor); return c.Next() })
	copyApp.Post("/forms/:kind/:id/copy", s.copyForm)
	malicious := draft
	malicious.Settings.HeaderImage = &FormHeaderImage{AssetID: privateHeader.ID, Alt: "Not shared"}
	if status, _ := formTestCall(t, copyApp, "POST", "/forms/assessment/"+doc.ResourceID+"/copy", marshalJSON(map[string]any{"content": malicious})); status != 403 {
		t.Fatal("editor copied owner's unrelated private header", status)
	}
	if status, _ := formTestCall(t, copyApp, "POST", "/forms/assessment/"+doc.ResourceID+"/copy", marshalJSON(map[string]any{"content": decoy})); status != 201 {
		t.Fatal("normal copy failed", status)
	}
	status, response := formTestCall(t, copyApp, "POST", "/forms/assessment/"+doc.ResourceID+"/copy", "{}")
	if status != 201 {
		t.Fatal(status, response)
	}
	var copied FormDocument
	if err := s.db.First(&copied, "id = ?", response["id"]).Error; err != nil {
		t.Fatal(err)
	}
	var content FormDraft
	if err := json.Unmarshal([]byte(copied.ContentJSON), &content); err != nil {
		t.Fatal(err)
	}
	if content.Settings.HeaderImage == nil || content.Settings.HeaderImage.AssetID != header.ID {
		t.Fatal("copied header lost")
	}
	if err := s.db.Model(&FormCollaborator{}).Where("document_id = ? AND account_id = ?", doc.ID, editor.ID).Update("revoked", true).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveFormDocument(editor, copied.ID, formSaveInput{Revision: copied.Revision, Content: content}); err != nil {
		t.Fatal("copied header lost explicit media grant", err)
	}
}
