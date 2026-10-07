package main

import (
	"crypto/subtle"
	"encoding/json"
	"errors"
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"gorm.io/gorm/clause"
	"strconv"
	"strings"
	"time"
)

func (s *Server) formCollaborators(c *fiber.Ctx) error {
	a := currentAccount(c)
	d, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	role := s.formRole(s.db, a, d)
	if c.Method() == "GET" {
		var rows []FormCollaborator
		err = s.db.Where("document_id = ? AND revoked = false", d.ID).Find(&rows).Error
		if err != nil {
			return err
		}
		out := []fiber.Map{}
		for _, member := range rows {
			var account CBTAccount
			_ = s.db.First(&account, "id = ?", member.AccountID).Error
			out = append(out, fiber.Map{"accountId": member.AccountID, "role": member.Role, "username": account.Username, "name": account.Nama})
		}
		return c.JSON(out)
	}
	if role != "owner" || a.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Hanya pemilik mengelola kolaborator")
	}
	var in struct {
		Username string `json:"username"`
		Role     string `json:"role"`
		Revoked  bool   `json:"revoked"`
	}
	if c.BodyParser(&in) != nil || (in.Role != "editor" && in.Role != "grader" && in.Role != "viewer") {
		return fiber.NewError(400, "Peran kolaborator tidak valid")
	}
	var member CBTAccount
	if s.db.First(&member, "username = ? AND active = true AND role IN ?", in.Username, []string{"admin", "guru", "kepala_sekolah"}).Error != nil {
		return fiber.NewError(400, "Akun staf aktif tidak ditemukan")
	}
	if member.Role == "kepala_sekolah" && in.Role != "viewer" {
		return fiber.NewError(403, "Kepala sekolah tetap baca-saja")
	}
	row := FormCollaborator{DocumentID: d.ID, AccountID: member.ID, Role: in.Role, Revoked: in.Revoked}
	if err := s.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "document_id"}, {Name: "account_id"}}, DoUpdates: clause.AssignmentColumns([]string{"role", "revoked", "updated_at"})}).Create(&row).Error; err != nil {
		return err
	}
	s.audit(a.ID, "change_form_collaborator", d.ID)
	return c.JSON(row)
}

type collaborationClaims struct {
	DocumentID string `json:"documentId"`
	SyncEpoch  int    `json:"syncEpoch"`
	jwt.RegisteredClaims
}

