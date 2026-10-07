package main

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func TestFormRichTextRejectsUnsafeAttributesAndMismatchedContent(t *testing.T) {
	parts := []FormRichPart{{Insert: "Teks", Attributes: map[string]bool{"bold": true}}, {Insert: " aman"}}
	if !validFormRichText(parts, "Teks aman") || validFormRichText(parts, "Teks berbeda") {
		t.Fatal("rich/plain contract")
	}
	parts[0].Attributes["onclick"] = true
	if validFormRichText(parts, "Teks aman") {
		t.Fatal("unsafe format accepted")
	}
	d := emptyForm()
	addQuestionToDraft(&d, Question{Prompt: "Teks aman", ConfigJSON: `{"promptRich":[{"insert":"Teks","attributes":{"bold":true}},{"insert":" aman"}]}`}, 0)
	if len(orderedCards(d)[0].PromptRich) != 2 {
		t.Fatal("source formatting lost on reuse")
	}
}

func TestPostgresRichTextSnapshotsAndTutorDefaults(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, d := createPostgresForm(t, s, owner)
	card := orderedCards(d)[0]
	card.PromptRich = []FormRichPart{{Insert: card.Prompt, Attributes: map[string]bool{"underline": true}}}
	d.Cards[card.ID] = card
	saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: d})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.publishFormDocument(owner, saved, saved.Revision); err != nil {
		t.Fatal(err)
	}
	var item AssessmentItem
	if err = s.db.First(&item, "assessment_id = ?", doc.ResourceID).Error; err != nil {
		t.Fatal(err)
	}
	var snap questionSnapshot
	if err = json.Unmarshal([]byte(item.SnapshotJSON), &snap); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(snap.ConfigJSON, `"underline":true`) {
		t.Fatal("format missing from immutable snapshot")
	}
	if strings.Contains(marshalJSON(studentSafeConfig(snap.ConfigJSON)), "correctIds") {
		t.Fatal("key leaked with rich content")
	}

	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error { c.Locals("account", owner); return c.Next() })
	app.Put("/defaults", s.formPreferences)
	r := httptest.NewRequest("PUT", "/defaults", strings.NewReader(`{"themeColor":"#155e75","font":"serif","durationMinute":45,"progressBar":true,"defaultQuestionPoints":4,"defaultQuestionRequired":true,"accessCode":"NEVER_COPY","classIds":["other-class"]}`))
	r.Header.Set("Content-Type", "application/json")
	res, err := app.Test(r)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatal("preferences", res.StatusCode)
	}
	defaults := emptyForm()
	if err = s.applyFormPreferences(owner.ID, &defaults); err != nil {
		t.Fatal(err)
	}
	if defaults.Settings.DefaultQuestionPoints != 4 || !defaults.Settings.DefaultQuestionRequired || defaults.Settings.DurationMinute != 45 {
		t.Fatal("defaults not persisted")
	}
	if defaults.Settings.AccessCode != "" || len(defaults.Settings.ClassIDs) != 0 {
		t.Fatal("identity/access copied through defaults")
	}
}
