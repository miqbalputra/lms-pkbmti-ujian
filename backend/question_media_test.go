package main

import (
	"strings"
	"testing"
)

func TestInspectQuestionMediaRequiresMatchingSafeFileSignature(t *testing.T) {
	tests := []struct {
		name      string
		extension string
		data      []byte
		kind      string
		mime      string
		wantError bool
	}{
		{"PNG", ".png", []byte("\x89PNG\r\n\x1a\nimage"), "image", "image/png", false},
		{"JPEG", ".jpg", []byte("\xff\xd8\xffimage"), "image", "image/jpeg", false},
		{"WebP", ".webp", []byte("RIFF0000WEBPdata"), "image", "image/webp", false},
		{"MP3", ".mp3", []byte("ID3sample"), "audio", "audio/mpeg", false},
		{"WAV", ".wav", []byte("RIFF0000WAVEdata"), "audio", "audio/wav", false},
		{"MP4", ".mp4", []byte("0000ftypisomdata"), "video", "video/mp4", false},
		{"WebM", ".webm", []byte{0x1a, 0x45, 0xdf, 0xa3, 0x01}, "video", "video/webm", false},
		{"renamed script", ".png", []byte("<svg onload=alert(1)>"), "", "", true},
		{"extension mismatch", ".jpg", []byte("\x89PNG\r\n\x1a\nimage"), "", "", true},
		{"unsupported extension", ".svg", []byte("<svg></svg>"), "", "", true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got, err := inspectQuestionMedia(test.extension, test.data)
			if (err != nil) != test.wantError {
				t.Fatalf("inspectQuestionMedia() error = %v", err)
			}
			if err == nil && (got.kind != test.kind || got.contentType != test.mime) {
				t.Fatalf("got %#v; want kind=%s mime=%s", got, test.kind, test.mime)
			}
		})
	}
}

func TestInspectQuestionMediaEnforcesFiveMegabyteLimit(t *testing.T) {
	_, err := inspectQuestionMedia("png", make([]byte, maxQuestionMediaBytes+1))
	if err == nil || !strings.Contains(err.Error(), "5 MB") {
		t.Fatalf("expected 5 MB limit error, got %v", err)
	}
}

func TestQuestionMediaEmbeddedStimulusRequiresScopedAssetReference(t *testing.T) {
	id := "a24b7bc3-612c-4be6-bcda-b374ccedee1c"
	valid := `[{"type":"image","content":"/api/question-media/` + id + `","assetId":"` + id + `","contentType":"image/webp","alt":"Peta sederhana"}]`
	if !validStimulusJSON(valid) {
		t.Fatal("owned uploaded image reference should be valid")
	}
	for _, raw := range []string{
		`[{"type":"image","content":"/api/question-media/` + id + `"}]`,
		`[{"type":"image","content":"https://example.org/image.png","assetId":"` + id + `","contentType":"image/png"}]`,
		`[{"type":"media","content":"/api/question-media/` + id + `","assetId":"` + id + `","contentType":"text/html"}]`,
	} {
		if validStimulusJSON(raw) {
			t.Fatalf("unsafe embedded media accepted: %s", raw)
		}
	}
}

func TestQuestionMediaReferencesAreCollectedAcrossStimulusAndOptions(t *testing.T) {
	one := "a24b7bc3-612c-4be6-bcda-b374ccedee1c"
	two := "f35f0912-abfd-4ef2-88ec-d17ef267b9bb"
	ids := questionMediaIDs(`[{"assetId":"`+one+`"}]`, `{"choices":[{"media":{"assetId":"`+two+`"}},{"assetId":"`+one+`"},{"assetId":"not-a-uuid"}]}`)
	if len(ids) != 2 || ids[0] != one || ids[1] != two {
		t.Fatalf("unexpected media references: %#v", ids)
	}
}
