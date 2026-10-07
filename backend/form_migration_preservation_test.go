package main

import (
	"crypto/sha256"
	"fmt"
	"testing"
)

func TestPostgresFormMigrationPreservesLegacyRosterSnapshotsAndScores(t *testing.T) {
	s, owner := postgresFormServer(t)
	doc, draft := createPostgresForm(t, s, owner)
	student := MasterPeserta{Nama: "Peserta lama", NIS: "LAMA-01", NISN: "9090000001", KelasID: draft.Settings.ClassIDs[0], Active: true}
	if err := s.db.Create(&student).Error; err != nil {
		t.Fatal(err)
	}
	attempt := Attempt{AssessmentID: doc.ResourceID, StudentID: student.ID, ClassIDAtAttempt: student.KelasID, Number: 1, Status: "completed", Score: 87.5, Seed: "seed-lama-tetap", SourceAttemptID: "lms-attempt-lama"}
	if err := s.db.Create(&attempt).Error; err != nil {
		t.Fatal(err)
	}
	item := AttemptItem{AttemptID: attempt.ID, Position: 1, Weight: 100, Flagged: true, SnapshotJSON: `{"prompt":"Soal lama","type":"isian_singkat","configJson":"{\"acceptedAnswers\":[\"42\"]}"}`}
	if err := s.db.Create(&item).Error; err != nil {
		t.Fatal(err)
	}
	answer := Answer{AttemptID: attempt.ID, AttemptItemID: item.ID, ValueJSON: `"42"`, AutoScore: 87.5, Revision: 4, Comment: "Catatan lama"}
	if err := s.db.Create(&answer).Error; err != nil {
		t.Fatal(err)
	}
	digest := func() string {
		var roster MasterPeserta
		var savedAttempt Attempt
		var savedItem AttemptItem
		var savedAnswer Answer
		for _, row := range []struct {
			value any
			id    string
		}{{&roster, student.ID}, {&savedAttempt, attempt.ID}, {&savedItem, item.ID}, {&savedAnswer, answer.ID}} {
			if err := s.db.First(row.value, "id = ?", row.id).Error; err != nil {
				t.Fatal(err)
			}
		}
		return fmt.Sprintf("%x", sha256.Sum256([]byte(marshalJSON([]any{roster, savedAttempt, savedItem, savedAnswer}))))
	}
	before := digest()
	// Reproduce indexes from the old release in this disposable test schema.
	for _, statement := range []string{
		"DROP INDEX idx_cbt_accounts_source_user_id", "CREATE UNIQUE INDEX idx_cbt_accounts_source_user_id ON cbt_accounts(source_user_id)",
		"DROP INDEX idx_attempts_source_attempt_id", "CREATE UNIQUE INDEX idx_attempts_source_attempt_id ON attempts(source_attempt_id)",
	} {
		if err := s.db.Exec(statement).Error; err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 2; i++ {
		if err := s.migrate(); err != nil {
			t.Fatal(err)
		}
		if digest() != before {
			t.Fatal("legacy identity, seed, snapshot, score or answer revision changed")
		}
	}
	for i := 0; i < 2; i++ {
		if err := s.db.Create(&CBTAccount{Username: fmt.Sprintf("local-%d", i), Role: "guru", Active: true}).Error; err != nil {
			t.Fatal("empty local source ID must not collide:", err)
		}
		if err := s.db.Create(&Attempt{AssessmentID: doc.ResourceID, StudentID: student.ID, Number: i + 2, Status: "started"}).Error; err != nil {
			t.Fatal("new local attempts must not collide:", err)
		}
	}
	if err := s.db.Create(&CBTAccount{Username: "duplicate-import", SourceUserID: owner.SourceUserID, Role: "guru", Active: true}).Error; err == nil {
		t.Fatal("imported source uniqueness was lost")
	}
	if digest() != before {
		t.Fatal("new records overwrote legacy assessment history")
	}
}
