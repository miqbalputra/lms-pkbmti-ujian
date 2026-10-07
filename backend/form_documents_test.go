package main

import (
	"encoding/json"
	"github.com/google/uuid"
	"strings"
	"testing"
	"time"
)

func formFixture() FormDraft {
	d := emptyForm()
	id := uuid.NewString()
	d.Title = "Kuis"
	d.Cards[id] = FormCard{ID: id, Type: "pg_tunggal", Prompt: "Berapa 2+2?", Position: 1, Points: 1, Config: configObject(`{"choices":[{"id":"a","text":"4"},{"id":"b","text":"5"}],"correctIds":["a"]}`)}
	return d
}
func TestFormDraftAllowsBlankButPublicationRequiresKeys(t *testing.T) {
	d := formFixture()
	for id, c := range d.Cards {
		c.Prompt = ""
		c.Config = map[string]any{}
		d.Cards[id] = c
	}
	if err := validateForm(d, false); err != nil {
		t.Fatal(err)
	}
	if validateForm(d, true) == nil {
		t.Fatal("blank question published")
	}
}
func TestStableCardIDsOrderAndDeletedCard(t *testing.T) {
	d := formFixture()
	first := orderedCards(d)[0]
	second := first
	second.ID = uuid.NewString()
	second.Position = 0
	d.Cards[second.ID] = second
	if orderedCards(d)[0].ID != second.ID {
		t.Fatal("reorder failed")
	}
	second.Deleted = true
	d.Cards[second.ID] = second
	if len(orderedCards(d)) != 1 || len(d.Cards) != 2 {
		t.Fatal("tombstone must be retained")
	}
}
func TestForwardBranchExcludesSkippedSections(t *testing.T) {
	d := formFixture()
	first := orderedCards(d)[0]
	s1, s2 := uuid.NewString(), uuid.NewString()
	d.Sections[s1] = FormSection{ID: s1, Position: 1}
	d.Sections[s2] = FormSection{ID: s2, Position: 2}
	first.Config["branchToByAnswer"] = map[string]any{"a": s2}
	d.Cards[first.ID] = first
	skipped := first
	skipped.ID = uuid.NewString()
	skipped.SectionID = s1
	skipped.Config = map[string]any{}
	d.Cards[skipped.ID] = skipped
	last := skipped
	last.ID = uuid.NewString()
	last.SectionID = s2
	d.Cards[last.ID] = last
	path := activeFormCards(d, map[string]any{first.ID: "a"})
	if !path[first.ID] || path[skipped.ID] || !path[last.ID] {
		t.Fatal(path)
	}
	first.SectionID = s2
	d.Cards[first.ID] = first
	if validateForm(d, false) == nil {
		t.Fatal("backward/loop branch accepted")
	}
}
func TestStudentFormConfigNeverContainsKeys(t *testing.T) {
	raw := `{"correctIds":["secret"],"choices":[{"id":"a","text":"4","correct":true}],"branchToByAnswer":{"a":"section"},"feedback":"secret feedback","required":true}`
	encoded, _ := json.Marshal(sanitizeStudentConfig(raw))
	for _, secret := range []string{"correctIds", "secret", "branchToByAnswer", "feedback", "correct\""} {
		if strings.Contains(string(encoded), secret) {
			t.Fatalf("leak %s", encoded)
		}
	}
}
func TestAssessmentScheduleGate(t *testing.T) {
	past, future := time.Now().Add(-time.Hour), time.Now().Add(time.Hour)
	a := Assessment{Status: "published", StartsAt: &past, EndsAt: &future}
	if !assessmentOpen(a, time.Now()) {
		t.Fatal("valid schedule denied")
	}
	a.EndsAt = &past
	if assessmentOpen(a, time.Now()) {
		t.Fatal("expired assessment accepted")
	}
}
