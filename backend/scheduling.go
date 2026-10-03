package main

import (
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

// scheduleConflicts is deliberately pure so conflict policy can be verified
// without a live database. A conflict exists when the time windows overlap
// and either the same class or the same physical room is booked.
func scheduleConflicts(candidate Assessment, existing []Assessment) []Assessment {
	if candidate.StartsAt == nil || candidate.EndsAt == nil || !candidate.EndsAt.After(*candidate.StartsAt) {
		return nil
	}
	conflicts := make([]Assessment, 0)
	for _, row := range existing {
		if row.ID == candidate.ID || row.Status != "published" || row.TrashedAt != nil || row.StartsAt == nil || row.EndsAt == nil {
			continue
		}
		overlaps := candidate.StartsAt.Before(*row.EndsAt) && candidate.EndsAt.After(*row.StartsAt)
		sameClass := candidate.ClassID != "" && row.ClassID == candidate.ClassID
		sameRoom := strings.TrimSpace(candidate.Room) != "" && strings.EqualFold(strings.TrimSpace(candidate.Room), strings.TrimSpace(row.Room))
		if overlaps && (sameClass || sameRoom) {
			conflicts = append(conflicts, row)
		}
	}
	return conflicts
}

func (s *Server) validatePublishedSchedule(db *gorm.DB, candidate Assessment) error {
	if candidate.Status != "published" || candidate.StartsAt == nil || candidate.EndsAt == nil {
		return nil
	}
	lockKeys := make([]string, 0, 2)
	if candidate.ClassID != "" {
		lockKeys = append(lockKeys, "cbt-schedule-class:"+candidate.ClassID)
	}
	if room := strings.TrimSpace(candidate.Room); room != "" {
		lockKeys = append(lockKeys, "cbt-schedule-room:"+strings.ToLower(room))
	}
	sort.Strings(lockKeys)
	for _, key := range lockKeys {
		if err := db.Exec("SELECT pg_advisory_xact_lock(hashtext(?))", key).Error; err != nil {
			return err
		}
	}
	var existing []Assessment
	query := db.Where("status = ? AND trashed_at IS NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_at < ? AND ends_at > ?", "published", candidate.EndsAt, candidate.StartsAt)
	if candidate.ID != "" {
		query = query.Where("id <> ?", candidate.ID)
	}
	if err := query.Find(&existing).Error; err != nil {
		return err
	}
	conflicts := scheduleConflicts(candidate, existing)
	if len(conflicts) == 0 {
		return nil
	}
	first := conflicts[0]
	reason := "kelas yang sama"
	if candidate.Room != "" && strings.EqualFold(strings.TrimSpace(candidate.Room), strings.TrimSpace(first.Room)) {
		reason = "ruang " + first.Room
	}
	return fiber.NewError(409, "Jadwal bentrok dengan \""+first.Title+"\" ("+reason+"). Pilih waktu atau ruang lain.")
}

func (s *Server) listAssessmentSchedule(c *fiber.Ctx) error {
	account := currentAccount(c)
	query := s.db.Where("trashed_at IS NULL AND starts_at IS NOT NULL")
	if account.Role == "guru" {
		query = query.Where("owner_id = ?", account.ID)
	}
	if classID := strings.TrimSpace(c.Query("classId")); classID != "" {
		query = query.Where("class_id = ?", classID)
	}
	if status := strings.TrimSpace(c.Query("status")); status != "" {
		if status != "draft" && status != "published" && status != "archived" {
			return fiber.NewError(400, "Filter status jadwal tidak valid")
		}
		query = query.Where("status = ?", status)
	}
	var rows []Assessment
	if err := query.Order("starts_at asc, title asc").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}

type monitorParticipant struct {
	StudentID       string     `json:"studentId"`
	Name            string     `json:"name"`
	Status          string     `json:"status"`
	AttemptNumber   int        `json:"attemptNumber,omitempty"`
	StartedAt       *time.Time `json:"startedAt,omitempty"`
	DeadlineAt      *time.Time `json:"deadlineAt,omitempty"`
	SubmittedAt     *time.Time `json:"submittedAt,omitempty"`
	RemainingSecond int64      `json:"remainingSeconds,omitempty"`
}

func (s *Server) assessmentMonitor(c *fiber.Ctx) error {
	account := currentAccount(c)
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ? AND trashed_at IS NULL", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !staffCanWrite(account, assessment.OwnerID) && account.Role != "kepala_sekolah" {
		return fiber.NewError(403, "Akses ditolak")
	}
	var assignments []AssessmentAssignment
	if err := s.db.Where("assessment_id = ?", assessment.ID).Find(&assignments).Error; err != nil {
		return err
	}
	var students []MasterPeserta
	if len(assignments) == 0 {
		if err := s.db.Where("kelas_id = ? AND active = ?", assessment.ClassID, true).Order("nama asc").Find(&students).Error; err != nil {
			return err
		}
	} else {
		ids := make([]string, 0, len(assignments))
		for _, assignment := range assignments {
			ids = append(ids, assignment.StudentID)
		}
		if err := s.db.Where("id IN ?", ids).Order("nama asc").Find(&students).Error; err != nil {
			return err
		}
	}
	var attempts []Attempt
	if err := s.db.Where("assessment_id = ?", assessment.ID).Order("number desc, started_at desc").Find(&attempts).Error; err != nil {
		return err
	}
	latest := make(map[string]Attempt, len(attempts))
	for _, attempt := range attempts {
		if _, exists := latest[attempt.StudentID]; !exists {
			latest[attempt.StudentID] = attempt
		}
	}
	now := time.Now().UTC()
	participants := make([]monitorParticipant, 0, len(students))
	counts := map[string]int{"belum_mulai": 0, "mengerjakan": 0, "selesai": 0}
	for _, student := range students {
		row := monitorParticipant{StudentID: student.ID, Name: student.Nama, Status: "belum_mulai"}
		if !student.Active {
			row.Status = "nonaktif"
		} else if attempt, ok := latest[student.ID]; ok {
			row.AttemptNumber, row.StartedAt, row.DeadlineAt, row.SubmittedAt = attempt.Number, attempt.StartedAt, attempt.DeadlineAt, attempt.SubmittedAt
			if attempt.Status == "started" {
				row.Status = "mengerjakan"
				if attempt.DeadlineAt != nil && attempt.DeadlineAt.After(now) {
					row.RemainingSecond = int64(attempt.DeadlineAt.Sub(now).Seconds())
				}
			} else {
				row.Status = "selesai"
			}
		}
		if row.Status != "nonaktif" {
			counts[row.Status]++
		}
		participants = append(participants, row)
	}
	return c.JSON(fiber.Map{"assessmentId": assessment.ID, "title": assessment.Title, "serverTime": now, "counts": counts, "participants": participants, "refreshAfterSeconds": 15})
}
