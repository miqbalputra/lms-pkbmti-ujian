package main

import (
	"crypto/sha256"
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
	"sync"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"github.com/google/uuid"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type Config struct {
	Env, JWTSecret, PublicBaseURL, LMSBaseURL, LMSPublicURL, IntegrationKeyID, IntegrationSecret, SSOSecret, UploadsDir string
	SyncInterval                                                                                                        time.Duration
	ForceHTTPS                                                                                                          bool
	TrustedProxies                                                                                                      []string
}
type Server struct {
	db         *gorm.DB
	cfg        Config
	httpClient *http.Client
	syncMu     sync.Mutex
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

func shuffledAssessmentItems(items []AssessmentItem, attemptSeed, assessmentID string) ([]AssessmentItem, *rand.Rand) {
	rows := append([]AssessmentItem(nil), items...)
	first, second := deterministicShuffleSeed(attemptSeed, assessmentID)
	random := rand.New(rand.NewPCG(first, second))
	// Keep shared stimuli and section/branch dependencies intact. Legacy items
	// without grouping metadata retain the same flat deterministic shuffle.
	groups := map[string][]AssessmentItem{}
	keys := []string{}
	for rowIndex, row := range rows {
		var snap questionSnapshot
		_ = json.Unmarshal([]byte(row.SnapshotJSON), &snap)
		config := configObject(snap.ConfigJSON)
		section := asString(config["sectionId"])
		key := asString(config["stimulusGroupId"])
		if section != "" || len(mapFrom(config["branchToByAnswer"])) > 0 {
			key = "section:" + section
		} else if key != "" {
			key = "stimulus:" + key
		} else {
			key = fmt.Sprintf("item:%d", rowIndex)
		}
		if _, ok := groups[key]; !ok {
			keys = append(keys, key)
		}
		groups[key] = append(groups[key], row)
	}
	// A sectioned document is kept in its authored dependency order; only
	// unsectioned, independent stimulus groups are shuffled.
	sectioned := false
	for _, key := range keys {
		if strings.HasPrefix(key, "section:") {
			sectioned = true
		}
	}
	if !sectioned {
		random.Shuffle(len(keys), func(i, j int) { keys[i], keys[j] = keys[j], keys[i] })
	}
	rows = rows[:0]
	for _, key := range keys {
		rows = append(rows, groups[key]...)
	}
	return rows, random
}

func main() {
	trustedProxies, err := parseTrustedProxies(env("TRUSTED_PROXY_IPS", ""))
	if err != nil {
		panic(err)
	}
	forceHTTPS, err := strconv.ParseBool(env("FORCE_HTTPS", "false"))
	if err != nil {
		panic("FORCE_HTTPS harus bernilai true atau false")
	}
	lmsBaseURL := strings.TrimRight(env("LMS_BASE_URL", "http://localhost:8080"), "/")
	cfg := Config{Env: env("APP_ENV", "development"), JWTSecret: env("JWT_SECRET", "development-secret-change-me-32-chars"), PublicBaseURL: env("PUBLIC_BASE_URL", "http://localhost:5173"), LMSBaseURL: lmsBaseURL, LMSPublicURL: strings.TrimRight(env("LMS_PUBLIC_URL", lmsBaseURL), "/"), IntegrationKeyID: env("LMS_INTEGRATION_KEY_ID", "cbt-local"), IntegrationSecret: env("LMS_INTEGRATION_HMAC_SECRET", "development-integration-secret-change-me"), SSOSecret: env("LMS_SSO_HMAC_SECRET", ""), UploadsDir: env("UPLOADS_DIR", "uploads"), SyncInterval: mustDuration(env("LMS_SYNC_INTERVAL", "5m")), ForceHTTPS: forceHTTPS, TrustedProxies: trustedProxies}
	if len(cfg.JWTSecret) < 32 && cfg.Env == "production" {
		panic("JWT_SECRET minimal 32 karakter")
	}
	if cfg.ForceHTTPS {
		if err := validateHTTPSBaseURL(cfg.PublicBaseURL); err != nil {
			panic(err)
		}
		if len(cfg.TrustedProxies) == 0 {
			panic("FORCE_HTTPS=true memerlukan TRUSTED_PROXY_IPS yang membatasi proxy Coolify tepercaya; jangan mempercayai X-Forwarded-Proto dari semua alamat")
		}
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
	app := fiber.New(fiber.Config{ErrorHandler: apiError, BodyLimit: 20 * 1024 * 1024, EnableTrustedProxyCheck: true, TrustedProxies: cfg.TrustedProxies})
	app.Use(securityHeaders())
	app.Use(s.embedHeaders())
	app.Use(httpsRedirect(cfg.ForceHTTPS, cfg.PublicBaseURL))
	app.Use(hidePoweredBy())
	app.Use(cors.New(cors.Config{AllowOrigins: cfg.PublicBaseURL, AllowHeaders: "Origin, Content-Type, Authorization, X-Request-ID", AllowCredentials: false}))
	app.Get("/health", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"status": "ok", "service": "cbt", "time": time.Now().UTC()})
	})
	api := app.Group("/api")
	api.Post("/auth/login", s.login)
	api.Post("/auth/sso/exchange", s.ssoExchange)
	app.Get("/sso/start", s.startSSO)
	api.Get("/auth/me", s.auth, func(c *fiber.Ctx) error {
		account := currentAccount(c)
		return c.JSON(fiber.Map{"id": account.ID, "username": account.Username, "nama": account.Nama, "role": account.Role, "pesertaDidikId": account.PesertaDidikID})
	})
	participantLimit := participantRateLimit()
	api.Use("/public", limiter.New(limiter.Config{Max: 2000, Expiration: time.Minute, LimitReached: func(c *fiber.Ctx) error {
		return c.Status(429).JSON(fiber.Map{"error": "Batas akses jaringan tercapai. Tunggu sebentar lalu coba lagi."})
	}}))
	api.Post("/public/ujian-online/cek", participantLimit, s.publicExamLogin)
	api.Post("/public/assessments/resolve", participantLimit, s.resolveAssessmentCode)
	api.Post("/public/assessments/login", participantLimit, s.publicExamLogin)
	api.Get("/public/config", func(c *fiber.Ctx) error {
		return c.JSON(fiber.Map{"publicBaseUrl": s.cfg.PublicBaseURL, "formsEnabled": env("CBT_FORMS_ENABLED", "false") == "true"})
	})
	api.Get("/question-media/:id", s.auth, s.downloadQuestionMedia)
	student := api.Group("/student", s.auth, requireRoles("siswa"))
	student.Get("/identity", s.studentRosterIdentity)
	student.Get("/assessments", s.studentAssessments)
	student.Post("/assessments/:id/verify", s.verifyStudentAssessment)
	student.Get("/attempts", s.studentAttempts)
	student.Post("/assessments/:id/start", s.startAttempt)
	student.Get("/attempts/:id", s.studentAttempt)
	student.Get("/attempts/:id/results", s.studentAttemptResult)
	student.Post("/attempts/:id/reopen", s.reopenFormResponse)
	student.Put("/attempts/:id/items/:itemId/answer", s.saveAnswer)
	student.Put("/attempts/:id/items/:itemId/flag", s.flagAttemptItem)
	student.Post("/attempts/:id/items/:itemId/files", s.uploadAttemptFile)
	student.Delete("/attempts/:id/items/:itemId/files/:fileId", s.deleteAttemptFile)
	student.Get("/attempts/:id/files/:fileId", s.downloadAttemptFile)
	student.Post("/attempts/:id/submit", s.submitAttempt)
	student.Post("/attempts/:id/recovery", s.submitLateRecovery)
	staff := api.Group("/staff", s.auth, requireRoles("admin", "guru", "kepala_sekolah"))
	s.registerForms(api, staff)
	staff.Get("/questions", s.listQuestions)
	staff.Get("/question-folders", s.listQuestionFolders)
	staff.Use(s.protectFormAdapter)
	staff.Post("/question-folders", s.createQuestionFolder)
	staff.Put("/question-folders/:id", s.updateQuestionFolder)
	staff.Delete("/question-folders/:id", s.deleteQuestionFolder)
	staff.Post("/questions", s.createQuestion)
	staff.Put("/questions/:id/folder", s.moveQuestionFolder)
	staff.Post("/questions/metadata-defaults", s.fillQuestionMetadataDefaults)
	staff.Post("/question-media", s.uploadQuestionMedia)
	staff.Post("/questions/import", s.importQuestions)
	staff.Get("/questions/import/template/:format", s.downloadQuestionImportTemplate)
	staff.Get("/questions/import/example-20", s.downloadQuestionImportExample)
	staff.Put("/questions/:id", s.updateQuestion)
	staff.Post("/questions/:id/revision", s.createQuestionRevision)
	staff.Post("/questions/:id/unpublish", s.unpublishQuestion)
	staff.Get("/questions/:id/history", s.questionHistory)
	staff.Post("/questions/:id/restore/:versionId", s.restoreQuestionVersion)
	staff.Delete("/questions/:id", s.archiveQuestion)
	staff.Post("/questions/:id/trash", s.trashQuestion)
	staff.Post("/questions/:id/restore", s.restoreQuestion)
	staff.Post("/questions/:id/unarchive", s.unarchiveQuestion)
	staff.Get("/question-packages", s.listQuestionPackages)
	staff.Post("/question-packages", s.createQuestionPackage)
	staff.Get("/question-packages/:id", s.getQuestionPackage)
	staff.Put("/question-packages/:id", s.updateQuestionPackage)
	staff.Put("/question-packages/:id/assignments", s.updateQuestionPackageAssignments)
	staff.Post("/question-packages/:id/questions", s.createQuestionInPackage)
	staff.Post("/question-packages/:id/publish", s.publishQuestionPackage)
	staff.Post("/question-packages/:id/unpublish", s.unpublishQuestionPackage)
	staff.Post("/question-packages/:id/archive", s.archiveQuestionPackage)
	staff.Post("/question-packages/:id/unarchive", s.unarchiveQuestionPackage)
	staff.Post("/question-packages/:id/duplicate", s.duplicateQuestionPackage)
	staff.Get("/assessments", s.listAssessments)
	staff.Get("/schedule", s.listAssessmentSchedule)
	staff.Get("/assessments/:id/monitor", s.assessmentMonitor)
	staff.Get("/assessment-templates", s.listAssessmentTemplates)
	staff.Post("/assessment-templates/:templateId/draft", s.createAssessmentTemplateDraft)
	staff.Post("/assessments", s.createAssessment)
	staff.Post("/assessments/drafts", s.createAssessmentDraft)
	staff.Get("/assessments/:id", s.getAssessment)
	staff.Post("/assessments/:id/duplicate", s.duplicateAssessment)
	staff.Put("/assessments/:id/draft", s.saveAssessmentDraft)
	staff.Put("/assessments/:id", s.updateAssessment)
	staff.Post("/assessments/:id/publish", s.publishAssessment)
	staff.Post("/assessments/:id/unpublish", s.unpublishAssessment)
	staff.Post("/assessments/:id/archive", s.archiveAssessment)
	staff.Post("/assessments/:id/unarchive", s.unarchiveAssessment)
	staff.Post("/assessments/:id/trash", s.trashAssessment)
	staff.Post("/assessments/:id/restore", s.restoreAssessment)
	staff.Get("/trash", s.listTrash)
	staff.Get("/archive", s.listArchive)
	staff.Put("/assessments/:id/items/order", s.reorderItems)
	staff.Get("/assessments/:id/results", s.assessmentResults)
	staff.Get("/assessments/:id/item-analysis", s.assessmentItemAnalysis)
	staff.Get("/assessments/:id/results/export.csv", s.exportAssessmentResultsCSV)
	staff.Get("/assessments/:id/results/export.xlsx", func(c *fiber.Ctx) error { return s.exportAssessmentReport(c, "xlsx") })
	staff.Get("/assessments/:id/results/export.pdf", func(c *fiber.Ctx) error { return s.exportAssessmentReport(c, "pdf") })
	staff.Get("/attempts/:id", s.staffAttemptDetail)
	staff.Post("/answers/:id/grade", s.gradeAnswer)
	staff.Get("/answers/:id/files/:fileId", s.downloadStaffAnswerFile)
	staff.Get("/recoveries", s.listAttemptRecoveries)
	staff.Post("/recoveries/:id/review", s.reviewAttemptRecovery)
	staff.Get("/master/students", s.listStudents)
	staff.Get("/master/classes", s.listClasses)
	staff.Get("/master/groups", s.listLearningGroups)
	staff.Get("/master/subjects", s.listSubjects)
	staff.Post("/master/classes/manual-label", s.createManualClassLabel)
	staff.Get("/sync/status", s.syncStatus)
	staff.Get("/sync/history", s.syncHistory)
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
	// Schema/index changes commit together. A failed additive migration must
	// retain the previous uniqueness constraints as well as all legacy records.
	return s.db.Transaction(func(tx *gorm.DB) error {
		// Local accounts/attempts have no imported source ID. Keep uniqueness for
		// nonempty source IDs without making the second local row fail. No data changes.
		for _, index := range []string{"idx_cbt_accounts_source_user_id", "idx_attempts_source_attempt_id"} {
			var definition string
			if err := tx.Raw("SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = ?", index).Scan(&definition).Error; err != nil {
				return err
			}
			if definition != "" && !strings.Contains(strings.ToUpper(definition), " WHERE ") {
				if err := tx.Exec("DROP INDEX " + index).Error; err != nil {
					return err
				}
			}
		}
		// Older CBT releases enforced a unique index on NISN. The LMS intentionally
		// shares a temporary placeholder NISN across multiple learners, so remove
		// that index before AutoMigrate recreates the field as a normal lookup index.
		if tx.Migrator().HasIndex(&MasterPeserta{}, "NISN") {
			if err := tx.Migrator().DropIndex(&MasterPeserta{}, "NISN"); err != nil {
				return fmt.Errorf("remove obsolete unique index on master student NISN: %w", err)
			}
		}
		return tx.AutoMigrate(&CBTAccount{}, &CBTSSOState{}, &MasterKelas{}, &MasterPeserta{}, &MasterKelompokBelajar{}, &MasterTahunAjaran{}, &MasterProgram{}, &MasterFase{}, &MasterTutor{}, &MasterMapel{}, &QuestionFolder{}, &Question{}, &QuestionPackage{}, &PackageAssignment{}, &QuestionVersion{}, &QuestionMedia{}, &Assessment{}, &AssessmentItem{}, &AssessmentAssignment{}, &Attempt{}, &AttemptItem{}, &Answer{}, &AttemptAttachment{}, &AttemptRecovery{}, &AttemptAnswerRevision{}, &AuditLog{}, &SyncState{}, &SyncRun{}, &IntegrationNonce{}, &IntegrationOutbox{}, &MigrationBatch{}, &FormDocument{}, &FormCollaborator{}, &FormMediaGrant{}, &FormVersion{}, &FormAccessLink{}, &FormResponseRevision{}, &FormTutorPreference{}, &AssessmentClassTarget{})
	})
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
	Revision            int     `json:"revision"`
	FolderID            string  `json:"folderId"`
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
	EstimatedMinutes    int     `json:"estimatedMinutes"`
	Curriculum          string  `json:"curriculum"`
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
	in.FolderID = strings.TrimSpace(in.FolderID)
	in.Tags = normalizeQuestionTags(in.Tags)
	in.Difficulty = strings.ToLower(strings.TrimSpace(in.Difficulty))
	if in.Difficulty == "" {
		in.Difficulty = "sedang"
	}
	if in.Difficulty != "mudah" && in.Difficulty != "sedang" && in.Difficulty != "sulit" {
		return fiber.NewError(400, "Kesukaran harus dipilih: mudah, sedang, atau sulit")
	}
	in.Curriculum = strings.TrimSpace(in.Curriculum)
	if in.Curriculum == "" {
		in.Curriculum = "Belum dipetakan"
	}
	if len([]rune(in.Curriculum)) > 120 {
		return fiber.NewError(400, "Tag kurikulum/CP maksimal 120 karakter")
	}
	if in.EstimatedMinutes < 0 {
		return fiber.NewError(400, "Estimasi waktu tidak boleh negatif")
	}
	if in.EstimatedMinutes == 0 {
		in.EstimatedMinutes = defaultEstimatedMinutes(in.Type, in.Prompt)
	}
	if in.EstimatedMinutes > 180 {
		return fiber.NewError(400, "Estimasi waktu soal maksimal 180 menit")
	}
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
	query := s.db.Where("archived_at IS NULL AND trashed_at IS NULL")
	if account.Role == "guru" {
		query = query.Where("owner_id = ?", account.ID)
	}
	if folderID := strings.TrimSpace(c.Query("folderId")); folderID != "" {
		if folderID == "unfiled" {
			query = query.Where("(folder_id IS NULL OR folder_id = '')")
		} else {
			query = query.Where("folder_id = ?", folderID)
		}
	}
	if text := strings.TrimSpace(c.Query("search")); text != "" {
		query = query.Where("(strpos(lower(title), lower(?)) > 0 OR strpos(lower(prompt), lower(?)) > 0 OR strpos(lower(description), lower(?)) > 0)", text, text, text)
	}
	if questionType := strings.TrimSpace(c.Query("type")); questionType != "" {
		query = query.Where("type = ?", questionType)
	}
	if subject := strings.TrimSpace(c.Query("subject")); subject != "" {
		query = query.Where("lower(subject) = lower(?)", subject)
	}
	if grade := strings.TrimSpace(c.Query("grade")); grade != "" {
		if gradeValue, err := strconv.Atoi(grade); err == nil && gradeValue >= 1 && gradeValue <= 12 {
			query = query.Where("grade = ?", gradeValue)
		} else {
			return fiber.NewError(400, "Filter kelas harus berada pada rentang 1–12")
		}
	}
	if difficulty := strings.TrimSpace(c.Query("difficulty")); difficulty != "" {
		query = query.Where("lower(difficulty) = lower(?)", difficulty)
	}
	var rows []Question
	sortBy := strings.TrimSpace(c.Query("sort"))
	if sortBy == "used" {
		query = query.Order("updated_at DESC")
	} else {
		sortBy = "newest"
		query = query.Order("updated_at DESC")
	}
	if err := query.Find(&rows).Error; err != nil {
		return err
	}
	if tag := strings.TrimSpace(c.Query("tag")); tag != "" {
		filtered := rows[:0]
		for _, row := range rows {
			if questionHasTag(row.Tags, tag) {
				filtered = append(filtered, row)
			}
		}
		rows = filtered
	}
	if len(rows) > 0 {
		ids := make([]string, len(rows))
		for index := range rows {
			ids[index] = rows[index].ID
		}
		var usage []struct {
			QuestionID string
			UsedCount  int64
		}
		if err := s.db.Model(&AssessmentItem{}).Select("assessment_items.question_id, COUNT(DISTINCT assessment_items.assessment_id) AS used_count").Joins("JOIN assessments ON assessments.id = assessment_items.assessment_id").Where("assessment_items.question_id IN ? AND assessments.status IN ? AND assessments.trashed_at IS NULL", ids, []string{"published", "archived"}).Group("assessment_items.question_id").Scan(&usage).Error; err != nil {
			return err
		}
		counts := make(map[string]int64, len(usage))
		for _, item := range usage {
			counts[item.QuestionID] = item.UsedCount
		}
		for index := range rows {
			rows[index].UsedCount = counts[rows[index].ID]
		}
		if sortBy == "used" {
			sort.SliceStable(rows, func(i, j int) bool {
				if rows[i].UsedCount == rows[j].UsedCount {
					return rows[i].UpdatedAt.After(rows[j].UpdatedAt)
				}
				return rows[i].UsedCount > rows[j].UsedCount
			})
		}
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
	if err := s.validateQuestionMediaOwner(account, input); err != nil {
		return err
	}
	if input.Status == "published" {
		return fiber.NewError(409, "Soal baru harus disimpan sebagai draf. Terbitkan soal melalui paket asesmen.")
	}
	if err := validateQuestionFolder(s.db, account, input.FolderID, ""); err != nil {
		return err
	}
	row := Question{OwnerID: account.ID, FolderID: input.FolderID, Title: input.Title, Program: input.Program, Grade: input.Grade, Phase: input.Phase, Mode: input.Mode, Subject: input.Subject, Domain: input.Domain, Topic: input.Topic, Competency: input.Competency, CognitiveLevel: input.CognitiveLevel, Difficulty: input.Difficulty, EstimatedMinutes: input.EstimatedMinutes, Curriculum: input.Curriculum, Tags: input.Tags, Type: input.Type, Prompt: input.Prompt, Description: input.Description, StimulusJSON: input.StimulusJSON, ConfigJSON: input.ConfigJSON, AnswerJSON: input.AnswerJSON, RubricJSON: input.RubricJSON, InternalExplanation: input.InternalExplanation, Points: input.Points, Status: input.Status, Revision: 1}
	if err := s.db.Create(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "create_question", row.ID)
	return c.Status(201).JSON(row)
}
func (s *Server) updateQuestion(c *fiber.Ctx) error {
	account := currentAccount(c)
	var input questionInput
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(400, "Data soal tidak valid")
	}
	if err := normalizeQuestionInput(&input); err != nil {
		return err
	}
	if err := s.validateQuestionMediaOwner(account, input); err != nil {
		return err
	}
	if input.Status == "published" {
		return fiber.NewError(409, "Soal diterbitkan melalui paket asesmen dan tidak dapat diterbitkan langsung.")
	}
	var updated Question
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var row Question
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&row, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(404, "Soal tidak ditemukan")
		}
		if !staffCanWrite(account, row.OwnerID) {
			return fiber.NewError(403, "Anda tidak dapat mengubah soal ini")
		}
		if row.TrashedAt != nil || row.ArchivedAt != nil {
			return fiber.NewError(409, "Soal yang diarsipkan atau berada di Trash tidak dapat diedit. Pulihkan terlebih dahulu.")
		}
		if err := editableQuestionStatus(row.Status); err != nil {
			return err
		}
		if input.Revision > 0 && input.Revision != row.Revision {
			return fiber.NewError(409, "Soal telah berubah di sesi lain. Muat ulang sebelum menyimpan.")
		}
		if err := validateQuestionFolder(tx, account, input.FolderID, row.OwnerID); err != nil {
			return err
		}
		if err := tx.Create(&QuestionVersion{QuestionID: row.ID, Revision: row.Revision, ChangedBy: account.ID, SnapshotJSON: questionSnapshotJSON(row)}).Error; err != nil {
			return err
		}
		applyQuestionInput(&row, input)
		row.Revision++
		if err := tx.Save(&row).Error; err != nil {
			return err
		}
		updated = row
		return nil
	}); err != nil {
		return err
	}
	s.audit(account.ID, "update_question", updated.ID)
	return c.JSON(updated)
}

