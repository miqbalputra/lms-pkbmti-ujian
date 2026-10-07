package main

import (
	"encoding/json"
	"errors"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"math"
	"sort"
	"strings"
	"time"
)

// Additive document storage. Nothing rewrites historical attempt snapshots.
type FormDocument struct {
	Base
	ResourceType     string `gorm:"uniqueIndex:form_resource;not null" json:"resourceType"`
	ResourceID       string `gorm:"uniqueIndex:form_resource;not null" json:"resourceId"`
	OwnerID          string `gorm:"index;not null" json:"ownerId"`
	SourceDocumentID string `gorm:"index" json:"sourceDocumentId,omitempty"`
	Revision         int    `json:"revision"`
	SyncEpoch        int    `gorm:"default:0" json:"syncEpoch"`
	ContentJSON      string `gorm:"type:text" json:"-"`
	MaterializedJSON string `gorm:"type:text" json:"-"`
	YState           []byte `gorm:"type:bytea" json:"-"`
	Frozen           bool   `json:"frozen"`
}
type FormCollaborator struct {
	Base
	DocumentID string `gorm:"uniqueIndex:form_member" json:"documentId"`
	AccountID  string `gorm:"uniqueIndex:form_member" json:"accountId"`
	Role       string `json:"role"`
	Revoked    bool   `json:"revoked"`
}

// A fork retains only media explicitly referenced in the copied document, not
// access to the original owner's complete upload library.
type FormMediaGrant struct {
	Base
	DocumentID string `gorm:"uniqueIndex:form_media_grant"`
	MediaID    string `gorm:"uniqueIndex:form_media_grant"`
}
type FormVersion struct {
	Base
	DocumentID  string `gorm:"uniqueIndex:form_version" json:"documentId"`
	Revision    int    `gorm:"uniqueIndex:form_version" json:"revision"`
	ContentJSON string `gorm:"type:text" json:"-"`
	Checksum    string `json:"checksum"`
	PublishedBy string `json:"publishedBy"`
}
type AssessmentClassTarget struct {
	Base
	AssessmentID string `gorm:"uniqueIndex:assessment_class"`
	ClassID      string `gorm:"uniqueIndex:assessment_class"`
}
type FormAccessLink struct {
	Base
	DocumentID  string     `gorm:"index" json:"documentId"`
	TokenHash   string     `gorm:"uniqueIndex" json:"-"`
	ExpiresAt   *time.Time `json:"expiresAt"`
	Revoked     bool       `json:"revoked"`
	PrefillJSON string     `gorm:"type:text" json:"-"`
}
type FormCard struct {
	ID              string         `json:"id"`
	SourceID        string         `json:"sourceId,omitempty"`
	Position        float64        `json:"position"`
	Deleted         bool           `json:"deleted"`
	Type            string         `json:"type"`
	Prompt          string         `json:"prompt"`
	PromptRich      []FormRichPart `json:"promptRich,omitempty"`
	Description     string         `json:"description"`
	Points          float64        `json:"points"`
	Required        bool           `json:"required"`
	SectionID       string         `json:"sectionId"`
	StimulusGroupID string         `json:"stimulusGroupId"`
	Config          map[string]any `json:"config"`
	Explanation     string         `json:"explanation"`
	Subject         string         `json:"subject"`
	Competency      string         `json:"competency"`
	Grade           int            `json:"grade"`
}
type FormSection struct {
	ID          string  `json:"id"`
	Title       string  `json:"title"`
	Description string  `json:"description"`
	Position    float64 `json:"position"`
	Deleted     bool    `json:"deleted"`
	Next        string  `json:"next"`
}
type FormStimulus struct {
	ID       string           `json:"id"`
	Title    string           `json:"title"`
	Position float64          `json:"position"`
	Deleted  bool             `json:"deleted"`
	Blocks   []map[string]any `json:"blocks"`
}
type FormSettings struct {
	Kind                    string           `json:"kind"`
	SubjectID               string           `json:"subjectId"`
	ClassIDs                []string         `json:"classIds"`
	StudentIDs              []string         `json:"studentIds"`
	AccessCode              string           `json:"accessCode"`
	DurationMinute          int              `json:"durationMinute"`
	StartsAt                *time.Time       `json:"startsAt"`
	EndsAt                  *time.Time       `json:"endsAt"`
	MaxAttempts             int              `json:"maxAttempts"`
	PassScore               float64          `json:"passScore"`
	Randomize               bool             `json:"randomize"`
	RandomizeOptions        bool             `json:"randomizeOptions"`
	ProgressBar             bool             `json:"progressBar"`
	ShowResult              bool             `json:"showResult"`
	ShowReview              bool             `json:"showReview"`
	ResultsPolicy           string           `json:"resultsPolicy"`
	Instructions            string           `json:"instructions"`
	ConfirmationMessage     string           `json:"confirmationMessage"`
	AcceptResponses         bool             `json:"acceptResponses"`
	ThemeColor              string           `json:"themeColor"`
	Font                    string           `json:"font"`
	HeaderImage             *FormHeaderImage `json:"headerImage,omitempty"`
	AllowResponseEdit       bool             `json:"allowResponseEdit"`
	DefaultQuestionPoints   float64          `json:"defaultQuestionPoints"`
	DefaultQuestionRequired bool             `json:"defaultQuestionRequired"`
}
type FormDraft struct {
	SchemaVersion int                     `json:"schemaVersion"`
	Title         string                  `json:"title"`
	Description   string                  `json:"description"`
	Cards         map[string]FormCard     `json:"cards"`
	Sections      map[string]FormSection  `json:"sections"`
	Stimuli       map[string]FormStimulus `json:"stimuli"`
	Settings      FormSettings            `json:"settings"`
}

