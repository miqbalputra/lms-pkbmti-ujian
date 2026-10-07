package main

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// Integration tests use an isolated schema on a explicitly disposable local DB.
// CI supplies PostgreSQL 16; ordinary unit runs report this gate as skipped.
func postgresFormServer(t *testing.T) (*Server, CBTAccount) {
	t.Helper()
	raw := os.Getenv("PG_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("PostgreSQL gate requires PG_TEST_DATABASE_URL (disposable PostgreSQL 16)")
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Hostname() != "127.0.0.1" && parsed.Hostname() != "localhost" && parsed.Hostname() != "postgres") || !strings.HasPrefix(strings.TrimPrefix(parsed.Path, "/"), "cbt_test") {
		t.Fatal("refusing non-disposable database")
	}
	admin, err := gorm.Open(postgres.Open(raw), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	var version int
	if err := admin.Raw("SELECT current_setting('server_version_num')::integer").Scan(&version).Error; err != nil || version/10000 != 16 {
		t.Fatalf("PostgreSQL 16 required: %d %v", version, err)
	}
	schema := "cbt_test_" + strings.ReplaceAll(uuid.NewString(), "-", "")
	if err := admin.Exec("CREATE SCHEMA " + schema).Error; err != nil {
		t.Fatal(err)
	}
	params := parsed.Query()
	params.Set("search_path", schema)
	parsed.RawQuery = params.Encode()
	db, err := gorm.Open(postgres.Open(parsed.String()), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		sqlDB, _ := db.DB()
		_ = sqlDB.Close()
		_ = admin.Exec("DROP SCHEMA " + schema + " CASCADE").Error
		sqlAdmin, _ := admin.DB()
		_ = sqlAdmin.Close()
	})
	s := &Server{db: db, cfg: Config{JWTSecret: "test-only-jwt-secret-32-characters-long", Env: "test"}}
	if err := s.migrate(); err != nil {
		t.Fatal(err)
	}
	account := CBTAccount{Username: "tutor", SourceUserID: "source-tutor", Nama: "Tutor", Role: "guru", Active: true}
	if err := db.Create(&account).Error; err != nil {
		t.Fatal(err)
	}
	return s, account
}
func createPostgresForm(t *testing.T, s *Server, a CBTAccount) (FormDocument, FormDraft) {
	t.Helper()
	d := formFixture()
	class := MasterKelas{Nama: "Kelas A", Active: true}
	if err := s.db.Create(&class).Error; err != nil {
		t.Fatal(err)
	}
	d.Settings.ClassIDs = []string{class.ID}
	d.Settings.AccessCode = "VALID123"
	row := Assessment{OwnerID: a.ID, Kind: "simulasi", Title: d.Title, Status: "draft", ClassID: class.ID, DurationMinute: 60, MaxAttempts: 1}
	if err := s.db.Create(&row).Error; err != nil {
		t.Fatal(err)
	}
	doc := FormDocument{OwnerID: a.ID, ResourceType: "assessment", ResourceID: row.ID, Revision: 1, ContentJSON: marshalJSON(d), MaterializedJSON: "{}"}
	if err := s.db.Create(&doc).Error; err != nil {
		t.Fatal(err)
	}
	return doc, d
}
func TestPostgresAtomicAutosaveConflictAndSourceCopy(t *testing.T) {
	s, a := postgresFormServer(t)
	doc, d := createPostgresForm(t, s, a)
	card := orderedCards(d)[0]
	source := Question{OwnerID: a.ID, Title: "Sumber asli", Prompt: "Sumber asli", Type: card.Type, ConfigJSON: marshalJSON(card.Config), Points: 1, Status: "published", Revision: 7}
	if err := s.db.Create(&source).Error; err != nil {
		t.Fatal(err)
	}
	card.SourceID = source.ID
	d.Cards[card.ID] = card
	saved, err := s.saveFormDocument(a, doc.ID, formSaveInput{Revision: 1, Content: d})
	if err != nil {
		t.Fatal(err)
	}
	if saved.Revision != 2 {
		t.Fatal(saved.Revision)
	}
	var original Question
	_ = s.db.First(&original, "id = ?", source.ID).Error
	if original.Revision != 7 || original.Prompt != "Sumber asli" {
		t.Fatal("source changed")
	}
	var items []AssessmentItem
	_ = s.db.Where("assessment_id = ?", doc.ResourceID).Find(&items).Error
	if len(items) != 1 || items[0].ID != card.ID || items[0].QuestionID == source.ID {
		t.Fatal("copy/stable item ID failed")
	}
	if _, err := s.saveFormDocument(a, doc.ID, formSaveInput{Revision: 1, Content: d}); err == nil {
		t.Fatal("stale revision accepted")
	}
	bad := card
	bad.ID = uuid.NewString()
	bad.SourceID = uuid.NewString()
	d.Cards[bad.ID] = bad
	card.Prompt = "Must roll back"
	d.Cards[card.ID] = card
	if _, err := s.saveFormDocument(a, doc.ID, formSaveInput{Revision: 2, Content: d}); err == nil {
		t.Fatal("invalid source accepted")
	}
	var bank Question
	_ = s.db.First(&bank, "id = ?", items[0].QuestionID).Error
	if bank.Prompt == "Must roll back" {
		t.Fatal("partial transaction committed")
	}
}
func TestPostgresPublishSnapshotAndRBAC(t *testing.T) {
	s, a := postgresFormServer(t)
	doc, d := createPostgresForm(t, s, a)
	saved, err := s.saveFormDocument(a, doc.ID, formSaveInput{Revision: 1, Content: d})
	if err != nil {
		t.Fatal(err)
	}
	other := CBTAccount{Username: "other", SourceUserID: "source-other", Role: "guru", Active: true}
	_ = s.db.Create(&other).Error
	if _, err := s.saveFormDocument(other, doc.ID, formSaveInput{Revision: 2, Content: d}); err == nil {
		t.Fatal("IDOR")
	}
	if err := s.db.Create(&FormCollaborator{DocumentID: doc.ID, AccountID: other.ID, Role: "viewer"}).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveFormDocument(other, doc.ID, formSaveInput{Revision: 2, Content: d}); err == nil {
		t.Fatal("viewer wrote")
	}
	version, err := s.publishFormDocument(a, saved, 2)
	if err != nil {
		t.Fatal(err)
	}
	if version.Checksum != hash(saved.ContentJSON) {
		t.Fatal("checksum mismatch")
	}
	if _, err := s.saveFormDocument(a, doc.ID, formSaveInput{Revision: 2, Content: d}); err == nil {
		t.Fatal("published version edited")
	}
	var assessment Assessment
	_ = s.db.First(&assessment, "id = ?", doc.ResourceID).Error
	if assessment.FormVersionID != version.ID || assessment.Status != "published" {
		t.Fatal("immutable version reference missing")
	}
}
func TestPostgresCodeGateNeverCreatesInvalidSession(t *testing.T) {
	s, a := postgresFormServer(t)
	doc, d := createPostgresForm(t, s, a)
	d.Settings.Kind = "simulasi"
	saved, err := s.saveFormDocument(a, doc.ID, formSaveInput{Revision: 1, Content: d})
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.publishFormDocument(a, saved, 2); err != nil {
		t.Fatal(err)
	}
	student := MasterPeserta{Nama: "Siswa A", NISN: "1234567890", KelasID: d.Settings.ClassIDs[0], Active: true}
	if err := s.db.Create(&student).Error; err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Post("/login", s.publicExamLogin)
	request := func(code string) (int, map[string]any) {
		r := httptest.NewRequest("POST", "/login", strings.NewReader(`{"nisn":"1234567890","accessCode":"`+code+`"}`))
		r.Header.Set("Content-Type", "application/json")
		resp, err := app.Test(r, -1)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var p map[string]any
		_ = json.Unmarshal(raw, &p)
		return resp.StatusCode, p
	}
	status, p := request("WRONG")
	if status < 400 || p["accessToken"] != nil {
		t.Fatal("wrong code issued JWT")
	}
	var count int64
	_ = s.db.Model(&CBTAccount{}).Where("peserta_didik_id = ?", student.ID).Count(&count).Error
	if count != 0 {
		t.Fatal("invalid attempt created account")
	}
	status, p = request("VALID123")
	if status != 200 || p["accessToken"] == nil {
		t.Fatalf("simulation login failed: %d %v", status, p)
	}
	future := time.Now().Add(time.Hour)
	_ = s.db.Model(&Assessment{}).Where("id = ?", doc.ResourceID).Update("starts_at", future).Error
	status, p = request("VALID123")
	if status < 400 || p["accessToken"] != nil {
		t.Fatal("future schedule issued JWT")
	}
}

