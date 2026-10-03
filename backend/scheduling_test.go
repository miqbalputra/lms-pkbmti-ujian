package main

import (
	"strings"
	"testing"
	"time"
)

func TestScheduleConflictsRespectClassRoomAndTimeBoundaries(t *testing.T) {
	start := time.Date(2026, 10, 3, 9, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	otherStart := start.Add(30 * time.Minute)
	otherEnd := end.Add(30 * time.Minute)
	booked := []Assessment{
		{Base: Base{ID: "same-class"}, Title: "Ujian Paket A", Status: "published", ClassID: "class-a", Room: "Lab", StartsAt: &otherStart, EndsAt: &otherEnd},
		{Base: Base{ID: "same-room"}, Title: "Simulasi Paket B", Status: "published", ClassID: "class-b", Room: " R. 1 ", StartsAt: &otherStart, EndsAt: &otherEnd},
		{Base: Base{ID: "draft"}, Title: "Draf", Status: "draft", ClassID: "class-a", Room: "R. 1", StartsAt: &otherStart, EndsAt: &otherEnd},
		{Base: Base{ID: "touching"}, Title: "Tepat berurutan", Status: "published", ClassID: "class-a", Room: "R. 1", StartsAt: &end, EndsAt: func() *time.Time { value := end.Add(time.Hour); return &value }()},
	}
	candidate := Assessment{Base: Base{ID: "candidate"}, Status: "published", ClassID: "class-a", Room: "R. 1", StartsAt: &start, EndsAt: &end}
	conflicts := scheduleConflicts(candidate, booked)
	if len(conflicts) != 2 || conflicts[0].ID != "same-class" || conflicts[1].ID != "same-room" {
		t.Fatalf("expected only overlapping published same-class/same-room records, got %#v", conflicts)
	}
	candidate.ClassID, candidate.Room = "class-c", ""
	if got := scheduleConflicts(candidate, booked); len(got) != 0 {
		t.Fatalf("unrelated class with no room should not conflict: %#v", got)
	}
}

func TestScheduleConflictMessageIsActionable(t *testing.T) {
	start := time.Date(2026, 10, 3, 9, 0, 0, 0, time.UTC)
	end := start.Add(time.Hour)
	conflict := Assessment{Base: Base{ID: "existing"}, Title: "Ujian yang sudah terbit", Status: "published", ClassID: "class-a", StartsAt: &start, EndsAt: &end}
	candidate := Assessment{Base: Base{ID: "new"}, Title: "Ujian baru", Status: "published", ClassID: "class-a", StartsAt: &start, EndsAt: &end}
	rows := scheduleConflicts(candidate, []Assessment{conflict})
	if len(rows) != 1 || !strings.Contains(rows[0].Title, "Ujian yang sudah terbit") {
		t.Fatalf("expected schedule overlap to be found, got %#v", rows)
	}
}

func TestRandomizedAttemptOrderIsStableAndPerAttempt(t *testing.T) {
	items := make([]AssessmentItem, 8)
	for index := range items {
		items[index] = AssessmentItem{QuestionID: string(rune('a' + index)), Position: index + 1}
	}
	first, _ := shuffledAssessmentItems(items, "attempt-alpha", "assessment-1")
	firstAgain, _ := shuffledAssessmentItems(items, "attempt-alpha", "assessment-1")
	second, _ := shuffledAssessmentItems(items, "attempt-beta", "assessment-1")
	ids := func(rows []AssessmentItem) []string {
		result := make([]string, len(rows))
		for index, row := range rows {
			result[index] = row.QuestionID
		}
		return result
	}
	firstIDs, repeatIDs, secondIDs := ids(first), ids(firstAgain), ids(second)
	for index := range firstIDs {
		if firstIDs[index] != repeatIDs[index] {
			t.Fatalf("same attempt seed must resume with the same order: %v vs %v", firstIDs, repeatIDs)
		}
	}
	same := true
	for index := range firstIDs {
		if firstIDs[index] != secondIDs[index] {
			same = false
			break
		}
	}
	if same {
		t.Fatalf("distinct student attempt seeds should yield different orders for this test fixture: %v", firstIDs)
	}
	if items[0].QuestionID != "a" {
		t.Fatal("randomization must not mutate the published assessment order")
	}
}
