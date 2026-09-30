package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/helmet"
	"github.com/google/uuid"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

type Config struct {
	Env, JWTSecret, PublicBaseURL, LMSBaseURL, IntegrationKeyID, IntegrationSecret, UploadsDir string
	SyncInterval                                                                               time.Duration
}
type Server struct {
	db         *gorm.DB
	cfg        Config
	httpClient *http.Client
}

func env(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
func mustDuration(value string) time.Duration {
	duration, err := time.ParseDuration(value)
	if err != nil || duration < time.Minute {
		return 5 * time.Minute
	}
	return duration
}
func hash(raw string) string { sum := sha256.Sum256([]byte(raw)); return hex.EncodeToString(sum[:]) }

// deterministicShuffleSeed derives two independent PCG seeds from the saved
// attempt seed. It is intentionally based on the contents rather than the
// length of the IDs so each student receives a stable, independently shuffled
// order when randomization is enabled.
func deterministicShuffleSeed(attemptSeed, assessmentID string) (uint64, uint64) {
	sum := sha256.Sum256([]byte(attemptSeed + ":" + assessmentID))
	var first, second uint64
	for index := 0; index < 8; index++ {
		first = first<<8 | uint64(sum[index])
		second = second<<8 | uint64(sum[index+8])
	}
	return first, second
}

func main() {
	cfg := Config{Env: env("APP_ENV", "development"), JWTSecret: env("JWT_SECRET", "development-secret-change-me-32-chars"), PublicBaseURL: env("PUBLIC_BASE_URL", "http://localhost:5173"), LMSBaseURL: strings.TrimRight(env("LMS_BASE_URL", "http://localhost:8080"), "/"), IntegrationKeyID: env("LMS_INTEGRATION_KEY_ID", "cbt-local"), IntegrationSecret: env("LMS_INTEGRATION_HMAC_SECRET", "development-integration-secret-change-me"), UploadsDir: env("UPLOADS_DIR", "uploads"), SyncInterval: mustDuration(env("LMS_SYNC_INTERVAL", "5m"))}
	if len(cfg.JWTSecret) < 32 && cfg.Env == "production" {
		panic("JWT_SECRET minimal 32 karakter")
	}
	db, err := gorm.Open(postgres.Open(os.Getenv("DATABASE_URL")), &gorm.Config{TranslateError: true})
	if err != nil {
		panic(err)
	}
	s := &Server{db: db, cfg: cfg, httpClient: &http.Client{Timeout: 20 * time.Second}}
	if err := s.migrate(); err != nil {
		panic(err)
	}
	if err := s.ensureAdmin(); err != nil {
		panic(err)
	}
	app := fiber.New(fiber.Config{ErrorHandler: apiError, BodyLimit: 20 * 1024 * 1024})
	app.Use(helmet.New())
	app.Use(cors.New(cors.Config{AllowOrigins: cfg.PublicBaseURL, AllowHeaders: "Origin, Content-Type, Authorization, X-Request-ID", AllowCredentials: false}))
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok", "service": "cbt", "time": time.Now().UTC()})
	})
	api := app.Group("/api")
	api.Post("/auth/login", s.login)
	api.Get("/auth/me", s.auth, func(c *fiber.Ctx) error {
		account := currentAccount(c)
		return c.JSON(fiber.Map{"id": account.ID, "username": account.Username, "nama": account.Nama, "role": account.Role, "pesertaDidikId": account.PesertaDidikID})
	})
	api.Post("/public/ujian-online/cek", s.publicExamLogin)
	api.Get("/public/config", func(c *fiber.Ctx) error { return c.JSON(fiber.Map{"publicBaseUrl": s.cfg.PublicBaseURL}) })
	student := api.Group("/student", s.auth, requireRoles("siswa"))
	student.Get("/assessments", s.studentAssessments)
	student.Post("/assessments/:id/start", s.startAttempt)
	student.Get("/attempts/:id", s.studentAttempt)
	student.Put("/attempts/:id/items/:itemId/answer", s.saveAnswer)
	student.Put("/attempts/:id/items/:itemId/flag", s.flagAttemptItem)
	student.Post("/attempts/:id/submit", s.submitAttempt)
	staff := api.Group("/staff", s.auth, requireRoles("admin", "guru", "kepala_sekolah"))
	staff.Get("/questions", s.listQuestions)
	staff.Post("/questions", s.createQuestion)
	staff.Put("/questions/:id", s.updateQuestion)
	staff.Delete("/questions/:id", s.archiveQuestion)
	staff.Get("/assessments", s.listAssessments)
	staff.Post("/assessments", s.createAssessment)
	staff.Get("/assessments/:id", s.getAssessment)
	staff.Put("/assessments/:id", s.updateAssessment)
	staff.Post("/assessments/:id/publish", s.publishAssessment)
	staff.Put("/assessments/:id/items/order", s.reorderItems)
	staff.Get("/assessments/:id/results", s.assessmentResults)
	staff.Get("/assessments/:id/results/export.csv", s.exportAssessmentResultsCSV)
	staff.Post("/answers/:id/grade", s.gradeAnswer)
	staff.Get("/master/students", s.listStudents)
	staff.Get("/master/classes", s.listClasses)
	staff.Get("/sync/status", s.syncStatus)
	staff.Post("/sync/run", s.runSync)
	staff.Post("/migrations/import", s.importLegacy)
	admin := api.Group("/admin", s.auth, requireRoles("admin"))
	admin.Get("/accounts", s.listAccounts)
	admin.Post("/accounts", s.createAccount)
	admin.Put("/accounts/:id/password", s.resetPassword)
	app.Static("/", "./public")
	app.Get("/*", func(c *fiber.Ctx) error { return c.SendFile(filepath.Join("public", "index.html")) })
	go s.runWorkers()
	if err := app.Listen(":" + env("PORT", "8080")); err != nil {
		panic(err)
	}
}

