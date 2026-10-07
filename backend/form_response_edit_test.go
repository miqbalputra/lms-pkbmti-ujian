package main

import (
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func formTestCall(t *testing.T, app *fiber.App, method, path, body string) (int, map[string]any) {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	res, err := app.Test(r, -1)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	var payload map[string]any
	_ = json.Unmarshal(raw, &payload)
	return res.StatusCode, payload
}

func TestPostgresResponseEditPreservesSubmittedLedgerAndDeadline(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	draft.Settings.AllowResponseEdit, draft.Settings.ShowResult = true, true
	draft.Settings.ResultsPolicy = "after_review"
	saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.publishFormDocument(owner, saved, saved.Revision); err != nil {
		t.Fatal(err)
	}
	student := MasterPeserta{Nama: "Pupil", NISN: "7777777701", KelasID: draft.Settings.ClassIDs[0], Active: true}
	if err = s.db.Create(&student).Error; err != nil {
		t.Fatal(err)
	}
	account := CBTAccount{Role: "siswa", Active: true, Username: "response-editor", PesertaDidikID: student.ID}
	if err = s.db.Create(&account).Error; err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error { c.Locals("account", account); return c.Next() })
	app.Post("/assessments/:id/start", s.startAttempt)
	app.Put("/attempts/:id/items/:itemId/answer", s.saveAnswer)
	app.Post("/attempts/:id/submit", s.submitAttempt)
	app.Post("/attempts/:id/reopen", s.reopenFormResponse)
	app.Get("/attempts/:id/results", s.studentAttemptResult)
	status, p := formTestCall(t, app, "POST", "/assessments/"+doc.ResourceID+"/start", `{"accessCode":"VALID123"}`)
	if status != 201 {
		t.Fatal(status, p)
	}
	id := p["id"].(string)
	var item AttemptItem
	if err = s.db.First(&item, "attempt_id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	path := "/attempts/" + id
	if status, p = formTestCall(t, app, "PUT", path+"/items/"+item.ID+"/answer", `{"value":"a","revision":0}`); status != 200 {
		t.Fatal(status, p)
	}
	if status, p = formTestCall(t, app, "POST", path+"/submit", `{}`); status != 200 {
		t.Fatal(status, p)
	}
	var before Attempt
	_ = s.db.First(&before, "id = ?", id).Error
	now := time.Now()
	_ = s.db.Model(&Assessment{}).Where("id = ?", doc.ResourceID).Update("results_released_at", now).Error
	if _, p = formTestCall(t, app, "GET", path+"/results", ""); p["canEdit"] != true || p["score"] != float64(1) {
		t.Fatal(p)
	}
	key := uuid.NewString()
	for n := 0; n < 2; n++ {
		if status, p = formTestCall(t, app, "POST", path+"/reopen", `{"requestId":"`+key+`"}`); status != 200 {
			t.Fatal(status, p)
		}
	}
	var ledger []FormResponseRevision
	if err = s.db.Where("attempt_id = ?", id).Find(&ledger).Error; err != nil {
		t.Fatal(err)
	}
	if len(ledger) != 1 || !strings.Contains(ledger[0].SnapshotJSON, `"score":1`) || !strings.Contains(ledger[0].SnapshotJSON, `"valueJson":"\"a\""`) {
		t.Fatal("submitted ledger lost", ledger)
	}
	var reopened Attempt
	_ = s.db.First(&reopened, "id = ?", id).Error
	if reopened.Seed != before.Seed || !reopened.DeadlineAt.Equal(*before.DeadlineAt) || reopened.Number != before.Number || reopened.SubmittedAt != nil {
		t.Fatal("reopen changed deadline/history", reopened)
	}
	if status, p = formTestCall(t, app, "PUT", path+"/items/"+item.ID+"/answer", `{"value":"b","revision":1}`); status != 200 {
		t.Fatal(status, p)
	}
	if status, p = formTestCall(t, app, "POST", path+"/submit", `{}`); status != 200 {
		t.Fatal(status, p)
	}
	if _, p = formTestCall(t, app, "GET", path+"/results", ""); p["available"] != false || p["score"] != nil {
		t.Fatal("revised result bypassed review", p)
	}
	now = time.Now()
	_ = s.db.Model(&Assessment{}).Where("id = ?", doc.ResourceID).Update("results_released_at", now).Error
	if _, p = formTestCall(t, app, "GET", path+"/results", ""); p["available"] != true || p["score"] != float64(0) {
		t.Fatal(p)
	}
	past := time.Now().Add(-time.Minute)
	_ = s.db.Model(&Attempt{}).Where("id = ?", id).Update("deadline_at", past).Error
	if status, _ = formTestCall(t, app, "POST", path+"/reopen", `{"requestId":"`+uuid.NewString()+`"}`); status != 403 {
		t.Fatal("late edit accepted", status)
	}
	account.PesertaDidikID = uuid.NewString()
	if status, _ = formTestCall(t, app, "POST", path+"/reopen", `{"requestId":"`+uuid.NewString()+`"}`); status != 404 {
		t.Fatal("response edit IDOR", status)
	}
}

func TestPostgresRESTReplacementInvalidatesOldCollaborationGeneration(t *testing.T) {
	s, a := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, a)
	old := doc.SyncEpoch
	saved, err := s.saveFormDocument(a, doc.ID, formSaveInput{Revision: doc.Revision, Content: draft, YState: []byte{0, 0}, SyncEpoch: &old})
	if err != nil {
		t.Fatal(err)
	}
	draft.Title = "Server replacement"
	replaced, err := s.saveFormDocument(a, doc.ID, formSaveInput{Revision: saved.Revision, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	if replaced.SyncEpoch != old+1 || len(replaced.YState) != 0 {
		t.Fatal("stale binary state survived", replaced.SyncEpoch)
	}
	if _, err = s.saveFormDocument(a, doc.ID, formSaveInput{Revision: replaced.Revision, Content: draft, YState: []byte{0, 0}, SyncEpoch: &old}); err == nil {
		t.Fatal("old CRDT room overwrote replacement")
	}
	var current FormDocument
	_ = s.db.First(&current, "id = ?", doc.ID).Error
	if current.ContentJSON != marshalJSON(draft) || current.Revision != replaced.Revision {
		t.Fatal("conflict mutated state")
	}
}

func TestPostgresSharedLibraryIsDocumentScoped(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, _ := createPostgresForm(t, s, owner)
	other, _ := createPostgresForm(t, s, owner)
	peer := CBTAccount{Username: "library-peer", Role: "guru", Active: true}
	if err := s.db.Create(&peer).Error; err != nil {
		t.Fatal(err)
	}
	member := FormCollaborator{AccountID: peer.ID, DocumentID: doc.ID, Role: "editor"}
	if err := s.db.Create(&member).Error; err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error { c.Locals("account", peer); return c.Next() })
	app.Get("/forms/:kind", s.formLibrary)
	res, err := app.Test(httptest.NewRequest("GET", "/forms/assessment", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if res.StatusCode != 200 || !strings.Contains(string(raw), doc.ResourceID) || strings.Contains(string(raw), other.ResourceID) || strings.Contains(string(raw), "VALID123") {
		t.Fatal("library leaked/omitted document", string(raw))
	}
	_ = s.db.Model(&member).Update("revoked", true).Error
	res, err = app.Test(httptest.NewRequest("GET", "/forms/assessment", nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ = io.ReadAll(res.Body)
	_ = res.Body.Close()
	if strings.Contains(string(raw), doc.ResourceID) {
		t.Fatal("revoked document remained visible")
	}
}
