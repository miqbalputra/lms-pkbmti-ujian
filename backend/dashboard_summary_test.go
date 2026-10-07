package main

import (
	"encoding/json"
	"io"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

func dashboardSummaryFor(t *testing.T, s *Server, account CBTAccount, rangeKey string) (int, map[string]any, string) {
	t.Helper()
	app := fiber.New()
	app.Get("/summary", func(c *fiber.Ctx) error {
		c.Locals("account", account)
		return s.dashboardSummary(c)
	})
	request := httptest.NewRequest("GET", "/summary?range="+rangeKey, nil)
	response, err := app.Test(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(response.Body)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if response.StatusCode == fiber.StatusOK {
		if err := json.Unmarshal(body, &decoded); err != nil {
			t.Fatal(err)
		}
	}
	return response.StatusCode, decoded, string(body)
}

func TestHeadTeacherStaffAPIIsReadOnly(t *testing.T) {
	app := fiber.New()
	app.Use(func(c *fiber.Ctx) error {
		c.Locals("account", CBTAccount{Role: "kepala_sekolah"})
		return c.Next()
	})
	app.Get("/staff/read", headTeacherReadOnly, func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) })
	app.Post("/staff/write", headTeacherReadOnly, func(c *fiber.Ctx) error { return c.SendStatus(fiber.StatusNoContent) })

	readResponse, err := app.Test(httptest.NewRequest("GET", "/staff/read", nil))
	if err != nil {
		t.Fatal(err)
	}
	defer readResponse.Body.Close()
	if readResponse.StatusCode != fiber.StatusNoContent {
		t.Fatalf("headteacher read request status = %d", readResponse.StatusCode)
	}
	writeResponse, err := app.Test(httptest.NewRequest("POST", "/staff/write", strings.NewReader(`{"change":true}`)))
	if err != nil {
		t.Fatal(err)
	}
	defer writeResponse.Body.Close()
	if writeResponse.StatusCode != fiber.StatusForbidden {
		t.Fatalf("headteacher write request status = %d, expected forbidden", writeResponse.StatusCode)
	}
}

func TestPostgresDashboardSummaryScopesAggregatesByRoleAndRejectsInvalidRange(t *testing.T) {
	s, tutor := postgresFormServer(t)
	otherTutor := CBTAccount{Username: "other-tutor", Nama: "Tutor Lain", Role: "guru", Active: true}
	admin := CBTAccount{Username: "dashboard-admin", Nama: "Admin", Role: "admin", Active: true}
	head := CBTAccount{Username: "dashboard-head", Nama: "Kepala", Role: "kepala_sekolah", Active: true}
	for _, account := range []*CBTAccount{&otherTutor, &admin, &head} {
		if err := s.db.Create(account).Error; err != nil {
			t.Fatal(err)
		}
	}
	classA := MasterKelas{Nama: "Kelas A", Active: true}
	classB := MasterKelas{Nama: "Kelas B", Active: true}
	if err := s.db.Create(&classA).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Create(&classB).Error; err != nil {
		t.Fatal(err)
	}
	studentA := MasterPeserta{Nama: "Nama Rahasia Satu", KelasID: classA.ID, Active: true}
	studentB := MasterPeserta{Nama: "Nama Rahasia Dua", KelasID: classB.ID, Active: true}
	if err := s.db.Create(&studentA).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Create(&studentB).Error; err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	assessmentA := Assessment{OwnerID: tutor.ID, Kind: "ujian_online", Title: "Formal A", Status: "published", ClassID: classA.ID, DurationMinute: 60}
	assessmentB := Assessment{OwnerID: otherTutor.ID, Kind: "simulasi", Title: "Latihan B", Status: "published", ClassID: classB.ID, DurationMinute: 30}
	if err := s.db.Create(&assessmentA).Error; err != nil {
		t.Fatal(err)
	}
	if err := s.db.Create(&assessmentB).Error; err != nil {
		t.Fatal(err)
	}
	started := now.Add(-time.Minute)
	submitted := now
	attemptA := Attempt{AssessmentID: assessmentA.ID, StudentID: studentA.ID, ClassIDAtAttempt: classA.ID, Number: 1, Status: "started", StartedAt: &started}
	attemptB := Attempt{AssessmentID: assessmentA.ID, StudentID: studentA.ID, ClassIDAtAttempt: classA.ID, Number: 2, Status: "submitted", SubmittedAt: &submitted, NeedsManual: true}
	attemptOther := Attempt{AssessmentID: assessmentB.ID, StudentID: studentB.ID, ClassIDAtAttempt: classB.ID, Number: 1, Status: "started", StartedAt: &started}
	for _, attempt := range []*Attempt{&attemptA, &attemptB, &attemptOther} {
		if err := s.db.Create(attempt).Error; err != nil {
			t.Fatal(err)
		}
	}

	status, tutorSummary, body := dashboardSummaryFor(t, s, tutor, "7d")
	if status != fiber.StatusOK {
		t.Fatalf("tutor summary status = %d, body=%s", status, body)
	}
	metrics := tutorSummary["metrics"].(map[string]any)
	if metrics["assessmentsPublished"] != float64(1) || metrics["activeAttempts"] != float64(1) || metrics["pendingGrading"] != float64(1) {
		t.Fatalf("tutor summary was not restricted to tutor-owned work: %#v", metrics)
	}
	if strings.Contains(body, studentA.Nama) || strings.Contains(body, studentB.Nama) || strings.Contains(body, assessmentA.Title) || strings.Contains(body, assessmentB.Title) {
		t.Fatalf("dashboard aggregate exposed individual records: %s", body)
	}

	status, headSummary, body := dashboardSummaryFor(t, s, head, "7d")
	if status != fiber.StatusOK {
		t.Fatalf("head summary status = %d, body=%s", status, body)
	}
	if got := headSummary["metrics"].(map[string]any)["assessmentsPublished"]; got != float64(2) {
		t.Fatalf("headteacher should receive school-wide aggregate, got %v", got)
	}
	if status, _, body = dashboardSummaryFor(t, s, admin, "all"); status != fiber.StatusBadRequest {
		t.Fatalf("invalid range status = %d, body=%s", status, body)
	}
}
