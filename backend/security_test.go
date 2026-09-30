package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"
)

func TestStudentSnapshotNeverIncludesAnswerMaterial(t *testing.T) {
	raw := `{"ID":"q-1","Title":"Contoh","Type":"pg_tunggal","Prompt":"Pilih","ConfigJSON":"{\"choices\":[{\"id\":\"a\",\"text\":\"A\"}],\"correctIds\":[\"a\"],\"acceptedAnswers\":[\"jawaban\"],\"branchToByAnswer\":{\"a\":\"next\"}}","AnswerJSON":"\"a\""}`
	student := safeSnapshot(raw)
	encoded, err := json.Marshal(student)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"correctIds", "acceptedAnswers", "branchToByAnswer", "jawaban"} {
		if string(encoded) == "" || contains(string(encoded), secret) {
			t.Fatalf("student snapshot leaks %q: %s", secret, encoded)
		}
	}
}

func TestDeterministicShuffleSeedUsesSeedContents(t *testing.T) {
	firstA, secondA := deterministicShuffleSeed("aaaaaaaa", "assessment")
	firstB, secondB := deterministicShuffleSeed("bbbbbbbb", "assessment")
	if firstA == firstB && secondA == secondB {
		t.Fatal("different saved seeds produced identical shuffle seed")
	}
	againA, againSecondA := deterministicShuffleSeed("aaaaaaaa", "assessment")
	if firstA != againA || secondA != againSecondA {
		t.Fatal("same saved seed was not deterministic")
	}
}

func TestIntegrationSignatureVerification(t *testing.T) {
	secret, method, path, timestamp, nonce := "development-integration-secret-change-me", "POST", "/api/integrations/cbt/v1/results", "1790726400", "nonce-1"
	body := []byte(`{"eventId":"event-1"}`)
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(method + "\n" + path + "\n" + timestamp + "\n" + nonce + "\n"))
	_, _ = mac.Write(body)
	signature := hex.EncodeToString(mac.Sum(nil))
	if !verifyIntegrationSignature(secret, method, path, timestamp, nonce, body, signature) {
		t.Fatal("valid signature rejected")
	}
	if verifyIntegrationSignature(secret, method, path, timestamp, nonce, []byte(`{}`), signature) {
		t.Fatal("signature accepted after body tampering")
	}
}

func TestMigrationWirePreservesAccessCodeWithoutExposingItElsewhere(t *testing.T) {
	raw := []byte(`{"batchId":"batch-1","assessments":[{"id":"assessment-1","OwnerID":"teacher-1","Kind":"ujian_online","Title":"Ujian","ClassID":"class-1","Status":"published","DurationMinute":60,"accessCodeHash":"secret-hash"}]}`)
	var bundle migrationBundle
	if err := json.Unmarshal(raw, &bundle); err != nil {
		t.Fatal(err)
	}
	if len(bundle.Assessments) != 1 {
		t.Fatal("assessment migration payload not decoded")
	}
	row := bundle.Assessments[0]
	if row.ID != "assessment-1" || row.OwnerID != "teacher-1" || row.AccessCodeHash != "secret-hash" {
		t.Fatalf("migration data lost: %#v", row)
	}
	encoded, err := json.Marshal(row.Assessment)
	if err != nil {
		t.Fatal(err)
	}
	if contains(string(encoded), "secret-hash") {
		t.Fatalf("access-code hash leaked from regular assessment response: %s", encoded)
	}
}

func contains(value, part string) bool {
	for index := 0; index+len(part) <= len(value); index++ {
		if value[index:index+len(part)] == part {
			return true
		}
	}
	return false
}
