package main

import (
	"encoding/json"
	"math"
	"sort"
	"strings"

	"github.com/gofiber/fiber/v2"
)

type itemAnalysisObservation struct {
	AttemptID  string
	Earned     float64
	Weight     float64
	Correct    *bool
	Answered   bool
	Graded     bool
	Selections []string
}

type rankedItemAttempt struct {
	AttemptID string
	Score     float64
}

type itemDistractorAnalysis struct {
	ID             string  `json:"id"`
	Text           string  `json:"text"`
	SelectedCount  int     `json:"selectedCount"`
	SelectionRate  float64 `json:"selectionRate"`
	NonFunctioning bool    `json:"nonFunctioning"`
}

type assessmentItemAnalysisRow struct {
	QuestionID     string                   `json:"questionId"`
	Position       int                      `json:"position"`
	Title          string                   `json:"title"`
	Prompt         string                   `json:"prompt"`
	Type           string                   `json:"type"`
	Weight         float64                  `json:"weight"`
	AttemptCount   int                      `json:"attemptCount"`
	AnsweredCount  int                      `json:"answeredCount"`
	CorrectRate    *float64                 `json:"correctRate,omitempty"`
	Difficulty     *float64                 `json:"difficultyIndex,omitempty"`
	DifficultyBand string                   `json:"difficultyBand,omitempty"`
	MeanScore      *float64                 `json:"meanScore,omitempty"`
	Discrimination *float64                 `json:"discrimination,omitempty"`
	NeedsRevision  bool                     `json:"needsRevision"`
	Reason         string                   `json:"reason,omitempty"`
	Manual         bool                     `json:"manual"`
	Distractors    []itemDistractorAnalysis `json:"distractors,omitempty"`
}

func isManualQuestionType(questionType string) bool {
	return questionType == "uraian" || questionType == "paragraf" || questionType == "unggah_berkas"
}

func selectionsFromAnswer(snapshot questionSnapshot, answer string) []string {
	value := decodeJSON(answer)
	if value == nil {
		return nil
	}
	if snapshot.Type == "pg_kompleks" {
		return stringSlice(value)
	}
	if selected, ok := value.(string); ok && strings.TrimSpace(selected) != "" {
		return []string{selected}
	}
	return nil
}

