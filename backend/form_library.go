package main

import (
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"time"
)

// The library includes explicitly shared documents, never another tutor's
// entire bank. Legacy resources remain accessible without rewriting them.
func (s *Server) formLibrary(c *fiber.Ctx) error {
	a := currentAccount(c)
	kind := c.Params("kind")
	if kind != "assessment" && kind != "package" {
		return fiber.NewError(400, "Jenis pustaka tidak valid")
	}
	var docs []FormDocument
	query := s.db.Model(&FormDocument{}).Where("resource_type = ?", kind)
	if a.Role != "admin" && a.Role != "kepala_sekolah" {
		members := s.db.Model(&FormCollaborator{}).Select("document_id").Where("account_id = ? AND revoked = false", a.ID)
		query = query.Where("owner_id = ? OR id IN (?)", a.ID, members)
	}
	if err := query.Find(&docs).Error; err != nil {
		return err
	}
	byResource := map[string]FormDocument{}
	ids := []string{}
	for _, doc := range docs {
		byResource[doc.ResourceID] = doc
		ids = append(ids, doc.ResourceID)
	}
	type entry struct {
		ID        string    `json:"id"`
		Title     string    `json:"title"`
		Status    string    `json:"status"`
		Kind      string    `json:"kind"`
		Subject   string    `json:"subject"`
		ClassIDs  []string  `json:"classIds"`
		CreatedAt time.Time `json:"createdAt"`
		UpdatedAt time.Time `json:"updatedAt"`
		Role      string    `json:"role"`
	}
	out := []entry{}
	if kind == "assessment" {
		var rows []Assessment
		q := s.db.Where("trashed_at IS NULL")
		if a.Role == "guru" {
			q = q.Where("owner_id = ? OR id IN ?", a.ID, append(ids, "__none__"))
		}
		if err := q.Order("updated_at DESC").Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			out = append(out, entry{ID: row.ID, Title: row.Title, Status: row.Status, Kind: row.Kind, Subject: row.SubjectID, ClassIDs: []string{row.ClassID}, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt})
		}
	} else {
		var rows []QuestionPackage
		q := s.db.Model(&QuestionPackage{})
		if a.Role == "guru" {
			q = q.Where("created_by = ? OR id IN ?", a.ID, append(ids, "__none__"))
		}
		if err := q.Order("updated_at DESC").Find(&rows).Error; err != nil {
			return err
		}
		for _, row := range rows {
			out = append(out, entry{ID: row.ID, Title: row.Title, Status: row.Status, Subject: row.Subject, ClassIDs: []string{}, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt})
		}
	}
	var subjects []MasterMapel
	if err := s.db.Find(&subjects).Error; err != nil {
		return err
	}
	names := map[string]string{}
	for _, subject := range subjects {
		names[subject.ID] = subject.Nama
	}
	for i := range out {
		row := &out[i]
		if doc, ok := byResource[row.ID]; ok {
			var draft FormDraft
			if json.Unmarshal([]byte(doc.ContentJSON), &draft) != nil {
				return fiber.NewError(500, "Dokumen pustaka tidak dapat dibaca")
			}
			row.ClassIDs = draft.Settings.ClassIDs
			row.Role = s.formRole(s.db, a, doc)
		} else if a.Role == "kepala_sekolah" {
			row.Role = "viewer"
		} else {
			row.Role = "owner"
		}
		if name := names[row.Subject]; name != "" {
			row.Subject = name
		}
	}
	c.Set("Cache-Control", "no-store")
	return c.JSON(out)
}

func (s *Server) formUsage(c *fiber.Ctx) error {
	a := currentAccount(c)
	d, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	var docs []FormDocument
	if err = s.db.Where("source_document_id = ?", d.ID).Order("created_at DESC").Find(&docs).Error; err != nil {
		return err
	}
	out := []fiber.Map{}
	for _, used := range docs {
		if role := s.formRole(s.db, a, used); role != "" {
			var draft FormDraft
			_ = json.Unmarshal([]byte(used.ContentJSON), &draft)
			out = append(out, fiber.Map{"id": used.ResourceID, "resourceType": used.ResourceType, "title": draft.Title, "kind": draft.Settings.Kind, "frozen": used.Frozen, "createdAt": used.CreatedAt})
		}
	}
	return c.JSON(out)
}
