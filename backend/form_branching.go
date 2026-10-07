package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"sort"
)

// Forward-only paths are authoritative on the server. Unvisited questions are
// never required and never contribute points, including previously saved answers.
func activeFormCards(d FormDraft, answers map[string]any) map[string]bool {
	sections := []FormSection{{ID: "", Position: -1}}
	for _, s := range d.Sections {
		if !s.Deleted {
			sections = append(sections, s)
		}
	}
	sort.Slice(sections, func(i, j int) bool {
		if sections[i].Position == sections[j].Position {
			return sections[i].ID < sections[j].ID
		}
		return sections[i].Position < sections[j].Position
	})
	cards := orderedCards(d)
	active := map[string]bool{}
	visited := map[string]bool{}
	for index := 0; index < len(sections); {
		section := sections[index]
		if visited[section.ID] {
			break
		}
		visited[section.ID] = true
		next := section.Next
		waiting := false
		for _, card := range cards {
			if card.SectionID != section.ID {
				continue
			}
			active[card.ID] = true
			branches := mapFrom(card.Config["branchToByAnswer"])
			if len(branches) > 0 {
				answer := answers[card.ID]
				if !hasValue(answer) {
					waiting = true
				} else if target, ok := branches[asString(answer)]; ok && asString(target) != "" {
					next = asString(target)
				}
			}
		}
		if waiting || next == "submit" {
			break
		}
		if next == "" {
			index++
			continue
		}
		found := -1
		for i, s := range sections {
			if s.ID == next {
				found = i
				break
			}
		}
		if found <= index {
			break
		}
		index = found
	}
	return active
}
func activeAttemptItems(tx *gorm.DB, attempt Attempt, items []AttemptItem, answers []Answer) ([]AttemptItem, error) {
	if attempt.FormVersionID == "" {
		return items, nil
	}
	var version FormVersion
	if err := tx.First(&version, "id = ?", attempt.FormVersionID).Error; err != nil {
		return nil, err
	}
	var d FormDraft
	if err := json.Unmarshal([]byte(version.ContentJSON), &d); err != nil {
		return nil, err
	}
	cardByItem := map[string]string{}
	for _, item := range items {
		cardByItem[item.ID] = item.AssessmentItemID
	}
	values := map[string]any{}
	for _, a := range answers {
		values[cardByItem[a.AttemptItemID]] = decodeJSON(a.ValueJSON)
	}
	active := activeFormCards(d, values)
	out := []AttemptItem{}
	for _, item := range items {
		if active[item.AssessmentItemID] {
			out = append(out, item)
		}
	}
	return out, nil
}
func validateRequiredAnswers(tx *gorm.DB, items []AttemptItem, answers []Answer) error {
	byItem := map[string]Answer{}
	for _, a := range answers {
		byItem[a.AttemptItemID] = a
	}
	for _, item := range items {
		var snapshot questionSnapshot
		_ = json.Unmarshal([]byte(item.SnapshotJSON), &snapshot)
		value := decodeJSON(byItem[item.ID].ValueJSON)
		if err := validateResponse(snapshot, value, true); err != nil {
			var validation *fiber.Error
			if errors.As(err, &validation) {
				return fiber.NewError(validation.Code, fmt.Sprintf("Soal %d: %s", item.Position, validation.Message))
			}
			return err
		}
		if err := validateResponseAttachments(tx, item, snapshot, value); err != nil {
			return err
		}
	}
	return nil
}
func (s *Server) activeIDsForAttempt(id string) ([]string, error) {
	var a Attempt
	if err := s.db.First(&a, "id = ?", id).Error; err != nil {
		return nil, err
	}
	var items []AttemptItem
	var answers []Answer
	if err := s.db.Where("attempt_id = ?", id).Order("position").Find(&items).Error; err != nil {
		return nil, err
	}
	if err := s.db.Where("attempt_id = ?", id).Find(&answers).Error; err != nil {
		return nil, err
	}
	active, err := activeAttemptItems(s.db, a, items, answers)
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, item := range active {
		ids = append(ids, item.ID)
	}
	return ids, nil
}
