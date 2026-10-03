package main

import (
	"strings"
	"testing"
)

func TestAnalyzeAssessmentItemDifficultyDiscriminationAndDistractors(t *testing.T) {
	observations := make([]itemAnalysisObservation, 20)
	ranked := make([]rankedItemAttempt, 20)
	for index := range observations {
		correct := index < 10
		earned := 0.0
		selection := "wrong"
		if correct {
			earned, selection = 1, "right"
		}
		observations[index] = itemAnalysisObservation{AttemptID: string(rune('a' + index)), Earned: earned, Weight: 1, Correct: &correct, Answered: true, Graded: true, Selections: []string{selection}}
		ranked[index] = rankedItemAttempt{AttemptID: observations[index].AttemptID, Score: earned}
	}
	snapshot := questionSnapshot{
		ID: "q-1", Title: "Membaca informasi", Type: "pg_tunggal", Points: 1,
		ConfigJSON: `{"choices":[{"id":"right","text":"Kunci"},{"id":"wrong","text":"Pengecoh"},{"id":"silent","text":"Pengecoh sepi"}],"correctIds":["right"]}`,
	}
	row := analyzeAssessmentItem(snapshot, 1, 1, observations, ranked)
	if row.Difficulty == nil || *row.Difficulty != 0.5 || row.DifficultyBand != "sedang" {
		t.Fatalf("unexpected difficulty index: %#v", row)
	}
	if row.CorrectRate == nil || *row.CorrectRate != 0.5 {
		t.Fatalf("unexpected correct rate: %#v", row.CorrectRate)
	}
	if row.Discrimination == nil || *row.Discrimination < 0.99 {
		t.Fatalf("expected strong positive discrimination: %#v", row.Discrimination)
	}
	if !row.NeedsRevision || !strings.Contains(row.Reason, "pengecoh") {
		t.Fatalf("rarely selected distractor should trigger a review suggestion: %q", row.Reason)
	}
	if len(row.Distractors) != 2 || !row.Distractors[1].NonFunctioning {
		t.Fatalf("expected the never-selected distractor to be flagged: %#v", row.Distractors)
	}
}

func TestAnalyzeAssessmentItemDoesNotRecommendRevisionWithSmallSample(t *testing.T) {
	correct := true
	observations := []itemAnalysisObservation{{AttemptID: "a", Earned: 1, Weight: 1, Correct: &correct, Answered: true, Graded: true}}
	row := analyzeAssessmentItem(questionSnapshot{ID: "q", Type: "pg_tunggal", Points: 1}, 1, 1, observations, []rankedItemAttempt{{AttemptID: "a", Score: 1}})
	if row.NeedsRevision || row.Discrimination != nil {
		t.Fatalf("small sample must not produce a revision/discrimination claim: %#v", row)
	}
	if row.Reason == "" {
		t.Fatal("small sample limitation should be explicit")
	}
}

func TestAnalyzeAssessmentItemMarksExtremeDifficultyAndDoesNotLeakManualKeys(t *testing.T) {
	observations := make([]itemAnalysisObservation, 10)
	ranked := make([]rankedItemAttempt, 10)
	for index := range observations {
		correct := false
		if index == 0 {
			correct = true
		}
		observations[index] = itemAnalysisObservation{AttemptID: string(rune('a' + index)), Weight: 1, Correct: &correct, Graded: true}
		ranked[index] = rankedItemAttempt{AttemptID: observations[index].AttemptID, Score: float64(10 - index)}
	}
	row := analyzeAssessmentItem(questionSnapshot{ID: "q", Type: "pg_tunggal", Points: 1}, 1, 1, observations, ranked)
	if !row.NeedsRevision {
		t.Fatal("one correct answer in ten should be recommended for tutor review")
	}
	manual := analyzeAssessmentItem(questionSnapshot{ID: "essay", Type: "uraian", Points: 5, AnswerJSON: `"private key"`, ConfigJSON: `{"rubrik":[{"text":"private"}]}`}, 2, 5, observations[:0], nil)
	if !manual.Manual || len(manual.Distractors) != 0 {
		t.Fatalf("manual question should not expose key/distractor analysis: %#v", manual)
	}
}