func analyzeAssessmentItem(snapshot questionSnapshot, position int, weight float64, observations []itemAnalysisObservation, ranked []rankedItemAttempt) assessmentItemAnalysisRow {
	row := assessmentItemAnalysisRow{
		QuestionID: snapshot.ID, Position: position, Title: snapshot.Title, Prompt: snapshot.Prompt,
		Type: snapshot.Type, Weight: weight, Manual: isManualQuestionType(snapshot.Type),
	}
	if row.Weight <= 0 {
		row.Weight = snapshot.Points
	}
	answered, sample, correctCount := 0, 0, 0
	var normalizedScoreSum float64
	observationByAttempt := make(map[string]itemAnalysisObservation, len(observations))
	for _, observation := range observations {
		observationByAttempt[observation.AttemptID] = observation
		if observation.Answered {
			answered++
		}
		if row.Manual && !observation.Graded {
			continue
		}
		sample++
		if observation.Weight > 0 {
			normalizedScoreSum += math.Max(0, math.Min(1, observation.Earned/observation.Weight))
		}
		if observation.Correct != nil && *observation.Correct {
			correctCount++
		}
	}
	row.AttemptCount, row.AnsweredCount = sample, answered
	if sample > 0 {
		difficulty := normalizedScoreSum / float64(sample)
		mean := normalizedScoreSum / float64(sample) * row.Weight
		row.Difficulty, row.MeanScore = &difficulty, &mean
		if !row.Manual {
			correctRate := float64(correctCount) / float64(sample)
			row.CorrectRate = &correctRate
		}
		switch {
		case difficulty < 0.3:
			row.DifficultyBand = "sulit"
		case difficulty > 0.7:
			row.DifficultyBand = "mudah"
		default:
			row.DifficultyBand = "sedang"
		}
	}
	if row.Weight > 0 && len(ranked) >= 10 {
		groupSize := int(math.Ceil(float64(len(ranked)) * 0.27))
		if groupSize < 1 {
			groupSize = 1
		}
		topAverage, bottomAverage, countedTop, countedBottom := 0.0, 0.0, 0, 0
		for index, student := range ranked {
			observation, ok := observationByAttempt[student.AttemptID]
			if !ok {
				continue
			}
			score := math.Max(0, math.Min(1, observation.Earned/row.Weight))
			if index < groupSize {
				topAverage += score
				countedTop++
			} else if index >= len(ranked)-groupSize {
				bottomAverage += score
				countedBottom++
			}
		}
		if countedTop > 0 && countedBottom > 0 {
			discrimination := topAverage/float64(countedTop) - bottomAverage/float64(countedBottom)
			row.Discrimination = &discrimination
		}
	}
	if len(ranked) < 10 {
		row.Reason = "Sampel minimal 10 percobaan selesai diperlukan untuk rekomendasi revisi dan daya beda."
	} else if row.Difficulty != nil {
		reasons := make([]string, 0, 2)
		if *row.Difficulty < 0.25 {
			reasons = append(reasons, "tingkat keberhasilan sangat rendah")
		}
		if *row.Difficulty > 0.95 {
			reasons = append(reasons, "tingkat keberhasilan hampir sempurna")
		}
		if row.Discrimination != nil && *row.Discrimination < 0.2 {
			reasons = append(reasons, "daya beda rendah atau negatif")
		}
		row.NeedsRevision = len(reasons) > 0
		row.Reason = strings.Join(reasons, "; ")
	}
	if snapshot.Type == "pg_tunggal" || snapshot.Type == "dropdown" {
		config := configObject(snapshot.ConfigJSON)
		choices, _ := config["choices"].([]any)
		keys := stringSlice(config["correctIds"])
		if len(keys) == 0 {
			keys = stringSlice(decodeJSON(snapshot.AnswerJSON))
		}
		keySet := make(map[string]bool, len(keys))
		for _, key := range keys {
			keySet[key] = true
		}
		for _, choice := range choices {
			option, ok := choice.(map[string]any)
			if !ok {
				continue
			}
			id, _ := option["id"].(string)
			text, _ := option["text"].(string)
			if keySet[id] || id == "" {
				continue
			}
			selectedCount := 0
			for _, observation := range observations {
				if observation.Answered && containsSelection(observation.Selections, id) {
					selectedCount++
				}
			}
			selectionRate := 0.0
			if answered > 0 {
				selectionRate = float64(selectedCount) / float64(answered)
			}
			row.Distractors = append(row.Distractors, itemDistractorAnalysis{ID: id, Text: text, SelectedCount: selectedCount, SelectionRate: selectionRate, NonFunctioning: answered >= 10 && selectionRate < 0.05})
		}
		if len(ranked) >= 10 {
			for _, distractor := range row.Distractors {
				if distractor.NonFunctioning {
					row.NeedsRevision = true
					if row.Reason == "" {
						row.Reason = "terdapat pengecoh yang jarang dipilih"
					} else {
						row.Reason += "; terdapat pengecoh yang jarang dipilih"
					}
					break
				}
			}
		}
	}
	return row
}

