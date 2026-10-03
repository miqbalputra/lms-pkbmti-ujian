package main

import (
	"strings"
	"testing"
)

func TestNormalizeQuestionTags(t *testing.T) {
	got := normalizeQuestionTags("  Literasi   Membaca, AKM, literasi membaca, , inferensi  ")
	if got != "Literasi Membaca, AKM, inferensi" {
		t.Fatalf("normalized tags = %q", got)
	}
	parts := make([]string, 22)
	for index := range parts {
		parts[index] = "tag" + string(rune('a'+index))
	}
	if got := len(strings.Split(normalizeQuestionTags(strings.Join(parts, ",")), ",")); got != 20 {
		t.Fatalf("expected maximum 20 tags, got %d", got)
	}
	if got := normalizeQuestionTags(strings.Repeat("x", 41)); got != "" {
		t.Fatalf("oversized tag should be ignored, got %q", got)
	}
}

func TestQuestionHasTagMatchesWholeNormalizedTag(t *testing.T) {
	if !questionHasTag("Literasi Membaca,   inferensi", " literasi   membaca ") {
		t.Fatal("expected trimmed/case-insensitive exact tag match")
	}
	if questionHasTag("numerasi tingkat lanjut", "numerasi") {
		t.Fatal("tag filter must not match only a substring")
	}
	if !questionHasTag("literasi", "") {
		t.Fatal("empty requested tag should preserve the unfiltered set")
	}
}

func TestNormalizeFolderInput(t *testing.T) {
	input := questionFolderInput{Name: "  Pecahan  ", Subject: " Matematika ", ParentID: " parent-id "}
	if err := normalizeFolderInput(&input); err != nil {
		t.Fatal(err)
	}
	if input.Name != "Pecahan" || input.Subject != "Matematika" || input.ParentID != "parent-id" {
		t.Fatalf("folder values not normalized: %#v", input)
	}
	if err := normalizeFolderInput(&questionFolderInput{}); err == nil {
		t.Fatal("folder name must be required")
	}
	if err := normalizeFolderInput(&questionFolderInput{Name: strings.Repeat("x", 101)}); err == nil {
		t.Fatal("folder name over 100 characters should fail")
	}
}