func apiError(c *fiber.Ctx, err error) error {
	code := 500
	message := "Terjadi gangguan pada layanan CBT"
	var typed *fiber.Error
	if errors.As(err, &typed) {
		code = typed.Code
		message = typed.Message
	}
	return c.Status(code).JSON(fiber.Map{"error": message})
}
func (s *Server) migrate() error {
	return s.db.AutoMigrate(&CBTAccount{}, &MasterKelas{}, &MasterPeserta{}, &MasterTutor{}, &MasterMapel{}, &Question{}, &Assessment{}, &AssessmentItem{}, &AssessmentAssignment{}, &Attempt{}, &AttemptItem{}, &Answer{}, &AuditLog{}, &SyncState{}, &IntegrationNonce{}, &IntegrationOutbox{}, &MigrationBatch{})
}
func (s *Server) ensureAdmin() error {
	var count int64
	if err := s.db.Model(&CBTAccount{}).Where("role = ?", "admin").Count(&count).Error; err != nil || count > 0 {
		return err
	}
	password, err := hashPassword(env("CBT_ADMIN_PASSWORD", ""))
	if err != nil {
		return err
	}
	if strings.TrimSpace(env("CBT_ADMIN_PASSWORD", "")) == "" && s.cfg.Env == "production" {
		return errors.New("CBT_ADMIN_PASSWORD wajib diisi")
	}
	return s.db.Create(&CBTAccount{Username: env("CBT_ADMIN_USERNAME", "admin"), Nama: "Administrator CBT", Role: "admin", PasswordHash: password, Active: true}).Error
}
func (s *Server) audit(actor, action, resource string) {
	_ = s.db.Create(&AuditLog{ActorID: actor, Action: action, Resource: resource}).Error
}

type questionInput struct {
	Title, Type, Prompt, Description, ConfigJSON, AnswerJSON, RubricJSON string
	Points                                                               float64
	Status                                                               string
}

func normalizeQuestionInput(in *questionInput) error {
	in.Title = strings.TrimSpace(in.Title)
	in.Type = strings.TrimSpace(in.Type)
	in.Prompt = strings.TrimSpace(in.Prompt)
	if in.Title == "" || in.Type == "" || in.Prompt == "" {
		return fiber.NewError(400, "Judul, jenis, dan pertanyaan wajib diisi")
	}
	if in.Points < 0 {
		return fiber.NewError(400, "Poin tidak boleh negatif")
	}
	if in.Status == "" {
		in.Status = "draft"
	}
	for _, raw := range []string{in.ConfigJSON, in.AnswerJSON, in.RubricJSON} {
		if raw != "" && !json.Valid([]byte(raw)) {
			return fiber.NewError(400, "Konfigurasi soal harus berupa JSON valid")
		}
	}
	return nil
}
func staffCanWrite(account CBTAccount, ownerID string) bool {
	return account.Role == "admin" || (account.Role == "guru" && account.ID == ownerID)
}
func (s *Server) listQuestions(c *fiber.Ctx) error {
	account := currentAccount(c)
	query := s.db.Where("archived_at IS NULL")
	if account.Role == "guru" {
		query = query.Where("owner_id = ?", account.ID)
	}
	var rows []Question
	if err := query.Order("updated_at desc").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}
