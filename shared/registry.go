package shared

import (
	_ "embed"
	"encoding/json"
)

// TypesJSON is the same registry bundled by the TypeScript tutor/student UI.
//
//go:embed question-types.json
var TypesJSON []byte

type QuestionType struct {
	ID        string `json:"id"`
	Label     string `json:"label"`
	Response  string `json:"response"`
	Scoring   string `json:"scoring"`
	Branching bool   `json:"branching"`
	AKM       bool   `json:"akm"`
	TKA       bool   `json:"tka"`
}

func QuestionTypes() []QuestionType {
	var out []QuestionType
	if err := json.Unmarshal(TypesJSON, &out); err != nil {
		panic("invalid embedded question registry")
	}
	return out
}