func (s *Server) createQuestionRevision(c *fiber.Ctx) error {
	account := currentAccount(c)
	var source Question
	if err := s.db.First(&source, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Soal tidak ditemukan")
	}
	if !staffCanWrite(account, source.OwnerID) {
		return fiber.NewError(403, "Anda tidak dapat membuat revisi soal ini")
	}
	if source.Status != "published" || source.TrashedAt != nil || source.ArchivedAt != nil {
		return fiber.NewError(409, "Revisi hanya dapat dibuat dari soal terbit yang masih aktif")
	}
	revision := draftQuestionRevision(source)
	if err := s.db.Create(&revision).Error; err != nil {
		return err
	}
	s.audit(account.ID, "create_question_revision", revision.ID)
	return c.Status(201).JSON(revision)
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
	if row.TrashedAt != nil {
		return fiber.NewError(409, "Soal berada di Trash")
	}
	if row.ArchivedAt != nil {
		return fiber.NewError(409, "Soal sudah diarsipkan")
	}
	if row.PackageID != "" {
		return fiber.NewError(409, "Keluarkan soal dari paket terlebih dahulu. Arsip paket tidak menghapus butir soal.")
	}
	now := time.Now()
	row.ArchivedFromStatus = row.Status
	row.Status = "archived"
	row.ArchivedAt = &now
	if err := s.db.Save(&row).Error; err != nil {
		return err
	}
	s.audit(account.ID, "archive_question", row.ID)
	return c.SendStatus(204)
}

