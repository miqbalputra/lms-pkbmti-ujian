package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"mime"
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
	"gorm.io/gorm/clause"
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

func shuffleSnapshotOptions(raw string, random *rand.Rand) string {
	var snapshot questionSnapshot
	if json.Unmarshal([]byte(raw), &snapshot) != nil {
		return raw
	}
	config := configObject(snapshot.ConfigJSON)
	for _, key := range []string{"choices", "right", "columns"} {
		rows, ok := config[key].([]any)
		if !ok || len(rows) < 2 {
			continue
		}
		random.Shuffle(len(rows), func(i, j int) { rows[i], rows[j] = rows[j], rows[i] })
		config[key] = rows
	}
	encodedConfig, err := json.Marshal(config)
	if err != nil {
		return raw
	}
	snapshot.ConfigJSON = string(encodedConfig)
	encodedSnapshot, err := json.Marshal(snapshot)
	if err != nil {
		return raw
	}
	return string(encodedSnapshot)
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
	if err := s.seedDevelopmentExamples(); err != nil {
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
	student.Get("/attempts", s.studentAttempts)
	student.Post("/assessments/:id/start", s.startAttempt)
	student.Get("/attempts/:id", s.studentAttempt)
	student.Get("/attempts/:id/results", s.studentAttemptResult)
	student.Put("/attempts/:id/items/:itemId/answer", s.saveAnswer)
	student.Put("/attempts/:id/items/:itemId/flag", s.flagAttemptItem)
	student.Post("/attempts/:id/items/:itemId/files", s.uploadAttemptFile)
	student.Delete("/attempts/:id/items/:itemId/files/:fileId", s.deleteAttemptFile)
	student.Get("/attempts/:id/files/:fileId", s.downloadAttemptFile)
	student.Post("/attempts/:id/submit", s.submitAttempt)
	student.Post("/attempts/:id/recovery", s.submitLateRecovery)
	staff := api.Group("/staff", s.auth, requireRoles("admin", "guru", "kepala_sekolah"))
	staff.Get("/questions", s.listQuestions)
	staff.Post("/questions", s.createQuestion)
	staff.Put("/questions/:id", s.updateQuestion)
	staff.Delete("/questions/:id", s.archiveQuestion)
	staff.Get("/assessments", s.listAssessments)
	staff.Post("/assessments", s.createAssessment)
	staff.Post("/assessments/drafts", s.createAssessmentDraft)
	staff.Get("/assessments/:id", s.getAssessment)
	staff.Put("/assessments/:id/draft", s.saveAssessmentDraft)
	staff.Put("/assessments/:id", s.updateAssessment)
	staff.Post("/assessments/:id/publish", s.publishAssessment)
	staff.Put("/assessments/:id/items/order", s.reorderItems)
	staff.Get("/assessments/:id/results", s.assessmentResults)
	staff.Get("/assessments/:id/results/export.csv", s.exportAssessmentResultsCSV)
	staff.Get("/attempts/:id", s.staffAttemptDetail)
	staff.Post("/answers/:id/grade", s.gradeAnswer)
	staff.Get("/answers/:id/files/:fileId", s.downloadStaffAnswerFile)
	staff.Get("/recoveries", s.listAttemptRecoveries)
	staff.Post("/recoveries/:id/review", s.reviewAttemptRecovery)
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
	return s.db.AutoMigrate(&CBTAccount{}, &MasterKelas{}, &MasterPeserta{}, &MasterTutor{}, &MasterMapel{}, &Question{}, &Assessment{}, &AssessmentItem{}, &AssessmentAssignment{}, &Attempt{}, &AttemptItem{}, &Answer{}, &AttemptAttachment{}, &AttemptRecovery{}, &AttemptAnswerRevision{}, &AuditLog{}, &SyncState{}, &IntegrationNonce{}, &IntegrationOutbox{}, &MigrationBatch{})
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
	Title               string  `json:"title"`
	Program             string  `json:"program"`
	Grade               int     `json:"grade"`
	Phase               string  `json:"phase"`
	Mode                string  `json:"mode"`
	Subject             string  `json:"subject"`
	Domain              string  `json:"domain"`
	Topic               string  `json:"topic"`
	Competency          string  `json:"competency"`
	CognitiveLevel      string  `json:"cognitiveLevel"`
	Difficulty          string  `json:"difficulty"`
	Tags                string  `json:"tags"`
	Type                string  `json:"type"`
	Prompt              string  `json:"prompt"`
	Description         string  `json:"description"`
	StimulusJSON        string  `json:"stimulusJson"`
	ConfigJSON          string  `json:"configJson"`
	AnswerJSON          string  `json:"answerJson"`
	RubricJSON          string  `json:"rubricJson"`
	InternalExplanation string  `json:"internalExplanation"`
	Points              float64 `json:"points"`
	Status              string  `json:"status"`
}

func normalizeQuestionInput(in *questionInput) error {
	in.Title = strings.TrimSpace(in.Title)
	in.Type = strings.TrimSpace(in.Type)
	in.Prompt = strings.TrimSpace(in.Prompt)
	if in.Title == "" || in.Type == "" || in.Prompt == "" {
		return fiber.NewError(400, "Judul, jenis, dan pertanyaan wajib diisi")
	}
	if !supportedQuestionTypes[in.Type] {
		return fiber.NewError(400, "Jenis soal belum didukung")
	}
	if in.Points < 0 {
		return fiber.NewError(400, "Poin tidak boleh negatif")
	}
	if in.Grade < 0 || in.Grade > 12 {
		return fiber.NewError(400, "Kelas harus berada pada rentang 1–12")
	}
	if in.Status == "" {
		in.Status = "draft"
	}
	if in.Status != "draft" && in.Status != "published" {
		return fiber.NewError(400, "Status soal tidak valid")
	}
	for _, raw := range []string{in.ConfigJSON, in.AnswerJSON, in.RubricJSON} {
		if raw != "" && !json.Valid([]byte(raw)) {
			return fiber.NewError(400, "Konfigurasi soal harus berupa JSON valid")
		}
	}
	if !validateQuestionConfig(in.Type, in.ConfigJSON) {
		return fiber.NewError(400, "Lengkapi konfigurasi jawaban untuk jenis soal ini")
	}
	if !validStimulusJSON(in.StimulusJSON) {
		return fiber.NewError(400, "Stimulus tidak valid. Tautan media harus HTTPS")
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
	row := Question{OwnerID: account.ID, Title: input.Title, Program: input.Program, Grade: input.Grade, Phase: input.Phase, Mode: input.Mode, Subject: input.Subject, Domain: input.Domain, Topic: input.Topic, Competency: input.Competency, CognitiveLevel: input.CognitiveLevel, Difficulty: input.Difficulty, Tags: input.Tags, Type: input.Type, Prompt: input.Prompt, Description: input.Description, StimulusJSON: input.StimulusJSON, ConfigJSON: input.ConfigJSON, AnswerJSON: input.AnswerJSON, RubricJSON: input.RubricJSON, InternalExplanation: input.InternalExplanation, Points: input.Points, Status: input.Status, Revision: 1}
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
	row.Title, row.Program, row.Grade, row.Phase, row.Mode, row.Subject, row.Domain, row.Topic, row.Competency, row.CognitiveLevel, row.Difficulty, row.Tags = input.Title, input.Program, input.Grade, input.Phase, input.Mode, input.Subject, input.Domain, input.Topic, input.Competency, input.CognitiveLevel, input.Difficulty, input.Tags
	row.Type, row.Prompt, row.Description, row.StimulusJSON, row.ConfigJSON, row.AnswerJSON, row.RubricJSON, row.InternalExplanation, row.Points, row.Status = input.Type, input.Prompt, input.Description, input.StimulusJSON, input.ConfigJSON, input.AnswerJSON, input.RubricJSON, input.InternalExplanation, input.Points, input.Status
	row.Revision++
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
	Kind, Title, Description, ClassID, SubjectID, Status, AccessCode          string
	Instructions, ResultsPolicy, ConfirmationMessage, ThemeJSON, SectionsJSON string
	DurationMinute                                                            int
	MaxAttempts                                                               int
	PassScore                                                                 float64
	Revision                                                                  int
	StartsAt, EndsAt                                                          *time.Time
	Randomize, ShowResult, ShowReview, RandomizeOptions, ProgressBar          bool
	Items                                                                     []struct {
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
	if in.MaxAttempts < 0 || in.MaxAttempts > 20 {
		return fiber.NewError(400, "Batas percobaan harus antara 0 dan 20")
	}
	if in.PassScore < 0 || in.PassScore > 100 {
		return fiber.NewError(400, "Nilai lulus harus antara 0 dan 100")
	}
	if in.ResultsPolicy != "" && in.ResultsPolicy != "immediate" && in.ResultsPolicy != "after_review" && in.ResultsPolicy != "hidden" {
		return fiber.NewError(400, "Kebijakan hasil tidak valid")
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
	row := Assessment{OwnerID: account.ID, Kind: input.Kind, Title: strings.TrimSpace(input.Title), Description: input.Description, Instructions: input.Instructions, ClassID: input.ClassID, SubjectID: input.SubjectID, Status: status, DurationMinute: input.DurationMinute, StartsAt: input.StartsAt, EndsAt: input.EndsAt, Randomize: input.Randomize, ShowResult: input.ShowResult, MaxAttempts: input.MaxAttempts, PassScore: input.PassScore, ResultsPolicy: input.ResultsPolicy, ShowReview: input.ShowReview, RandomizeOptions: input.RandomizeOptions, ProgressBar: input.ProgressBar, ConfirmationMessage: input.ConfirmationMessage, ThemeJSON: input.ThemeJSON, SectionsJSON: input.SectionsJSON, Revision: 1}
	if input.AccessCode != "" {
		row.AccessCodeHash = hash(input.AccessCode)
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return s.replaceItemsTx(tx, row, input.Items, input.StudentIDs, account)
	})
	if err != nil {
		return err
	}
	s.audit(account.ID, "create_assessment", row.ID)
	return c.Status(201).JSON(row)
}

func (s *Server) createAssessmentDraft(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Kepala sekolah hanya dapat melihat")
	}
	var input assessmentInput
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Draf asesmen tidak valid")
	}
	if input.Kind == "" {
		input.Kind = "ujian_online"
	}
	if input.Kind != "ujian_online" && input.Kind != "simulasi" {
		return fiber.NewError(400, "Jenis asesmen tidak valid")
	}
	if input.DurationMinute == 0 {
		input.DurationMinute = 60
	}
	if input.DurationMinute < 1 || input.DurationMinute > 1440 {
		return fiber.NewError(400, "Durasi harus antara 1 dan 1440 menit")
	}
	title := strings.TrimSpace(input.Title)
	if title == "" {
		title = "Paket tanpa judul"
	}
	row := Assessment{OwnerID: account.ID, Kind: input.Kind, Title: title, Description: input.Description, Instructions: input.Instructions, ClassID: input.ClassID, SubjectID: input.SubjectID, Status: "draft", DurationMinute: input.DurationMinute, StartsAt: input.StartsAt, EndsAt: input.EndsAt, Randomize: input.Randomize, ShowResult: input.ShowResult, MaxAttempts: input.MaxAttempts, PassScore: input.PassScore, ResultsPolicy: input.ResultsPolicy, ShowReview: input.ShowReview, RandomizeOptions: input.RandomizeOptions, ProgressBar: input.ProgressBar, ConfirmationMessage: input.ConfirmationMessage, ThemeJSON: input.ThemeJSON, SectionsJSON: input.SectionsJSON, Revision: 1}
	if input.AccessCode != "" {
		row.AccessCodeHash = hash(input.AccessCode)
	}
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return s.replaceItemsTx(tx, row, input.Items, input.StudentIDs, account)
	}); err != nil {
		return err
	}
	s.audit(account.ID, "create_assessment_draft", row.ID)
	return c.Status(201).JSON(fiber.Map{"assessment": row})
}