func TestPostgresScopedSessionsLinksAndRevocation(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.publishFormDocument(owner, saved, saved.Revision); err != nil {
		t.Fatal(err)
	}
	student := MasterPeserta{Nama: "Scoped student", NISN: "1234567890", KelasID: draft.Settings.ClassIDs[0], Active: true}
	if err := s.db.Create(&student).Error; err != nil {
		t.Fatal(err)
	}
	account := CBTAccount{Username: "scoped-student", PesertaDidikID: student.ID, Role: "siswa", Active: true}
	if err := s.db.Create(&account).Error; err != nil {
		t.Fatal(err)
	}
	other := Assessment{OwnerID: owner.ID, Kind: "ujian_online", Status: "published", ClassID: student.KelasID, AccessCodeHash: hash("OTHER123")}
	if err := s.db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	attempt := Attempt{AssessmentID: other.ID, StudentID: student.ID, Status: "started", Number: 1}
	if err := s.db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}
	token, err := s.issueAssessmentToken(account, []string{doc.ResourceID})
	if err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	// Same group middleware order as the real app: Params are not yet resolved.
	group := app.Group("/api/student", s.auth, requireRoles("siswa"))
	group.Get("/assessments/:id", func(c *fiber.Ctx) error { return c.SendStatus(200) })
	group.Get("/attempts/:id", func(c *fiber.Ctx) error { return c.SendStatus(200) })
	request := func(path, bearer string) int {
		r := httptest.NewRequest("GET", path, nil)
		r.Header.Set("Authorization", "Bearer "+bearer)
		res, err := app.Test(r, -1)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		return res.StatusCode
	}
	if got := request("/api/student/assessments/"+other.ID, token); got != 403 {
		t.Fatalf("assessment IDOR: %d", got)
	}
	if got := request("/api/student/attempts/"+attempt.ID, token); got != 403 {
		t.Fatalf("attempt IDOR: %d", got)
	}
	if got := request("/api/student/assessments/"+doc.ResourceID, token); got != 200 {
		t.Fatal(got)
	}
	// A WebSocket ticket must never authenticate to any regular API.
	foreign, _ := jwt.NewWithClaims(jwt.SigningMethodHS256, authClaims{RegisteredClaims: jwt.RegisteredClaims{Subject: account.ID, Audience: jwt.ClaimStrings{"cbt-collaboration"}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(time.Minute))}}).SignedString([]byte(s.cfg.JWTSecret))
	if got := request("/api/student/assessments/"+doc.ResourceID, foreign); got != 401 {
		t.Fatalf("foreign ticket accepted: %d", got)
	}
	future := time.Now().Add(time.Hour)
	link := FormAccessLink{DocumentID: doc.ID, TokenHash: hash("private-link"), ExpiresAt: &future}
	if err := s.db.Create(&link).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.resolveFormLink("private-link"); err != nil {
		t.Fatal(err)
	}
	scoped, _ := s.issueAssessmentToken(account, []string{doc.ResourceID}, link.ID)
	active := Attempt{AssessmentID: doc.ResourceID, StudentID: student.ID, Status: "started", Number: 1}
	if err := s.db.Create(&active).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Model(&link).Update("revoked", true).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.resolveFormLink("private-link"); err == nil {
		t.Fatal("revoked link accepted")
	}
	if got := request("/api/student/assessments/"+doc.ResourceID, scoped); got != 403 {
		t.Fatalf("revoked link started access: %d", got)
	}
	if got := request("/api/student/attempts/"+active.ID, scoped); got != 200 {
		t.Fatalf("revocation interrupted active attempt: %d", got)
	}
	past := time.Now().Add(-time.Minute)
	if err := s.db.Model(&link).Updates(map[string]any{"revoked": false, "expires_at": past}).Error; err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.resolveFormLink("private-link"); err == nil {
		t.Fatal("expired link accepted")
	}
}

