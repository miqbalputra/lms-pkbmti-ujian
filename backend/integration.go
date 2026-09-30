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
)

type lmsAccount struct {
	ID, Username, Nama, Role, TutorID, PesertaDidikID string
	Active                                            bool
	UpdatedAt                                         time.Time
}
type lmsKelas struct {
	ID, Nama  string
	Jenjang   int
	Active    bool
	UpdatedAt time.Time
}
type lmsPeserta struct {
	ID, Nama, NISN, KelasID string
	Active                  bool
	UpdatedAt               time.Time
}
type lmsTutor struct {
	ID, Nama  string
	Active    bool
	UpdatedAt time.Time
}
type lmsMapel struct {
	ID, Nama, Kode string
	Active         bool
	UpdatedAt      time.Time
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
		return fmt.Errorf("LMS merespons %d: %s", response.StatusCode, strings.TrimSpace(string(data)))
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

func (s *Server) syncMaster() error {
	cursor := syncCursor(s.db)
	path := "/api/integrations/cbt/v1/master"
	if cursor != "" {
		path += "?cursor=" + url.QueryEscape(cursor)
	}
	response, err := s.lmsRequest(http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	var payload masterPayload
	if err := readJSONResponse(response, &payload); err != nil {
		return err
	}
	return s.db.Transaction(func(tx *gorm.DB) error {
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
}
func (s *Server) runWorkers() {
	ticker := time.NewTicker(s.cfg.SyncInterval)
	defer ticker.Stop()
	_ = s.syncMaster()
	_ = s.flushOutbox()
	for range ticker.C {
		if err := s.syncMaster(); err != nil {
			logError("master sync failed: %v", err)
		}
		if err := s.flushOutbox(); err != nil {
			logError("outbox delivery failed: %v", err)
		}
	}
}
func (s *Server) syncStatus(c *fiber.Ctx) error {
	var states []SyncState
	if err := s.db.Order("key").Find(&states).Error; err != nil {
		return err
	}
	return c.JSON(states)
}
func (s *Server) runSync(c *fiber.Ctx) error {
	if err := s.syncMaster(); err != nil {
		return fiber.NewError(502, "Sinkronisasi LMS gagal: "+err.Error())
	}
	_ = s.flushOutbox()
	s.audit(currentAccount(c).ID, "manual_master_sync", "lms")
	return c.JSON(fiber.Map{"status": "ok", "cursor": syncCursor(s.db)})
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