func (s *Server) createQuestion(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	var input questionInput
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(400, "Data soal tidak valid")
	}
	if err := normalizeQuestionInput(&input); err != nil {
		return err
	}
	row := Question{OwnerID: account.ID, Title: input.Title, Type: input.Type, Prompt: input.Prompt, Description: input.Description, ConfigJSON: input.ConfigJSON, AnswerJSON: input.AnswerJSON, RubricJSON: input.RubricJSON, Points: input.Points, Status: input.Status}
	if err := s.db.Create(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "create_question", row.ID)
	return c.Status(201).JSON(row)
}
func (s *Server) updateQuestion(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Question
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat mengubah soal ini")
	}
	var input questionInput
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(400, "Data soal tidak valid")
	}
	if err := normalizeQuestionInput(&input); err != nil {
		return err
	}
	row.Title, row.Type, row.Prompt, row.Description, row.ConfigJSON, row.AnswerJSON, row.RubricJSON, row.Points, row.Status = input.Title, input.Type, input.Prompt, input.Description, input.ConfigJSON, input.AnswerJSON, input.RubricJSON, input.Points, input.Status
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "update_question", row.ID)
	return c.JSON(row)
}
func (s *Server) archiveQuestion(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Question
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Soal tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat menghapus soal ini")
	}
	now := time.Now()
	if err := s.db.Model(&row).Update("archived_at", now).Error; err != nil {
		return err
	}
	s.audit(account.ID, "archive_question", row.ID)
	return c.SendStatus(204)
}

type assessmentInput struct {
	Kind, Title, Description, ClassID, SubjectID, Status, AccessCode string
	DurationMinute                                                   int
	StartsAt, EndsAt                                                 *time.Time
	Randomize, ShowResult                                            bool
	Items                                                            []struct {
		QuestionID string  `json:"questionId"`
		Weight     float64 `json:"weight"`
	} `json:"items"`
	StudentIDs []string `json:"studentIds"`
}

func validAssessmentInput(in *assessmentInput) error {
	if in.Kind != "ujian_online" && in.Kind != "simulasi" {
		return fiber.NewError(400, "Jenis asesmen tidak valid")
	}
	if strings.TrimSpace(in.Title) == "" || strings.TrimSpace(in.ClassID) == "" {
		return fiber.NewError(400, "Judul dan kelas wajib diisi")
	}
	if in.DurationMinute < 1 || in.DurationMinute > 1440 {
		return fiber.NewError(400, "Durasi harus antara 1 dan 1440 menit")
	}
	if in.EndsAt != nil && in.StartsAt != nil && !in.EndsAt.After(*in.StartsAt) {
		return fiber.NewError(400, "Jadwal selesai harus setelah jadwal mulai")
	}
	return nil
}
func (s *Server) listAssessments(c *fiber.Ctx) error {
	account := currentAccount(c)
	query := s.db.Model(&Assessment{})
	if account.Role == "guru" {
		query = query.Where("owner_id = ?", account.ID)
	}
	var rows []Assessment
	if err := query.Order("updated_at desc").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}