func (s *Server) collaborationTicket(c *fiber.Ctx) error {
	a := currentAccount(c)
	d, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	ticket, err := jwt.NewWithClaims(jwt.SigningMethodHS256, collaborationClaims{DocumentID: d.ID, SyncEpoch: d.SyncEpoch, RegisteredClaims: jwt.RegisteredClaims{Subject: a.ID, Audience: jwt.ClaimStrings{"cbt-collaboration"}, ExpiresAt: jwt.NewNumericDate(time.Now().Add(10 * time.Minute))}}).SignedString([]byte(s.cfg.JWTSecret))
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"ticket": ticket, "documentId": formRoomName(d), "url": env("COLLABORATION_PUBLIC_URL", "/realtime"), "name": a.Nama, "role": s.formRole(s.db, a, d)})
}
func formRoomName(d FormDocument) string {
	if d.SyncEpoch == 0 {
		return d.ID
	}
	return d.ID + "~" + strconv.Itoa(d.SyncEpoch)
}
func (s *Server) collaborationAccount(ticket, id string) (CBTAccount, error) {
	claims := &collaborationClaims{}
	_, err := jwt.ParseWithClaims(ticket, claims, func(t *jwt.Token) (any, error) {
		if t.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("invalid algorithm")
		}
		return []byte(s.cfg.JWTSecret), nil
	}, jwt.WithAudience("cbt-collaboration"))
	if err != nil || formRoomName(FormDocument{Base: Base{ID: claims.DocumentID}, SyncEpoch: claims.SyncEpoch}) != id {
		return CBTAccount{}, fiber.NewError(401, "Tiket kolaborasi tidak valid")
	}
	var a CBTAccount
	if s.db.First(&a, "id = ? AND active = true", claims.Subject).Error != nil {
		return a, fiber.NewError(403, "Akun nonaktif")
	}
	return a, nil
}
func (s *Server) internalCollaboration(c *fiber.Ctx) error {
	secret := env("CBT_COLLABORATION_SECRET", "")
	if len(secret) < 32 || subtle.ConstantTimeCompare([]byte(c.Get("X-CBT-Collaboration")), []byte(secret)) != 1 {
		return fiber.NewError(401, "Layanan tidak berwenang")
	}
	return c.Next()
}
func (s *Server) internalForm(c *fiber.Ctx) error {
	room := c.Params("id")
	id, _, _ := strings.Cut(room, "~")
	var d FormDocument
	if s.db.First(&d, "id = ?", id).Error != nil {
		return fiber.NewError(404, "Dokumen tidak ditemukan")
	}
	if room != formRoomName(d) {
		return fiber.NewError(409, "Generasi dokumen berubah. Muat versi server atau simpan sebagai salinan.")
	}
	if c.Method() == "GET" {
		var content FormDraft
		_ = json.Unmarshal([]byte(d.ContentJSON), &content)
		return c.JSON(fiber.Map{"revision": d.Revision, "syncEpoch": d.SyncEpoch, "frozen": d.Frozen, "content": content, "yState": d.YState})
	}
	var in struct {
		formSaveInput
		Ticket string `json:"ticket"`
	}
	if c.BodyParser(&in) != nil {
		return fiber.NewError(400, "Dokumen tidak valid")
	}
	a, err := s.collaborationAccount(in.Ticket, room)
	if err != nil {
		return err
	}
	role := s.formRole(s.db, a, d)
	if role == "" {
		return fiber.NewError(403, "Akses kolaborator dicabut")
	}
	if c.Params("action") == "authorize" {
		return c.JSON(fiber.Map{"role": role, "frozen": d.Frozen, "revision": d.Revision, "userId": a.ID, "name": a.Nama})
	}
	if c.Params("action") == "publish" {
		v, err := s.publishFormDocument(a, d, in.Revision)
		if err != nil {
			return err
		}
		return c.JSON(fiber.Map{"published": true, "versionId": v.ID, "checksum": v.Checksum})
	}
	if c.Params("action") != "store" {
		return fiber.NewError(404, "Tindakan kolaborasi tidak tersedia")
	}
	if len(in.YState) == 0 || len(in.YState) > 2*1024*1024 {
		return fiber.NewError(400, "State kolaborasi tidak valid")
	}
	in.SyncEpoch = &d.SyncEpoch
	d, err = s.saveFormDocument(a, id, in.formSaveInput)
	if err != nil {
		return err
	}
	return c.JSON(fiber.Map{"revision": d.Revision, "saved": true})
}
func (s *Server) registerForms(api fiber.Router, staff fiber.Router) {
	guard := func(c *fiber.Ctx) error {
		if env("CBT_FORMS_ENABLED", "false") != "true" {
			return fiber.NewError(404, "Editor baru belum diaktifkan")
		}
		return c.Next()
	}
	staff.Get("/forms/:kind", guard, s.formLibrary)
	staff.Get("/form-preferences", guard, s.formPreferences)
	staff.Put("/form-preferences", guard, s.formPreferences)
	staff.Post("/forms/:kind", guard, s.createForm)
	staff.Get("/forms/:kind/:id", guard, s.getForm)
	staff.Put("/forms/:kind/:id", guard, s.saveForm)
	staff.Post("/forms/:kind/:id/publish", guard, s.publishForm)
	staff.Post("/forms/:kind/:id/unpublish", guard, s.unpublishFormResource)
	staff.Post("/forms/:kind/:id/copy", guard, s.copyForm)
	staff.Get("/forms/:kind/:id/preview", guard, s.formPreview)
	staff.Get("/forms/:kind/:id/usage", guard, s.formUsage)
	staff.Post("/forms/:kind/:id/preview", guard, s.formPreview)
	staff.Get("/forms/:kind/:id/collaborators", guard, s.formCollaborators)
	staff.Put("/forms/:kind/:id/collaborators", guard, s.formCollaborators)
	staff.Post("/forms/:kind/:id/ticket", guard, s.collaborationTicket)
	staff.Get("/forms/:kind/:id/links", guard, s.formLinks)
	staff.Post("/forms/:kind/:id/links", guard, s.formLinks)
	staff.Delete("/forms/:kind/:id/links/:linkId", guard, s.formLinks)
	staff.Put("/forms/:kind/:id/acceptance", guard, s.formResponseAcceptance)
	staff.Get("/forms/:kind/:id/result-release", guard, s.formResultRelease)
	staff.Post("/forms/:kind/:id/result-release", guard, s.formResultRelease)
	api.Get("/internal/form-docs/:id", guard, s.internalCollaboration, s.internalForm)
	api.Post("/internal/form-docs/:id/:action", guard, s.internalCollaboration, s.internalForm)
}
