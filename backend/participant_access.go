package main

import (
	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"strings"
	"time"
)

func assessmentOpen(a Assessment, now time.Time) bool {
	return a.Status == "published" && !a.ResponsesPaused && a.TrashedAt == nil && (a.StartsAt == nil || !now.Before(*a.StartsAt)) && (a.EndsAt == nil || now.Before(*a.EndsAt))
}
func publicAssessment(a Assessment) fiber.Map {
	return fiber.Map{"id": a.ID, "title": a.Title, "kind": a.Kind, "subjectId": a.SubjectID, "durationMinute": a.DurationMinute}
}
func (s *Server) accessibleByCode(code, id string) ([]Assessment, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return nil, fiber.NewError(400, "Kode tutor wajib diisi")
	}
	rows := []Assessment{}
	query := s.db.Where("status = ? AND trashed_at IS NULL AND access_code_hash = ?", "published", hash(code))
	if id != "" {
		query = query.Where("id = ?", id)
	}
	if err := query.Find(&rows).Error; err != nil {
		return nil, err
	}
	available := []Assessment{}
	for _, a := range rows {
		if assessmentOpen(a, time.Now()) {
			available = append(available, a)
		}
	}
	return available, nil
}
func (s *Server) resolveAssessmentCode(c *fiber.Ctx) error {
	var input struct {
		AccessCode   string `json:"accessCode"`
		AssessmentID string `json:"assessmentId"`
		LinkToken    string `json:"linkToken"`
	}
	if c.BodyParser(&input) != nil {
		return fiber.NewError(400, "Kode tutor tidak valid")
	}
	var rows []Assessment
	var err error
	if input.LinkToken != "" {
		var row Assessment
		row, _, err = s.resolveFormLink(input.LinkToken)
		rows = []Assessment{row}
	} else {
		rows, err = s.accessibleByCode(input.AccessCode, input.AssessmentID)
	}
	if err != nil {
		return err
	}
	if len(rows) == 0 {
		return fiber.NewError(404, "Kode tidak sesuai atau asesmen belum tersedia dalam jadwal")
	}
	output := []fiber.Map{}
	for _, a := range rows {
		row := publicAssessment(a)
		var subject MasterMapel
		if s.db.First(&subject, "id = ?", a.SubjectID).Error == nil {
			row["subjectName"] = subject.Nama
		}
		var class MasterKelas
		if s.db.First(&class, "id = ?", a.ClassID).Error == nil {
			row["gradeLevel"] = class.Jenjang
		}
		output = append(output, row)
	}
	c.Set("Cache-Control", "no-store")
	return c.JSON(fiber.Map{"assessments": output})
}
func (s *Server) issueAssessmentToken(account CBTAccount, ids []string, linkID ...string) (string, error) {
	link := ""
	if len(linkID) > 0 {
		link = linkID[0]
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, authClaims{Role: "siswa", StudentID: account.PesertaDidikID, AssessmentIDs: ids, AccessLinkID: link, RegisteredClaims: jwt.RegisteredClaims{Subject: account.ID, ExpiresAt: jwt.NewNumericDate(time.Now().Add(8 * time.Hour)), IssuedAt: jwt.NewNumericDate(time.Now())}}).SignedString([]byte(s.cfg.JWTSecret))
}
func (s *Server) studentLearningGroup(id string) string {
	var group MasterKelompokBelajar
	if s.db.First(&group, "id = ?", id).Error == nil {
		return group.Nama
	}
	return ""
}
func (s *Server) studentRosterIdentity(c *fiber.Ctx) error {
	a := currentAccount(c)
	var student MasterPeserta
	if s.db.First(&student, "id = ? AND active = true", a.PesertaDidikID).Error != nil {
		return fiber.NewError(403, "Profil siswa tidak aktif")
	}
	var class MasterKelas
	_ = s.db.First(&class, "id = ?", student.KelasID).Error
	c.Set("Cache-Control", "no-store")
	return c.JSON(fiber.Map{"id": student.ID, "name": student.Nama, "nis": student.NIS, "nisn": student.NISN, "className": class.Nama, "gender": student.JenisKelamin, "learningGroup": s.studentLearningGroup(student.PokjarID)})
}
func (s *Server) listSubjects(c *fiber.Ctx) error {
	rows := []MasterMapel{}
	if err := s.db.Where("active = true").Order("nama").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}