type assessmentInput struct {
	Kind, Title, Description, ClassID, Room, SubjectID, Status                string
	AccessCode                                                                *string `json:"accessCode"`
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
	return validAssessmentSchedule(in.StartsAt, in.EndsAt)
}
func validAssessmentSchedule(startsAt, endsAt *time.Time) error {
	if startsAt != nil && endsAt != nil && !endsAt.After(*startsAt) {
		return fiber.NewError(400, "Tanggal selesai harus setelah tanggal mulai")
	}
	return nil
}
func (s *Server) listAssessments(c *fiber.Ctx) error {
	account := currentAccount(c)
	query := s.db.Model(&Assessment{}).Where("trashed_at IS NULL")
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
	row := Assessment{OwnerID: account.ID, Kind: input.Kind, Title: strings.TrimSpace(input.Title), Description: input.Description, Instructions: input.Instructions, ClassID: input.ClassID, Room: strings.TrimSpace(input.Room), SubjectID: input.SubjectID, Status: status, DurationMinute: input.DurationMinute, StartsAt: input.StartsAt, EndsAt: input.EndsAt, Randomize: input.Randomize, ShowResult: input.ShowResult, MaxAttempts: input.MaxAttempts, PassScore: input.PassScore, ResultsPolicy: input.ResultsPolicy, ShowReview: input.ShowReview, RandomizeOptions: input.RandomizeOptions, ProgressBar: input.ProgressBar, ConfirmationMessage: input.ConfirmationMessage, ThemeJSON: input.ThemeJSON, SectionsJSON: input.SectionsJSON, Revision: 1}
	if err := s.setAssessmentAccessCode(&row, input.AccessCode); err != nil {
		return err
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := s.validatePublishedSchedule(tx, row); err != nil {
			return err
		}
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
	if err := validAssessmentSchedule(input.StartsAt, input.EndsAt); err != nil {
		return err
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
	row := Assessment{OwnerID: account.ID, Kind: input.Kind, Title: title, Description: input.Description, Instructions: input.Instructions, ClassID: input.ClassID, Room: strings.TrimSpace(input.Room), SubjectID: input.SubjectID, Status: "draft", DurationMinute: input.DurationMinute, StartsAt: input.StartsAt, EndsAt: input.EndsAt, Randomize: input.Randomize, ShowResult: input.ShowResult, MaxAttempts: input.MaxAttempts, PassScore: input.PassScore, ResultsPolicy: input.ResultsPolicy, ShowReview: input.ShowReview, RandomizeOptions: input.RandomizeOptions, ProgressBar: input.ProgressBar, ConfirmationMessage: input.ConfirmationMessage, ThemeJSON: input.ThemeJSON, SectionsJSON: input.SectionsJSON, Revision: 1}
	if err := s.setAssessmentAccessCode(&row, input.AccessCode); err != nil {
		return err
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
	if row.TrashedAt != nil || row.Status == "archived" {
		return fiber.NewError(409, "Paket diarsipkan atau berada di Trash; pulihkan sebelum mengedit")
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
	if err := validAssessmentSchedule(input.StartsAt, input.EndsAt); err != nil {
		return err
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
	row.Kind, row.Title, row.Description, row.Instructions, row.ClassID, row.Room, row.SubjectID = input.Kind, strings.TrimSpace(input.Title), input.Description, input.Instructions, input.ClassID, strings.TrimSpace(input.Room), input.SubjectID
	if row.Title == "" {
		row.Title = "Paket tanpa judul"
	}
	row.DurationMinute, row.StartsAt, row.EndsAt = input.DurationMinute, input.StartsAt, input.EndsAt
	row.Randomize, row.ShowResult, row.MaxAttempts, row.PassScore = input.Randomize, input.ShowResult, input.MaxAttempts, input.PassScore
	row.ResultsPolicy, row.ShowReview, row.RandomizeOptions, row.ProgressBar = input.ResultsPolicy, input.ShowReview, input.RandomizeOptions, input.ProgressBar
	row.ConfirmationMessage, row.ThemeJSON, row.SectionsJSON = input.ConfirmationMessage, input.ThemeJSON, input.SectionsJSON
	if err := s.setAssessmentAccessCode(&row, input.AccessCode); err != nil {
		return err
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
		if err := tx.First(&question, "id = ? AND archived_at IS NULL AND trashed_at IS NULL", item.QuestionID).Error; err != nil {
			return fiber.NewError(400, "Soal pilihan tidak ditemukan")
		}
		if account.Role == "guru" && question.OwnerID != account.ID {
			return fiber.NewError(403, "Guru hanya dapat memakai soal miliknya")
		}
		snapshot, _ := json.Marshal(questionSnapshot{ID: question.ID, Title: question.Title, FolderID: question.FolderID, Program: question.Program, Grade: question.Grade, Phase: question.Phase, Mode: question.Mode, Subject: question.Subject, Domain: question.Domain, Topic: question.Topic, Competency: question.Competency, CognitiveLevel: question.CognitiveLevel, Difficulty: question.Difficulty, EstimatedMinutes: question.EstimatedMinutes, Curriculum: question.Curriculum, Tags: question.Tags, Type: question.Type, Prompt: question.Prompt, Description: question.Description, StimulusJSON: question.StimulusJSON, ConfigJSON: question.ConfigJSON, AnswerJSON: question.AnswerJSON, RubricJSON: question.RubricJSON, InternalExplanation: question.InternalExplanation, Points: question.Points, TemplatePlaceholder: question.TemplatePlaceholder})
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
	if err := s.db.First(&row, "id = ? AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Akses ditolak")
	}
	var items []AssessmentItem
	var assignments []AssessmentAssignment
	_ = s.db.Where("assessment_id = ?", row.ID).Order("position").Find(&items).Error
	_ = s.db.Where("assessment_id = ?", row.ID).Find(&assignments).Error
	accessCode := ""
	if account.Role != "kepala_sekolah" {
		var err error
		accessCode, err = decryptAssessmentCode(s.cfg.JWTSecret, row.AccessCodeCiphertext)
		if err != nil {
			return fiber.NewError(500, "Kode akses draf tidak dapat dibuka. Buat kode baru sebelum menerbitkan.")
		}
	}
	assessment := struct {
		Assessment
		AccessCode           string `json:"accessCode,omitempty"`
		AccessCodeConfigured bool   `json:"accessCodeConfigured"`
	}{Assessment: row, AccessCode: accessCode, AccessCodeConfigured: row.AccessCodeHash != ""}
	return c.JSON(fiber.Map{"assessment": assessment, "items": items, "assignments": assignments})
}
func (s *Server) updateAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ? AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) {
		return fiber.NewError(403, "Akses ditolak")
	}
	if row.Status == "archived" {
		return fiber.NewError(409, "Pulihkan paket dari arsip sebelum mengubahnya")
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
	row.Kind, row.Title, row.Description, row.Instructions, row.ClassID, row.Room, row.SubjectID, row.DurationMinute, row.StartsAt, row.EndsAt, row.Randomize, row.ShowResult = input.Kind, input.Title, input.Description, input.Instructions, input.ClassID, strings.TrimSpace(input.Room), input.SubjectID, input.DurationMinute, input.StartsAt, input.EndsAt, input.Randomize, input.ShowResult
	row.MaxAttempts, row.PassScore, row.ResultsPolicy, row.ShowReview, row.RandomizeOptions, row.ProgressBar = input.MaxAttempts, input.PassScore, input.ResultsPolicy, input.ShowReview, input.RandomizeOptions, input.ProgressBar
	row.ConfirmationMessage, row.ThemeJSON, row.SectionsJSON = input.ConfirmationMessage, input.ThemeJSON, input.SectionsJSON
	if input.Status != "" {
		row.Status = input.Status
	}
	if err := s.setAssessmentAccessCode(&row, input.AccessCode); err != nil {
		return err
	}
	row.Revision++
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := s.validatePublishedSchedule(tx, row); err != nil {
			return err
		}
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
	if row.Status != "draft" || row.TrashedAt != nil {
		return fiber.NewError(409, "Hanya paket draf yang dapat diterbitkan")
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
		if json.Unmarshal([]byte(item.SnapshotJSON), &snapshot) != nil || snapshot.TemplatePlaceholder || !validQuestionForPublish(snapshot) || item.Weight <= 0 {
			if snapshot.TemplatePlaceholder {
				return fiber.NewError(400, fmt.Sprintf("Soal nomor %d masih berupa contoh template. Ganti teks dan lengkapi kunci atau rubrik sebelum menerbitkan.", index+1))
			}
			return fiber.NewError(400, fmt.Sprintf("Konfigurasi jawaban, bobot, atau rubrik soal nomor %d belum lengkap", index+1))
		}
	}
	promotedQuestionIDs := make([]string, 0, len(items))
	if err := s.db.Transaction(func(tx *gorm.DB) error {
		var current Assessment
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&current, "id = ?", row.ID).Error; err != nil {
			return fiber.NewError(404, "Asesmen tidak ditemukan")
		}
		if !staffCanWrite(account, current.OwnerID) || current.Status != "draft" || current.TrashedAt != nil {
			return fiber.NewError(409, "Asesmen berubah. Muat ulang draf sebelum menerbitkan.")
		}
		candidate := current
		candidate.Status = "published"
		if err := s.validatePublishedSchedule(tx, candidate); err != nil {
			return err
		}
		for _, item := range items {
			var source Question
			err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&source, "id = ?", item.QuestionID).Error
			if errors.Is(err, gorm.ErrRecordNotFound) {
				continue // The immutable item snapshot remains publishable even if its bank row was removed.
			}
			if err != nil {
				return err
			}
			if source.TrashedAt != nil || source.ArchivedAt != nil || source.Status == "published" {
				continue
			}
			if err := tx.Create(&QuestionVersion{QuestionID: source.ID, Revision: source.Revision, ChangedBy: account.ID, SnapshotJSON: questionSnapshotJSON(source)}).Error; err != nil {
				return err
			}
			source.Status = "published"
			source.Revision++
			if err := tx.Save(&source).Error; err != nil {
				return err
			}
			promotedQuestionIDs = append(promotedQuestionIDs, source.ID)
		}
		current.Status = "published"
		current.Revision++
		return tx.Save(&current).Error
	}); err != nil {
		return err
	}
	s.audit(account.ID, "publish_assessment", row.ID)
	for _, questionID := range promotedQuestionIDs {
		s.audit(account.ID, "publish_question_source", questionID)
	}
	row.Status = "published"
	row.Revision++
	return c.JSON(row)
}
func (s *Server) reorderItems(c *fiber.Ctx) error {
	account := currentAccount(c)
	var row Assessment
	if err := s.db.First(&row, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, row.OwnerID) || row.Status != "draft" || row.TrashedAt != nil {
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
	ID, Title, Type, Prompt, Description, ConfigJSON, AnswerJSON, RubricJSON                                                              string
	FolderID, Program, Phase, Mode, Subject, Domain, Topic, Competency, CognitiveLevel, Difficulty, Curriculum, Tags, InternalExplanation string
	Grade                                                                                                                                 int
	EstimatedMinutes                                                                                                                      int
	StimulusJSON                                                                                                                          string
	Points                                                                                                                                float64
	TemplatePlaceholder                                                                                                                   bool
}

func (s *Server) publicExamLogin(c *fiber.Ctx) error {
	var input struct {
		NISN         string `json:"nisn"`
		AccessCode   string `json:"accessCode"`
		AssessmentID string `json:"assessmentId"`
		LinkToken    string `json:"linkToken"`
	}
	if c.BodyParser(&input) != nil || strings.TrimSpace(input.NISN) == "" || strings.TrimSpace(input.AccessCode) == "" {
		return fiber.NewError(400, "NISN dan kode akses wajib diisi")
	}
	students := []MasterPeserta{}
	if err := s.db.Where("nisn = ? AND active = ?", strings.TrimSpace(input.NISN), true).Find(&students).Error; err != nil {
		return err
	}
	rows, err := s.accessibleByCode(input.AccessCode, input.AssessmentID)
	if err != nil {
		return err
	}
	linkID := ""
	if input.LinkToken != "" {
		linked, id, err := s.resolveFormLink(input.LinkToken)
		if err != nil {
			return err
		}
		linkID = id
		filtered := []Assessment{}
		for _, row := range rows {
			if row.ID == linked.ID {
				filtered = append(filtered, row)
			}
		}
		rows = filtered
	}
	var student MasterPeserta
	allowed := []Assessment{}
	// Placeholder/duplicate NISNs must never silently select the first learner.
	for _, candidate := range students {
		matches := []Assessment{}
		for _, row := range rows {
			permitted, err := s.studentHasAssessmentAccess(candidate, row)
			if err != nil {
				return err
			}
			if permitted {
				matches = append(matches, row)
			}
		}
		if len(matches) > 0 {
			if student.ID != "" {
				return fiber.NewError(409, "NISN belum unik di LMS. Hubungi tutor untuk memperbaiki identitas peserta.")
			}
			student, allowed = candidate, matches
		}
	}
	if len(allowed) == 0 {
		return fiber.NewError(401, "NISN atau kode tidak sesuai, peserta belum ditugaskan, atau jadwal tidak berlaku")
	}
	var account CBTAccount
	err = s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(hashtext(?))", "cbt-code-account:"+student.ID).Error; err != nil {
			return err
		}
		if err := tx.Where("peserta_didik_id = ?", student.ID).First(&account).Error; err == nil {
			if !account.Active || account.Role != "siswa" {
				return fiber.NewError(403, "Akun siswa tidak aktif")
			}
			return nil
		} else if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		password, err := hashPassword(uuid.NewString())
		if err != nil {
			return err
		}
		account = CBTAccount{SourceUserID: "cbt-code:" + student.ID, Username: "peserta-" + student.ID, Nama: student.Nama, Role: "siswa", PesertaDidikID: student.ID, Active: true, PasswordHash: password}
		return tx.Create(&account).Error
	})
	if err != nil {
		return err
	}
	ids := []string{}
	output := []fiber.Map{}
	for _, row := range allowed {
		ids = append(ids, row.ID)
		output = append(output, publicAssessment(row))
	}
	token, err := s.issueAssessmentToken(account, ids, linkID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"accessToken": token, "user": fiber.Map{"id": account.ID, "username": account.Username, "nama": student.Nama, "role": "siswa", "pesertaDidikId": student.ID}, "student": fiber.Map{"id": student.ID, "nama": student.Nama, "nis": student.NIS, "nisn": student.NISN}, "assessments": output})
}
func (s *Server) studentHasAssessmentAccess(student MasterPeserta, assessment Assessment) (bool, error) {
	return studentHasAssessmentAccessTx(s.db, student, assessment)
}
func studentHasAssessmentAccessTx(tx *gorm.DB, student MasterPeserta, assessment Assessment) (bool, error) {
	var assignmentCount, directAssignmentCount int64
	if err := tx.Model(&AssessmentAssignment{}).Where("assessment_id = ?", assessment.ID).Count(&assignmentCount).Error; err != nil {
		return false, err
	}
	if assignmentCount == 0 {
		var count int64
		if err := tx.Model(&AssessmentClassTarget{}).Where("assessment_id = ?", assessment.ID).Count(&count).Error; err != nil {
			return false, err
		}
		if count > 0 {
			var matched int64
			err := tx.Model(&AssessmentClassTarget{}).Where("assessment_id = ? AND class_id = ?", assessment.ID, student.KelasID).Count(&matched).Error
			return matched > 0, err
		}
		return assessment.ClassID == student.KelasID, nil
	}
	if err := tx.Model(&AssessmentAssignment{}).Where("assessment_id = ? AND student_id = ?", assessment.ID, student.ID).Count(&directAssignmentCount).Error; err != nil {
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
	gradeLevel := 0
	var studentClass MasterKelas
	if s.db.Select("jenjang").First(&studentClass, "id = ?", student.KelasID).Error == nil {
		gradeLevel = studentClass.Jenjang
	}
	var candidates []Assessment
	if err := s.db.Where("status = ? AND trashed_at IS NULL", "published").Order("starts_at asc nulls first, title asc").Find(&candidates).Error; err != nil {
		return err
	}
	rows := make([]fiber.Map, 0, len(candidates))
	for _, assessment := range candidates {
		if scope, _ := c.Locals("assessmentScope").([]string); len(scope) > 0 && !containsString(scope, assessment.ID) {
			continue
		}
		permitted, err := s.studentHasAssessmentAccess(student, assessment)
		if err != nil {
			return err
		}
		if permitted {
			className, subjectName := "", assessment.SubjectID
			var class MasterKelas
			if s.db.Select("nama").First(&class, "id = ?", assessment.ClassID).Error == nil {
				className = class.Nama
			}
			var subject MasterMapel
			if s.db.Select("nama").First(&subject, "id = ?", assessment.SubjectID).Error == nil && strings.TrimSpace(subject.Nama) != "" {
				subjectName = subject.Nama
			}
			rows = append(rows, fiber.Map{
				"id": assessment.ID, "kind": assessment.Kind, "title": assessment.Title,
				"description": assessment.Description, "instructions": assessment.Instructions,
				"classId": assessment.ClassID, "className": className, "subjectId": assessment.SubjectID,
				"subjectName": subjectName, "gradeLevel": gradeLevel, "room": assessment.Room, "durationMinute": assessment.DurationMinute,
				"startsAt": assessment.StartsAt, "endsAt": assessment.EndsAt,
				"randomize": assessment.Randomize, "progressBar": assessment.ProgressBar,
				"accessCodeRequired": assessment.AccessCodeHash != "",
			})
		}
	}
	return c.JSON(rows)
}

func (s *Server) verifyStudentAssessment(c *fiber.Ctx) error {
	account := currentAccount(c)
	var input struct {
		AccessCode string `json:"accessCode"`
	}
	if len(strings.TrimSpace(string(c.Body()))) > 0 {
		if err := c.BodyParser(&input); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "Kode akses tidak valid")
		}
	}
	var student MasterPeserta
	if err := s.db.First(&student, "id = ? AND active = ?", account.PesertaDidikID, true).Error; err != nil {
		return fiber.NewError(fiber.StatusForbidden, "Profil siswa tidak aktif")
	}
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ? AND status = ? AND trashed_at IS NULL", c.Params("id"), "published").Error; err != nil {
		return fiber.NewError(fiber.StatusNotFound, "Asesmen tidak tersedia")
	}
	permitted, err := s.studentHasAssessmentAccess(student, assessment)
	if err != nil {
		return err
	}
	if !permitted {
		return fiber.NewError(fiber.StatusForbidden, "Anda tidak ditugaskan pada asesmen ini")
	}
	if !assessmentAccessCodeMatches(assessment, input.AccessCode) {
		return fiber.NewError(fiber.StatusUnauthorized, "Token tidak sesuai. Periksa kembali token dari tutor.")
	}
	now := time.Now()
	if assessment.StartsAt != nil && now.Before(*assessment.StartsAt) {
		return fiber.NewError(fiber.StatusForbidden, "Asesmen belum dimulai sesuai jadwal")
	}
	if assessment.EndsAt != nil && now.After(*assessment.EndsAt) {
		return fiber.NewError(fiber.StatusForbidden, "Waktu akses asesmen sudah berakhir")
	}
	className, subjectName := "", assessment.SubjectID
	var class MasterKelas
	if s.db.Select("nama").First(&class, "id = ?", student.KelasID).Error == nil {
		className = class.Nama
	}
	var subject MasterMapel
	if s.db.Select("nama").First(&subject, "id = ?", assessment.SubjectID).Error == nil && strings.TrimSpace(subject.Nama) != "" {
		subjectName = subject.Nama
	}
	return c.JSON(fiber.Map{
		"verified":   true,
		"student":    fiber.Map{"id": student.ID, "name": student.Nama, "nis": student.NIS, "nisn": student.NISN, "className": className, "gender": student.JenisKelamin, "learningGroup": s.studentLearningGroup(student.PokjarID)},
		"assessment": fiber.Map{"id": assessment.ID, "title": assessment.Title, "kind": assessment.Kind, "subjectName": subjectName, "durationMinute": assessment.DurationMinute, "room": assessment.Room, "startsAt": assessment.StartsAt, "endsAt": assessment.EndsAt, "instructions": assessment.Instructions},
		"serverTime": now.UTC(),
	})
}

