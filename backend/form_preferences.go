package main

import (
	"encoding/json"
	"errors"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type FormTutorPreference struct {
	Base
	AccountID    string `gorm:"uniqueIndex" json:"-"`
	SettingsJSON string `gorm:"type:text" json:"-"`
}
type FormPreference struct {
	ThemeColor              string  `json:"themeColor"`
	Font                    string  `json:"font"`
	DurationMinute          int     `json:"durationMinute"`
	ProgressBar             bool    `json:"progressBar"`
	DefaultQuestionPoints   float64 `json:"defaultQuestionPoints"`
	DefaultQuestionRequired bool    `json:"defaultQuestionRequired"`
}

func (p FormPreference) apply(d *FormDraft) {
	d.Settings.ThemeColor = p.ThemeColor
	d.Settings.Font = p.Font
	d.Settings.DurationMinute = p.DurationMinute
	d.Settings.ProgressBar = p.ProgressBar
	d.Settings.DefaultQuestionPoints = p.DefaultQuestionPoints
	d.Settings.DefaultQuestionRequired = p.DefaultQuestionRequired
}
func (s *Server) applyFormPreferences(accountID string, d *FormDraft) error {
	var row FormTutorPreference
	err := s.db.First(&row, "account_id = ?", accountID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return nil
	}
	if err != nil {
		return err
	}
	var p FormPreference
	if err = json.Unmarshal([]byte(row.SettingsJSON), &p); err != nil {
		return err
	}
	p.apply(d)
	return nil
}
func (s *Server) formPreferences(c *fiber.Ctx) error {
	a := currentAccount(c)
	if c.Method() == "GET" {
		d := emptyForm()
		if err := s.applyFormPreferences(a.ID, &d); err != nil {
			return err
		}
		return c.JSON(d.Settings)
	}
	if a.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Akses baca-saja")
	}
	var p FormPreference
	if c.BodyParser(&p) != nil {
		return fiber.NewError(400, "Default tidak valid")
	}
	d := emptyForm()
	p.apply(&d)
	if err := validateForm(d, false); err != nil {
		return err
	}
	if p.DurationMinute < 1 || p.DurationMinute > 1440 {
		return fiber.NewError(400, "Durasi 1 sampai 1440 menit")
	}
	row := FormTutorPreference{AccountID: a.ID, SettingsJSON: marshalJSON(p)}
	if err := s.db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "account_id"}}, DoUpdates: clause.AssignmentColumns([]string{"settings_json", "updated_at"})}).Create(&row).Error; err != nil {
		return err
	}
	s.audit(a.ID, "save_form_defaults", a.ID)
	return c.JSON(p)
}