func (s *Server) saveAssessmentDraft(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Draf asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) || row.Status != "draft" {
		return fiber.NewError(403, "Draf hanya dapat diubah oleh pemiliknya")
	}
	var attempts int64
	if err := s.db.Model(&Attempt{}).Where("assessment_id = ?", row.ID).Count(&attempts).Error; err != nil {
		return err
	}
	if attempts > 0 {
		return fiber.NewError(409, "Asesmen yang sudah memiliki percobaan harus diduplikasi")
	}
	var input assessmentInput
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Perubahan draf tidak valid")
	}
	if input.Revision != 0 && input.Revision != row.Revision {
		var items []AssessmentItem
		_ = s.db.Where("assessment_id = ?", row.ID).Order("position").Find(&items).Error
		return c.Status(409).JSON(fiber.Map{"error": "Draf berubah di sesi lain", "server": row, "items": items})
	}
	if input.Kind != "ujian_online" && input.Kind != "simulasi" {
		return fiber.NewError(400, "Jenis asesmen tidak valid")
	}
	if input.DurationMinute == 0 {
		input.DurationMinute = 60
	}
	if input.DurationMinute < 1 || input.DurationMinute > 1440 || input.MaxAttempts < 0 || input.MaxAttempts > 20 || input.PassScore < 0 || input.PassScore > 100 {
		return fiber.NewError(400, "Durasi, batas percobaan, atau nilai lulus tidak valid")
	}
	row.Kind, row.Title, row.Description, row.Instructions, row.ClassID, row.SubjectID = input.Kind, strings.TrimSpace(input.Title), input.Description, input.Instructions, input.ClassID, input.SubjectID
	if row.Title == "" {
		row.Title = "Paket tanpa judul"
	}
	row.DurationMinute, row.StartsAt, row.EndsAt = input.DurationMinute, input.StartsAt, input.EndsAt
	row.Randomize, row.ShowResult, row.MaxAttempts, row.PassScore = input.Randomize, input.ShowResult, input.MaxAttempts, input.PassScore
	row.ResultsPolicy, row.ShowReview, row.RandomizeOptions, row.ProgressBar = input.ResultsPolicy, input.ShowReview, input.RandomizeOptions, input.ProgressBar
	row.ConfirmationMessage, row.ThemeJSON, row.SectionsJSON = input.ConfirmationMessage, input.ThemeJSON, input.SectionsJSON
	if input.AccessCode != "" {
		row.AccessCodeHash = hash(input.AccessCode)
	}
	row.Revision++
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		return s.replaceItemsTx(tx, row, input.Items, input.StudentIDs, account)
	}); err != nil {
		return err
	}
	s.audit(account.ID, "autosave_assessment_draft", row.ID)
	return c.JSON(fiber.Map{"assessment": row})
}