func (s *Server) startAttempt(c *fiber.Ctx) error {
	account := currentAccount(c)
	var input struct {
		AccessCode string `json:"accessCode"`
	}
	if len(strings.TrimSpace(string(c.Body()))) > 0 {
		if err := c.BodyParser(&input); err != nil {
			return fiber.NewError(fiber.StatusBadRequest, "Data mulai asesmen tidak valid")
		}
	}
	var student MasterPeserta
	if err := s.db.First(&student, "id = ? AND active = ?", account.PesertaDidikID, true).Error; err != nil {
		return fiber.NewError(403, "Siswa tidak aktif")
	}
	var assessment Assessment
	var attempt Attempt
	created := false
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&assessment, "id = ? AND status = ? AND trashed_at IS NULL", c.Params("id"), "published").Error; err != nil {
			return fiber.NewError(404, "Asesmen tidak tersedia")
		}
		permitted, err := studentHasAssessmentAccessTx(tx, student, assessment)
		if err != nil {
			return err
		}
		if !permitted {
			return fiber.NewError(403, "Anda tidak ditugaskan pada asesmen ini")
		}
		var previous []Attempt
		if err := tx.Where("assessment_id = ? AND student_id = ?", assessment.ID, student.ID).Order("number desc").Find(&previous).Error; err != nil {
			return err
		}
		if len(previous) > 0 && previous[0].Status == "started" {
			if previous[0].DeadlineAt != nil && time.Now().After(*previous[0].DeadlineAt) {
				return fiber.NewError(fiber.StatusForbidden, "Waktu percobaan sudah berakhir. Hubungi tutor jika perlu bantuan.")
			}
			attempt = previous[0]
			return nil
		}
		if assessment.ResponsesPaused {
			return fiber.NewError(403, "Penerimaan peserta baru sedang dijeda oleh tutor")
		}
		now := time.Now()
		if assessment.StartsAt != nil && now.Before(*assessment.StartsAt) || assessment.EndsAt != nil && now.After(*assessment.EndsAt) {
			return fiber.NewError(403, "Asesmen tidak berada dalam jadwal")
		}
		if !assessmentAccessCodeMatches(assessment, input.AccessCode) {
			return fiber.NewError(fiber.StatusUnauthorized, "Token wajib diisi dan harus sesuai sebelum ujian dimulai")
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
		attempt = Attempt{AssessmentID: assessment.ID, FormVersionID: assessment.FormVersionID, StudentID: student.ID, ClassIDAtAttempt: student.KelasID, Number: number, Status: "started", Seed: uuid.NewString(), StartedAt: &now, DeadlineAt: &deadline}
		if err := tx.Create(&attempt).Error; err != nil {
			return err
		}
		created = true
		var items []AssessmentItem
		if err := tx.Where("assessment_id = ?", assessment.ID).Order("position").Find(&items).Error; err != nil {
			return err
		}
		var random *rand.Rand
		if assessment.Randomize {
			items, random = shuffledAssessmentItems(items, attempt.Seed, assessment.ID)
		}
		if assessment.RandomizeOptions {
			if random == nil {
				first, second := deterministicShuffleSeed(attempt.Seed, assessment.ID)
				random = rand.New(rand.NewPCG(first, second))
			}
			for index := range items {
				items[index].SnapshotJSON = shuffleSnapshotOptions(items[index].SnapshotJSON, random)
			}
		}
		attemptItems := []AttemptItem{}
		for index, item := range items {
			row := AttemptItem{AttemptID: attempt.ID, AssessmentItemID: item.ID, QuestionID: item.QuestionID, Position: index + 1, Weight: item.Weight, SnapshotJSON: item.SnapshotJSON}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			attemptItems = append(attemptItems, row)
		}
		linkID, _ := c.Locals("accessLinkID").(string)
		return s.materializePrefill(tx, linkID, assessment, attempt, attemptItems)
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
	activeIDs, err := s.activeIDsForAttempt(attempt.ID)
	if err != nil {
		return err
	}
	display, err := attemptFormDisplay(s.db, attempt)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"attempt": studentAttemptSummary(attempt), "items": output, "activeItemIds": activeIDs, "serverTime": time.Now().UTC(), "display": display})
}