func (s *Server) createAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	var input assessmentInput
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(400, "Data asesmen tidak valid")
	}
	if err := validAssessmentInput(&input); err != nil {
		return err
	}
	status := input.Status
	if status == "" {
		status = "draft"
	}
	row := Assessment{OwnerID: account.ID, Kind: input.Kind, Title: strings.TrimSpace(input.Title), Description: input.Description, ClassID: input.ClassID, SubjectID: input.SubjectID, Status: status, DurationMinute: input.DurationMinute, StartsAt: input.StartsAt, EndsAt: input.EndsAt, Randomize: input.Randomize, ShowResult: input.ShowResult}
	if input.AccessCode != "" {
		row.AccessCodeHash = hash(input.AccessCode)
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return s.replaceItemsTx(tx, row, input.Items, input.StudentIDs)
	})
	if err != nil {
		return err
	}
	s.audit(account.ID, "create_assessment", row.ID)
	return c.Status(201).JSON(row)
}
func (s *Server) replaceItemsTx(tx *gorm.DB, assessment Assessment, inputs []struct {
	QuestionID string  `json:"questionId"`
	Weight     float64 `json:"weight"`
}, studentIDs []string) error {
	if err := tx.Where("assessment_id = ?", assessment.ID).Delete(&AssessmentItem{}).Error; err != nil {
		return err
	}
	if err := tx.Where("assessment_id = ?", assessment.ID).Delete(&AssessmentAssignment{}).Error; err != nil {
		return err
	}
	seen := map[string]bool{}
	for position, item := range inputs {
		if seen[item.QuestionID] {
			return fiber.NewError(400, "Soal tidak boleh dipilih dua kali")
		}
		seen[item.QuestionID] = true
		var question Question
		if err := tx.First(&question, "id = ? AND archived_at IS NULL", item.QuestionID).Error; err != nil {
			return fiber.NewError(400, "Soal pilihan tidak ditemukan")
		}
		snapshot, _ := json.Marshal(questionSnapshot{ID: question.ID, Title: question.Title, Type: question.Type, Prompt: question.Prompt, Description: question.Description, ConfigJSON: question.ConfigJSON, AnswerJSON: question.AnswerJSON, RubricJSON: question.RubricJSON, Points: question.Points})
		weight := item.Weight
		if weight <= 0 {
			weight = question.Points
		}
		if err := tx.Create(&AssessmentItem{AssessmentID: assessment.ID, QuestionID: question.ID, Position: position + 1, Weight: weight, SnapshotJSON: string(snapshot)}).Error; err != nil {
			return err
		}
	}
	for _, studentID := range studentIDs {
		if strings.TrimSpace(studentID) != "" {
			if err := tx.Create(&AssessmentAssignment{AssessmentID: assessment.ID, StudentID: studentID}).Error; err != nil {
				return err
			}
		}
	}
	return nil
}
func (s *Server) getAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Akses ditolak")
	}
	var items []AssessmentItem
	var assignments []AssessmentAssignment
	_ = s.db.Where("assessment_id = ?", row.ID).Order("position").Find(&items).Error
	_ = s.db.Where("assessment_id = ?", row.ID).Find(&assignments).Error
	return c.JSON(fiber.Map{"assessment": row, "items": items, "assignments": assignments})
}
func (s *Server) updateAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Akses ditolak")
	}
	var attempts int64
	_ = s.db.Model(&Attempt{}).Where("assessment_id = ?", row.ID).Count(&attempts).Error
	if attempts > 0 {
		return fiber.NewError(409, "Asesmen yang sudah memiliki percobaan harus diduplikasi")
	}
	var input assessmentInput
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(400, "Data asesmen tidak valid")
	}
	if err := validAssessmentInput(&input); err != nil {
		return err
	}
	row.Kind, row.Title, row.Description, row.ClassID, row.SubjectID, row.DurationMinute, row.StartsAt, row.EndsAt, row.Randomize, row.ShowResult = input.Kind, input.Title, input.Description, input.ClassID, input.SubjectID, input.DurationMinute, input.StartsAt, input.EndsAt, input.Randomize, input.ShowResult
	if input.Status != "" {
		row.Status = input.Status
	}
	if input.AccessCode != "" {
		row.AccessCodeHash = hash(input.AccessCode)
	}
	row.Revision++
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		return s.replaceItemsTx(tx, row, input.Items, input.StudentIDs)
	})
	if err != nil {
		return err
	}
	s.audit(account.ID, "update_assessment", row.ID)
	return c.JSON(row)
}
func (s *Server) publishAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Akses ditolak")
	}
	var count int64
	_ = s.db.Model(&AssessmentItem{}).Where("assessment_id = ?", row.ID).Count(&count).Error
	if count == 0 {
		return fiber.NewError(400, "Tambahkan minimal satu soal sebelum menerbitkan")
	}
	row.Status = "published"
	row.Revision++
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "publish_assessment", row.ID)
	return c.JSON(row)
}
func (s *Server) reorderItems(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) || row.Status != "draft" {
		return fiber.NewError(403, "Urutan hanya dapat diubah oleh pemilik draft")
	}
	var input struct {
		IDs []string `json:"ids"`
	}
	if c.BodyParser(&input) != nil || len(input.IDs) == 0 {
		return fiber.NewError(400, "Urutan tidak valid")
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
		for index, id := range input.IDs {
			if err := tx.Model(&AssessmentItem{}).Where("id = ? AND assessment_id = ?", id, row.ID).Update("position", index+1000).Error; err != nil {
				return err
			}
		}
		for index, id := range input.IDs {
			if err := tx.Model(&AssessmentItem{}).Where("id = ? AND assessment_id = ?", id, row.ID).Update("position", index+1).Error; err != nil {
				return err
			}
		}
		s.audit(account.ID, "reorder_assessment_items", row.ID)
		return nil
	})
}

type questionSnapshot struct {
	ID, Title, Type, Prompt, Description, ConfigJSON, AnswerJSON, RubricJSON string
	Points                                                                   float64
}

