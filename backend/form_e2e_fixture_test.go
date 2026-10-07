package main

import (
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
	"net/url"
	"os"
	"strings"
	"testing"
)

// Explicit fixture preparation for the real browser gate. Never runs against
// production or ordinary unit databases, and never deletes an existing record.
func TestE2EPrepareFixture(t *testing.T) {
	raw := os.Getenv("CBT_E2E_DATABASE_URL")
	if raw == "" {
		t.Skip("fixture command, not a release scenario")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost") || !strings.HasPrefix(strings.TrimPrefix(u.Path, "/"), "cbt_test") {
		t.Fatal("refusing non-disposable fixture DB")
	}
	db, err := gorm.Open(postgres.Open(raw), &gorm.Config{})
	if err != nil {
		t.Fatal(err)
	}
	sql, _ := db.DB()
	defer sql.Close()
	s := &Server{db: db}
	if err := s.migrate(); err != nil {
		t.Fatal(err)
	}
	password, err := hashPassword("CBT-E2E-password-ONLY-2026")
	if err != nil {
		t.Fatal(err)
	}
	for i, user := range []string{"e2e-owner", "e2e-editor"} {
		role := "guru"
		if i == 0 {
			role = "admin"
		}
		row := CBTAccount{Base: Base{ID: []string{"83dd78ee-b01d-4cfe-837b-c28379708461", "cd08c02b-caa3-4f10-9f83-62f012869d04"}[i]}, Username: user, Role: role, Nama: user, Active: true, PasswordHash: password}
		if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
	class := MasterKelas{Base: Base{ID: "84c35435-2b35-4443-ac11-aabf1c11b7fa"}, Nama: "Paket A E2E", Jenjang: 6, Active: true}
	if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&class).Error; err != nil {
		t.Fatal(err)
	}
	group := MasterKelompokBelajar{Base: Base{ID: "6147a797-82d9-4b49-bef9-3b3e8b1d87a8"}, Nama: "Pokjar E2E"}
	if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&group).Error; err != nil {
		t.Fatal(err)
	}
	for i, nisn := range []string{"9090909001", "9090909002"} {
		row := MasterPeserta{Base: Base{ID: []string{"1400353a-7bb5-4287-801f-5cf22f7a0284", "33ddcdf0-a686-4abf-a651-5671ec92ba5b"}[i]}, Nama: "Siswa E2E " + nisn, NISN: nisn, NIS: nisn, KelasID: class.ID, PokjarID: group.ID, JenisKelamin: "L", Active: true}
		if err := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error; err != nil {
			t.Fatal(err)
		}
	}
}