func (s *Server) replaceItemsTx(tx *gorm.DB, assessment Assessment, inputs []struct {
	QuestionID string  `json:"questionId"`
	Weight     float64 `json:"weight"`
}, studentIDs []string, account CBTAccount) error {
	if err := tx.Where("assessment_id = ?", assessment.ID).Delete(&AssessmentItem{}).Error; err != nil {
		return err
	}
	if err := tx.Where("assessment_id = ?", assessment.ID).Delete(&AssessmentAssignment{}).Error; err != nil {
		return err
	}
	if strings.TrimSpace(assessment.ClassID) != "" {
		var class MasterKelas
		if err := tx.First(&class, "id = ? AND active = ?", assessment.ClassID, true).Error; err != nil {
			return fiber.NewError(400, "Kelas asesmen tidak tersedia atau tidak aktif")
		}
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
		if account.Role == "guru" && question.OwnerID != account.ID {
			return fiber.NewError(403, "Guru hanya dapat memakai soal miliknya")
		}
		snapshot, _ := json.Marshal(questionSnapshot{ID: question.ID, Title: question.Title, Program: question.Program, Grade: question.Grade, Phase: question.Phase, Mode: question.Mode, Subject: question.Subject, Domain: question.Domain, Topic: question.Topic, Competency: question.Competency, CognitiveLevel: question.CognitiveLevel, Difficulty: question.Difficulty, Tags: question.Tags, Type: question.Type, Prompt: question.Prompt, Description: question.Description, StimulusJSON: question.StimulusJSON, ConfigJSON: question.ConfigJSON, AnswerJSON: question.AnswerJSON, RubricJSON: question.RubricJSON, InternalExplanation: question.InternalExplanation, Points: question.Points})
		weight := item.Weight
		if weight <= 0 {
			weight = question.Points
		}
		if err := tx.Create(&AssessmentItem{AssessmentID: assessment.ID, QuestionID: question.ID, Position: position + 1, Weight: weight, SnapshotJSON: string(snapshot)}).Error; err != nil {
			return err
		}
	}
	assigned := map[string]bool{}
	for _, studentID := range studentIDs {
		studentID = strings.TrimSpace(studentID)
		if studentID == "" || assigned[studentID] {
			return fiber.NewError(400, "Pilihan peserta tidak valid atau ganda")
		}
		assigned[studentID] = true
		var student MasterPeserta
		if err := tx.First(&student, "id = ? AND active = ?", studentID, true).Error; err != nil || student.KelasID != assessment.ClassID {
			return fiber.NewError(400, "Peserta harus aktif dan berada di kelas asesmen")
		}
		if err := tx.Create(&AssessmentAssignment{AssessmentID: assessment.ID, StudentID: studentID}).Error; err != nil {
			return err
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
	row.Kind, row.Title, row.Description, row.Instructions, row.ClassID, row.SubjectID, row.DurationMinute, row.StartsAt, row.EndsAt, row.Randomize, row.ShowResult = input.Kind, input.Title, input.Description, input.Instructions, input.ClassID, input.SubjectID, input.DurationMinute, input.StartsAt, input.EndsAt, input.Randomize, input.ShowResult
	row.MaxAttempts, row.PassScore, row.ResultsPolicy, row.ShowReview, row.RandomizeOptions, row.ProgressBar = input.MaxAttempts, input.PassScore, input.ResultsPolicy, input.ShowReview, input.RandomizeOptions, input.ProgressBar
	row.ConfirmationMessage, row.ThemeJSON, row.SectionsJSON = input.ConfirmationMessage, input.ThemeJSON, input.SectionsJSON
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
		return s.replaceItemsTx(tx, row, input.Items, input.StudentIDs, account)
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
	if strings.TrimSpace(row.Title) == "" || strings.EqualFold(strings.TrimSpace(row.Title), "Paket tanpa judul") {
		return fiber.NewError(400, "Beri judul asesmen sebelum menerbitkan")
	}
	if strings.TrimSpace(row.ClassID) == "" {
		return fiber.NewError(400, "Pilih kelas yang akan mengikuti asesmen")
	}
	if row.Kind == "ujian_online" && strings.TrimSpace(row.AccessCodeHash) == "" {
		return fiber.NewError(400, "Kode akses wajib dibuat untuk Ujian Online")
	}
	if row.DurationMinute < 1 || row.DurationMinute > 1440 {
		return fiber.NewError(400, "Durasi asesmen belum valid")
	}
	var items []AssessmentItem
	if err := s.db.Where("assessment_id = ?", row.ID).Order("position").Find(&items).Error; err != nil {
		return err
	}
	if len(items) == 0 {
		return fiber.NewError(400, "Tambahkan minimal satu soal sebelum menerbitkan")
	}
	for index, item := range items {
		var snapshot questionSnapshot
		if json.Unmarshal([]byte(item.SnapshotJSON), &snapshot) != nil || !validQuestionForPublish(snapshot) || item.Weight <= 0 {
			return fiber.NewError(400, fmt.Sprintf("Konfigurasi jawaban, bobot, atau rubrik soal nomor %d belum lengkap", index+1))
		}
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
	ID, Title, Type, Prompt, Description, ConfigJSON, AnswerJSON, RubricJSON                                        string
	Program, Phase, Mode, Subject, Domain, Topic, Competency, CognitiveLevel, Difficulty, Tags, InternalExplanation string
	Grade                                                                                                           int
	StimulusJSON                                                                                                    string
	Points                                                                                                          float64
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
	var attempt Attempt
	created := false
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&assessment, "id = ? AND status = ?", c.Params("id"), "published").Error; err != nil {
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
		var previous []Attempt
		if err := tx.Where("assessment_id = ? AND student_id = ?", assessment.ID, student.ID).Order("number desc").Find(&previous).Error; err != nil {
			return err
		}
		if len(previous) > 0 && previous[0].Status == "started" {
			attempt = previous[0]
			return nil
		}
		maxAttempts := assessment.MaxAttempts
		if maxAttempts < 1 {
			maxAttempts = 1
		}
		if len(previous) >= maxAttempts {
			return fiber.NewError(403, "Batas percobaan asesmen sudah digunakan")
		}
		deadline := now.Add(time.Duration(assessment.DurationMinute) * time.Minute)
		if assessment.EndsAt != nil && assessment.EndsAt.Before(deadline) {
			deadline = *assessment.EndsAt
		}
		number := 1
		if len(previous) > 0 {
			number = previous[0].Number + 1
		}
		attempt = Attempt{AssessmentID: assessment.ID, StudentID: student.ID, ClassIDAtAttempt: student.KelasID, Number: number, Status: "started", Seed: uuid.NewString(), StartedAt: &now, DeadlineAt: &deadline}
		if err := tx.Create(&attempt).Error; err != nil {
			return err
		}
		created = true
		var items []AssessmentItem
		if err := tx.Where("assessment_id = ?", assessment.ID).Order("position").Find(&items).Error; err != nil {
			return err
		}
		if assessment.Randomize {
			first, second := deterministicShuffleSeed(attempt.Seed, assessment.ID)
			random := rand.New(rand.NewPCG(first, second))
			random.Shuffle(len(items), func(i, j int) { items[i], items[j] = items[j], items[i] })
			if assessment.RandomizeOptions {
				for index := range items {
					items[index].SnapshotJSON = shuffleSnapshotOptions(items[index].SnapshotJSON, random)
				}
			}
		} else if assessment.RandomizeOptions {
			first, second := deterministicShuffleSeed(attempt.Seed, assessment.ID)
			random := rand.New(rand.NewPCG(first, second))
			for index := range items {
				items[index].SnapshotJSON = shuffleSnapshotOptions(items[index].SnapshotJSON, random)
			}
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
	if created {
		s.audit(account.ID, "start_attempt", attempt.ID)
		return c.Status(201).JSON(studentAttemptSummary(attempt))
	}
	return c.JSON(studentAttemptSummary(attempt))
}
func studentSafeConfig(raw string) any {
	if strings.TrimSpace(raw) == "" || !json.Valid([]byte(raw)) {
		return nil
	}
	return sanitizeStudentConfig(raw)
}

func safeSnapshot(raw string) fiber.Map {
	var snapshot questionSnapshot
	_ = json.Unmarshal([]byte(raw), &snapshot)
	var stimulus any
	if strings.TrimSpace(snapshot.StimulusJSON) != "" && json.Valid([]byte(snapshot.StimulusJSON)) {
		_ = json.Unmarshal([]byte(snapshot.StimulusJSON), &stimulus)
	}
	return fiber.Map{"id": snapshot.ID, "title": snapshot.Title, "type": snapshot.Type, "prompt": snapshot.Prompt, "description": snapshot.Description, "stimulus": stimulus, "config": studentSafeConfig(snapshot.ConfigJSON), "points": snapshot.Points}
}

func studentAttemptSummary(attempt Attempt) fiber.Map {
	return fiber.Map{"id": attempt.ID, "assessmentId": attempt.AssessmentID, "status": attempt.Status, "startedAt": attempt.StartedAt, "deadlineAt": attempt.DeadlineAt, "submittedAt": attempt.SubmittedAt, "number": attempt.Number}
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
	return c.JSON(fiber.Map{"attempt": studentAttemptSummary(attempt), "items": output, "serverTime": time.Now().UTC()})
}

func resultVisible(assessment Assessment, attempt Attempt) bool {
	if !assessment.ShowResult || assessment.ResultsPolicy == "hidden" || attempt.NeedsManual || attempt.Status == "pending_grade" {
		return false
	}
	if assessment.ResultsPolicy == "after_review" {
		return attempt.Status == "completed"
	}
	return attempt.Status == "completed" || attempt.Status == "submitted"
}

func (s *Server) studentAttempts(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempts []Attempt
	if err := s.db.Where("student_id = ?", account.PesertaDidikID).Order("started_at desc").Limit(100).Find(&attempts).Error; err != nil {
		return err
	}
	output := make([]fiber.Map, 0, len(attempts))
	for _, attempt := range attempts {
		var assessment Assessment
		if err := s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil {
			continue
		}
		entry := fiber.Map{"id": attempt.ID, "assessmentId": assessment.ID, "title": assessment.Title, "kind": assessment.Kind, "status": attempt.Status, "startedAt": attempt.StartedAt, "deadlineAt": attempt.DeadlineAt, "number": attempt.Number, "resultAvailable": resultVisible(assessment, attempt)}
		if resultVisible(assessment, attempt) {
			entry["score"] = attempt.Score
		}
		output = append(output, entry)
	}
	return c.JSON(output)
}

func (s *Server) studentAttemptResult(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ? AND student_id = ?", c.Params("id"), account.PesertaDidikID).Error; err != nil {
		return fiber.NewError(404, "Hasil tidak ditemukan")
	}
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	visible := resultVisible(assessment, attempt)
	result := fiber.Map{"available": visible, "status": attempt.Status, "pendingManual": attempt.NeedsManual, "title": assessment.Title, "showReview": visible && assessment.ShowReview}
	if !visible {
		return c.JSON(result)
	}
	result["score"] = attempt.Score
	var class MasterKelas
	if s.db.First(&class, "id = ?", attempt.ClassIDAtAttempt).Error == nil {
		result["className"] = class.Nama
	}
	if assessment.ShowReview {
		var items []AttemptItem
		var answers []Answer
		_ = s.db.Where("attempt_id = ?", attempt.ID).Order("position").Find(&items).Error
		_ = s.db.Where("attempt_id = ?", attempt.ID).Find(&answers).Error
		byID := map[string]Answer{}
		for _, answer := range answers {
			byID[answer.AttemptItemID] = answer
		}
		details := make([]fiber.Map, 0, len(items))
		for _, item := range items {
			answer := byID[item.ID]
			entry := safeSnapshot(item.SnapshotJSON)
			entry["answer"] = answer.ValueJSON
			entry["correct"] = answer.Correct
			if answer.ManualScore != nil {
				entry["score"] = *answer.ManualScore
			} else {
				entry["score"] = answer.AutoScore
			}
			details = append(details, entry)
		}
		result["items"] = details
	}
	return c.JSON(result)
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
func (s *Server) saveAnswer(c *fiber.Ctx) error {
	account := currentAccount(c)
	var input struct {
		Value    json.RawMessage `json:"value"`
		Revision int             `json:"revision"`
	}
	if c.BodyParser(&input) != nil || len(input.Value) == 0 || !json.Valid(input.Value) {
		return fiber.NewError(400, "Jawaban tidak valid")
	}
	var answer Answer
	manual := false
	err := s.db.Transaction(func(tx *gorm.DB) error {
		var attempt Attempt
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&attempt, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(404, "Percobaan tidak ditemukan")
		}
		if err := s.canWriteAttempt(account, attempt); err != nil {
			return err
		}
		var item AttemptItem
		if err := tx.First(&item, "id = ? AND attempt_id = ?", c.Params("itemId"), attempt.ID).Error; err != nil {
			return fiber.NewError(404, "Soal tidak ditemukan")
		}
		var snapshot questionSnapshot
		_ = json.Unmarshal([]byte(item.SnapshotJSON), &snapshot)
		correct, score, needsManual := grade(snapshot, string(input.Value), item.Weight)
		manual = needsManual
		err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).Where("attempt_id = ? AND attempt_item_id = ?", attempt.ID, item.ID).First(&answer).Error
		if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		if errors.Is(err, gorm.ErrRecordNotFound) {
			if input.Revision != 0 {
				return fiber.NewError(409, "Versi jawaban sudah berubah; muat kembali jawaban tersimpan")
			}
			answer = Answer{AttemptID: attempt.ID, AttemptItemID: item.ID, ValueJSON: string(input.Value), Correct: correct, AutoScore: score, Revision: 1}
		} else {
			if input.Revision != answer.Revision {
				return fiber.NewError(409, "Versi jawaban sudah berubah; muat kembali jawaban tersimpan")
			}
			answer.ValueJSON, answer.Correct, answer.AutoScore, answer.Revision = string(input.Value), correct, score, answer.Revision+1
		}
		if err := tx.Create(&AttemptAnswerRevision{AttemptID: attempt.ID, AttemptItemID: item.ID, ActorID: account.ID, Source: "student_autosave", Revision: answer.Revision, ValueJSON: answer.ValueJSON}).Error; err != nil {
			return err
		}
		return tx.Save(&answer).Error
	})
	if err != nil {
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

func (s *Server) uploadAttemptFile(c *fiber.Ctx) error {
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
	var snapshot questionSnapshot
	_ = json.Unmarshal([]byte(item.SnapshotJSON), &snapshot)
	if snapshot.Type != "unggah_berkas" {
		return fiber.NewError(400, "Soal ini tidak menerima unggahan")
	}
	config := configObject(snapshot.ConfigJSON)
	allowed := stringSlice(config["allowedFileTypes"])
	if len(allowed) == 0 {
		allowed = []string{"pdf", "docx", "xlsx", "png", "jpg", "jpeg"}
	}
	file, err := c.FormFile("file")
	if err != nil {
		return fiber.NewError(400, "Pilih berkas terlebih dahulu")
	}
	extension := strings.TrimPrefix(strings.ToLower(filepath.Ext(filepath.Base(file.Filename))), ".")
	allowedExtension := false
	for _, ext := range allowed {
		if strings.EqualFold(strings.TrimPrefix(ext, "."), extension) {
			allowedExtension = true
			break
		}
	}
	if !allowedExtension {
		return fiber.NewError(400, "Jenis berkas tidak diizinkan untuk soal ini")
	}
	maxMB := 10.0
	if value, ok := config["maxFileSizeMB"].(json.Number); ok {
		if parsed, parseErr := value.Float64(); parseErr == nil && parsed > 0 && parsed <= 20 {
			maxMB = parsed
		}
	} else if value, ok := config["maxFileSizeMB"].(float64); ok && value > 0 && value <= 20 {
		maxMB = value
	}
	maxBytes := int64(maxMB * 1024 * 1024)
	if file.Size > maxBytes {
		return fiber.NewError(413, fmt.Sprintf("Ukuran berkas maksimal %.0f MB", maxMB))
	}
	maxFiles := 1
	if value, ok := config["maxFiles"].(json.Number); ok {
		if parsed, parseErr := value.Int64(); parseErr == nil && parsed >= 1 && parsed <= 10 {
			maxFiles = int(parsed)
		}
	} else if value, ok := config["maxFiles"].(float64); ok && value >= 1 && value <= 10 {
		maxFiles = int(value)
	}
	var existing int64
	if err := s.db.Model(&AttemptAttachment{}).Where("attempt_item_id = ? AND deleted_at IS NULL", item.ID).Count(&existing).Error; err != nil {
		return err
	}
	if int(existing) >= maxFiles {
		return fiber.NewError(400, fmt.Sprintf("Maksimal %d berkas untuk soal ini", maxFiles))
	}
	opened, err := file.Open()
	if err != nil {
		return fiber.NewError(400, "Berkas tidak dapat dibaca")
	}
	defer opened.Close()
	data, err := io.ReadAll(io.LimitReader(opened, maxBytes+1))
	if err != nil || len(data) == 0 {
		return fiber.NewError(400, "Berkas kosong atau tidak dapat dibaca")
	}
	if int64(len(data)) > maxBytes {
		return fiber.NewError(413, fmt.Sprintf("Ukuran berkas maksimal %.0f MB", maxMB))
	}
	detected := http.DetectContentType(data[:min(len(data), 512)])
	if !safeUploadType(extension, detected) {
		return fiber.NewError(400, "Isi berkas tidak sesuai dengan ekstensi yang diizinkan")
	}
	id := uuid.NewString()
	stored := id + "." + extension
	directory := filepath.Join(s.cfg.UploadsDir, "answers")
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	path := filepath.Join(directory, stored)
	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	attachment := AttemptAttachment{Base: Base{ID: id}, AttemptID: attempt.ID, AttemptItemID: item.ID, StudentID: attempt.StudentID, StoredName: stored, OriginalName: filepath.Base(file.Filename), ContentType: detected, Size: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}
	if err := s.db.Create(&attachment).Error; err != nil {
		_ = os.Remove(path)
		return err
	}
	s.audit(account.ID, "upload_attempt_file", attachment.ID)
	return c.Status(201).JSON(fiber.Map{"id": attachment.ID, "name": attachment.OriginalName, "size": attachment.Size, "contentType": attachment.ContentType})
}

func safeUploadType(extension, detected string) bool {
	mediaType, _, _ := mime.ParseMediaType(detected)
	switch extension {
	case "pdf":
		return mediaType == "application/pdf"
	case "png":
		return mediaType == "image/png"
	case "jpg", "jpeg":
		return mediaType == "image/jpeg"
	case "docx":
		return mediaType == "application/zip" || mediaType == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
	case "xlsx":
		return mediaType == "application/zip" || mediaType == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
	default:
		return false
	}
}

func (s *Server) deleteAttemptFile(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attachment AttemptAttachment
	if err := s.db.First(&attachment, "id = ? AND attempt_item_id = ? AND deleted_at IS NULL", c.Params("fileId"), c.Params("itemId")).Error; err != nil {
		return fiber.NewError(404, "Berkas tidak ditemukan")
	}
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ? AND student_id = ?", attachment.AttemptID, account.PesertaDidikID).Error; err != nil {
		return fiber.NewError(404, "Berkas tidak ditemukan")
	}
	if err := s.canWriteAttempt(account, attempt); err != nil {
		return err
	}
	now := time.Now()
	if err := s.db.Model(&attachment).Update("deleted_at", now).Error; err != nil {
		return err
	}
	_ = os.Remove(filepath.Join(s.cfg.UploadsDir, "answers", attachment.StoredName))
	s.audit(account.ID, "delete_attempt_file", attachment.ID)
	return c.SendStatus(204)
}

func (s *Server) sendAttemptFile(c *fiber.Ctx, attachment AttemptAttachment) error {
	path := filepath.Join(s.cfg.UploadsDir, "answers", filepath.Base(attachment.StoredName))
	if _, err := os.Stat(path); err != nil {
		return fiber.NewError(404, "Berkas tidak ditemukan")
	}
	c.Set(fiber.HeaderContentType, attachment.ContentType)
	c.Set(fiber.HeaderContentDisposition, fmt.Sprintf("attachment; filename=%q", filepath.Base(attachment.OriginalName)))
	c.Set("X-Content-Type-Options", "nosniff")
	return c.SendFile(path)
}

func (s *Server) downloadAttemptFile(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attachment AttemptAttachment
	if err := s.db.First(&attachment, "id = ? AND attempt_id = ? AND deleted_at IS NULL", c.Params("fileId"), c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Berkas tidak ditemukan")
	}
	if attachment.StudentID != account.PesertaDidikID {
		return fiber.NewError(403, "Akses ditolak")
	}
	return s.sendAttemptFile(c, attachment)
}

func (s *Server) downloadStaffAnswerFile(c *fiber.Ctx) error {
	account := currentAccount(c)
	var answer Answer
	if err := s.db.First(&answer, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Jawaban tidak ditemukan")
	}
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ?", answer.AttemptID).Error; err != nil {
		return fiber.NewError(404, "Jawaban tidak ditemukan")
	}
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil || !staffCanWrite(account, assessment.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Akses ditolak")
	}
	var attachment AttemptAttachment
	if err := s.db.First(&attachment, "id = ? AND attempt_id = ? AND deleted_at IS NULL", c.Params("fileId"), attempt.ID).Error; err != nil {
		return fiber.NewError(404, "Berkas tidak ditemukan")
	}
	return s.sendAttemptFile(c, attachment)
}

func finalizeAttemptTx(tx *gorm.DB, attempt *Attempt, submittedAt time.Time) error {
	var items []AttemptItem
	if err := tx.Where("attempt_id = ?", attempt.ID).Find(&items).Error; err != nil {
		return err
	}
	var answers []Answer
	if err := tx.Where("attempt_id = ?", attempt.ID).Find(&answers).Error; err != nil {
		return err
	}
	byItem := make(map[string]Answer, len(answers))
	for _, answer := range answers {
		byItem[answer.AttemptItemID] = answer
	}
	score, needsManual := 0.0, false
	for _, item := range items {
		answer, found := byItem[item.ID]
		if !found {
			var snapshot questionSnapshot
			_ = json.Unmarshal([]byte(item.SnapshotJSON), &snapshot)
			correct, autoScore, manual := grade(snapshot, "null", item.Weight)
			answer = Answer{AttemptID: attempt.ID, AttemptItemID: item.ID, ValueJSON: "null", Correct: correct, AutoScore: autoScore, Revision: 1}
			if err := tx.Create(&answer).Error; err != nil {
				return err
			}
			byItem[item.ID] = answer
			if manual {
				needsManual = true
			}
		}
		if answer.ManualScore != nil {
			score += *answer.ManualScore
		} else {
			score += answer.AutoScore
		}
		if answer.Correct == nil && answer.ManualScore == nil {
			needsManual = true
		}
	}
	attempt.Score, attempt.NeedsManual, attempt.SubmittedAt = score, needsManual, &submittedAt
	if needsManual {
		attempt.Status = "pending_grade"
	} else {
		attempt.Status = "completed"
	}
	return tx.Save(attempt).Error
}

func (s *Server) submitAttempt(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempt Attempt
	var assessment Assessment
	newlySubmitted := false
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&attempt, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(404, "Percobaan tidak ditemukan")
		}
		if attempt.StudentID != account.PesertaDidikID {
			return fiber.NewError(403, "Akses ditolak")
		}
		if err := tx.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil {
			return fiber.NewError(404, "Asesmen tidak ditemukan")
		}
		if attempt.Status != "started" {
			return nil
		}
		newlySubmitted = true
		return finalizeAttemptTx(tx, &attempt, time.Now())
	})
	if err != nil {
		return err
	}
	if newlySubmitted {
		_ = s.enqueueAttemptResult(attempt.ID)
		s.audit(account.ID, "submit_attempt", attempt.ID)
	}
	visible := resultVisible(assessment, attempt)
	payload := fiber.Map{"status": attempt.Status, "showResult": visible, "pendingManual": attempt.NeedsManual}
	if visible {
		payload["score"] = attempt.Score
	}
	return c.JSON(payload)
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