func resultVisible(assessment Assessment, attempt Attempt) bool {
	if !assessment.ShowResult || assessment.ResultsPolicy == "hidden" || attempt.NeedsManual || attempt.Status == "pending_grade" {
		return false
	}
	if assessment.ResultsPolicy == "after_review" {
		// Legacy policies remain unchanged; new Forms explicitly require release.
		if assessment.FormVersionID != "" && (assessment.ResultsReleasedAt == nil || attempt.SubmittedAt != nil && assessment.ResultsReleasedAt.Before(*attempt.SubmittedAt)) {
			return false
		}
		return attempt.Status == "completed"
	}
	return attempt.Status == "completed" || attempt.Status == "submitted"
}

func (s *Server) studentAttempts(c *fiber.Ctx) error {
	account := currentAccount(c)
	var attempts []Attempt
	query := s.db.Where("student_id = ?", account.PesertaDidikID)
	if scope, _ := c.Locals("assessmentScope").([]string); len(scope) > 0 {
		query = query.Where("assessment_id IN ?", scope)
	}
	if err := query.Order("started_at desc").Limit(100).Find(&attempts).Error; err != nil {
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
	result := fiber.Map{"attemptId": attempt.ID, "canEdit": canReopenFormResponse(s.db, attempt), "available": visible, "status": attempt.Status, "pendingManual": attempt.NeedsManual, "title": assessment.Title, "showReview": visible && assessment.ShowReview}
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
		active, err := activeAttemptItems(s.db, attempt, items, answers)
		if err != nil {
			return err
		}
		items = active
		byID := map[string]Answer{}
		for _, answer := range answers {
			byID[answer.AttemptItemID] = answer
		}
		details := make([]fiber.Map, 0, len(items))
		for _, item := range items {
			answer := byID[item.ID]
			entry := safeSnapshot(item.SnapshotJSON)
			entry["question"] = safeSnapshot(item.SnapshotJSON)
			entry["position"], entry["weight"] = item.Position, item.Weight
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
	requestKey := strings.TrimSpace(c.Get("Idempotency-Key"))
	if requestKey != "" {
		if _, err := uuid.Parse(requestKey); err != nil {
			return fiber.NewError(400, "ID penyimpanan tidak valid")
		}
	}
	requestHash := hash(currentAccount(c).ID + ":" + c.Params("itemId") + ":" + marshalJSON(input))
	err := s.db.Transaction(func(tx *gorm.DB) error {
		var attempt Attempt
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&attempt, "id = ?", c.Params("id")).Error; err != nil {
			return fiber.NewError(404, "Percobaan tidak ditemukan")
		}
		if attempt.StudentID != account.PesertaDidikID {
			return fiber.NewError(403, "Akses ditolak")
		}
		if requestKey != "" {
			var receipt AttemptAnswerRevision
			err := tx.First(&receipt, "attempt_id = ? AND request_key = ?", attempt.ID, requestKey).Error
			if err == nil {
				if receipt.RequestHash != requestHash {
					return fiber.NewError(409, "ID penyimpanan telah digunakan untuk perubahan lain")
				}
				answer = Answer{AttemptID: attempt.ID, AttemptItemID: receipt.AttemptItemID, Revision: receipt.Revision}
				return nil
			}
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				return err
			}
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
		// New typed Forms enforce response shape; historical snapshots retain
		// their original permissive contract for compatibility.
		if attempt.FormVersionID != "" {
			if err := validateResponse(snapshot, decodeJSON(string(input.Value)), false); err != nil {
				return err
			}
			if err := validateResponseAttachments(tx, item, snapshot, decodeJSON(string(input.Value))); err != nil {
				return err
			}
		}
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
			// Marking of an earlier submitted response must not apply to new text.
			if attempt.FormVersionID != "" {
				answer.ManualScore = nil
				answer.Comment = ""
			}
		}
		if err := tx.Create(&AttemptAnswerRevision{AttemptID: attempt.ID, AttemptItemID: item.ID, ActorID: account.ID, Source: "student_autosave", Revision: answer.Revision, ValueJSON: answer.ValueJSON, RequestKey: requestKey, RequestHash: requestHash}).Error; err != nil {
			return err
		}
		return tx.Save(&answer).Error
	})
	if err != nil {
		return err
	}
	activeIDs, err := s.activeIDsForAttempt(answer.AttemptID)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"id": answer.ID, "revision": answer.Revision, "manual": manual, "saved": true, "activeItemIds": activeIDs})
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
	if err := s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil || !s.canReadAssessment(s.db, account, assessment) {
		return fiber.NewError(403, "Akses ditolak")
	}
	var attachment AttemptAttachment
	if err := s.db.First(&attachment, "id = ? AND attempt_id = ? AND attempt_item_id = ? AND deleted_at IS NULL", c.Params("fileId"), attempt.ID, answer.AttemptItemID).Error; err != nil {
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
	activeItems, err := activeAttemptItems(tx, *attempt, items, answers)
	if err != nil {
		return err
	}
	items = activeItems
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
		// Prefilled responses are not graded when an attempt starts. At submit,
		// calculate them from the immutable snapshot, just like an autosaved
		// response, without mistaking a missing objective grade for manual work.
		if found && answer.Correct == nil && answer.ManualScore == nil {
			var snapshot questionSnapshot
			if err := json.Unmarshal([]byte(item.SnapshotJSON), &snapshot); err != nil {
				return err
			}
			correct, autoScore, manual := grade(snapshot, answer.ValueJSON, item.Weight)
			if !manual {
				answer.Correct, answer.AutoScore = correct, autoScore
				if err := tx.Model(&Answer{}).Where("id = ?", answer.ID).Updates(map[string]any{"correct": correct, "auto_score": autoScore}).Error; err != nil {
					return err
				}
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
		if attempt.FormVersionID != "" && (attempt.DeadlineAt == nil || time.Now().Before(*attempt.DeadlineAt)) {
			var items []AttemptItem
			var answers []Answer
			if err := tx.Where("attempt_id = ?", attempt.ID).Find(&items).Error; err != nil {
				return err
			}
			if err := tx.Where("attempt_id = ?", attempt.ID).Find(&answers).Error; err != nil {
				return err
			}
			active, err := activeAttemptItems(tx, attempt, items, answers)
			if err != nil {
				return err
			}
			if attempt.FormVersionID != "" {
				if err := validateRequiredAnswers(tx, active, answers); err != nil {
					return err
				}
			}
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
	if !s.canReadAssessment(s.db, account, assessment) {
		return fiber.NewError(403, "Akses ditolak")
	}
	filters, err := parseResultFilters(c)
	if err != nil {
		return err
	}
	var attempts []Attempt
	if err := filteredAttemptQuery(s.db, assessment.ID, filters).Order("started_at desc").Find(&attempts).Error; err != nil {
		return err
	}
	studentIDs := make([]string, 0, len(attempts))
	for _, attempt := range attempts {
		studentIDs = append(studentIDs, attempt.StudentID)
	}
	var students []MasterPeserta
	if len(studentIDs) > 0 {
		if err := s.db.Where("id IN ?", studentIDs).Find(&students).Error; err != nil {
			return err
		}
	}
	names := make(map[string]string, len(students))
	for _, student := range students {
		names[student.ID] = student.Nama
	}
	output := make([]fiber.Map, 0, len(attempts))
	for _, attempt := range attempts {
		output = append(output, fiber.Map{"id": attempt.ID, "assessmentId": attempt.AssessmentID, "studentId": attempt.StudentID, "studentName": names[attempt.StudentID], "classIdAtAttempt": attempt.ClassIDAtAttempt, "number": attempt.Number, "status": attempt.Status, "score": attempt.Score, "needsManual": attempt.NeedsManual, "startedAt": attempt.StartedAt, "submittedAt": attempt.SubmittedAt, "deadlineAt": attempt.DeadlineAt})
	}
	return c.JSON(output)
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
	if !s.canReadAssessment(s.db, account, assessment) {
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
	return s.exportAssessmentReport(c, "csv")
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
	if !s.canGradeAssessment(s.db, account, assessment) {
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
		if err := tx.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil || !s.canGradeAssessment(tx, account, assessment) {
			return fiber.NewError(403, "Akses ditolak")
		}
		if attempt.FormVersionID != "" && attempt.Status == "started" {
			return fiber.NewError(409, "Siswa masih menyunting respons. Tunggu hingga dikirim kembali.")
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
		var items []AttemptItem
		if err := tx.Where("attempt_id = ?", attempt.ID).Find(&items).Error; err != nil {
			return err
		}
		items, err := activeAttemptItems(tx, attempt, items, answers)
		if err != nil {
			return err
		}
		active := map[string]bool{}
		for _, item := range items {
			active[item.ID] = true
		}
		if !active[answer.AttemptItemID] {
			return fiber.NewError(400, "Soal ini tidak termasuk jalur respons aktif")
		}
		attempt.Score, attempt.NeedsManual = 0, false
		for _, row := range answers {
			if !active[row.AttemptItemID] {
				continue
			}
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

// createManualClassLabel is a temporary recovery path for LMS integrations that
// have synced active students but have not synced their class metadata yet. It
// only creates a label for an existing source class ID and never invents a
// class without a verified active student roster. The next successful LMS sync
// replaces this fallback with the authoritative class record.
func (s *Server) createManualClassLabel(c *fiber.Ctx) error {
	account := currentAccount(c)
	if account.Role == "kepala_sekolah" {
		return fiber.NewError(fiber.StatusForbidden, "Kepala sekolah hanya dapat melihat")
	}
	var input struct {
		ClassID string `json:"classId"`
		Name    string `json:"name"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(fiber.StatusBadRequest, "Data kelas manual tidak valid")
	}
	input.ClassID = strings.TrimSpace(input.ClassID)
	input.Name = strings.TrimSpace(input.Name)
	if input.ClassID == "" || len(input.ClassID) > 128 || input.Name == "" || len([]rune(input.Name)) > 100 {
		return fiber.NewError(fiber.StatusBadRequest, "Pilih kelas dari peserta tersinkron dan isi nama kelas (maksimal 100 karakter)")
	}
	var row MasterKelas
	err := s.db.Transaction(func(tx *gorm.DB) error {
		var students int64
		if err := tx.Model(&MasterPeserta{}).Where("kelas_id = ? AND active = ?", input.ClassID, true).Count(&students).Error; err != nil {
			return err
		}
		if students == 0 {
			return fiber.NewError(fiber.StatusConflict, "Kelas manual harus merujuk ke kelas dengan peserta aktif yang sudah tersinkron dari LMS")
		}
		err := tx.First(&row, "id = ?", input.ClassID).Error
		if err == nil {
			return fiber.NewError(fiber.StatusConflict, "Data kelas sudah tercatat. Sinkronkan ulang LMS untuk memperbarui daftar kelas")
		}
		if err != gorm.ErrRecordNotFound {
			return err
		}
		row = MasterKelas{Base: Base{ID: input.ClassID}, Nama: input.Name, Active: true, ManualFallback: true}
		return tx.Create(&row).Error
	})
	if err != nil {
		return err
	}
	s.audit(account.ID, "create_manual_class_label", row.ID)
	return c.Status(fiber.StatusCreated).JSON(row)
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