func TestPostgresCollaboratorRolesCannotEscalate(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	peer := CBTAccount{Username: "peer", Role: "guru", Active: true}
	if err := s.db.Create(&peer).Error; err != nil {
		t.Fatal(err)
	}
	member := FormCollaborator{DocumentID: doc.ID, AccountID: peer.ID, Role: "editor"}
	if err := s.db.Create(&member).Error; err != nil {
		t.Fatal(err)
	}
	saved, err := s.saveFormDocument(peer, doc.ID, formSaveInput{Revision: 1, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.publishFormDocument(peer, saved, saved.Revision); err == nil {
		t.Fatal("editor published owner document")
	}
	if err := s.db.Model(&member).Update("role", "grader").Error; err != nil {
		t.Fatal(err)
	}
	if _, err := s.saveFormDocument(peer, doc.ID, formSaveInput{Revision: saved.Revision, Content: draft}); err == nil {
		t.Fatal("grader edited content")
	}
	var assessment Assessment
	_ = s.db.First(&assessment, "id = ?", doc.ResourceID).Error
	if !s.canGradeAssessment(s.db, peer, assessment) {
		t.Fatal("grader cannot grade assigned document")
	}
	other := Assessment{OwnerID: owner.ID}
	if err := s.db.Create(&other).Error; err != nil {
		t.Fatal(err)
	}
	if s.canReadAssessment(s.db, peer, other) || s.canGradeAssessment(s.db, peer, other) {
		t.Fatal("document sharing granted global access")
	}
	if err := s.db.Model(&member).Update("revoked", true).Error; err != nil {
		t.Fatal(err)
	}
	if s.formRole(s.db, peer, saved) != "" {
		t.Fatal("revoked role accepted")
	}
	if s.canGradeAssessment(s.db, peer, assessment) {
		t.Fatal("revoked grader retained access")
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error { c.Locals("account", owner); return c.Next() })
	group := app.Group("/api/staff", s.protectFormAdapter)
	group.Put("/assessments/:id", func(c *fiber.Ctx) error { return c.SendStatus(200) })
	res, err := app.Test(httptest.NewRequest("PUT", "/api/staff/assessments/"+doc.ResourceID, nil), -1)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 409 {
		t.Fatalf("legacy adapter bypass: %d", res.StatusCode)
	}
}

func TestPostgresIdempotentAnswersSubmitAndResultRelease(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	draft.Settings.ShowResult, draft.Settings.ResultsPolicy = true, "after_review"
	saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.publishFormDocument(owner, saved, saved.Revision); err != nil {
		t.Fatal(err)
	}
	student := MasterPeserta{Nama: "Siswa", NISN: "1234567890", KelasID: draft.Settings.ClassIDs[0], Active: true}
	if err := s.db.Create(&student).Error; err != nil {
		t.Fatal(err)
	}
	account := CBTAccount{Username: "pupil", PesertaDidikID: student.ID, Role: "siswa", Active: true}
	if err := s.db.Create(&account).Error; err != nil {
		t.Fatal(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError})
	app.Use(func(c *fiber.Ctx) error { c.Locals("account", account); return c.Next() })
	app.Post("/assessments/:id/start", s.startAttempt)
	app.Put("/attempts/:id/items/:itemId/answer", s.saveAnswer)
	app.Post("/attempts/:id/submit", s.submitAttempt)
	app.Get("/attempts/:id/results", s.studentAttemptResult)
	call := func(method, path, body, key string) (int, map[string]any) {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if key != "" {
			r.Header.Set("Idempotency-Key", key)
		}
		resp, err := app.Test(r, -1)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		var p map[string]any
		_ = json.Unmarshal(raw, &p)
		return resp.StatusCode, p
	}
	status, p := call("POST", "/assessments/"+doc.ResourceID+"/start", `{"accessCode":"VALID123"}`, "")
	if status != 201 {
		t.Fatalf("start %d %v", status, p)
	}
	id := p["id"].(string)
	var item AttemptItem
	if err := s.db.First(&item, "attempt_id = ?", id).Error; err != nil {
		t.Fatal(err)
	}
	key := uuid.NewString()
	path := "/attempts/" + id + "/items/" + item.ID + "/answer"
	for n := 0; n < 2; n++ {
		status, p = call("PUT", path, `{"value":"a","revision":0}`, key)
		if status != 200 || p["revision"] != float64(1) {
			t.Fatalf("retry %d %v", status, p)
		}
	}
	status, _ = call("PUT", path, `{"value":"b","revision":0}`, key)
	if status != 409 {
		t.Fatal("same key accepted different payload", status)
	}
	var count int64
	_ = s.db.Model(&AttemptAnswerRevision{}).Where("attempt_id = ?", id).Count(&count).Error
	if count != 1 {
		t.Fatal("duplicate revision", count)
	}
	for n := 0; n < 2; n++ {
		status, p = call("POST", "/attempts/"+id+"/submit", `{}`, "")
		if status != 200 {
			t.Fatalf("submit %d %v", status, p)
		}
	}
	_, p = call("GET", "/attempts/"+id+"/results", "", "")
	if p["available"] != false || p["score"] != nil {
		t.Fatal("held result leaked", p)
	}
	var assessment Assessment
	_ = s.db.First(&assessment, "id = ?", doc.ResourceID).Error
	if assessment.FormVersionID == "" {
		t.Fatal("attempt missing version")
	}
	now := time.Now()
	if err := s.db.Model(&assessment).Update("results_released_at", now).Error; err != nil {
		t.Fatal(err)
	}
	_, p = call("GET", "/attempts/"+id+"/results", "", "")
	if p["available"] != true || p["score"] != float64(1) {
		t.Fatal("released result unavailable", p)
	}
}
