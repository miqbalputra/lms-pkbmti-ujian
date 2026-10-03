package main

import (
	"archive/zip"
	"bytes"
	"io"
	"strings"
	"testing"
)

func TestAssessmentXLSXReportIsAValidPackageWithEscapedCellValues(t *testing.T) {
	rows := [][]string{{"Nama", "Nilai"}, {"Siswa & Satu", "90"}}
	body, err := buildAssessmentXLSX(rows)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		t.Fatalf("XLSX must be a valid ZIP package: %v", err)
	}
	var sheet string
	for _, file := range archive.File {
		if file.Name == "xl/worksheets/sheet1.xml" {
			reader, err := file.Open()
			if err != nil {
				t.Fatal(err)
			}
			data, err := io.ReadAll(reader)
			_ = reader.Close()
			if err != nil {
				t.Fatal(err)
			}
			sheet = string(data)
		}
	}
	if !strings.Contains(sheet, "Siswa &amp; Satu") || !strings.Contains(sheet, "A2") {
		t.Fatalf("worksheet should contain escaped text and cell references, got %s", sheet)
	}
}

func TestAssessmentPDFReportHasValidHeaderTrailerAndEscapesText(t *testing.T) {
	body := buildAssessmentPDF("Tes (akhir)", [][]string{{"Nama", "Nilai"}, {"Siswa", "90"}})
	if !bytes.HasPrefix(body, []byte("%PDF-1.4")) || !bytes.HasSuffix(bytes.TrimSpace(body), []byte("%%EOF")) {
		t.Fatalf("PDF should contain a PDF header and EOF marker: %q", body[:min(len(body), 16)])
	}
	if !bytes.Contains(body, []byte("Tes \\(akhir\\)")) {
		t.Fatal("PDF text should escape parentheses in the assessment title")
	}
}

func TestCSVFormulaInjectionIsNeutralized(t *testing.T) {
	for _, value := range []string{"=1+1", " +SUM(A1:A2)", "-10", "@cmd"} {
		if safe := spreadsheetSafe(value); !strings.HasPrefix(safe, "'") {
			t.Errorf("formula-like cell %q was not prefixed: %q", value, safe)
		}
	}
	if got := spreadsheetSafe("Siswa aman"); got != "Siswa aman" {
		t.Fatalf("ordinary text should remain unchanged, got %q", got)
	}
}