func emptyForm() FormDraft {
	return FormDraft{SchemaVersion: 1, Cards: map[string]FormCard{}, Sections: map[string]FormSection{}, Stimuli: map[string]FormStimulus{}, Settings: FormSettings{Kind: "ujian_online", DurationMinute: 60, MaxAttempts: 1, ResultsPolicy: "after_review", ProgressBar: true, AcceptResponses: true, ThemeColor: "#326698", Font: "sans-serif", DefaultQuestionPoints: 1, ConfirmationMessage: "Jawabanmu sudah terkirim. Terima kasih."}}
}
func orderedCards(d FormDraft) []FormCard {
	out := []FormCard{}
	for _, c := range d.Cards {
		if !c.Deleted {
			out = append(out, c)
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Position == out[j].Position {
			return out[i].ID < out[j].ID
		}
		return out[i].Position < out[j].Position
	})
	return out
}
func validateForm(d FormDraft, publishing bool) error {
	if d.Settings.HeaderImage != nil {
		if _, err := uuid.Parse(d.Settings.HeaderImage.AssetID); err != nil || len(d.Settings.HeaderImage.Alt) > 1000 {
			return fiber.NewError(400, "Gambar header tidak valid")
		}
		if publishing && strings.TrimSpace(d.Settings.HeaderImage.Alt) == "" {
			return fiber.NewError(400, "Tambahkan teks alternatif gambar header")
		}
	}
	if !validFormTheme(d.Settings, publishing) {
		return fiber.NewError(400, "Tema/font tidak valid atau kontras teks belum memenuhi 4.5:1")
	}
	if d.SchemaVersion != 1 || len(d.Cards) > 500 || len(d.Title) > 640 || len(d.Description) > 20000 {
		return fiber.NewError(400, "Dokumen draf tidak valid atau terlalu besar")
	}
	if math.IsNaN(d.Settings.DefaultQuestionPoints) || math.IsInf(d.Settings.DefaultQuestionPoints, 0) || d.Settings.DefaultQuestionPoints < 0 || d.Settings.DefaultQuestionPoints > 10000 {
		return fiber.NewError(400, "Poin default tidak valid")
	}
	for id, c := range d.Cards {
		if _, err := uuid.Parse(id); err != nil || id != c.ID || !supportedQuestionTypes[c.Type] || math.IsNaN(c.Position) || math.IsInf(c.Position, 0) || c.Points < 0 || c.Points > 10000 || len(c.Prompt) > 100000 {
			return fiber.NewError(400, "Kartu soal tidak valid")
		}
		if c.Deleted {
			continue
		}
		if !validFormRichText(c.PromptRich, c.Prompt) {
			return fiber.NewError(400, "Format pertanyaan tidak sesuai teks atau mengandung atribut terlarang")
		}
		for _, field := range []string{"choices", "statements", "left", "right", "rows", "columns", "rubrik"} {
			if c.Config[field] == nil {
				continue
			}
			rows, ok := c.Config[field].([]any)
			if !ok {
				raw := marshalJSON(c.Config[field])
				if json.Unmarshal([]byte(raw), &rows) != nil || rows == nil {
					return fiber.NewError(400, "Opsi/baris harus berupa daftar visual")
				}
			}
			if len(rows) > 300 {
				return fiber.NewError(400, "Jumlah opsi terlalu banyak")
			}
			seen := map[string]bool{}
			for _, raw := range rows {
				id := asString(mapFrom(raw)["id"])
				if id == "" || len(id) > 128 || seen[id] {
					return fiber.NewError(400, "Setiap opsi/baris memerlukan ID unik dan stabil")
				}
				seen[id] = true
			}
		}
		if c.SectionID != "" {
			sec, ok := d.Sections[c.SectionID]
			if !ok || sec.Deleted {
				return fiber.NewError(400, "Bagian soal tidak tersedia")
			}
		}
		if c.StimulusGroupID != "" {
			group, ok := d.Stimuli[c.StimulusGroupID]
			if !ok || group.Deleted {
				return fiber.NewError(400, "Stimulus soal tidak tersedia")
			}
			raw, _ := json.Marshal(group.Blocks)
			if publishing && !validStimulusJSON(string(raw)) {
				return fiber.NewError(400, "Bahan/media belum valid")
			}
		}
		branches := mapFrom(c.Config["branchToByAnswer"])
		if len(branches) > 0 && c.Type != "pg_tunggal" && c.Type != "dropdown" {
			return fiber.NewError(400, "Percabangan hanya untuk pilihan tunggal atau dropdown")
		}
		for _, v := range branches {
			target := asString(v)
			if target == "submit" || target == "" {
				continue
			}
			sec, ok := d.Sections[target]
			if !ok || sec.Deleted {
				return fiber.NewError(400, "Tujuan percabangan tidak tersedia")
			}
			if c.SectionID != "" && sec.Position <= d.Sections[c.SectionID].Position {
				return fiber.NewError(400, "Percabangan harus menuju bagian berikutnya")
			}
		}
		if publishing {
			config, _ := json.Marshal(c.Config)
			if strings.TrimSpace(c.Prompt) == "" || !validQuestionForPublish(questionSnapshot{Type: c.Type, ConfigJSON: string(config), Points: c.Points}) {
				return fiber.NewError(400, "Lengkapi pertanyaan dan kunci/rubrik semua soal")
			}
		}
	}
	if publishing && (strings.TrimSpace(d.Title) == "" || len(orderedCards(d)) == 0) {
		return fiber.NewError(400, "Isi judul dan minimal satu soal")
	}
	for id, sec := range d.Sections {
		if _, err := uuid.Parse(id); err != nil || sec.ID != id || math.IsNaN(sec.Position) || math.IsInf(sec.Position, 0) {
			return fiber.NewError(400, "ID bagian tidak valid")
		}
		if sec.Next != "" && sec.Next != "submit" {
			next, ok := d.Sections[sec.Next]
			if !ok || next.Deleted || next.Position <= sec.Position {
				return fiber.NewError(400, "Bagian berikutnya tidak valid")
			}
		}
	}
	for id, group := range d.Stimuli {
		if _, err := uuid.Parse(id); err != nil || id != group.ID || len(group.Blocks) > 100 {
			return fiber.NewError(400, "Kelompok stimulus tidak valid")
		}
		seen := map[string]bool{}
		for _, block := range group.Blocks {
			id := asString(block["id"])
			if _, err := uuid.Parse(id); err != nil || seen[id] {
				return fiber.NewError(400, "ID blok stimulus harus unik dan stabil")
			}
			seen[id] = true
			if len(asString(block["content"])) > 200000 {
				return fiber.NewError(400, "Isi stimulus terlalu panjang")
			}
		}
	}
	return nil
}
func (s *Server) formRole(tx *gorm.DB, a CBTAccount, d FormDocument) string {
	if !a.Active || a.Role == "siswa" {
		return ""
	}
	if a.Role == "kepala_sekolah" {
		return "viewer"
	}
	if staffCanWrite(a, d.OwnerID) {
		return "owner"
	}
	var m FormCollaborator
	if tx.First(&m, "document_id = ? AND account_id = ? AND revoked = false", d.ID, a.ID).Error == nil {
		return m.Role
	}
	return ""
}
func formEditable(role string) bool { return role == "owner" || role == "editor" }
func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
func marshalJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func formResponse(d FormDocument, content FormDraft, role string) fiber.Map {
	if role == "viewer" {
		content.Settings.AccessCode = ""
	}
	return fiber.Map{"id": d.ID, "resourceId": d.ResourceID, "resourceType": d.ResourceType, "revision": d.Revision, "syncEpoch": d.SyncEpoch, "frozen": d.Frozen, "role": role, "content": content}
}
func (s *Server) createForm(c *fiber.Ctx) error {
	a := currentAccount(c)
	if a.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Akses baca-saja")
	}
	kind := c.Params("kind")
	draft := emptyForm()
	if err := s.applyFormPreferences(a.ID, &draft); err != nil {
		return err
	}
	var input struct {
		Kind string `json:"kind"`
	}
	_ = c.BodyParser(&input)
	if input.Kind == "simulasi" {
		draft.Settings.Kind = "simulasi"
	}
	doc := FormDocument{ResourceType: kind, OwnerID: a.ID, Revision: 1}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		switch kind {
		case "assessment":
			row := Assessment{OwnerID: a.ID, Kind: draft.Settings.Kind, Title: "Paket tanpa judul", Status: "draft", DurationMinute: 60, MaxAttempts: 1, Revision: 1}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			doc.ResourceID = row.ID
		case "package":
			row := QuestionPackage{OwnerID: a.ID, Title: "Paket tanpa judul", Status: "draft"}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			doc.ResourceID = row.ID
		default:
			return fiber.NewError(400, "Jenis dokumen belum didukung")
		}
		doc.ContentJSON = marshalJSON(draft)
		doc.MaterializedJSON = "{}"
		return tx.Create(&doc).Error
	})
	if err != nil {
		return err
	}
	s.audit(a.ID, "create_form_document", doc.ID)
	return c.Status(201).JSON(formResponse(doc, draft, "owner"))
}
func addQuestionToDraft(d *FormDraft, q Question, position int) {
	id := uuid.NewString()
	config := configObject(q.ConfigJSON)
	card := FormCard{ID: id, SourceID: q.ID, Position: float64(position), Type: q.Type, Prompt: q.Prompt, Description: q.Description, Config: config, Points: q.Points, Subject: q.Subject, Grade: q.Grade, Competency: q.Competency, Explanation: q.InternalExplanation}
	// Imported/reused cards keep structured formatting; the CRDT bootstrap
	// recreates its Y.Text marks rather than silently flattening the source.
	if raw, err := json.Marshal(config["promptRich"]); err == nil {
		var rich []FormRichPart
		if json.Unmarshal(raw, &rich) == nil && validFormRichText(rich, q.Prompt) {
			card.PromptRich = rich
		}
	}
	if required, ok := config["required"].(bool); ok {
		card.Required = required
	}
	var blocks []map[string]any
	if json.Unmarshal([]byte(q.StimulusJSON), &blocks) == nil && len(blocks) > 0 {
		for _, b := range blocks {
			b["id"] = uuid.NewString()
		}
		groupID := uuid.NewString()
		d.Stimuli[groupID] = FormStimulus{ID: groupID, Title: "Bahan soal", Blocks: blocks}
		card.StimulusGroupID = groupID
	}
	d.Cards[id] = card
}
func (s *Server) loadForm(a CBTAccount, kind, id string) (FormDocument, error) {
	var d FormDocument
	if err := s.db.First(&d, "resource_type = ? AND resource_id = ?", kind, id).Error; err == nil {
		if s.formRole(s.db, a, d) == "" {
			return d, fiber.NewError(403, "Dokumen tidak dibagikan kepada Anda")
		}
		return d, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return d, err
	}
	draft := emptyForm()
	d = FormDocument{ResourceID: id, ResourceType: kind, Revision: 1}
	switch kind {
	case "assessment":
		var row Assessment
		if s.db.First(&row, "id = ? AND trashed_at IS NULL", id).Error != nil {
			return d, fiber.NewError(404, "Asesmen tidak ditemukan")
		}
		d.OwnerID = row.OwnerID
		d.Frozen = row.Status != "draft"
		draft.Title, draft.Description = row.Title, row.Description
		draft.Settings = FormSettings{Kind: row.Kind, SubjectID: row.SubjectID, ClassIDs: []string{}, DurationMinute: row.DurationMinute, StartsAt: row.StartsAt, EndsAt: row.EndsAt, MaxAttempts: row.MaxAttempts, PassScore: row.PassScore, Randomize: row.Randomize, RandomizeOptions: row.RandomizeOptions, ShowResult: row.ShowResult, ShowReview: row.ShowReview, ResultsPolicy: row.ResultsPolicy, Instructions: row.Instructions, ProgressBar: row.ProgressBar, ConfirmationMessage: row.ConfirmationMessage, AcceptResponses: true, ThemeColor: "#326698", Font: "sans-serif"}
		if row.ClassID != "" {
			draft.Settings.ClassIDs = []string{row.ClassID}
		}
		draft.Settings.AccessCode, _ = decryptAssessmentCode(s.cfg.JWTSecret, row.AccessCodeCiphertext)
		var assignments []AssessmentAssignment
		if err := s.db.Where("assessment_id = ?", id).Find(&assignments).Error; err != nil {
			return d, err
		}
		for _, x := range assignments {
			draft.Settings.StudentIDs = append(draft.Settings.StudentIDs, x.StudentID)
		}
		if len(draft.Settings.StudentIDs) > 0 {
			draft.Settings.ClassIDs = nil
		}
		var items []AssessmentItem
		if err := s.db.Where("assessment_id = ?", id).Order("position").Find(&items).Error; err != nil {
			return d, err
		}
		for i, x := range items {
			var snap questionSnapshot
			if err := json.Unmarshal([]byte(x.SnapshotJSON), &snap); err != nil {
				return d, err
			}
			addQuestionToDraft(&draft, Question{Base: Base{ID: snap.ID}, Type: snap.Type, Prompt: snap.Prompt, Description: snap.Description, ConfigJSON: snap.ConfigJSON, StimulusJSON: snap.StimulusJSON, Points: x.Weight, InternalExplanation: snap.InternalExplanation}, i)
		}
	case "package":
		var row QuestionPackage
		if s.db.First(&row, "id = ?", id).Error != nil {
			return d, fiber.NewError(404, "Paket tidak ditemukan")
		}
		d.OwnerID = row.OwnerID
		d.Frozen = row.Status != "draft"
		draft.Title, draft.Description, draft.Settings.SubjectID = row.Title, row.Description, row.Subject
		var qs []Question
		if err := s.db.Where("package_id = ? AND trashed_at IS NULL", id).Order("package_position").Find(&qs).Error; err != nil {
			return d, err
		}
		for i, q := range qs {
			addQuestionToDraft(&draft, q, i)
		}
		var targets []PackageAssignment
		_ = s.db.Where("package_id = ?", id).Find(&targets).Error
		for _, x := range targets {
			if x.TargetType == "class" {
				draft.Settings.ClassIDs = append(draft.Settings.ClassIDs, x.TargetID)
			} else {
				draft.Settings.StudentIDs = append(draft.Settings.StudentIDs, x.TargetID)
			}
		}
	default:
		return d, fiber.NewError(400, "Jenis dokumen tidak dikenal")
	}
	if !staffCanWrite(a, d.OwnerID) && a.Role != "kepala_sekolah" {
		return d, fiber.NewError(403, "Akses ditolak")
	}
	d.ContentJSON = marshalJSON(draft)
	d.MaterializedJSON = "{}"
	if err := s.db.Clauses(clause.OnConflict{DoNothing: true}).Create(&d).Error; err != nil {
		return d, err
	}
	if err := s.db.First(&d, "resource_type = ? AND resource_id = ?", kind, id).Error; err != nil {
		return d, err
	}
	return d, nil
}
func (s *Server) getForm(c *fiber.Ctx) error {
	a := currentAccount(c)
	d, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	var content FormDraft
	_ = json.Unmarshal([]byte(d.ContentJSON), &content)
	c.Set("Cache-Control", "no-store")
	return c.JSON(formResponse(d, content, s.formRole(s.db, a, d)))
}

