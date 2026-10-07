package main

import (
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

type dashboardAction struct {
	Title       string `json:"title"`
	Description string `json:"description"`
	Count       int64  `json:"count,omitempty"`
	Tab         string `json:"tab"`
	Tone        string `json:"tone"`
}

type dashboardTrend struct {
	Date        string `json:"date"`
	Attempts    int64  `json:"attempts"`
	Submissions int64  `json:"submissions"`
}

// dashboardSummary deliberately returns aggregates only. Assessment ownership
// and class scope are resolved on the server so clients cannot widen a view by
// changing query parameters.
func (s *Server) dashboardSummary(c *fiber.Ctx) error {
	rangeKey := c.Query("range", "7d")
	days := map[string]int{"7d": 7, "30d": 30, "90d": 90}[rangeKey]
	if days == 0 {
		return fiber.NewError(fiber.StatusBadRequest, "Rentang ringkasan harus 7d, 30d, atau 90d")
	}
	account := currentAccount(c)
	now := time.Now().UTC()
	periodStart := now.AddDate(0, 0, -days)
	assessmentQuery := s.db.Model(&Assessment{}).Where("trashed_at IS NULL")
	questionQuery := s.db.Model(&Question{}).Where("archived_at IS NULL AND trashed_at IS NULL")
	if account.Role == "guru" {
		assessmentQuery = assessmentQuery.Where("owner_id = ?", account.ID)
		questionQuery = questionQuery.Where("owner_id = ?", account.ID)
	}

	count := func(query *gorm.DB) (int64, error) {
		var value int64
		err := query.Count(&value).Error
		return value, err
	}
	metrics := map[string]int64{}
	var err error
	if metrics["assessmentsPublished"], err = count(assessmentQuery.Session(&gorm.Session{}).Where("status = ?", "published")); err != nil {
		return err
	}
	if metrics["assessmentsDraft"], err = count(assessmentQuery.Session(&gorm.Session{}).Where("status = ?", "draft")); err != nil {
		return err
	}
	if metrics["questions"], err = count(questionQuery); err != nil {
		return err
	}

	var assessmentIDs []string
	if err := assessmentQuery.Session(&gorm.Session{}).Pluck("id", &assessmentIDs).Error; err != nil {
		return err
	}
	attemptQuery := s.db.Model(&Attempt{})
	if len(assessmentIDs) == 0 {
		attemptQuery = attemptQuery.Where("1 = 0")
	} else {
		attemptQuery = attemptQuery.Where("assessment_id IN ?", assessmentIDs)
	}
	if metrics["activeAttempts"], err = count(attemptQuery.Session(&gorm.Session{}).Where("status = ?", "started")); err != nil {
		return err
	}
	if metrics["pendingGrading"], err = count(attemptQuery.Session(&gorm.Session{}).Where("needs_manual = ? AND status IN ?", true, []string{"submitted", "pending_grade"})); err != nil {
		return err
	}
	if metrics["attemptsInPeriod"], err = count(attemptQuery.Session(&gorm.Session{}).Where("started_at >= ?", periodStart)); err != nil {
		return err
	}
	if metrics["submissionsInPeriod"], err = count(attemptQuery.Session(&gorm.Session{}).Where("submitted_at >= ?", periodStart)); err != nil {
		return err
	}
	type dailyCount struct {
		Day   time.Time `gorm:"column:day"`
		Count int64     `gorm:"column:count"`
	}
	startDay := time.Date(periodStart.Year(), periodStart.Month(), periodStart.Day(), 0, 0, 0, 0, time.UTC)
	today := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, time.UTC)
	trendByDate := make(map[string]*dashboardTrend, days+1)
	for day := startDay; !day.After(today); day = day.AddDate(0, 0, 1) {
		key := day.Format(time.DateOnly)
		trendByDate[key] = &dashboardTrend{Date: key}
	}
	var attemptDays []dailyCount
	if err := attemptQuery.Session(&gorm.Session{}).Select("DATE(started_at) AS day, COUNT(*) AS count").Where("started_at >= ?", periodStart).Group("DATE(started_at)").Scan(&attemptDays).Error; err != nil {
		return err
	}
	for _, row := range attemptDays {
		if trend := trendByDate[row.Day.Format(time.DateOnly)]; trend != nil {
			trend.Attempts = row.Count
		}
	}
	var submissionDays []dailyCount
	if err := attemptQuery.Session(&gorm.Session{}).Select("DATE(submitted_at) AS day, COUNT(*) AS count").Where("submitted_at >= ?", periodStart).Group("DATE(submitted_at)").Scan(&submissionDays).Error; err != nil {
		return err
	}
	for _, row := range submissionDays {
		if trend := trendByDate[row.Day.Format(time.DateOnly)]; trend != nil {
			trend.Submissions = row.Count
		}
	}
	trends := make([]dashboardTrend, 0, len(trendByDate))
	for day := startDay; !day.After(today); day = day.AddDate(0, 0, 1) {
		trends = append(trends, *trendByDate[day.Format(time.DateOnly)])
	}
	if metrics["upcomingSchedules"], err = count(assessmentQuery.Session(&gorm.Session{}).Where("status = ? AND starts_at >= ? AND starts_at <= ?", "published", now, now.AddDate(0, 0, 7))); err != nil {
		return err
	}

	classQuery := s.db.Model(&MasterKelas{}).Where("active = ?", true)
	studentQuery := s.db.Model(&MasterPeserta{}).Where("active = ?", true)
	if account.Role == "guru" {
		var classIDs []string
		if account.TutorID != "" {
			if err := s.db.Model(&MasterKelas{}).Where("active = ? AND wali_kelas_id = ?", true, account.TutorID).Pluck("id", &classIDs).Error; err != nil {
				return err
			}
		}
		if len(classIDs) == 0 {
			if err := s.db.Model(&Assessment{}).Where("owner_id = ? AND trashed_at IS NULL AND class_id <> ''", account.ID).Distinct().Pluck("class_id", &classIDs).Error; err != nil {
				return err
			}
		}
		if len(classIDs) == 0 {
			classQuery, studentQuery = classQuery.Where("1 = 0"), studentQuery.Where("1 = 0")
		} else {
			classQuery = classQuery.Where("id IN ?", classIDs)
			studentQuery = studentQuery.Where("kelas_id IN ?", classIDs)
		}
	}
	if metrics["activeClasses"], err = count(classQuery); err != nil {
		return err
	}
	if metrics["activeStudents"], err = count(studentQuery); err != nil {
		return err
	}
	if account.Role == "admin" {
		if metrics["activeAccounts"], err = count(s.db.Model(&CBTAccount{}).Where("active = ?", true)); err != nil {
			return err
		}
		if metrics["inactiveAccounts"], err = count(s.db.Model(&CBTAccount{}).Where("active = ?", false)); err != nil {
			return err
		}
		if metrics["studentsMissingClass"], err = count(s.db.Model(&MasterPeserta{}).Where("active = ? AND (kelas_id = '' OR kelas_id IS NULL)", true)); err != nil {
			return err
		}
		if metrics["undeliveredResults"], err = count(s.db.Model(&IntegrationOutbox{}).Where("delivered_at IS NULL")); err != nil {
			return err
		}
	}

	var latestSync SyncRun
	syncStatus := "never"
	var syncAt *time.Time
	if err := s.db.Order("started_at desc").First(&latestSync).Error; err == nil {
		syncStatus = latestSync.Status
		stamp := latestSync.FinishedAt
		if stamp == nil {
			started := latestSync.StartedAt
			stamp = &started
		}
		syncAt = stamp
	} else if err != gorm.ErrRecordNotFound {
		return err
	}

	actions := make([]dashboardAction, 0, 6)
	add := func(title, description, tab, tone string, value int64) {
		if value > 0 {
			actions = append(actions, dashboardAction{Title: title, Description: description, Count: value, Tab: tab, Tone: tone})
		}
	}
	if account.Role == "admin" {
		if syncStatus != "success" || syncAt == nil || now.Sub(*syncAt) > 15*time.Minute {
			add("Periksa sinkronisasi LMS", "Status data kelas dan siswa perlu dipastikan.", "sync", "warning", 1)
		}
		add("Lengkapi kesehatan roster", "Sebagian siswa aktif belum terhubung ke kelas.", "students", "warning", metrics["studentsMissingClass"])
		add("Tinjau penilaian tertunda", "Jawaban siswa menunggu penilaian tutor.", "results", "info", metrics["pendingGrading"])
		add("Periksa antrean hasil", "Sebagian hasil belum mendapat konfirmasi pengiriman ke LMS.", "sync", "warning", metrics["undeliveredResults"])
		add("Lanjutkan draf asesmen", "Draf yang belum diterbitkan.", "assessments", "info", metrics["assessmentsDraft"])
	} else if account.Role == "guru" {
		add("Lanjutkan draf asesmen", "Draf milik Anda yang belum diterbitkan.", "assessments", "info", metrics["assessmentsDraft"])
		add("Periksa jadwal 7 hari ke depan", "Asesmen terbit yang segera dimulai.", "schedule", "info", metrics["upcomingSchedules"])
		add("Nilai jawaban uraian", "Respons siswa menunggu penilaian manual.", "results", "warning", metrics["pendingGrading"])
		add("Pantau sesi aktif", "Siswa sedang mengerjakan asesmen Anda.", "monitor", "info", metrics["activeAttempts"])
	} else {
		add("Tinjau hasil terbaru", "Buka laporan kelas dalam mode baca-saja.", "results", "info", metrics["submissionsInPeriod"])
		add("Pantau sesi berjalan", "Lihat status asesmen yang sedang berlangsung.", "monitor", "info", metrics["activeAttempts"])
	}

	return c.JSON(fiber.Map{
		"asOf": now, "range": rangeKey, "role": account.Role,
		"periodStart": periodStart, "metrics": metrics, "trends": trends,
		"operations": fiber.Map{"syncStatus": syncStatus, "syncAt": syncAt},
		"actions":    actions,
	})
}
