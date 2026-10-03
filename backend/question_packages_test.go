package main

import (
	"sync"
	"testing"

	"gorm.io/gorm/schema"
)

func TestNormalizeQuestionPackageInputTrimsAndPreservesSelectionOrder(t *testing.T) {
	input := questionPackageInput{
		Title:       "  Ujian Akhir Semester  ",
		Description: "  Matematika kelas 10  ",
		Subject:     " Matematika ",
		QuestionIDs: []string{" q-2 ", "q-1"},
		ClassIDs:    []string{" kelas-10a "},
	}
	if err := normalizeQuestionPackageInput(&input); err != nil {
		t.Fatal(err)
	}
	if input.Title != "Ujian Akhir Semester" || input.Description != "Matematika kelas 10" || input.Subject != "Matematika" {
		t.Fatalf("package metadata was not normalized: %#v", input)
	}
	if len(input.QuestionIDs) != 2 || input.QuestionIDs[0] != "q-2" || input.QuestionIDs[1] != "q-1" {
		t.Fatalf("question order was not retained: %#v", input.QuestionIDs)
	}
	if input.ClassIDs[0] != "kelas-10a" {
		t.Fatalf("class target was not normalized: %#v", input.ClassIDs)
	}
}

func TestNormalizeQuestionPackageInputRejectsAmbiguousTargets(t *testing.T) {
	input := questionPackageInput{Title: "Paket", ClassIDs: []string{"kelas-1"}, StudentIDs: []string{"siswa-1"}}
	if err := normalizeQuestionPackageInput(&input); err == nil {
		t.Fatal("class and student targets must not be mixed")
	}
}

func TestNormalizeQuestionPackageInputRejectsDuplicateQuestionAndTargetIDs(t *testing.T) {
	for name, input := range map[string]questionPackageInput{
		"questions": {Title: "Paket", QuestionIDs: []string{"q-1", "q-1"}},
		"classes":   {Title: "Paket", ClassIDs: []string{"class-1", "class-1"}},
		"students":  {Title: "Paket", StudentIDs: []string{"student-1", "student-1"}},
	} {
		t.Run(name, func(t *testing.T) {
			if err := normalizeQuestionPackageInput(&input); err == nil {
				t.Fatal("duplicate IDs must be rejected")
			}
		})
	}
}

func TestNormalizeQuestionPackageInputEnforcesFriendlyFieldLimits(t *testing.T) {
	if err := normalizeQuestionPackageInput(&questionPackageInput{Title: string(make([]byte, 161))}); err == nil {
		t.Fatal("package titles longer than 160 characters must be rejected")
	}
	if err := normalizeQuestionPackageInput(&questionPackageInput{Title: "Paket", Description: string(make([]byte, 5001))}); err == nil {
		t.Fatal("package descriptions longer than 5,000 characters must be rejected")
	}
}

func TestQuestionPackageSchemaKeepsExplicitPackageAndAssignmentRelations(t *testing.T) {
	cache := &sync.Map{}
	questionSchema, err := schema.Parse(&Question{}, cache, schema.NamingStrategy{})
	if err != nil {
		t.Fatal(err)
	}
	if questionSchema.FieldsByName["PackageID"].DBName != "package_id" {
		t.Fatalf("question package foreign key column = %q", questionSchema.FieldsByName["PackageID"].DBName)
	}
	if questionSchema.Relationships.Relations["Package"] == nil {
		t.Fatal("question must expose the package foreign-key relationship")
	}
	packageSchema, err := schema.Parse(&QuestionPackage{}, cache, schema.NamingStrategy{})
	if err != nil {
		t.Fatal(err)
	}
	if packageSchema.Table != "question_packages" || packageSchema.FieldsByName["OwnerID"].DBName != "created_by" {
		t.Fatalf("unexpected question package schema: table=%q createdBy=%q", packageSchema.Table, packageSchema.FieldsByName["OwnerID"].DBName)
	}
	assignmentSchema, err := schema.Parse(&PackageAssignment{}, cache, schema.NamingStrategy{})
	if err != nil {
		t.Fatal(err)
	}
	if assignmentSchema.Table != "package_assignments" {
		t.Fatalf("assignment table = %q", assignmentSchema.Table)
	}
}
