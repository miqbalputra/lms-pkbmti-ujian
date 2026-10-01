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

func TestAllSupportedQuestionTypesValidateVisualConfiguration(t *testing.T) {
	tests := []struct {
		kind   string
		config string
	}{
		{"pg_tunggal", `{"choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correctIds":["a"]}`},
		{"pg_kompleks", `{"choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correctIds":["a"]}`},
		{"dropdown", `{"choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correctIds":["a"]}`},
		{"isian_singkat", `{"acceptedAnswers":["empat"]}`},
		{"uraian", `{"rubrik":[{"text":"Alasan","points":2}]}`},
		{"benar_salah", `{"statements":[{"id":"s1","text":"Pernyataan","correct":true}]}`},
		{"menjodohkan", `{"left":[{"id":"l1","text":"Kiri"}],"right":[{"id":"r1","text":"Kanan"}],"pairs":{"l1":"r1"}}`},
		{"susun_urutan", `{"choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correctOrder":["a","b"]}`},
		{"kisi_pg", `{"rows":[{"id":"r1","text":"Baris"}],"columns":[{"id":"c1","text":"Kolom"}],"gridCorrect":{"r1":"c1"}}`},
		{"kisi_checkbox", `{"rows":[{"id":"r1","text":"Baris"}],"columns":[{"id":"c1","text":"Kolom"}],"gridMultiCorrect":{"r1":["c1"]}}`},
		{"skala_linear", `{"scaleMin":1,"scaleMax":5,"correctNumber":4}`},
		{"rating", `{"ratingMax":5,"correctNumber":4}`},
		{"tanggal", `{"acceptedAnswers":["2026-10-01"]}`},
		{"waktu", `{"acceptedAnswers":["08:30"]}`},
		{"unggah_berkas", `{"allowedFileTypes":["pdf"],"maxFiles":1,"maxFileSizeMB":10}`},
	}
	if len(tests) != len(supportedQuestionTypes) {
		t.Fatalf("test coverage mismatch: have %d tests for %d question types", len(tests), len(supportedQuestionTypes))
	}
	for _, test := range tests {
		t.Run(test.kind, func(t *testing.T) {
			if !validateQuestionConfig(test.kind, test.config) {
				t.Fatalf("expected visual config for %s to validate", test.kind)
			}
		})
	}
}

func TestPublishingRejectsInvalidAnswerReferences(t *testing.T) {
	tests := []struct {
		name     string
		snapshot questionSnapshot
	}{
		{"choice id missing", questionSnapshot{Type: "pg_tunggal", ConfigJSON: `{"choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correctIds":["missing"]}`}},
		{"single choice has multiple keys", questionSnapshot{Type: "pg_tunggal", ConfigJSON: `{"choices":[{"id":"a","text":"A"},{"id":"b","text":"B"}],"correctIds":["a","b"]}`}},
		{"matching does not cover every prompt", questionSnapshot{Type: "menjodohkan", ConfigJSON: `{"left":[{"id":"l1","text":"Satu"},{"id":"l2","text":"Dua"}],"right":[{"id":"r1","text":"A"},{"id":"r2","text":"B"}],"pairs":{"l1":"r1"}}`}},
		{"grid references unknown row", questionSnapshot{Type: "kisi_pg", ConfigJSON: `{"rows":[{"id":"r1","text":"Baris"}],"columns":[{"id":"c1","text":"Kolom"}],"gridCorrect":{"r2":"c1"}}`}},
		{"grid references unknown column", questionSnapshot{Type: "kisi_checkbox", ConfigJSON: `{"rows":[{"id":"r1","text":"Baris"}],"columns":[{"id":"c1","text":"Kolom"}],"gridMultiCorrect":{"r1":["unknown"]}}`}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if validQuestionForPublish(test.snapshot) {
				t.Fatal("invalid answer references must not be published")
			}
		})
	}
}

func TestShortAnswerNormalizationIsHumanFriendly(t *testing.T) {
	for _, pair := range [][2]string{{"  TIGA   apel! ", "tiga apel"}, {"3,5 meter", "3.5 METER!"}, {"(42)", "42"}} {
		if normalizedShortAnswer(pair[0]) != normalizedShortAnswer(pair[1]) {
			t.Errorf("%q and %q should normalize equally", pair[0], pair[1])
		}
	}
}

func TestStimulusRejectsUnsafeMediaURL(t *testing.T) {
	for _, raw := range []string{
		`[{"type":"image","content":"http://example.com/image.png"}]`,
		`[{"type":"media","content":"https://user:pass@example.com/video"}]`,
		`[{"type":"image","content":"javascript:alert(1)"}]`,
	} {
		if validStimulusJSON(raw) {
			t.Errorf("unsafe stimulus URL was accepted: %s", raw)
		}
	}
	if !validStimulusJSON(`[{"type":"image","content":"https://example.com/image.png","alt":"Ilustrasi"}]`) {
		t.Fatal("valid HTTPS stimulus URL was rejected")
	}
}

