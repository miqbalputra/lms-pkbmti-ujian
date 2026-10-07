package main

import "strings"

type FormRichPart struct {
	Insert     string          `json:"insert"`
	Attributes map[string]bool `json:"attributes,omitempty"`
}

// Formatting is structured and escaped by React. HTML, scripts, CSS, and
// arbitrary attributes are not part of the document contract.
func validFormRichText(parts []FormRichPart, plain string) bool {
	if len(parts) == 0 {
		return true
	}
	if len(parts) > 10000 {
		return false
	}
	var text strings.Builder
	for _, part := range parts {
		if part.Insert == "" {
			return false
		}
		text.WriteString(part.Insert)
		for attr := range part.Attributes {
			if attr != "bold" && attr != "italic" && attr != "underline" {
				return false
			}
		}
	}
	return text.String() == plain
}