func (s *Server) assessmentItemAnalysis(c *fiber.Ctx) error {
	account := currentAccount(c)
	var assessment Assessment
	if err := s.db.First(&assessment, "id = ?", c.Params("id")).Error; err != nil {
		return fiber.NewError(404, "Asesmen tidak ditemukan")
	}
	if !s.canReadAssessment(s.db, account, assessment) {
		return fiber.NewError(403, "Analisis butir hanya tersedia bagi admin dan tutor pemilik asesmen")
	}
	var assessmentItems []AssessmentItem
	if err := s.db.Where("assessment_id = ?", assessment.ID).Order("position").Find(&assessmentItems).Error; err != nil {
		return err
	}
	var attempts []Attempt
	if err := s.db.Where("assessment_id = ? AND status IN ?", assessment.ID, []string{"completed", "pending_grade", "submitted"}).Find(&attempts).Error; err != nil {
		return err
	}
	attemptIDs := make([]string, 0, len(attempts))
	var totalWeight float64
	for _, item := range assessmentItems {
		if item.Weight > 0 {
			totalWeight += item.Weight
		}
	}
	ranked := make([]rankedItemAttempt, 0, len(attempts))
	for _, attempt := range attempts {
		attemptIDs = append(attemptIDs, attempt.ID)
		if attempt.Status == "completed" && !attempt.NeedsManual && totalWeight > 0 {
			ranked = append(ranked, rankedItemAttempt{AttemptID: attempt.ID, Score: attempt.Score / totalWeight})
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].Score > ranked[j].Score })
	var attemptItems []AttemptItem
	var answers []Answer
	if len(attemptIDs) > 0 {
		if err := s.db.Where("attempt_id IN ?", attemptIDs).Find(&attemptItems).Error; err != nil {
			return err
		}
		if err := s.db.Where("attempt_id IN ?", attemptIDs).Find(&answers).Error; err != nil {
			return err
		}
	}
	itemByAttemptAndAssessmentItem := make(map[string]AttemptItem, len(attemptItems))
	for _, item := range attemptItems {
		itemByAttemptAndAssessmentItem[item.AttemptID+":"+item.AssessmentItemID] = item
	}
	answerByAttemptItem := make(map[string]Answer, len(answers))
	for _, answer := range answers {
		answerByAttemptItem[answer.AttemptItemID] = answer
	}
	activeByAttempt := map[string]map[string]bool{}
	itemsByAttempt := map[string][]AttemptItem{}
	answersByAttempt := map[string][]Answer{}
	for _, item := range attemptItems {
		itemsByAttempt[item.AttemptID] = append(itemsByAttempt[item.AttemptID], item)
	}
	for _, answer := range answers {
		answersByAttempt[answer.AttemptID] = append(answersByAttempt[answer.AttemptID], answer)
	}
	for _, attempt := range attempts {
		if attempt.FormVersionID == "" {
			continue
		}
		active, err := activeAttemptItems(s.db, attempt, itemsByAttempt[attempt.ID], answersByAttempt[attempt.ID])
		if err != nil {
			return err
		}
		activeByAttempt[attempt.ID] = map[string]bool{}
		for _, item := range active {
			activeByAttempt[attempt.ID][item.AssessmentItemID] = true
		}
	}
	// Normalize ranking by the weight of the route each pupil actually took.
	for i := range ranked {
		if active, ok := activeByAttempt[ranked[i].AttemptID]; ok {
			weight := 0.0
			for _, item := range assessmentItems {
				if active[item.ID] && item.Weight > 0 {
					weight += item.Weight
				}
			}
			if weight > 0 {
				ranked[i].Score = ranked[i].Score * totalWeight / weight
			}
		}
	}
	sort.SliceStable(ranked, func(i, j int) bool { return ranked[i].Score > ranked[j].Score })
	output := make([]assessmentItemAnalysisRow, 0, len(assessmentItems))
	for _, item := range assessmentItems {
		var snapshot questionSnapshot
		if json.Unmarshal([]byte(item.SnapshotJSON), &snapshot) != nil {
			continue
		}
		observations := make([]itemAnalysisObservation, 0, len(attempts))
		for _, attempt := range attempts {
			if active, ok := activeByAttempt[attempt.ID]; ok && !active[item.ID] {
				continue
			}
			attemptItem, exists := itemByAttemptAndAssessmentItem[attempt.ID+":"+item.ID]
			answer, hasAnswer := answerByAttemptItem[attemptItem.ID]
			if !exists || !hasAnswer {
				observations = append(observations, itemAnalysisObservation{AttemptID: attempt.ID, Weight: item.Weight, Correct: boolPointer(false), Graded: true})
				continue
			}
			earned := answer.AutoScore
			if answer.ManualScore != nil {
				earned = *answer.ManualScore
			}
			correct := answer.Correct
			if correct == nil && answer.ManualScore == nil {
				// A manually graded response still awaiting review is intentionally
				// omitted from difficulty statistics rather than counted as wrong.
				observations = append(observations, itemAnalysisObservation{AttemptID: attempt.ID, Weight: item.Weight, Answered: hasValue(decodeJSON(answer.ValueJSON)), Graded: false})
				continue
			}
			observations = append(observations, itemAnalysisObservation{AttemptID: attempt.ID, Earned: earned, Weight: item.Weight, Correct: correct, Answered: hasValue(decodeJSON(answer.ValueJSON)), Graded: true, Selections: selectionsFromAnswer(snapshot, answer.ValueJSON)})
		}
		output = append(output, analyzeAssessmentItem(snapshot, item.Position, item.Weight, observations, ranked))
	}
	return c.JSON(fiber.Map{"assessmentId": assessment.ID, "attemptCount": len(attempts), "completedAttemptCount": len(ranked), "items": output})
}

func boolPointer(value bool) *bool { return &value }

func containsSelection(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
