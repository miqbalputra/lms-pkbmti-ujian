package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/url"
	"reflect"
	"sort"
	"strings"
	"unicode"
	"unicode/utf8"
)

var supportedQuestionTypes = map[string]bool{
	"pg_tunggal": true, "pg_kompleks": true, "dropdown": true, "isian_singkat": true,
	"uraian": true, "benar_salah": true, "menjodohkan": true, "susun_urutan": true,
	"kisi_pg": true, "kisi_checkbox": true, "skala_linear": true, "rating": true,
	"tanggal": true, "waktu": true, "unggah_berkas": true,
}

func decodeJSON(raw string) any {
	decoder := json.NewDecoder(bytes.NewBufferString(raw))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return nil
	}
	return value
}

func configObject(raw string) map[string]any {
	if value, ok := decodeJSON(raw).(map[string]any); ok {
		return value
	}
	return map[string]any{}
}

func stringSlice(value any) []string {
	rows, ok := value.([]any)
	if !ok {
		if values, ok := value.([]string); ok {
			return values
		}
		return nil
	}
	out := make([]string, 0, len(rows))
	for _, row := range rows {
		if text, ok := row.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func normalizedShortAnswer(value string) string {
	value = strings.ToLower(strings.TrimSpace(value))
	value = strings.ReplaceAll(value, "−", "-")
	runes := []rune(value)
	var out strings.Builder
	for i, r := range runes {
		if unicode.IsSpace(r) {
			out.WriteRune(' ')
			continue
		}
		if r == ',' && i > 0 && i+1 < len(runes) && unicode.IsDigit(runes[i-1]) && unicode.IsDigit(runes[i+1]) {
			out.WriteRune('.')
			continue
		}
		if unicode.IsPunct(r) || unicode.IsSymbol(r) {
			if (r == '-' || r == '+') && out.Len() == 0 {
				out.WriteRune(r)
			}
			if r == '.' && i > 0 && i+1 < len(runes) && unicode.IsDigit(runes[i-1]) && unicode.IsDigit(runes[i+1]) {
				out.WriteRune(r)
			}
			continue
		}
		out.WriteRune(r)
	}
	return strings.Join(strings.Fields(out.String()), " ")
}

func canonical(value any) any {
	switch typed := value.(type) {
	case []any:
		out := make([]any, len(typed))
		for i, item := range typed {
			out[i] = canonical(item)
		}
		return out
	case map[string]any:
		out := make(map[string]any, len(typed))
		for key, item := range typed {
			out[key] = canonical(item)
		}
		return out
	case json.Number:
		if number, err := typed.Float64(); err == nil {
			return number
		}
	}
	return value
}

func sameValue(left, right any) bool { return reflect.DeepEqual(canonical(left), canonical(right)) }

func sameSet(left, right any) bool {
	leftValues, rightValues := stringSlice(left), stringSlice(right)
	if len(leftValues) != len(rightValues) {
		return false
	}
	leftValues, rightValues = stableIDs(leftValues), stableIDs(rightValues)
	return reflect.DeepEqual(leftValues, rightValues)
}

func sameAnswer(questionType string, expected, actual any) bool {
	switch questionType {
	case "pg_kompleks":
		return sameSet(expected, actual)
	case "kisi_checkbox":
		left, right := mapFrom(expected), mapFrom(actual)
		if len(left) != len(right) {
			return false
		}
		for row, expectedValues := range left {
			actualValues, exists := right[row]
			if !exists || !sameSet(expectedValues, actualValues) {
				return false
			}
		}
		return true
	default:
		return sameValue(expected, actual)
	}
}

func hasValue(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case string:
		return strings.TrimSpace(typed) != ""
	case []any:
		return len(typed) > 0
	case map[string]any:
		return len(typed) > 0
	default:
		return true
	}
}

func mapFrom(value any) map[string]any {
	if result, ok := value.(map[string]any); ok {
		return result
	}
	return map[string]any{}
}

func expectedValue(snapshot questionSnapshot, config map[string]any, fallback any) any {
	if fallback != nil {
		return fallback
	}
	switch snapshot.Type {
	case "pg_tunggal", "pg_kompleks", "dropdown":
		if ids, ok := config["correctIds"]; ok {
			if snapshot.Type != "pg_kompleks" {
				if values := stringSlice(ids); len(values) == 1 {
					return values[0]
				}
			}
			return ids
		}
	case "benar_salah":
		if statements, ok := config["statements"].([]any); ok {
			result := map[string]any{}
			for _, raw := range statements {
				row := mapFrom(raw)
				if id, ok := row["id"].(string); ok {
					result[id] = row["correct"]
				}
			}
			return result
		}
	case "menjodohkan":
		if pairs, ok := config["pairs"]; ok {
			return pairs
		}
	case "susun_urutan":
		if order, ok := config["correctOrder"]; ok {
			return order
		}
	case "kisi_pg":
		if correct, ok := config["gridCorrect"]; ok {
			return correct
		}
	case "kisi_checkbox":
		if correct, ok := config["gridMultiCorrect"]; ok {
			return correct
		}
	case "skala_linear", "rating":
		if number, ok := config["correctNumber"]; ok {
			return number
		}
	case "isian_singkat", "tanggal", "waktu":
		if accepted, ok := config["acceptedAnswers"]; ok {
			return accepted
		}
	}
	return nil
}

func shortAnswerMatches(config map[string]any, actual any) bool {
	answer, ok := actual.(string)
	if !ok || strings.TrimSpace(answer) == "" {
		return false
	}
	accepted := stringSlice(config["acceptedAnswers"])
	for _, candidate := range accepted {
		if normalizedShortAnswer(candidate) == normalizedShortAnswer(answer) {
			return true
		}
	}
	return false
}

func proportionalScore(questionType string, expected, actual any) float64 {
	left, right := mapFrom(expected), mapFrom(actual)
	if len(left) > 0 {
		correct := 0
		for key, value := range left {
			got, ok := right[key]
			matched := ok && sameValue(value, got)
			if questionType == "kisi_checkbox" && ok {
				matched = sameSet(value, got)
			}
			if matched {
				correct++
			}
		}
		wrongExtra := len(right) - correct
		return math.Max(0, float64(correct-wrongExtra)/float64(len(left)))
	}
	leftList, rightList := stringSlice(expected), stringSlice(actual)
	if len(leftList) == 0 {
		return 0
	}
	if questionType == "pg_kompleks" {
		wanted := map[string]bool{}
		for _, value := range leftList {
			wanted[value] = true
		}
		correct, wrong := 0, 0
		for _, value := range rightList {
			if wanted[value] {
				correct++
			} else {
				wrong++
			}
		}
		return math.Max(0, float64(correct-wrong)/float64(len(leftList)))
	}
	correct, extras := 0, 0
	if len(leftList) == len(rightList) && len(leftList) > 0 {
		for i, value := range leftList {
			if value == rightList[i] {
				correct++
			} else {
				extras++
			}
		}
		return math.Max(0, float64(correct-extras)/float64(len(leftList)))
	}
	wanted := map[string]bool{}
	for _, value := range leftList {
		wanted[value] = true
	}
	for _, value := range rightList {
		if wanted[value] {
			correct++
		} else {
			extras++
		}
	}
	return math.Max(0, float64(correct-extras)/float64(len(leftList)))
}

func grade(snapshot questionSnapshot, answer string, weight float64) (*bool, float64, bool) {
	actual := decodeJSON(answer)
	if !hasValue(actual) {
		correct := false
		return &correct, 0, false
	}
	if snapshot.Type == "uraian" || snapshot.Type == "unggah_berkas" || snapshot.Type == "paragraf" {
		return nil, 0, true
	}
	config := configObject(snapshot.ConfigJSON)
	key := decodeJSON(snapshot.AnswerJSON)
	if snapshot.Type == "isian_singkat" || snapshot.Type == "tanggal" || snapshot.Type == "waktu" {
		correct := shortAnswerMatches(config, actual)
		if len(stringSlice(config["acceptedAnswers"])) == 0 {
			if expected, ok := key.(string); ok {
				config["acceptedAnswers"] = []any{expected}
				correct = shortAnswerMatches(config, actual)
			}
		}
		if correct {
			return &correct, weight, false
		}
		return &correct, 0, false
	}
	expected := expectedValue(snapshot, config, key)
	if expected == nil {
		correct := false
		return &correct, 0, false
	}
	if sameAnswer(snapshot.Type, expected, actual) {
		correct := true
		return &correct, weight, false
	}
	if config["partialScoring"] == "proportional" {
		score := proportionalScore(snapshot.Type, expected, actual)
		if score > 0 {
			correct := false
			return &correct, weight * score, false
		}
	}
	correct := false
	return &correct, 0, false
}

func validateQuestionConfig(questionType, raw string) bool {
	if !supportedQuestionTypes[questionType] || strings.TrimSpace(raw) == "" || !json.Valid([]byte(raw)) {
		return false
	}
	config := configObject(raw)
	switch questionType {
	case "pg_tunggal", "pg_kompleks", "dropdown", "susun_urutan":
		choices, ok := config["choices"].([]any)
		if !ok || len(choices) < 2 || !validUniqueTextRows(choices) {
			return false
		}
		if questionType == "susun_urutan" {
			order := stringSlice(config["correctOrder"])
			return len(order) == len(choices) && sameSet(order, rowIDs(choices))
		}
		return true
	case "benar_salah":
		rows, ok := config["statements"].([]any)
		if !ok || len(rows) == 0 || !validUniqueTextRows(rows) {
			return false
		}
		for _, raw := range rows {
			if _, ok := mapFrom(raw)["correct"].(bool); !ok {
				return false
			}
		}
		return true
	case "menjodohkan":
		left, leftOK := config["left"].([]any)
		right, rightOK := config["right"].([]any)
		if !leftOK || !rightOK || len(left) == 0 || len(right) == 0 || !validUniqueTextRows(left) || !validUniqueTextRows(right) {
			return false
		}
		return true
	case "kisi_pg", "kisi_checkbox":
		rows, rowsOK := config["rows"].([]any)
		columns, columnsOK := config["columns"].([]any)
		return rowsOK && columnsOK && len(rows) > 0 && len(columns) > 0 && validUniqueTextRows(rows) && validUniqueTextRows(columns)
	default:
		return true
	}
}

func validUniqueTextRows(rows []any) bool {
	ids := map[string]bool{}
	for _, raw := range rows {
		row := mapFrom(raw)
		id, text := asString(row["id"]), asString(row["text"])
		if strings.TrimSpace(id) == "" || strings.TrimSpace(text) == "" || ids[id] {
			return false
		}
		ids[id] = true
	}
	return true
}

func rowIDs(rows []any) []string {
	ids := make([]string, 0, len(rows))
	for _, raw := range rows {
		ids = append(ids, asString(mapFrom(raw)["id"]))
	}
	return ids
}

func validQuestionForPublish(snapshot questionSnapshot) bool {
	config := configObject(snapshot.ConfigJSON)
	if !validateQuestionConfig(snapshot.Type, snapshot.ConfigJSON) {
		return false
	}
	switch snapshot.Type {
	case "pg_tunggal", "pg_kompleks", "dropdown":
		correct := stringSlice(config["correctIds"])
		if len(correct) == 0 {
			key := decodeJSON(snapshot.AnswerJSON)
			if key == nil {
				return false
			}
			if values, ok := key.([]any); ok {
				correct = stringSlice(values)
			} else if value, ok := key.(string); ok {
				correct = []string{value}
			}
		}
		choices := stringSliceFromObjects(config["choices"])
		if len(correct) == 0 || (snapshot.Type != "pg_kompleks" && len(correct) != 1) {
			return false
		}
		return isSubset(correct, choices) && len(stableIDs(correct)) == len(correct)
	case "isian_singkat", "tanggal", "waktu":
		return len(stringSlice(config["acceptedAnswers"])) > 0 || decodeJSON(snapshot.AnswerJSON) != nil
	case "menjodohkan":
		pairs := mapFrom(config["pairs"])
		leftIDs := stringSliceFromObjects(config["left"])
		rightIDs := stringSliceFromObjects(config["right"])
		if len(leftIDs) == 0 || len(pairs) != len(leftIDs) {
			return false
		}
		for _, id := range leftIDs {
			match, ok := pairs[id].(string)
			if !ok || !containsString(rightIDs, match) {
				return false
			}
		}
		return true
	case "kisi_pg":
		correct := mapFrom(config["gridCorrect"])
		rows, columns := stringSliceFromObjects(config["rows"]), stringSliceFromObjects(config["columns"])
		if len(correct) != len(rows) {
			return false
		}
		for _, row := range rows {
			column, ok := correct[row].(string)
			if !ok || !containsString(columns, column) {
				return false
			}
		}
		return true
	case "kisi_checkbox":
		correct := mapFrom(config["gridMultiCorrect"])
		rows, columns := stringSliceFromObjects(config["rows"]), stringSliceFromObjects(config["columns"])
		if len(correct) != len(rows) {
			return false
		}
		for _, row := range rows {
			values, ok := correct[row]
			if !ok || len(stringSlice(values)) == 0 || !isSubset(stringSlice(values), columns) {
				return false
			}
		}
		return true
	case "skala_linear", "rating":
		correct, inConfig := numberValue(config["correctNumber"])
		if !inConfig {
			correct, inConfig = numberValue(decodeJSON(snapshot.AnswerJSON))
		}
		if !inConfig {
			return false
		}
		if snapshot.Type == "rating" {
			max, ok := numberValue(config["ratingMax"])
			if !ok {
				max = 5
			}
			return correct >= 1 && correct <= max
		}
		min, minOK := numberValue(config["scaleMin"])
		max, maxOK := numberValue(config["scaleMax"])
		if !minOK {
			min = 1
		}
		if !maxOK {
			max = 5
		}
		return min < max && correct >= min && correct <= max
	case "uraian":
		var rubric []map[string]any
		if json.Unmarshal([]byte(snapshot.RubricJSON), &rubric) == nil && len(rubric) > 0 {
			return true
		}
		rows, _ := config["rubrik"].([]any)
		return len(rows) > 0
	case "unggah_berkas":
		allowed := stringSlice(config["allowedFileTypes"])
		maxFiles, filesOK := numberValue(config["maxFiles"])
		maxSize, sizeOK := numberValue(config["maxFileSizeMB"])
		if !filesOK {
			maxFiles = 1
		}
		if !sizeOK {
			maxSize = 10
		}
		allowedExtensions := map[string]bool{"pdf": true, "docx": true, "xlsx": true, "png": true, "jpg": true, "jpeg": true}
		if len(allowed) == 0 || maxFiles < 1 || maxFiles > 10 || maxSize < 1 || maxSize > 20 {
			return false
		}
		for _, extension := range allowed {
			if !allowedExtensions[strings.TrimPrefix(strings.ToLower(extension), ".")] {
				return false
			}
		}
		return true
	case "benar_salah":
		for _, raw := range config["statements"].([]any) {
			if _, ok := mapFrom(raw)["correct"].(bool); !ok {
				return false
			}
		}
		return true
	case "susun_urutan":
		return len(stringSlice(config["correctOrder"])) == len(stringSliceFromObjects(config["choices"]))
	default:
		return false
	}
}

func stringSliceFromObjects(value any) []string {
	rows, _ := value.([]any)
	out := make([]string, 0, len(rows))
	for _, raw := range rows {
		row := mapFrom(raw)
		if strings.TrimSpace(strings.TrimSpace(asString(row["id"]))) != "" {
			out = append(out, asString(row["id"]))
		}
	}
	return out
}

func asString(value any) string {
	text, _ := value.(string)
	return text
}

func numberValue(value any) (float64, bool) {
	switch typed := value.(type) {
	case json.Number:
		number, err := typed.Float64()
		return number, err == nil
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	default:
		return 0, false
	}
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

func isSubset(values, allowed []string) bool {
	for _, value := range values {
		if !containsString(allowed, value) {
			return false
		}
	}
	return true
}

func validStimulusJSON(raw string) bool {
	if strings.TrimSpace(raw) == "" {
		return true
	}
	var blocks []struct {
		Type    string `json:"type"`
		Title   string `json:"title"`
		Content string `json:"content"`
		Alt     string `json:"alt"`
	}
	if json.Unmarshal([]byte(raw), &blocks) != nil {
		return false
	}
	for _, block := range blocks {
		if block.Type != "text" && block.Type != "table" && block.Type != "image" && block.Type != "media" {
			return false
		}
		if block.Type == "image" || block.Type == "media" {
			parsed, err := url.Parse(strings.TrimSpace(block.Content))
			if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil {
				return false
			}
		}
	}
	return true
}

func sanitizeStudentConfig(raw string) any {
	config := configObject(raw)
	secretKeys := map[string]bool{"correctIds": true, "acceptedAnswers": true, "pairs": true, "gridCorrect": true, "gridMultiCorrect": true, "correctOrder": true, "correctNumber": true, "rubrik": true, "partialScoring": true, "branchToByAnswer": true, "answer": true, "answerKey": true, "feedback": true}
	var scrub func(any) any
	scrub = func(value any) any {
		switch typed := value.(type) {
		case map[string]any:
			out := map[string]any{}
			for key, item := range typed {
				if secretKeys[key] || key == "correct" || key == "isCorrect" || key == "score" {
					continue
				}
				out[key] = scrub(item)
			}
			return out
		case []any:
			out := make([]any, len(typed))
			for i, item := range typed {
				out[i] = scrub(item)
			}
			return out
		default:
			return value
		}
	}
	return scrub(config)
}

func stableIDs(values []string) []string {
	copyValues := append([]string(nil), values...)
	sort.Strings(copyValues)
	return copyValues
}

func hasMinimumRunes(value string, min int) bool {
	return utf8.RuneCountInString(strings.TrimSpace(value)) >= min
}