type formSaveInput struct {
	Revision  int       `json:"revision"`
	Content   FormDraft `json:"content"`
	YState    []byte    `json:"yState"`
	SyncEpoch *int      `json:"syncEpoch,omitempty"`
}

func (s *Server) saveFormDocument(a CBTAccount, id string, in formSaveInput) (FormDocument, error) {
	var d FormDocument
	if err := validateForm(in.Content, false); err != nil {
		return d, err
	}
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&d, "id = ?", id).Error; err != nil {
			return fiber.NewError(404, "Draf tidak ditemukan")
		}
		if !formEditable(s.formRole(tx, a, d)) {
			return fiber.NewError(403, "Anda tidak dapat mengedit dokumen ini")
		}
		if d.Frozen {
			return fiber.NewError(409, "Dokumen sudah diterbitkan. Duplikasi untuk versi baru.")
		}
		if d.Revision != in.Revision {
			return fiber.NewError(409, "Konflik versi")
		}
		if in.YState != nil && (in.SyncEpoch == nil || *in.SyncEpoch != d.SyncEpoch) {
			return fiber.NewError(409, "Generasi dokumen berubah. Muat versi server atau simpan sebagai salinan.")
		}
		if err := s.materializeForm(tx, a, &d, in.Content); err != nil {
			return err
		}
		d.ContentJSON = marshalJSON(in.Content)
		d.Revision++
		if in.YState != nil {
			d.YState = in.YState
		} else {
			// REST replacement starts a fresh room. Old CRDT clients cannot merge
			// their binary state into this newly acknowledged server revision.
			d.YState = nil
			d.SyncEpoch++
		}
		if err := tx.Save(&d).Error; err != nil {
			return err
		}
		return tx.Create(&AuditLog{ActorID: a.ID, Action: "save_form_document", Resource: d.ID}).Error
	})
	return d, err
}
func (s *Server) saveForm(c *fiber.Ctx) error {
	a := currentAccount(c)
	d, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	var in formSaveInput
	if c.BodyParser(&in) != nil {
		return fiber.NewError(400, "Draf tidak valid")
	}
	// Binary CRDT state is accepted only from the authenticated Node service.
	in.YState, in.SyncEpoch = nil, nil
	d, err = s.saveFormDocument(a, d.ID, in)
	if err != nil {
		var e *fiber.Error
		if errors.As(err, &e) && e.Code == 409 {
			var server FormDraft
			_ = json.Unmarshal([]byte(d.ContentJSON), &server)
			return c.Status(409).JSON(fiber.Map{"error": e.Message, "server": formResponse(d, server, s.formRole(s.db, a, d))})
		}
		return err
	}
	return c.JSON(formResponse(d, in.Content, s.formRole(s.db, a, d)))
}
func (s *Server) formPreview(c *fiber.Ctx) error {
	a := currentAccount(c)
	d, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	var content FormDraft
	_ = json.Unmarshal([]byte(d.ContentJSON), &content)
	input := struct {
		Answers map[string]any `json:"answers"`
	}{}
	if len(c.Body()) > 0 && c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Jawaban pratinjau tidak valid")
	}
	active := activeFormCards(content, input.Answers)
	activeIDs := []string{}
	out := []fiber.Map{}
	for _, card := range orderedCards(content) {
		stimulus := "[]"
		if group, ok := content.Stimuli[card.StimulusGroupID]; ok {
			stimulus = marshalJSON(group.Blocks)
		}
		config := configObject(marshalJSON(card.Config))
		if len(card.PromptRich) > 0 {
			config["promptRich"] = card.PromptRich
		}
		config["required"], config["stimulusGroupId"] = card.Required, card.StimulusGroupID
		out = append(out, safeSnapshot(marshalJSON(questionSnapshot{ID: card.ID, Title: card.Prompt, Prompt: card.Prompt, Type: card.Type, Description: card.Description, ConfigJSON: marshalJSON(config), StimulusJSON: stimulus, Points: card.Points})))
		if active[card.ID] {
			activeIDs = append(activeIDs, card.ID)
		}
	}
	c.Set("Cache-Control", "no-store")
	return c.JSON(fiber.Map{"title": content.Title, "description": content.Description, "items": out, "activeItemIds": activeIDs, "themeColor": content.Settings.ThemeColor, "font": content.Settings.Font, "progressBar": content.Settings.ProgressBar, "confirmationMessage": content.Settings.ConfirmationMessage, "headerImage": content.Settings.HeaderImage})
}
