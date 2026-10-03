package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"gorm.io/gorm/schema"
)

func TestMasterSyncRetriesTransientFailureThreeTimes(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		if r.Header.Get("X-CBT-Key-ID") != "test-key" || r.Header.Get("X-CBT-Signature") == "" {
			t.Errorf("signed integration headers missing")
		}
		if requests < 3 {
			http.Error(w, `{"error":"sementara tidak tersedia"}`, http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"cursor":"2026-10-03T00:00:00Z","accounts":[{}],"kelas":[{},{}],"pesertaDidik":[{},{}],"tutor":[{}],"mapel":[{}]}`))
	}))
	defer server.Close()

	s := &Server{cfg: Config{LMSBaseURL: server.URL, IntegrationKeyID: "test-key", IntegrationSecret: "test-secret"}, httpClient: &http.Client{Timeout: time.Second}}
	start := time.Now()
	payload, err := s.fetchMasterPayload("")
	if err != nil {
		t.Fatalf("expected retry to recover: %v", err)
	}
	if requests != 3 {
		t.Fatalf("expected three total attempts, got %d", requests)
	}
	if time.Since(start) < 1400*time.Millisecond {
		t.Fatal("expected exponential backoff between retry attempts")
	}
	if len(payload.Kelas) != 2 || payload.Cursor == "" {
		t.Fatalf("successful response was not decoded: %+v", payload)
	}
}

func TestManualMasterSyncRequestsFullFeedAndAutomaticSyncKeepsCursor(t *testing.T) {
	const cursor = "2026-10-01T09:30:00Z"
	if got := masterSyncCursor(cursor, true); got != "" {
		t.Fatalf("manual reconciliation must bypass a potentially stale cursor, got %q", got)
	}
	if got := masterSyncCursor(cursor, false); got != cursor {
		t.Fatalf("automatic sync must retain its incremental cursor, got %q", got)
	}
	if got := masterFeedPath(masterSyncCursor(cursor, true)); got != "/api/integrations/cbt/v1/master" {
		t.Fatalf("full feed path = %q", got)
	}
}

func TestMasterPayloadDecodesCanonicalLMSJSONFields(t *testing.T) {
	data := []byte(`{"cursor":"2026-10-03T00:00:00Z","kelas":[{"id":"class-1","nama":"Paket A Kelas 1","jenjang":1,"active":true,"updatedAt":"2026-10-03T00:00:00Z"}],"pesertaDidik":[{"id":"student-1","nama":"Siswa Satu","nisn":"1234567890","kelasId":"class-1","active":true,"updatedAt":"2026-10-03T00:00:00Z"}]}`)
	var payload masterPayload
	if err := json.Unmarshal(data, &payload); err != nil {
		t.Fatal(err)
	}
	if len(payload.Kelas) != 1 || payload.Kelas[0].ID != "class-1" || payload.Kelas[0].Nama != "Paket A Kelas 1" || !payload.Kelas[0].Active {
		t.Fatalf("LMS class record was not decoded: %+v", payload.Kelas)
	}
	if len(payload.PesertaDidik) != 1 || payload.PesertaDidik[0].ID != "student-1" || payload.PesertaDidik[0].KelasID != "class-1" || payload.PesertaDidik[0].NISN != "1234567890" || !payload.PesertaDidik[0].Active {
		t.Fatalf("LMS student record was not decoded: %+v", payload.PesertaDidik)
	}
}

func TestMasterStudentNISNIndexAllowsSharedLMSPlaceholders(t *testing.T) {
	parsed, err := schema.Parse(&MasterPeserta{}, &sync.Map{}, schema.NamingStrategy{})
	if err != nil {
		t.Fatal(err)
	}
	wantIndex := (schema.NamingStrategy{}).IndexName(parsed.Table, "NISN")
	for _, index := range parsed.ParseIndexes() {
		if index.Name == wantIndex && strings.EqualFold(index.Class, "UNIQUE") {
			t.Fatalf("master student NISN index %q must be non-unique; LMS shares temporary NISNs", index.Name)
		}
	}
}

func TestMasterSyncStopsAfterThreeFailuresWithUsefulError(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		http.Error(w, `<html>gateway unavailable</html>`, http.StatusBadGateway)
	}))
	defer server.Close()

	s := &Server{cfg: Config{LMSBaseURL: server.URL, IntegrationKeyID: "test-key", IntegrationSecret: "test-secret"}, httpClient: &http.Client{Timeout: time.Second}}
	_, err := s.fetchMasterPayload("")
	if err == nil || requests != 3 {
		t.Fatalf("expected three failed attempts, got attempts=%d err=%v", requests, err)
	}
	message := syncErrorMessage(err)
	if !strings.Contains(message, "data terakhir tetap digunakan") {
		t.Fatalf("error should explain safe fallback to last synced data: %s", message)
	}
}

func TestSyncErrorMessageExplainsCommonIntegrationFailures(t *testing.T) {
	tests := []struct{ detail, want string }{
		{"LMS merespons HTTP 401: unauthorized", "menolak autentikasi"},
		{"LMS merespons HTTP 503: Terjadi kesalahan internal", "CBT_INTEGRATION_KEY_ID"},
		{"LMS merespons HTTP 502: gateway", "domain/port di Coolify"},
		{"LMS merespons HTTP 404", "tidak ditemukan"},
		{"Get https://example: context deadline exceeded", "tidak merespons"},
		{"dial tcp: connection refused", "tidak dapat terhubung"},
	}
	for _, test := range tests {
		if got := syncErrorMessage(errString(test.detail)); !strings.Contains(got, test.want) {
			t.Errorf("syncErrorMessage(%q) = %q; want phrase %q", test.detail, got, test.want)
		}
	}
}

type errString string

func (e errString) Error() string { return string(e) }

func TestLMSRequestSignsExactRequestURIAndBody(t *testing.T) {
	const secret = "test-shared-hmac-secret-at-least-32-chars"
	const signedPath = "/api/integrations/cbt/v1/master?cursor=2026-10-03T01%3A02%3A03%2B07%3A00"
	const requestBody = `{"eventId":"result-1"}`
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.RequestURI() != signedPath {
			t.Errorf("request URI changed in transit: got %q want %q", r.URL.RequestURI(), signedPath)
		}
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read request body: %v", err)
		}
		timestamp, nonce := r.Header.Get("X-CBT-Timestamp"), r.Header.Get("X-CBT-Nonce")
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write([]byte(strings.ToUpper(r.Method) + "\n" + r.URL.RequestURI() + "\n" + timestamp + "\n" + nonce + "\n"))
		_, _ = mac.Write(body)
		want := hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(want), []byte(r.Header.Get("X-CBT-Signature"))) {
			t.Errorf("signature did not cover exact request URI and body")
		}
		if r.Header.Get("X-CBT-Key-ID") != "key-test" {
			t.Errorf("unexpected integration key id %q", r.Header.Get("X-CBT-Key-ID"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"accepted"}`))
	}))
	defer server.Close()

	s := &Server{cfg: Config{LMSBaseURL: server.URL, IntegrationKeyID: "key-test", IntegrationSecret: secret}, httpClient: server.Client()}
	response, err := s.lmsRequest(http.MethodPost, signedPath, []byte(requestBody))
	if err != nil {
		t.Fatalf("signed request failed: %v", err)
	}
	_ = response.Body.Close()
}
