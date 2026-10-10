package main

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestStudentUIFlagDoesNotEnableFormEditor(t *testing.T) {
	t.Setenv("CBT_FORMS_ENABLED", "false")
	t.Setenv("CBT_STUDENT_UX_ENABLED", "true")
	config := publicUIConfig("https://example.test")
	if config["studentUxEnabled"] != true || config["formsEnabled"] != false {
		t.Fatal("student interface flag must be independent from form editor")
	}
	t.Setenv("CBT_STUDENT_UX_ENABLED", "")
	if publicUIConfig("")["studentUxEnabled"] != false {
		t.Fatal("student interface must default to disabled")
	}
}

func TestPublicAssessmentMetadataDoesNotExposePrivateFields(t *testing.T) {
	start := time.Now().UTC().Truncate(time.Second)
	assessment := Assessment{Kind: "ujian_online", Title: "Math", DurationMinute: 60, StartsAt: &start, AccessCodeHash: "PRIVATE_CODE", AccessCodeCiphertext: "PRIVATE_CIPHER", OwnerID: "PRIVATE_OWNER"}
	metadata := publicAssessment(assessment)
	if metadata["durationMinute"] != 60 || metadata["startsAt"] != &start || metadata["kind"] != "ujian_online" {
		t.Fatal(metadata)
	}
	raw, err := json.Marshal(metadata)
	if err != nil || strings.Contains(string(raw), "PRIVATE_") {
		t.Fatal("public selection leaked access or owner data", err)
	}
	assessment.Kind = "simulasi"
	if publicAssessment(assessment)["kind"] != "simulasi" {
		t.Fatal("selection lost service type")
	}
}