func (s *Server) staffAttemptDetail(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Percobaan tidak ditemukan")
	}
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, assessment.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Akses ditolak")
	}
	var student MasterPeserta
	_ = s.db.First(&student, "id = ?", attempt.StudentID).Error
	var items []AttemptItem
	var answers []Answer
	if err := s.db.Where("attempt_id = ?", attempt.ID).Order("position").Find(&items).Error; err != nil {
		return err
	}
	if err := s.db.Where("attempt_id = ?", attempt.ID).Find(&answers).Error; err != nil {
		return err
	}
	answerByItem := make(map[string]Answer, len(answers))
	for _, answer := range answers {
		answerByItem[answer.AttemptItemID] = answer
	}
	output := make([]fiber.Map, 0, len(items))
	for _, item := range items {
		answer := answerByItem[item.ID]
		var question fiber.Map
		if account.Role == "kepala_sekolah" {
			question = safeSnapshot(item.SnapshotJSON)
		} else {
			var snapshot questionSnapshot
			_ = json.Unmarshal([]byte(item.SnapshotJSON), &snapshot)
			question = fiber.Map{"id": snapshot.ID, "title": snapshot.Title, "type": snapshot.Type, "prompt": snapshot.Prompt, "description": snapshot.Description, "configJson": snapshot.ConfigJSON, "answerJson": snapshot.AnswerJSON, "rubricJson": snapshot.RubricJSON, "points": snapshot.Points}
		}
		output = append(output, fiber.Map{"itemId": item.ID, "answerId": answer.ID, "position": item.Position, "weight": item.Weight, "question": question, "answer": answer.ValueJSON, "correct": answer.Correct, "autoScore": answer.AutoScore, "manualScore": answer.ManualScore, "comment": answer.Comment, "revision": answer.Revision})
	}
	return c.JSON(fiber.Map{"attempt": fiber.Map{"id": attempt.ID, "assessmentId": attempt.AssessmentID, "studentId": attempt.StudentID, "studentName": student.Nama, "classIdAtAttempt": attempt.ClassIDAtAttempt, "status": attempt.Status, "score": attempt.Score, "needsManual": attempt.NeedsManual, "startedAt": attempt.StartedAt, "submittedAt": attempt.SubmittedAt}, "items": output})
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
	if err := s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, assessment.OwnerID) {
		return fiber.NewError(403, "Akses ditolak")
	}
	var input struct {
		Score   float64 `json:"score"`
		Comment string  `json:"comment"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Nilai manual tidak valid")
	}
	if input.Score < 0 || strings.TrimSpace(input.Comment) == "" || len(input.Comment) > 4000 {
		return fiber.NewError(400, "Nilai harus valid dan komentar penilaian wajib diisi")
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&answer, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(404, "Jawaban tidak ditemukan")
		}
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&attempt, "id = ?", answer.AttemptID).Error; err != nil {
			return fiber.NewError(404, "Percobaan tidak ditemukan")
		}
		if err := tx.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil || !staffCanWrite(account, assessment.OwnerID) {
			return fiber.NewError(403, "Akses ditolak")
		}
		var item AttemptItem
		if err := tx.First(&item, "id = ? AND attempt_id = ?", answer.AttemptItemID, attempt.ID).Error; err != nil {
			return fiber.NewError(404, "Soal jawaban tidak ditemukan")
		}
		if answer.Correct != nil {
			return fiber.NewError(400, "Jawaban ini sudah dinilai otomatis dan tidak memerlukan penilaian manual")
		}
		if input.Score > item.Weight {
			return fiber.NewError(400, "Nilai manual melebihi bobot soal")
		}
		answer.ManualScore, answer.Comment = &input.Score, strings.TrimSpace(input.Comment)
		if err := tx.Save(&answer).Error; err != nil {
			return err
		}
		var answers []Answer
		if err := tx.Where("attempt_id = ?", attempt.ID).Find(&answers).Error; err != nil {
			return err
		}
		attempt.Score, attempt.NeedsManual = 0, false
		for _, row := range answers {
			if row.ManualScore != nil {
				attempt.Score += *row.ManualScore
			} else {
				attempt.Score += row.AutoScore
			}
			if row.Correct == nil && row.ManualScore == nil {
				attempt.NeedsManual = true
			}
		}
		if !attempt.NeedsManual && attempt.Status == "pending_grade" {
			attempt.Status = "completed"
		}
		return tx.Save(&attempt).Error
	})
	if err != nil {
		return err
	}
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