func TestLateRecoveryPayloadRejectsUnknownOrDuplicateItems(t *testing.T) {
	allowed := map[string]bool{"item-1": true}
	valid, err := validateRecoveryPayload([]byte(`{"answers":[{"itemId":"item-1","value":"jawaban"}]}`), allowed)
	if err != nil || len(valid) != 1 {
		t.Fatalf("valid recovery payload rejected: rows=%v err=%v", valid, err)
	}
	for _, raw := range []string{
		`{"answers":[{"itemId":"other","value":"jawaban"}]}`,
		`{"answers":[{"itemId":"item-1","value":"a"},{"itemId":"item-1","value":"b"}]}`,
		`{"answers":[{"itemId":"item-1","value":}]}`,
	} {
		if _, err := validateRecoveryPayload([]byte(raw), allowed); err == nil {
			t.Errorf("invalid recovery payload accepted: %s", raw)
		}
	}
}

func TestAutomaticScoringCoversAssessmentQuestionTypes(t *testing.T) {
	tests := []struct {
		name, kind, config, key, answer string
		manual                          bool
	}{
		{"single choice", "pg_tunggal", `{"correctIds":["a"]}`, `null`, `"a"`, false},
		{"multiple choice ignores order", "pg_kompleks", `{"correctIds":["a","b"]}`, `null`, `["b","a"]`, false},
		{"dropdown", "dropdown", `{"correctIds":["b"]}`, `null`, `"b"`, false},
		{"true false table", "benar_salah", `{"statements":[{"id":"s1","correct":true},{"id":"s2","correct":false}]}`, `null`, `{"s1":true,"s2":false}`, false},
		{"matching", "menjodohkan", `{"pairs":{"l1":"r2","l2":"r1"}}`, `null`, `{"l1":"r2","l2":"r1"}`, false},
		{"ordering", "susun_urutan", `{"correctOrder":["a","b","c"]}`, `null`, `["a","b","c"]`, false},
		{"single grid", "kisi_pg", `{"gridCorrect":{"r1":"c1","r2":"c2"}}`, `null`, `{"r1":"c1","r2":"c2"}`, false},
		{"multi grid ignores cell order", "kisi_checkbox", `{"gridMultiCorrect":{"r1":["c1","c2"]}}`, `null`, `{"r1":["c2","c1"]}`, false},
		{"short answer normalization", "isian_singkat", `{"acceptedAnswers":["3,5 meter"]}`, `null`, `"3.5 METER!"`, false},
		{"date accepted value", "tanggal", `{"acceptedAnswers":["2026-10-01"]}`, `null`, `"2026-10-01"`, false},
		{"time accepted value", "waktu", `{"acceptedAnswers":["08:30"]}`, `null`, `"08:30"`, false},
		{"linear scale", "skala_linear", `{"correctNumber":4}`, `null`, `4`, false},
		{"rating", "rating", `{"correctNumber":5}`, `null`, `5`, false},
		{"essay needs manual", "uraian", `{}`, `null`, `"Alasan lengkap"`, true},
		{"file needs manual", "unggah_berkas", `{}`, `null`, `[{"id":"file"}]`, true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			snapshot := questionSnapshot{Type: test.kind, ConfigJSON: test.config, AnswerJSON: test.key}
			correct, score, manual := grade(snapshot, test.answer, 2)
			if manual != test.manual {
				t.Fatalf("manual=%v, expected %v", manual, test.manual)
			}
			if test.manual {
				if correct != nil || score != 0 {
					t.Fatalf("manual answer must not be auto-scored: correct=%v score=%v", correct, score)
				}
				return
			}
			if correct == nil || !*correct || score != 2 {
				t.Fatalf("expected full score, got correct=%v score=%v", correct, score)
			}
		})
	}
}

func TestProportionalScoringPenalizesIncorrectSelections(t *testing.T) {
	snapshot := questionSnapshot{Type: "pg_kompleks", ConfigJSON: `{"correctIds":["a","b"],"partialScoring":"proportional"}`}
	correct, score, manual := grade(snapshot, `["a"]`, 4)
	if manual || correct == nil || *correct || score != 2 {
		t.Fatalf("expected half credit and a non-perfect correctness mark, got correct=%v score=%v manual=%v", correct, score, manual)
	}
}

func TestBlankManualQuestionDoesNotWaitForGrading(t *testing.T) {
	for _, kind := range []string{"uraian", "unggah_berkas"} {
		correct, score, manual := grade(questionSnapshot{Type: kind}, "null", 5)
		if manual || score != 0 || correct == nil || *correct {
			t.Fatalf("blank %s response should be zero and not pending manual grading: correct=%v score=%v manual=%v", kind, correct, score, manual)
		}
	}
	correct, score, manual := grade(questionSnapshot{Type: "uraian"}, `"Alasan yang jelas"`, 5)
	if !manual || score != 0 || correct != nil {
		t.Fatalf("answered essay should wait for a tutor: correct=%v score=%v manual=%v", correct, score, manual)
	}
}

func TestStudentConfigRetainsPromptContentWithoutGradingKeys(t *testing.T) {
	student := sanitizeStudentConfig(`{"statements":[{"id":"s1","text":"Air mengalir ke bawah","correct":true}],"correctIds":["a"],"acceptedAnswers":["rahasia"],"partialScoring":"proportional"}`).(map[string]any)
	encoded, _ := json.Marshal(student)
	if contains(string(encoded), "correct") || contains(string(encoded), "rahasia") || contains(string(encoded), "partialScoring") {
		t.Fatalf("grading key leaked: %s", encoded)
	}
	statements := student["statements"].([]any)
	if mapFrom(statements[0])["text"] != "Air mengalir ke bawah" {
		t.Fatalf("statement prompt was lost: %s", encoded)
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
