package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

func TestPostgresStudentReceiptRespectsPolicyOwnershipAndHistory(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	draft.Title = "Receipt test"
	draft.Settings.ShowResult, draft.Settings.ShowReview = true, true
	draft.Settings.ResultsPolicy = "after_review"
	saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: doc.Revision, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	version, err := s.publishFormDocument(owner, saved, saved.Revision)
	if err != nil {
		t.Fatal(err)
	}
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ?", doc.ResourceID).Error; err != nil {
		t.Fatal(err)
	}
	student := MasterPeserta{Nama: "Receipt pupil", NISN: "8888888801", KelasID: assessment.ClassID, Active: true}
	if err := s.db.Create(&student).Error; err != nil {
		t.Fatal(err)
	}
	submitted := time.Now().UTC().Truncate(time.Second)
	attempt := Attempt{AssessmentID: assessment.ID, FormVersionID: version.ID, StudentID: student.ID, ClassIDAtAttempt: student.KelasID, Number: 1, Status: "completed", Score: 81, SubmittedAt: &submitted}
	if err := s.db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}
	item := AttemptItem{AttemptID: attempt.ID, Position: 1, Weight: 1, SnapshotJSON: marshalJSON(questionSnapshot{ID: "q", Type: "pg_tunggal", Prompt: "Test", Points: 1, ConfigJSON: `{"choices":[{"id":"a","text":"4"},{"id":"b","text":"5"}],"correctIds":["a"],"acceptedAnswers":["4"],"rubrik":"internal"}`, InternalExplanation: "PRIVATE"})}
	if err := s.db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	account := CBTAccount{Role: "siswa", PesertaDidikID: student.ID}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error { c.Locals("account", account); return c.Next() })
	app.Get("/attempts/:id/results", s.studentAttemptResult)
	var beforeAttempt Attempt
	if err := s.db.First(&beforeAttempt, "id = ?", attempt.ID).Error; err != nil {
		t.Fatal(err)
	}
	before, _ := json.Marshal(beforeAttempt)
	status, payload := formTestCall(t, app, "GET", "/attempts/"+attempt.ID+"/results", "")
	if status != 200 || payload["kind"] != "simulasi" || payload["submittedAt"] != submitted.Format(time.RFC3339) || payload["available"] != false || payload["score"] != nil || payload["items"] != nil {
		t.Fatalf("receipt must not release withheld marking: %d %#v", status, payload)
	}
	if err := s.db.Model(&assessment).Update("results_released_at", submitted).Error; err != nil {
		t.Fatal(err)
	}
	status, payload = formTestCall(t, app, "GET", "/attempts/"+attempt.ID+"/results", "")
	if status != 200 || payload["score"] != float64(81) || payload["showReview"] != true {
		t.Fatal(status, payload)
	}
	raw, _ := json.Marshal(payload)
	for _, secret := range []string{"correctIds", "acceptedAnswers", "rubrik", "PRIVATE"} {
		if strings.Contains(string(raw), secret) {
			t.Fatalf("student review leaked %s", secret)
		}
	}
	var after Attempt
	if err := s.db.First(&after, "id = ?", attempt.ID).Error; err != nil {
		t.Fatal(err)
	}
	afterJSON, _ := json.Marshal(after)
	if string(before) != string(afterJSON) {
		t.Fatal("reading receipt rewrote attempt history")
	}
	var snapshot AttemptItem
	if err := s.db.First(&snapshot, "id = ?", item.ID).Error; err != nil || snapshot.SnapshotJSON != item.SnapshotJSON {
		t.Fatal("reading review altered snapshot", err)
	}
	account.PesertaDidikID = "another-student"
	if status, _ := formTestCall(t, app, "GET", "/attempts/"+attempt.ID+"/results", ""); status != 404 {
		t.Fatal("receipt crossed student boundary", status)
	}
}
