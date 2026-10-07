package main

import "testing"

func TestResponseValidationEveryType(t *testing.T) {
	cases := []struct{ kind, config, good, bad string }{
		{"pg_tunggal", `{"choices":[{"id":"a"}]}`, `"a"`, `"unknown"`},
		{"pg_kompleks", `{"choices":[{"id":"a"}]}`, `["a"]`, `["a","a"]`},
		{"dropdown", `{"choices":[{"id":"a"}]}`, `"a"`, `{}`},
		{"isian_singkat", `{"textMaxLength":5}`, `"empat"`, `"melebihi"`},
		{"uraian", `{"textMinLength":4}`, `"alasan"`, `"a"`},
		{"benar_salah", `{"statements":[{"id":"a"}]}`, `{"a":false}`, `{"a":"false"}`},
		{"menjodohkan", `{"left":[{"id":"a"}],"right":[{"id":"b"}]}`, `{"a":"b"}`, `{"a":"missing"}`},
		{"susun_urutan", `{"choices":[{"id":"a"},{"id":"b"}]}`, `["b","a"]`, `["a"]`},
		{"kisi_pg", `{"rows":[{"id":"r"}],"columns":[{"id":"c"}]}`, `{"r":"c"}`, `{"invalid":"c"}`},
		{"kisi_checkbox", `{"rows":[{"id":"r"}],"columns":[{"id":"c"}]}`, `{"r":["c"]}`, `{"r":["c","c"]}`},
		{"skala_linear", `{"scaleMin":0,"scaleMax":5}`, `0`, `6`},
		{"rating", `{"ratingMax":5}`, `4`, `4.5`},
		{"tanggal", `{}`, `"2026-10-07"`, `"2026-02-30"`},
		{"waktu", `{}`, `"08:30"`, `"26:30"`},
		{"unggah_berkas", `{"maxFiles":1}`, `[{"id":"file"}]`, `[{"id":"file"},{"id":"file"}]`},
	}
	if len(cases) != len(supportedQuestionTypes) {
		t.Fatal("missing type")
	}
	for _, c := range cases {
		t.Run(c.kind, func(t *testing.T) {
			q := questionSnapshot{Type: c.kind, ConfigJSON: c.config}
			if err := validateResponse(q, decodeJSON(c.good), true); err != nil {
				t.Fatal(err)
			}
			// Empty optional values are intentionally allowed. Test nonempty wrong
			// shape for dropdown; it cannot be used to bypass a required question.
			if c.bad == `{}` {
				q.ConfigJSON = `{"required":true,"choices":[{"id":"a"}]}`
			}
			if validateResponse(q, decodeJSON(c.bad), true) == nil {
				t.Fatal("invalid response accepted")
			}
		})
	}
}
func TestRequiredGridCannotSubmitOnlyOneRow(t *testing.T) {
	q := questionSnapshot{Type: "kisi_pg", ConfigJSON: `{"required":true,"rows":[{"id":"a"},{"id":"b"}],"columns":[{"id":"x"}]}`}
	value := decodeJSON(`{"a":"x"}`)
	if err := validateResponse(q, value, false); err != nil {
		t.Fatal("partial autosave denied", err)
	}
	if validateResponse(q, value, true) == nil {
		t.Fatal("incomplete grid submitted")
	}
}

func TestNewResultReleaseDoesNotChangeLegacyPolicy(t *testing.T) {
	a := Assessment{ShowResult: true, ResultsPolicy: "after_review"}
	completed := Attempt{Status: "completed"}
	if !resultVisible(a, completed) {
		t.Fatal("legacy result changed")
	}
	a.FormVersionID = "new-version"
	if resultVisible(a, completed) {
		t.Fatal("new exam released before owner review")
	}
}