func (s *Server) publicExamLogin(c *fiber.Ctx) error {
	var input struct {
		NISN       string `json:"nisn"`
		AccessCode string `json:"accessCode"`
	}
	if c.BodyParser(&input) != nil || strings.TrimSpace(input.NISN) == "" || strings.TrimSpace(input.AccessCode) == "" {
		return fiber.NewError(400, "NISN dan kode akses wajib diisi")
	}
	var student MasterPeserta
	if err := s.db.Where("nisn = ? AND active = ?", strings.TrimSpace(input.NISN), true).First(&student).Error; err != nil {
		return fiber.NewError(401, "Peserta tidak aktif atau tidak ditemukan")
	}
	var account CBTAccount
	if err := s.db.Where("peserta_didik_id = ? AND active = ?", student.ID, true).First(&account).Error; err != nil {
		account = CBTAccount{Username: "nisn-" + student.NISN, Nama: student.Nama, Role: "siswa", PesertaDidikID: student.ID, Active: true}
		account.PasswordHash, _ = hashPassword(uuid.NewString())
		_ = s.db.Create(&account).Error
	}
	var rows []Assessment
	if err := s.db.Where("kind = ? AND class_id = ? AND status = ? AND access_code_hash = ?", "ujian_online", student.KelasID, "published", hash(strings.TrimSpace(input.AccessCode))).Find(&rows).Error; err != nil {
		return err
	}
	token, _ := s.issueToken(account, 8*time.Hour)
	return c.JSON(fiber.Map{"accessToken": token, "student": fiber.Map{"id": student.ID, "nama": student.Nama}, "assessments": rows})
}
func (s *Server) studentHasAssessmentAccess(student MasterPeserta, assessment Assessment) (bool, error) {
	var assignmentCount, directAssignmentCount int64
	if err := s.db.Model(&AssessmentAssignment{}).Where("assessment_id = ?", assessment.ID).Count(&assignmentCount).Error; err != nil {
		return false, err
	}
	if assignmentCount == 0 {
		return assessment.ClassID == student.KelasID, nil
	}
	if err := s.db.Model(&AssessmentAssignment{}).Where("assessment_id = ? AND student_id = ?", assessment.ID, student.ID).Count(&directAssignmentCount).Error; err != nil {
		return false, err
	}
	return directAssignmentCount > 0, nil
}

func (s *Server) studentAssessments(c *fiber.Ctx) error {
	account := currentAccount(c)
	var student MasterPeserta
	if err := s.db.First(&student, "id = ? AND active = ?", account.PesertaDidikID, true).Error; err != nil {
		return fiber.NewError(403, "Profil siswa tidak aktif")
	}
	var candidates []Assessment
	if err := s.db.Where("status = ?", "published").Order("starts_at asc nulls first, title asc").Find(&candidates).Error; err != nil {
		return err
	}
	rows := make([]Assessment, 0, len(candidates))
	for _, assessment := range candidates {
		permitted, err := s.studentHasAssessmentAccess(student, assessment)
		if err != nil {
			return err
		}
		if permitted {
			rows = append(rows, assessment)
		}
	}
	return c.JSON(rows)
}

func (s *Server) startAttempt(c *fiber.Ctx) error {
	account := currentAccount(c)
	var student MasterPeserta
	if err := s.db.First(&student, "id = ? AND active = ?", account.PesertaDidikID, true).Error; err != nil {
		return fiber.NewError(403, "Siswa tidak aktif")
	}
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ? AND status = ?", c.Params("id"), "published").Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak tersedia")
	}
	permitted, err := s.studentHasAssessmentAccess(student, assessment)
	if err != nil {
		return err
	}
	if !permitted {
		return fiber.NewError(403, "Anda tidak ditugaskan pada asesmen ini")
	}
	now := time.Now()
	if assessment.StartsAt != nil && now.Before(*assessment.StartsAt) || assessment.EndsAt != nil && now.After(*assessment.EndsAt) {
		return fiber.NewError(403, "Asesmen tidak berada dalam jadwal")
	}
	var existing Attempt
	if err := s.db.Where("assessment_id = ? AND student_id = ? AND number = ?", assessment.ID, student.ID, 1).First(&existing).Error; err == nil {
		return c.JSON(existing)
	}
	deadline := now.Add(time.Duration(assessment.DurationMinute) * time.Minute)
	if assessment.EndsAt != nil && assessment.EndsAt.Before(deadline) {
		deadline = *assessment.EndsAt
	}
	attempt := Attempt{AssessmentID: assessment.ID, StudentID: student.ID, ClassIDAtAttempt: student.KelasID, Number: 1, Status: "started", Seed: uuid.NewString(), StartedAt: &now, DeadlineAt: &deadline}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&attempt).Error; err != nil {
			return err
		}
		var items []AssessmentItem
		if err := tx.Where("assessment_id = ?", assessment.ID).Order("position").Find(&items).Error; err != nil {
			return err
		}
		if assessment.Randomize {
			first, second := deterministicShuffleSeed(attempt.Seed, assessment.ID)
			random := rand.New(rand.NewPCG(first, second))
			random.Shuffle(len(items), func(i, j int) { items[i], items[j] = items[j], items[i] })
		}
		for index, item := range items {
			if err := tx.Create(&AttemptItem{AttemptID: attempt.ID, AssessmentItemID: item.ID, QuestionID: item.QuestionID, Position: index + 1, Weight: item.Weight, SnapshotJSON: item.SnapshotJSON}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return err
	}
	s.audit(account.ID, "start_attempt", attempt.ID)
	return c.Status(201).JSON(attempt)
}
func studentSafeConfig(raw string) any {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	var config map[string]any
	if json.Unmarshal([]byte(raw), &config) != nil {
		return nil
	}
	// These fields either reveal an answer, a grading rule, or an internal
	// route. They must never leave the server in a learner response, including
	// when the snapshot originated from a legacy LMS assessment.
	for _, key := range []string{"correctIds", "acceptedAnswers", "pairs", "gridCorrect", "gridMultiCorrect", "correctOrder", "correctNumber", "statements", "rubrik", "branchToByAnswer", "partialScoring"} {
		delete(config, key)
	}
	return config
}

