package main

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type lmsAccount struct {
	ID             string    `json:"id"`
	Username       string    `json:"username"`
	Nama           string    `json:"nama"`
	Role           string    `json:"role"`
	TutorID        string    `json:"tutorId"`
	PesertaDidikID string    `json:"pesertaDidikId"`
	Active         bool      `json:"active"`
	UpdatedAt      time.Time `json:"updatedAt"`
}
type lmsKelas struct {
	ID        string    `json:"id"`
	Nama      string    `json:"nama"`
	Jenjang   int       `json:"jenjang"`
	Active    bool      `json:"active"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type lmsPeserta struct {
	ID        string    `json:"id"`
	Nama      string    `json:"nama"`
	NISN      string    `json:"nisn"`
	KelasID   string    `json:"kelasId"`
	Active    bool      `json:"active"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type lmsTutor struct {
	ID        string    `json:"id"`
	Nama      string    `json:"nama"`
	Active    bool      `json:"active"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type lmsMapel struct {
	ID        string    `json:"id"`
	Nama      string    `json:"nama"`
	Kode      string    `json:"kode"`
	Active    bool      `json:"active"`
	UpdatedAt time.Time `json:"updatedAt"`
}
type masterPayload struct {
	Cursor       string       `json:"cursor"`
	Accounts     []lmsAccount `json:"accounts"`
	Kelas        []lmsKelas   `json:"kelas"`
	PesertaDidik []lmsPeserta `json:"pesertaDidik"`
	Tutor        []lmsTutor   `json:"tutor"`
	Mapel        []lmsMapel   `json:"mapel"`
}

func (s *Server) integrationSignature(method, path, timestamp, nonce string, body []byte) string {
	mac := hmac.New(sha256.New, []byte(s.cfg.IntegrationSecret))
	_, _ = mac.Write([]byte(strings.ToUpper(method) + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n"))
	_, _ = mac.Write(body)
	return hex.EncodeToString(mac.Sum(nil))
}
func (s *Server) lmsRequest(method, path string, body []byte) (*http.Response, error) {
	if strings.TrimSpace(s.cfg.LMSBaseURL) == "" {
		return nil, fmt.Errorf("LMS_BASE_URL belum diisi")
	}
	timestamp := fmt.Sprintf("%d", time.Now().Unix())
	nonce := newIntegrationNonce()
	req, err := http.NewRequest(method, s.cfg.LMSBaseURL+path, bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("X-CBT-Key-ID", s.cfg.IntegrationKeyID)
	req.Header.Set("X-CBT-Timestamp", timestamp)
	req.Header.Set("X-CBT-Nonce", nonce)
	req.Header.Set("X-CBT-Signature", s.integrationSignature(method, path, timestamp, nonce, body))
	if len(body) > 0 {
		req.Header.Set("Content-Type", "application/json")
	}
	return s.httpClient.Do(req)
}
func readJSONResponse[T any](response *http.Response, output *T) error {
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 64*1024*1024))
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		var details map[string]any
		message := ""
		if json.Unmarshal(data, &details) == nil {
			for _, key := range []string{"error", "message"} {
				if value, ok := details[key].(string); ok && strings.TrimSpace(value) != "" {
					message = strings.TrimSpace(value)
					break
				}
			}
		}
		if len(message) > 300 {
			message = message[:300]
		}
		if message == "" {
			return fmt.Errorf("LMS merespons HTTP %d", response.StatusCode)
		}
		return fmt.Errorf("LMS merespons HTTP %d: %s", response.StatusCode, message)
	}
	return json.Unmarshal(data, output)
}
func syncCursor(db *gorm.DB) string {
	var state SyncState
	if err := db.First(&state, "key = ?", "master_cursor").Error; err == nil {
		return state.Value
	}
	return ""
}
func setSyncState(db *gorm.DB, key, value string) error {
	return db.Save(&SyncState{Key: key, Value: value, UpdatedAt: time.Now()}).Error
}

type syncCounts struct {
	Accounts int `json:"accounts"`
	Classes  int `json:"classes"`
	Students int `json:"students"`
	Tutors   int `json:"tutors"`
	Subjects int `json:"subjects"`
}

func syncErrorMessage(err error) string {
	if err == nil {
		return "Sinkronisasi LMS berhasil."
	}
	message := strings.ToLower(err.Error())
	switch {
	case strings.Contains(message, "http 401") || strings.Contains(message, "http 403"):
		return "LMS menolak autentikasi integrasi. Periksa LMS_INTEGRATION_KEY_ID dan LMS_INTEGRATION_HMAC_SECRET di kedua aplikasi."
	case strings.Contains(message, "integrasi cbt belum dikonfigurasi"):
		return "Integrasi belum dikonfigurasi di LMS. Isi CBT_INTEGRATION_KEY_ID dan CBT_INTEGRATION_HMAC_SECRET di environment LMS, lalu samakan nilainya dengan LMS_INTEGRATION_KEY_ID dan LMS_INTEGRATION_HMAC_SECRET di CBT."
	case strings.Contains(message, "http 404"):
		return "Endpoint sinkronisasi LMS tidak ditemukan. Periksa LMS_BASE_URL dan pastikan backend LMS mendukung integrasi CBT."
	case strings.Contains(message, "http 502"):
		return "Gateway gagal menghubungi LMS (HTTP 502). Periksa LMS_BASE_URL, domain/port di Coolify, dan log backend LMS; data terakhir tetap digunakan."
	case strings.Contains(message, "http 503"):
		return "Endpoint integrasi LMS belum siap (HTTP 503). Periksa CBT_INTEGRATION_KEY_ID dan CBT_INTEGRATION_HMAC_SECRET di environment LMS, lalu lihat log LMS; data terakhir tetap digunakan."
	case strings.Contains(message, "http 504"):
		return "Layanan integrasi LMS sedang tidak tersedia. Data terakhir tetap digunakan; sistem akan mencoba lagi otomatis."
	case strings.Contains(message, "timeout") || strings.Contains(message, "deadline exceeded"):
		return "LMS tidak merespons dalam batas waktu. Periksa koneksi server dan status LMS; sistem akan mencoba lagi otomatis."
	case strings.Contains(message, "connection refused") || strings.Contains(message, "no such host") || strings.Contains(message, "network is unreachable"):
		return "CBT tidak dapat terhubung ke LMS. Periksa LMS_BASE_URL, DNS, dan koneksi jaringan antarserver."
	case strings.Contains(message, "invalid character") || strings.Contains(message, "unexpected eof"):
		return "LMS mengirim data yang formatnya tidak valid. Periksa versi backend dan log integrasi LMS."
	default:
		return "Sinkronisasi LMS gagal setelah beberapa percobaan. Data terakhir tetap digunakan; lihat detail teknis atau log server."
	}
}

func masterFeedPath(cursor string) string {
	path := "/api/integrations/cbt/v1/master"
	if strings.TrimSpace(cursor) != "" {
		path += "?cursor=" + url.QueryEscape(cursor)
	}
	return path
}

func masterSyncCursor(cursor string, fullRefresh bool) string {
	if fullRefresh {
		return ""
	}
	return cursor
}

func (s *Server) fetchMasterPayload(cursor string) (masterPayload, error) {
	var payload masterPayload
	var lastErr error
	for attempt := 1; attempt <= 3; attempt++ {
		path := masterFeedPath(cursor)
		response, err := s.lmsRequest(http.MethodGet, path, nil)
		if err == nil {
			err = readJSONResponse(response, &payload)
		}
		if err == nil {
			lastErr = nil
			break
		}
		lastErr = err
		if attempt < 3 {
			time.Sleep(time.Duration(attempt) * 500 * time.Millisecond)
		}
	}
	if lastErr != nil {
		return masterPayload{}, fmt.Errorf("LMS sync failed after 3 attempts: %w", lastErr)
	}
	return payload, nil
}

func (s *Server) syncMaster(fullRefresh bool) (syncCounts, error) {
	s.syncMu.Lock()
	defer s.syncMu.Unlock()
	// Manual sync is the recovery path for cursor gaps, initial deployment, and
	// LMS imports whose source timestamps predate the last CBT cursor. A full
	// feed only upserts source records, so it never deletes CBT assessment data.
	cursor := masterSyncCursor(syncCursor(s.db), fullRefresh)
	payload, err := s.fetchMasterPayload(cursor)
	if err != nil {
		return syncCounts{}, err
	}
	counts := syncCounts{Accounts: len(payload.Accounts), Classes: len(payload.Kelas), Students: len(payload.PesertaDidik), Tutors: len(payload.Tutor), Subjects: len(payload.Mapel)}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		for _, source := range payload.Kelas {
			if source.ID == "" {
				continue
			}
			row := MasterKelas{Base: Base{ID: source.ID}, Nama: source.Nama, Jenjang: source.Jenjang, Active: source.Active, SourceUpdatedAt: source.UpdatedAt.Unix()}
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
		}
		for _, source := range payload.PesertaDidik {
			if source.ID == "" {
				continue
			}
			row := MasterPeserta{Base: Base{ID: source.ID}, Nama: source.Nama, NISN: source.NISN, KelasID: source.KelasID, Active: source.Active, SourceUpdatedAt: source.UpdatedAt.Unix()}
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
			if !source.Active {
				if err := tx.Model(&CBTAccount{}).Where("peserta_didik_id = ?", source.ID).Update("active", false).Error; err != nil {
					return err
				}
			}
		}
		for _, source := range payload.Tutor {
			if source.ID == "" {
				continue
			}
			row := MasterTutor{Base: Base{ID: source.ID}, Nama: source.Nama, Active: source.Active, SourceUpdatedAt: source.UpdatedAt.Unix()}
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
		}
		for _, source := range payload.Mapel {
			if source.ID == "" {
				continue
			}
			row := MasterMapel{Base: Base{ID: source.ID}, Nama: source.Nama, Kode: source.Kode, Active: source.Active, SourceUpdatedAt: source.UpdatedAt.Unix()}
			if err := tx.Save(&row).Error; err != nil {
				return err
			}
		}
		for _, source := range payload.Accounts {
			if source.ID == "" || source.Username == "" {
				continue
			}
			var account CBTAccount
			err := tx.Where("source_user_id = ?", source.ID).First(&account).Error
			if err != nil && err != gorm.ErrRecordNotFound {
				return err
			}
			if err == gorm.ErrRecordNotFound {
				account = CBTAccount{SourceUserID: source.ID, Username: source.Username, Nama: source.Nama, Role: source.Role, TutorID: source.TutorID, PesertaDidikID: source.PesertaDidikID, Active: false}
			} else {
				account.Username, account.Nama, account.Role, account.TutorID, account.PesertaDidikID = source.Username, source.Nama, source.Role, source.TutorID, source.PesertaDidikID
				account.Active = account.Active && source.Active
			}
			account.SourceUpdatedAt = source.UpdatedAt.Unix()
			if err := tx.Save(&account).Error; err != nil {
				return err
			}
		}
		if payload.Cursor != "" {
			return setSyncState(tx, "master_cursor", payload.Cursor)
		}
		return nil
	})
	return counts, err
}

func (s *Server) recordMasterSync(trigger, actor string) (SyncRun, error) {
	run := SyncRun{Trigger: trigger, Status: "running", StartedAt: time.Now().UTC()}
	if err := s.db.Create(&run).Error; err != nil {
		return run, err
	}
	counts, syncErr := s.syncMaster(trigger == "manual")
	run.Accounts, run.Classes, run.Students, run.Tutors, run.Subjects = counts.Accounts, counts.Classes, counts.Students, counts.Tutors, counts.Subjects
	finished := time.Now().UTC()
	run.FinishedAt = &finished
	if syncErr != nil {
		run.Status = "failed"
		run.Message = syncErrorMessage(syncErr)
		run.ErrorDetails = syncErr.Error()
	} else {
		run.Status = "success"
		if trigger == "manual" && counts.Classes == 0 && counts.Students == 0 {
			run.Message = "Sinkronisasi penuh berhasil, tetapi LMS mengirim 0 kelas dan 0 siswa. Periksa apakah data peserta didik aktif tersedia di LMS dan LMS_BASE_URL mengarah ke aplikasi LMS yang benar."
		} else if trigger == "manual" {
			run.Message = fmt.Sprintf("Rekonsiliasi penuh berhasil: %d siswa, %d kelas, %d tutor, %d mapel, %d akun diperiksa dari LMS.", counts.Students, counts.Classes, counts.Tutors, counts.Subjects, counts.Accounts)
		} else {
			run.Message = fmt.Sprintf("Batch sinkronisasi berhasil: %d siswa, %d kelas, %d tutor, %d mapel, %d akun diperbarui.", counts.Students, counts.Classes, counts.Tutors, counts.Subjects, counts.Accounts)
		}
	}
	if err := s.db.Save(&run).Error; err != nil {
		return run, err
	}
	state := map[string]string{
		"last_master_sync_status":  run.Status,
		"last_master_sync_message": run.Message,
		"last_master_sync_at":      finished.Format(time.RFC3339),
		"last_master_sync_counts":  fmt.Sprintf("siswa=%d, kelas=%d, tutor=%d, mapel=%d, akun=%d", counts.Students, counts.Classes, counts.Tutors, counts.Subjects, counts.Accounts),
	}
	if syncErr != nil {
		state["last_master_sync_error"] = run.ErrorDetails
	} else {
		state["last_master_sync_error"] = ""
	}
	for key, value := range state {
		if err := setSyncState(s.db, key, value); err != nil {
			return run, err
		}
	}
	if actor != "" {
		s.audit(actor, "manual_master_sync", "lms")
	}
	return run, syncErr
}
func (s *Server) runWorkers() {
	ticker := time.NewTicker(s.cfg.SyncInterval)
	defer ticker.Stop()
	go s.runDeadlineWorker()
	if _, err := s.recordMasterSync("automatic", ""); err != nil {
		logError("master sync failed: %v", err)
	}
	_ = s.flushOutbox()
	for range ticker.C {
		if _, err := s.recordMasterSync("automatic", ""); err != nil {
			logError("master sync failed: %v", err)
		}
		if err := s.flushOutbox(); err != nil {
			logError("outbox delivery failed: %v", err)
		}
	}
}

func (s *Server) runDeadlineWorker() {
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		if err := s.closeExpiredAttempts(); err != nil {
			logError("expired attempt close failed: %v", err)
		}
		<-ticker.C
	}
}

func (s *Server) closeExpiredAttempts() error {
	now := time.Now()
	var candidates []Attempt
	if err := s.db.Where("status = ? AND deadline_at IS NOT NULL AND deadline_at <= ?", "started", now).Limit(200).Find(&candidates).Error; err != nil {
		return err
	}
	for _, candidate := range candidates {
		closed := false
		err := s.db.Transaction(func(tx *gorm.DB) error {
			var attempt Attempt
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&attempt, "id = ?", candidate.ID).Error; err != nil {
				return err
			}
			if attempt.Status != "started" || attempt.DeadlineAt == nil || attempt.DeadlineAt.After(time.Now()) {
				return nil
			}
			closed = true
			return finalizeAttemptTx(tx, &attempt, *attempt.DeadlineAt)
		})
		if err != nil {
			return err
		}
		if closed {
			_ = s.enqueueAttemptResult(candidate.ID)
			s.audit("system", "auto_submit_attempt", candidate.ID)
		}
	}
	return nil
}
func (s *Server) syncStatus(c *fiber.Ctx) error {
	var states []SyncState
	if err := s.db.Order("key").Find(&states).Error; err != nil {
		return err
	}
	return c.JSON(states)
}
func (s *Server) syncHistory(c *fiber.Ctx) error {
	var runs []SyncRun
	if err := s.db.Order("started_at desc").Limit(10).Find(&runs).Error; err != nil {
		return err
	}
	return c.JSON(runs)
}
func (s *Server) runSync(c *fiber.Ctx) error {
	run, err := s.recordMasterSync("manual", currentAccount(c).ID)
	if err != nil {
		return c.Status(fiber.StatusServiceUnavailable).JSON(fiber.Map{"error": run.Message, "syncRun": run})
	}
	_ = s.flushOutbox()
	return c.JSON(fiber.Map{"status": "ok", "cursor": syncCursor(s.db), "syncRun": run})
}

type resultAnswer struct {
	AttemptItemID, QuestionID, ValueJSON, Comment string
	Correct                                       *bool
	AutoScore                                     float64
	ManualScore                                   *float64
	Revision                                      int
}
type resultPayload struct {
	EventID    string         `json:"eventId"`
	Attempt    Attempt        `json:"attempt"`
	Assessment Assessment     `json:"assessment"`
	Student    MasterPeserta  `json:"student"`
	Answers    []resultAnswer `json:"answers"`
}

func (s *Server) enqueueAttemptResult(attemptID string) error {
	var attempt Attempt
	if err := s.db.First(&attempt, "id = ?", attemptID).Error; err != nil {
		return err
	}
	var assessment Assessment
	var student MasterPeserta
	if err := s.db.First(&assessment, "id = ?", attempt.AssessmentID).Error; err != nil {
		return err
	}
	if err := s.db.First(&student, "id = ?", attempt.StudentID).Error; err != nil {
		return err
	}
	var answers []Answer
	if err := s.db.Where("attempt_id = ?", attempt.ID).Find(&answers).Error; err != nil {
		return err
	}
	exported := make([]resultAnswer, 0, len(answers))
	for _, answer := range answers {
		var item AttemptItem
		_ = s.db.First(&item, "id = ?", answer.AttemptItemID).Error
		exported = append(exported, resultAnswer{AttemptItemID: answer.AttemptItemID, QuestionID: item.QuestionID, ValueJSON: answer.ValueJSON, Correct: answer.Correct, AutoScore: answer.AutoScore, ManualScore: answer.ManualScore, Comment: answer.Comment, Revision: answer.Revision})
	}
	eventID := hash(attempt.ID + ":" + attempt.UpdatedAt.UTC().Format(time.RFC3339Nano))
	payload, _ := json.Marshal(resultPayload{EventID: eventID, Attempt: attempt, Assessment: assessment, Student: student, Answers: exported})
	row := IntegrationOutbox{EventID: eventID, Type: "assessment.result.v1", PayloadJSON: string(payload), NextAttemptAt: time.Now()}
	return s.db.Where("event_id = ?", eventID).FirstOrCreate(&row).Error
}
func (s *Server) flushOutbox() error {
	var rows []IntegrationOutbox
	if err := s.db.Where("delivered_at IS NULL AND next_attempt_at <= ?", time.Now()).Order("created_at").Limit(25).Find(&rows).Error; err != nil {
		return err
	}
	for _, row := range rows {
		response, err := s.lmsRequest(http.MethodPost, "/api/integrations/cbt/v1/results", []byte(row.PayloadJSON))
		if err == nil && response != nil && response.StatusCode >= 200 && response.StatusCode < 300 {
			response.Body.Close()
			now := time.Now()
			_ = s.db.Model(&row).Updates(map[string]any{"delivered_at": now, "last_error": ""}).Error
			continue
		}
		message := "jaringan LMS tidak tersedia"
		if err != nil {
			message = err.Error()
		} else if response != nil {
			body, _ := io.ReadAll(io.LimitReader(response.Body, 4096))
			response.Body.Close()
			message = fmt.Sprintf("LMS %d: %s", response.StatusCode, strings.TrimSpace(string(body)))
		}
		backoff := time.Duration(min(3600, 1<<min(row.Attempts, 10))) * time.Second
		_ = s.db.Model(&row).Updates(map[string]any{"attempts": row.Attempts + 1, "next_attempt_at": time.Now().Add(backoff), "last_error": message}).Error
	}
	return nil
}

type migrationAssessment struct {
	Assessment
	AccessCodeHash string `json:"accessCodeHash"`
}
type migrationBundle struct {
	BatchID      string                 `json:"batchId"`
	Questions    []Question             `json:"questions"`
	Assessments  []migrationAssessment  `json:"assessments"`
	Items        []AssessmentItem       `json:"items"`
	Assignments  []AssessmentAssignment `json:"assignments"`
	Attempts     []Attempt              `json:"attempts"`
	AttemptItems []AttemptItem          `json:"attemptItems"`
	Answers      []Answer               `json:"answers"`
}

func (s *Server) importLegacy(c *fiber.Ctx) error {
	response, err := s.lmsRequest(http.MethodGet, "/api/integrations/cbt/v1/migration/export", nil)
	if err != nil {
		return fiber.NewError(502, "Export LMS gagal: "+err.Error())
	}
	var bundle migrationBundle
	if err := readJSONResponse(response, &bundle); err != nil {
		return fiber.NewError(502, "Data export LMS tidak valid: "+err.Error())
	}
	if bundle.BatchID == "" {
		return fiber.NewError(502, "Export LMS tidak memiliki batch ID")
	}
	batch := MigrationBatch{SourceBatchID: bundle.BatchID, Status: "running"}
	if err := s.db.Where("source_batch_id = ?", bundle.BatchID).FirstOrCreate(&batch).Error; err != nil {
		return err
	}
	if batch.Status == "completed" {
		return c.JSON(batch)
	}
	assessments := make([]Assessment, 0, len(bundle.Assessments))
	for _, source := range bundle.Assessments {
		row := source.Assessment
		row.AccessCodeHash = source.AccessCodeHash
		assessments = append(assessments, row)
	}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		for _, rows := range []any{&bundle.Questions, &assessments, &bundle.Items, &bundle.Assignments, &bundle.Attempts, &bundle.AttemptItems, &bundle.Answers} {
			if err := tx.Save(rows).Error; err != nil {
				return err
			}
		}
		summary, _ := json.Marshal(fiber.Map{"questions": len(bundle.Questions), "assessments": len(bundle.Assessments), "attempts": len(bundle.Attempts), "answers": len(bundle.Answers)})
		now := time.Now()
		return tx.Model(&MigrationBatch{}).Where("id = ?", batch.ID).Updates(map[string]any{"status": "completed", "summary_json": string(summary), "finished_at": now}).Error
	})
	if err != nil {
		_ = s.db.Model(&MigrationBatch{}).Where("id = ?", batch.ID).Updates(map[string]any{"status": "failed", "error_text": err.Error()}).Error
		return err
	}
	s.audit(currentAccount(c).ID, "import_legacy_assessments", bundle.BatchID)
	if err := s.db.First(&batch, "id = ?", batch.ID).Error; err != nil {
		return err
	}
	return c.JSON(batch)
}

func verifyIntegrationSignature(secret, method, path, timestamp, nonce string, body []byte, received string) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(strings.ToUpper(method) + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n"))
	_, _ = mac.Write(body)
	return hmac.Equal([]byte(hex.EncodeToString(mac.Sum(nil))), []byte(strings.ToLower(strings.TrimSpace(received))))
}
func newIntegrationNonce() string { return uuid.NewString() }
