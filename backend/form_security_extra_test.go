package main

import (
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"testing"
	"time"
)

func TestPostgresFileAnswerRequiresExactOwnedAttachment(t *testing.T) {
	s, _ := postgresFormServer(t)
	a := Attempt{AssessmentID: uuid.NewString(), StudentID: uuid.NewString(), Number: 1, Status: "started"}
	if err := s.db.Create(&a).Error; err != nil {
		t.Fatal(err)
	}
	item := AttemptItem{AttemptID: a.ID, Position: 1}
	if err := s.db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	file := AttemptAttachment{AttemptID: a.ID, AttemptItemID: item.ID, StudentID: a.StudentID, StoredName: uuid.NewString() + ".png"}
	if err := s.db.Create(&file).Error; err != nil {
		t.Fatal(err)
	}
	q := questionSnapshot{Type: "unggah_berkas"}
	value := []any{map[string]any{"id": file.ID, "name": "arbitrary client name"}}
	if err := validateResponseAttachments(s.db, item, q, value); err != nil {
		t.Fatal(err)
	}
	foreign := item
	foreign.ID = uuid.NewString()
	if validateResponseAttachments(s.db, foreign, q, value) == nil {
		t.Fatal("another question claimed attachment")
	}
	if validateResponseAttachments(s.db, item, q, []any{map[string]any{"id": uuid.NewString()}}) == nil {
		t.Fatal("invented file accepted")
	}
	now := time.Now()
	_ = s.db.Model(&file).Update("deleted_at", now).Error
	if validateResponseAttachments(s.db, item, q, value) == nil {
		t.Fatal("deleted attachment accepted")
	}
}

func TestPostgresBothModulesRejectInvalidOrUnassignedCodeBeforeSession(t *testing.T) {
	for _, kind := range []string{"ujian_online", "simulasi"} {
		t.Run(kind, func(t *testing.T) {
			s, owner := postgresFormServer(t)
			doc, draft := createPostgresForm(t, s, owner)
			draft.Settings.Kind = kind
			saved, err := s.saveFormDocument(owner, doc.ID, formSaveInput{Revision: 1, Content: draft})
			if err != nil {
				t.Fatal(err)
			}
			if _, err = s.publishFormDocument(owner, saved, saved.Revision); err != nil {
				t.Fatal(err)
			}
			student := MasterPeserta{Nama: "Unassigned", NISN: "8787878701", KelasID: uuid.NewString(), Active: true}
			if err = s.db.Create(&student).Error; err != nil {
				t.Fatal(err)
			}
			app := fiber.New(fiber.Config{ErrorHandler: apiError})
			app.Post("/login", s.publicExamLogin)
			for _, code := range []string{"WRONG", "VALID123"} {
				status, p := formTestCall(t, app, "POST", "/login", `{"nisn":"8787878701","accessCode":"`+code+`"}`)
				if status < 400 || p["accessToken"] != nil {
					t.Fatal("invalid session", status, p)
				}
			}
			var n int64
			_ = s.db.Model(&CBTAccount{}).Where("peserta_didik_id = ?", student.ID).Count(&n).Error
			if n != 0 {
				t.Fatal("account created before validation")
			}
		})
	}
}

func TestFormRejectsUnstableOrMalformedOptionsAndInaccessibleTheme(t *testing.T) {
	for _, choices := range []any{"not-an-array", map[string]any{"id": "x"}, []any{map[string]any{"id": "duplicate"}, map[string]any{"id": "duplicate"}}, []any{map[string]any{"text": "no stable ID"}}} {
		d := formFixture()
		for id, card := range d.Cards {
			card.Config["choices"] = choices
			d.Cards[id] = card
		}
		if validateForm(d, false) == nil {
			t.Fatal("malformed/stale option accepted", choices)
		}
	}
	d := formFixture()
	d.Settings.ThemeColor = "#ffffff"
	if validateForm(d, true) == nil {
		t.Fatal("invisible header text accepted")
	}
}
