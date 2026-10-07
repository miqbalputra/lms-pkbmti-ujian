package main

import (
	"encoding/json"
	"fmt"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"io"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
)

// Capacity regression on a disposable PG16 schema, not a substitute for the
// staging reverse-proxy/load gate. Auth and all attempt writes use actual API
// handlers and DB transactions; each of 200 pupils has a distinct account.
func TestPostgres200DistinctSessionsPreserveAnswersAndScores(t *testing.T) {
	if os.Getenv("CBT_LOAD_TEST_SESSIONS") != "200" {
		t.Skip("explicit capacity gate requires CBT_LOAD_TEST_SESSIONS=200")
	}
	s, owner := postgresFormServer(t)
	sqlDB, _ := s.db.DB()
	sqlDB.SetMaxOpenConns(25)
	sqlDB.SetMaxIdleConns(10)
	doc, draft := createPostgresForm(t, s, owner)
	saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.publishFormDocument(owner, saved, saved.Revision); err != nil {
		t.Fatal(err)
	}
	students := []MasterPeserta{}
	accounts := []CBTAccount{}
	for i := 0; i < 200; i++ {
		id := uuid.NewString()
		students = append(students, MasterPeserta{Base: Base{ID: id}, Nama: fmt.Sprintf("Load %d", i), NISN: fmt.Sprintf("9088%06d", i), KelasID: draft.Settings.ClassIDs[0], Active: true})
		accounts = append(accounts, CBTAccount{Username: fmt.Sprintf("capacity-%d", i), Role: "siswa", Active: true, PesertaDidikID: id})
	}
	if err = s.db.Create(&students).Error; err != nil {
		t.Fatal(err)
	}
	if err = s.db.Create(&accounts).Error; err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	group := app.Group("/api/student", s.auth, requireRoles("siswa"))
	group.Post("/assessments/:id/start", s.startAttempt)
	group.Put("/attempts/:id/items/:itemId/answer", s.saveAnswer)
	group.Post("/attempts/:id/submit", s.submitAttempt)
	call := func(token, method, path, body string) (int, map[string]any, error) {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", "Bearer "+token)
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Idempotency-Key", uuid.NewString())
		res, e := app.Test(r, 60000)
		if e != nil {
			return 0, nil, e
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		var p map[string]any
		_ = json.Unmarshal(raw, &p)
		return res.StatusCode, p, nil
	}
	var wg sync.WaitGroup
	errors := make(chan error, 200)
	for _, a := range accounts {
		wg.Add(1)
		go func(a CBTAccount) {
			defer wg.Done()
			token, e := s.issueAssessmentToken(a, []string{doc.ResourceID})
			if e != nil {
				errors <- e
				return
			}
			status, p, e := call(token, "POST", "/api/student/assessments/"+doc.ResourceID+"/start", `{"accessCode":"VALID123"}`)
			if e != nil || status != 201 {
				errors <- fmt.Errorf("start %d %v %v", status, p, e)
				return
			}
			id := p["id"].(string)
			var item AttemptItem
			if e = s.db.First(&item, "attempt_id = ?", id).Error; e != nil {
				errors <- e
				return
			}
			status, p, e = call(token, "PUT", "/api/student/attempts/"+id+"/items/"+item.ID+"/answer", `{"value":"a","revision":0}`)
			if e != nil || status != 200 {
				errors <- fmt.Errorf("save %d %v %v", status, p, e)
				return
			}
			for n := 0; n < 2; n++ {
				status, p, e = call(token, "POST", "/api/student/attempts/"+id+"/submit", `{}`)
				if e != nil || status != 200 {
					errors <- fmt.Errorf("submit %d %v %v", status, p, e)
					return
				}
			}
		}(a)
	}
	wg.Wait()
	close(errors)
	for e := range errors {
		t.Error(e)
	}
	var completed, answers int64
	_ = s.db.Model(&Attempt{}).Where("assessment_id = ? AND status = 'completed' AND score = 1", doc.ResourceID).Count(&completed).Error
	_ = s.db.Model(&Answer{}).Count(&answers).Error
	if completed != 200 || answers != 200 {
		t.Fatalf("lost/duplicated results: completed %d answers %d", completed, answers)
	}
}

func TestRestrictedEmbedOriginsDoNotExposeStaffPages(t *testing.T) {
	t.Setenv("CBT_FORMS_ENABLED", "true")
	t.Setenv("CBT_EMBED_ALLOWED_ORIGINS", "https://edu.example.sch.id")
	s := &Server{}
	app := fiber.New()
	app.Use(securityHeaders())
	app.Use(s.embedHeaders())
	app.Get("/*", func(c *fiber.Ctx) error { return c.SendString("shell") })
	for _, path := range []string{"/akses/token", "/siswa/upaya/id", "/editor/assessment/id", "/api/staff/questions"} {
		res, err := app.Test(httptest.NewRequest("GET", path, nil))
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		csp := res.Header.Get("Content-Security-Policy")
		student := strings.HasPrefix(path, "/akses/") || strings.HasPrefix(path, "/siswa/")
		if student {
			if !strings.Contains(csp, "frame-ancestors https://edu.example.sch.id") || res.Header.Get("X-Frame-Options") != "" {
				t.Fatal(path, csp)
			}
		} else if !strings.Contains(csp, "frame-ancestors 'none'") || res.Header.Get("X-Frame-Options") != "DENY" {
			t.Fatal("staff embed permitted", path, csp)
		}
	}
	for _, origin := range []string{"*", "https://*.example.sch.id", "http://example.sch.id", "https://example.sch.id/path", "https://user:pass@example.sch.id", "https://example.sch.id?unsafe=1"} {
		if _, err := embedOrigins(origin); err == nil {
			t.Fatal("unsafe embed origin", origin)
		}
	}
}

func TestPostgresPrefillLinkRequiresIdentityAndProducesAuditedEditableDefaults(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.publishFormDocument(owner, saved, saved.Revision); err != nil {
		t.Fatal(err)
	}
	staff := fiber.New(fiber.Config{ErrorHandler: apiError})
	staff.Use(func(c *fiber.Ctx) error { c.Locals("account", owner); return c.Next() })
	staff.Post("/forms/:kind/:id/links", s.formLinks)
	path := "/forms/assessment/" + doc.ResourceID + "/links"
	if status, _ := formTestCall(t, staff, "POST", path, `{"prefill":{"unknown":"a"}}`); status != 400 {
		t.Fatal("unknown prefill accepted", status)
	}
	card := orderedCards(draft)[0]
	status, p := formTestCall(t, staff, "POST", path, `{"prefill":{"`+card.ID+`":"a"}}`)
	if status != 201 {
		t.Fatal(status, p)
	}
	if strings.Contains(p["url"].(string), "VALID123") || strings.Contains(p["url"].(string), card.ID) {
		t.Fatal("code/defaults placed in URL")
	}
	linkID := p["link"].(map[string]any)["id"].(string)
	student := MasterPeserta{Nama: "Prefill student", NISN: "7676767601", KelasID: draft.Settings.ClassIDs[0], Active: true}
	if err = s.db.Create(&student).Error; err != nil {
		t.Fatal(err)
	}
	account := CBTAccount{Username: "prefill-student", Role: "siswa", Active: true, PesertaDidikID: student.ID}
	if err = s.db.Create(&account).Error; err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("account", account)
		c.Locals("accessLinkID", linkID)
		return c.Next()
	})
	app.Post("/assessments/:id/start", s.startAttempt)
	status, p = formTestCall(t, app, "POST", "/assessments/"+doc.ResourceID+"/start", `{"accessCode":"WRONG"}`)
	if status < 400 {
		t.Fatal("prefill bypassed code")
	}
	status, p = formTestCall(t, app, "POST", "/assessments/"+doc.ResourceID+"/start", `{"accessCode":"VALID123"}`)
	if status != 201 {
		t.Fatal(status, p)
	}
	var answer Answer
	if err = s.db.First(&answer, "attempt_id = ?", p["id"]).Error; err != nil {
		t.Fatal(err)
	}
	if answer.Revision != 1 || answer.ValueJSON != `"a"` || answer.AutoScore != 0 {
		t.Fatal("default scored or not saved", answer)
	}
	var n int64
	_ = s.db.Model(&AttemptAnswerRevision{}).Where("attempt_id = ? AND source = 'form_prefill'", p["id"]).Count(&n).Error
	if n != 1 {
		t.Fatal("prefill revision missing")
	}
	attemptID := p["id"].(string)
	app.Post("/attempts/:id/submit", s.submitAttempt)
	status, submitted := formTestCall(t, app, "POST", "/attempts/"+attemptID+"/submit", "{}")
	if status != 200 || submitted["pendingManual"] != false || submitted["status"] != "completed" {
		t.Fatal("objective prefill incorrectly left for manual grading", status, submitted)
	}
	if err := s.db.First(&answer, "attempt_id = ?", attemptID).Error; err != nil || answer.Correct == nil {
		t.Fatal("prefill not graded at submit", err, answer)
	}
}
