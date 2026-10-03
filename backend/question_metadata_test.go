package main

import (
	"strings"
	"testing"
)

func TestDefaultEstimatedMinutesByQuestionType(t *testing.T) {
	cases := []struct {
		kind string
		want int
	}{
		{kind: "pg_tunggal", want: 2},
		{kind: "menjodohkan", want: 3},
		{kind: "uraian", want: 5},
		{kind: "unggah_berkas", want: 5},
	}
	for _, test := range cases {
		if got := defaultEstimatedMinutes(test.kind, "Pertanyaan singkat"); got != test.want {
			t.Errorf("defaultEstimatedMinutes(%q) = %d; want %d", test.kind, got, test.want)
		}
	}
	if got := defaultEstimatedMinutes("pg_tunggal", strings.Repeat("x", 401)); got != 3 {
		t.Fatalf("long prompt should get a small reading-time allowance, got %d", got)
	}
}

func TestFillMissingQuestionMetadataPreservesTutorValues(t *testing.T) {
	question := Question{Type: "uraian", Prompt: "Jelaskan alasan", Difficulty: "mudah", EstimatedMinutes: 8, Curriculum: "CP IPA Fase C"}
	if fillMissingQuestionMetadata(&question) {
		t.Fatal("complete tutor metadata should remain unchanged")
	}
	question = Question{Type: "uraian", Prompt: "Jelaskan alasan"}
	if !fillMissingQuestionMetadata(&question) {
		t.Fatal("expected missing values to be filled")
	}
	if question.Difficulty != "sedang" || question.EstimatedMinutes != 5 || question.Curriculum != "Belum dipetakan" {
		t.Fatalf("unexpected defaults: %#v", question)
	}
}