func safeSnapshot(raw string) fiber.Map {
	var snapshot questionSnapshot
	_ = json.Unmarshal([]byte(raw), &snapshot)
	return fiber.Map{"id": snapshot.ID, "title": snapshot.Title, "type": snapshot.Type, "prompt": snapshot.Prompt, "description": snapshot.Description, "config": studentSafeConfig(snapshot.ConfigJSON), "points": snapshot.Points}
}
func (s *Server) studentAttempt(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ? AND student_id = ?", c.Params("id"), account.PesertaDidikID).Error; err != nil {
		return fiber.NewError(404, "Percobaan tidak ditemukan")
	}
	var items []AttemptItem
	var answers []Answer
	_ = s.db.Where("attempt_id = ?", attempt.ID).Order("position").Find(&items).Error
	_ = s.db.Where("attempt_id = ?", attempt.ID).Find(&answers).Error
	byItem := map[string]Answer{}
	for _, answer := range answers {
		byItem[answer.AttemptItemID] = answer
	}
	output := make([]fiber.Map, 0, len(items))
	for _, item := range items {
		answer := byItem[item.ID]
		output = append(output, fiber.Map{"id": item.ID, "position": item.Position, "question": safeSnapshot(item.SnapshotJSON), "flagged": item.Flagged, "answer": answer.ValueJSON, "revision": answer.Revision})
	}
	return c.JSON(fiber.Map{"attempt": attempt, "items": output, "serverTime": time.Now().UTC()})
}
func (s *Server) canWriteAttempt(account CBTAccount, attempt Attempt) error {
	if account.PesertaDidikID != attempt.StudentID {
		return fiber.NewError(403, "Akses ditolak")
	}
	if attempt.Status != "started" {
		return fiber.NewError(409, "Percobaan sudah dikirim")
	}
	if attempt.DeadlineAt != nil && time.Now().After(*attempt.DeadlineAt) {
		return fiber.NewError(403, "Waktu asesmen sudah habis")
	}
	return nil
}
func grade(snapshot questionSnapshot, answer string, weight float64) (*bool, float64, bool) {
	if snapshot.Type == "uraian" || snapshot.Type == "unggah_berkas" || snapshot.Type == "paragraf" {
		return nil, 0, true
	}
	if strings.TrimSpace(answer) == "" {
		correct := false
		return &correct, 0, false
	}
	var key any
	var value any
	_ = json.Unmarshal([]byte(snapshot.AnswerJSON), &key)
	_ = json.Unmarshal([]byte(answer), &value)
	normalizedKey, _ := json.Marshal(key)
	normalizedValue, _ := json.Marshal(value)
	correct := string(normalizedKey) == string(normalizedValue)
	if snapshot.Type == "isian_singkat" {
		correct = strings.EqualFold(strings.Join(strings.Fields(strings.Trim(string(normalizedKey), "\"")), " "), strings.Join(strings.Fields(strings.Trim(answer, "\"")), " "))
	}
	if correct {
		return &correct, weight, false
	}
	return &correct, 0, false
}
func (s *Server) saveAnswer(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Percobaan tidak ditemukan")
	}
	if err := s.canWriteAttempt(account, attempt); err != nil {
		return err
	}
	var item AttemptItem
	if err := s.db.First(&item, "id = ? AND attempt_id = ?", c.Params("itemId"), attempt.ID).Error; err != nil {
		return fiber.NewError(404, "Soal tidak ditemukan")
	}
	var input struct {
		Value    json.RawMessage `json:"value"`
		Revision int             `json:"revision"`
	}
	if c.BodyParser(&input) != nil || len(input.Value) == 0 || !json.Valid(input.Value) {
		return fiber.NewError(400, "Jawaban tidak valid")
	}
	var snapshot questionSnapshot
	_ = json.Unmarshal([]byte(item.SnapshotJSON), &snapshot)
	correct, score, manual := grade(snapshot, string(input.Value), item.Weight)
	var answer Answer
	err := s.db.Where("attempt_id = ? AND attempt_item_id = ?", attempt.ID, item.ID).First(&answer).Error
	if err == nil && input.Revision != answer.Revision {
		return c.Status(409).JSON(fiber.Map{"error": "Versi jawaban sudah berubah", "server": answer})
	}
	if errors.Is(err, gorm.ErrRecordNotFound) {
		answer = Answer{AttemptID: attempt.ID, AttemptItemID: item.ID, ValueJSON: string(input.Value), Correct: correct, AutoScore: score, Revision: 1}
	} else {
		answer.ValueJSON, answer.Correct, answer.AutoScore, answer.Revision = string(input.Value), correct, score, answer.Revision+1
	}
	if err := s.db.Save(&answer).Error; err != nil {
		return err
	}
	return c.JSON(fiber.Map{"id": answer.ID, "revision": answer.Revision, "manual": manual, "saved": true})
}
func (s *Server) flagAttemptItem(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Percobaan tidak ditemukan")
	}
	if err := s.canWriteAttempt(account, attempt); err != nil {
		return err
	}
	var input struct {
		Flagged bool `json:"flagged"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Penanda tidak valid")
	}
	result := s.db.Model(&AttemptItem{}).Where("id = ? AND attempt_id = ?", c.Params("itemId"), attempt.ID).Update("flagged", input.Flagged)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return fiber.NewError(404, "Soal tidak ditemukan")
	}
	return c.JSON(fiber.Map{"flagged": input.Flagged})
}
func (s *Server) submitAttempt(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Percobaan tidak ditemukan")
	}
	if attempt.StudentID != account.PesertaDidikID {
		return fiber.NewError(403, "Akses ditolak")
	}
	if attempt.Status != "started" {
		var assessment Assessment
		_ = s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error
		return c.JSON(fiber.Map{"status": attempt.Status, "score": attempt.Score, "showResult": assessment.ShowResult})
	}
	if err := s.canWriteAttempt(account, attempt); err != nil {
		return err
	}
	now := time.Now()
	var answers []Answer
	_ = s.db.Where("attempt_id = ?", attempt.ID).Find(&answers).Error
	score, needsManual := 0.0, false
	for _, answer := range answers {
		score += answer.AutoScore
		if answer.Correct == nil {
			needsManual = true
		}
	}
	attempt.Score, attempt.NeedsManual, attempt.SubmittedAt = score, needsManual, &now
	if needsManual {
		attempt.Status = "pending_grade"
	} else {
		attempt.Status = "completed"
	}
	if err := s.db.Save(&attempt).Error; err != nil {
		return err
	}
	var assessment Assessment
	_ = s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error
	_ = s.enqueueAttemptResult(attempt.ID)
	s.audit(account.ID, "submit_attempt", attempt.ID)
	return c.JSON(fiber.Map{"status": attempt.Status, "score": attempt.Score, "showResult": assessment.ShowResult})
}
func (s *Server) assessmentResults(c *fiber.Ctx) error {
	account := currentAccount(c)
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, assessment.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Akses ditolak")
	}
	var attempts []Attempt
	if err := s.db.Where("assessment_id = ?", assessment.ID).Order("started_at desc").Find(&attempts).Error; err != nil {
		return err
	}
	return c.JSON(attempts)
}

func (s *Server) exportAssessmentResultsCSV(c *fiber.Ctx) error {
	account := currentAccount(c)
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, assessment.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Akses ditolak")
	}
	var attempts []Attempt
	if err := s.db.Where("assessment_id = ?", assessment.ID).Order("started_at asc").Find(&attempts).Error; err != nil {
		return err
	}
	var output bytes.Buffer
	writer := csv.NewWriter(&output)
	_ = writer.Write([]string{"ID Percobaan", "ID Siswa", "Nama Siswa", "Kelas Saat Ujian", "Status", "Nilai", "Perlu Penilaian Manual", "Mulai", "Kirim"})
	for _, attempt := range attempts {
		var student MasterPeserta
		_ = s.db.First(&student, "id = ?", attempt.StudentID).Error
		started, submitted := "", ""
		if attempt.StartedAt != nil {
			started = attempt.StartedAt.Format(time.RFC3339)
		}
		if attempt.SubmittedAt != nil {
			submitted = attempt.SubmittedAt.Format(time.RFC3339)
		}
		_ = writer.Write([]string{attempt.ID, attempt.StudentID, student.Nama, attempt.ClassIDAtAttempt, attempt.Status, strconv.FormatFloat(attempt.Score, 'f', 2, 64), strconv.FormatBool(attempt.NeedsManual), started, submitted})
	}
	writer.Flush()
	if err := writer.Error(); err != nil {
		return err
	}
	fileName := strings.NewReplacer("/", "-", "\\", "-").Replace(assessment.Title)
	c.Set(fiber.HeaderContentType, "text/csv; charset=utf-8")
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf("attachment; filename=%q", fileName+"-hasil.csv"))
	return c.Send(output.Bytes())
}

func (s *Server) gradeAnswer(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	var answer Answer
	if err := s.db.First(&answer, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Jawaban tidak ditemukan")
	}
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ?", answer.AttemptID).Error; err != nil {
		return fiber.NewError(404, "Percobaan tidak ditemukan")
	}
	var assessment Assessment
	_ = s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error
	if !staffCanWrite(account, assessment.OwnerID) {
		return fiber.NewError(403, "Akses ditolak")
	}
	var input struct {
		Score   float64 `json:"score"`
		Comment string  `json:"comment"`
	}
	if c.BodyParser(&input) != nil || input.Score < 0 {
		return fiber.NewError(400, "Nilai manual tidak valid")
	}
	answer.ManualScore, answer.Comment = &input.Score, strings.TrimSpace(input.Comment)
	if err := s.db.Save(&answer).Error; err != nil {
		return err
	}
	var answers []Answer
	_ = s.db.Where("attempt_id = ?", attempt.ID).Find(&answers).Error
	attempt.Score, attempt.NeedsManual = 0, false
	for _, row := range answers {
		attempt.Score += row.AutoScore
		if row.ManualScore != nil {
			attempt.Score += *row.ManualScore
		}
		if row.Correct == nil && row.ManualScore == nil {
			attempt.NeedsManual = true
		}
	}
	if !attempt.NeedsManual && attempt.Status == "pending_grade" {
		attempt.Status = "completed"
	}
	_ = s.db.Save(&attempt).Error
	_ = s.enqueueAttemptResult(attempt.ID)
	s.audit(account.ID, "grade_answer", answer.ID)
	return c.JSON(answer)
}
func (s *Server) listStudents(c *fiber.Ctx) error {
	var rows []MasterPeserta
	if err := s.db.Where("active = ?", true).Order("nama").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}
func (s *Server) listClasses(c *fiber.Ctx) error {
	var rows []MasterKelas
	if err := s.db.Where("active = ?", true).Order("jenjang, nama").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}
func (s *Server) listAccounts(c *fiber.Ctx) error {
	var rows []CBTAccount
	if err := s.db.Order("username").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}
func (s *Server) createAccount(c *fiber.Ctx) error {
	var input struct {
		Username, Password, Nama, Role, PesertaDidikID, TutorID string
		Active                                                  *bool
	}
	if c.BodyParser(&input) != nil || strings.TrimSpace(input.Username) == "" || len(input.Password) < 10 {
		return fiber.NewError(400, "Username dan kata sandi minimal 10 karakter wajib diisi")
	}
	if !map[string]bool{"admin": true, "guru": true, "kepala_sekolah": true, "siswa": true}[input.Role] {
		return fiber.NewError(400, "Peran akun tidak valid")
	}
	if input.Role == "siswa" && strings.TrimSpace(input.PesertaDidikID) == "" {
		return fiber.NewError(400, "Akun siswa harus terhubung ke peserta didik")
	}
	password, _ := hashPassword(input.Password)
	active := true
	if input.Active != nil {
		active = *input.Active
	}
	row := CBTAccount{Username: strings.TrimSpace(input.Username), PasswordHash: password, Nama: input.Nama, Role: input.Role, PesertaDidikID: input.PesertaDidikID, TutorID: input.TutorID, Active: active}
	if err := s.db.Create(&row).Error; err != nil {
		return fiber.NewError(409, "Akun sudah ada")
	}
	s.audit(currentAccount(c).ID, "create_account", row.ID)
	return c.Status(201).JSON(row)
}
func (s *Server) resetPassword(c *fiber.Ctx) error {
	var row CBTAccount
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Akun tidak ditemukan")
	}
	var input struct {
		Password string `json:"password"`
	}
	if c.BodyParser(&input) != nil || len(input.Password) < 10 {
		return fiber.NewError(400, "Kata sandi minimal 10 karakter")
	}
	row.PasswordHash, _ = hashPassword(input.Password)
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(currentAccount(c).ID, "reset_password", row.ID)
	return c.SendStatus(204)
}

func sortedKeys(values map[string]any) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
func parseInt(raw string) int             { value, _ := strconv.Atoi(raw); return value }
func logError(format string, args ...any) { fmt.Fprintf(os.Stderr, format+"\n", args...) }
