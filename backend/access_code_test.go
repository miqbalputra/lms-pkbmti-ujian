package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/gofiber/fiber/v2"
)

func TestAssessmentAccessCodeIsEncryptedAndRoundTrips(t *testing.T) {
	code := "  KELAS-7-RAHASIA  "
	encoded, err := encryptAssessmentCode("stable-test-secret", code)
	if err != nil {
		t.Fatal(err)
	}
	if encoded == "" || strings.Contains(encoded, "KELAS") {
		t.Fatal("access code must not be stored as plaintext")
	}
	decoded, err := decryptAssessmentCode("stable-test-secret", encoded)
	if err != nil || decoded != "KELAS-7-RAHASIA" {
		t.Fatalf("encrypted code did not round trip: value=%q err=%v", decoded, err)
	}
	if _, err := decryptAssessmentCode("rotated-or-wrong-secret", encoded); err == nil {
		t.Fatal("ciphertext must not decrypt with a different application secret")
	}
	sealed, _ := base64.RawURLEncoding.DecodeString(encoded)
	sealed[0] ^= 1
	changed := base64.RawURLEncoding.EncodeToString(sealed)
	if _, err := decryptAssessmentCode("stable-test-secret", changed); err == nil {
		t.Fatal("tampered ciphertext must not be accepted")
	}
}

func TestAssessmentCodeHashAndCiphertextStayInSync(t *testing.T) {
	s := &Server{cfg: Config{JWTSecret: "stable-test-secret"}}
	row := Assessment{}
	code := " EXAM-2026 "
	if err := s.setAssessmentAccessCode(&row, &code); err != nil {
		t.Fatal(err)
	}
	if row.AccessCodeHash != hash("EXAM-2026") || row.AccessCodeCiphertext == "" {
		t.Fatal("normalized verification hash and encrypted display value should both be stored")
	}
	empty := ""
	if err := s.setAssessmentAccessCode(&row, &empty); err != nil {
		t.Fatal(err)
	}
	if row.AccessCodeHash != "" || row.AccessCodeCiphertext != "" {
		t.Fatal("clearing the draft access code must remove both stored representations")
	}
	legacy := Assessment{AccessCodeHash: hash("LEGACY-CODE")}
	if err := s.setAssessmentAccessCode(&legacy, &empty); err != nil {
		t.Fatal(err)
	}
	if legacy.AccessCodeHash == "" {
		t.Fatal("an empty save must not erase a legacy hash that has no recoverable ciphertext")
	}
}

func TestAssessmentJSONNeverSerializesAccessCodeStorage(t *testing.T) {
	data, err := json.Marshal(Assessment{AccessCodeHash: "one-way-hash", AccessCodeCiphertext: "encrypted-value"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "one-way-hash") || strings.Contains(string(data), "encrypted-value") || strings.Contains(string(data), "accessCodeHash") {
		t.Fatalf("internal access-code representations leaked in default model JSON: %s", data)
	}
}

func TestAssessmentScheduleRequiresEndAfterStart(t *testing.T) {
	start := time.Date(2026, 10, 3, 10, 0, 0, 0, time.UTC)
	end := start.Add(-time.Minute)
	err := validAssessmentSchedule(&start, &end)
	if err == nil {
		t.Fatal("end before start must be rejected")
	}
	var fiberErr *fiber.Error
	if !errors.As(err, &fiberErr) || fiberErr.Code != fiber.StatusBadRequest || fiberErr.Message != "Tanggal selesai harus setelah tanggal mulai" {
		t.Fatalf("unexpected validation error: %v", err)
	}
	end = start.Add(time.Minute)
	if err := validAssessmentSchedule(&start, &end); err != nil {
		t.Fatalf("valid schedule was rejected: %v", err)
	}
}
