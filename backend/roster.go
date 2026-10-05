package main

import (
	"sort"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
)

type masterClassView struct {
	ID              string    `json:"id"`
	Nama            string    `json:"nama"`
	Jenjang         int       `json:"jenjang"`
	PokjarID        string    `json:"pokjarId"`
	KelompokBelajar string    `json:"kelompokBelajar"`
	TahunAjaranID   string    `json:"tahunAjaranId"`
	TahunAjaran     string    `json:"tahunAjaran"`
	WaliKelasID     string    `json:"waliKelasId,omitempty"`
	ProgramID       string    `json:"programId,omitempty"`
	Program         string    `json:"program,omitempty"`
	FaseID          string    `json:"faseId,omitempty"`
	Fase            string    `json:"fase,omitempty"`
	Active          bool      `json:"active"`
	ManualFallback  bool      `json:"manualFallback,omitempty"`
	SourceUpdatedAt int64     `json:"sourceUpdatedAt"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

type masterStudentView struct {
	ID              string    `json:"id"`
	Nama            string    `json:"nama"`
	NIS             string    `json:"nis"`
	NISN            string    `json:"nisn"`
	JenisKelamin    string    `json:"jenisKelamin"`
	KelasID         string    `json:"kelasId"`
	Kelas           string    `json:"kelas"`
	Jenjang         int       `json:"jenjang"`
	PokjarID        string    `json:"pokjarId"`
	KelompokBelajar string    `json:"kelompokBelajar"`
	TahunAjaranID   string    `json:"tahunAjaranId"`
	TahunAjaran     string    `json:"tahunAjaran"`
	ProgramID       string    `json:"programId,omitempty"`
	Program         string    `json:"program,omitempty"`
	Urutan          int       `json:"urutan"`
	Active          bool      `json:"active"`
	SourceUpdatedAt int64     `json:"sourceUpdatedAt"`
	CreatedAt       time.Time `json:"createdAt"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

func masterClassViews(db *gorm.DB) (map[string]masterClassView, error) {
	var classes []MasterKelas
	if err := db.Order("jenjang, nama").Find(&classes).Error; err != nil {
		return nil, err
	}
	var groups []MasterKelompokBelajar
	if err := db.Find(&groups).Error; err != nil {
		return nil, err
	}
	groupNames := make(map[string]string, len(groups))
	for _, row := range groups {
		groupNames[row.ID] = row.Nama
	}
	var years []MasterTahunAjaran
	if err := db.Find(&years).Error; err != nil {
		return nil, err
	}
	yearNames := make(map[string]string, len(years))
	for _, row := range years {
		yearNames[row.ID] = row.Nama
	}
	var programs []MasterProgram
	if err := db.Find(&programs).Error; err != nil {
		return nil, err
	}
	programNames := make(map[string]string, len(programs))
	for _, row := range programs {
		programNames[row.ID] = row.Nama
	}
	var phases []MasterFase
	if err := db.Find(&phases).Error; err != nil {
		return nil, err
	}
	phaseNames := make(map[string]string, len(phases))
	for _, row := range phases {
		phaseNames[row.ID] = row.Nama
	}
	result := make(map[string]masterClassView, len(classes))
	for _, row := range classes {
		result[row.ID] = masterClassView{
			ID: row.ID, Nama: row.Nama, Jenjang: row.Jenjang, PokjarID: row.PokjarID,
			KelompokBelajar: groupNames[row.PokjarID], TahunAjaranID: row.TahunAjaranID,
			TahunAjaran: yearNames[row.TahunAjaranID], WaliKelasID: row.WaliKelasID,
			ProgramID: row.ProgramID, Program: programNames[row.ProgramID], FaseID: row.FaseID,
			Fase: phaseNames[row.FaseID], Active: row.Active, ManualFallback: row.ManualFallback,
			SourceUpdatedAt: row.SourceUpdatedAt, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		}
	}
	return result, nil
}

func (s *Server) listStudents(c *fiber.Ctx) error {
	query := s.db.Model(&MasterPeserta{})
	if c.Query("includeInactive") != "true" {
		query = query.Where("active = ?", true)
	}
	var rows []MasterPeserta
	if err := query.Order("kelas_id, urutan, nama").Find(&rows).Error; err != nil {
		return err
	}
	classes, err := masterClassViews(s.db)
	if err != nil {
		return err
	}
	result := make([]masterStudentView, 0, len(rows))
	var groupRows []MasterKelompokBelajar
	if err := s.db.Find(&groupRows).Error; err != nil {
		return err
	}
	groupNames := make(map[string]string, len(groupRows))
	for _, group := range groupRows {
		groupNames[group.ID] = group.Nama
	}
	var programRows []MasterProgram
	if err := s.db.Find(&programRows).Error; err != nil {
		return err
	}
	programNames := make(map[string]string, len(programRows))
	for _, program := range programRows {
		programNames[program.ID] = program.Nama
	}
	for _, row := range rows {
		class := classes[row.KelasID]
		groupID := row.PokjarID
		groupName := ""
		if groupID != "" {
			groupName = groupNames[groupID]
		} else {
			groupID, groupName = class.PokjarID, class.KelompokBelajar
		}
		programID, programName := row.ProgramID, ""
		if programID == "" {
			programID = class.ProgramID
		}
		programName = programNames[programID]
		result = append(result, masterStudentView{
			ID: row.ID, Nama: row.Nama, NIS: row.NIS, NISN: row.NISN, JenisKelamin: row.JenisKelamin,
			KelasID: row.KelasID, Kelas: class.Nama, Jenjang: class.Jenjang, PokjarID: groupID,
			KelompokBelajar: groupName, TahunAjaranID: class.TahunAjaranID, TahunAjaran: class.TahunAjaran,
			ProgramID: programID, Program: programName, Urutan: row.Urutan, Active: row.Active,
			SourceUpdatedAt: row.SourceUpdatedAt, CreatedAt: row.CreatedAt, UpdatedAt: row.UpdatedAt,
		})
	}
	return c.JSON(result)
}

func (s *Server) listClasses(c *fiber.Ctx) error {
	views, err := masterClassViews(s.db.Where("active = ?", true))
	if err != nil {
		return err
	}
	result := make([]masterClassView, 0, len(views))
	for _, row := range views {
		result = append(result, row)
	}
	sort.Slice(result, func(i, j int) bool {
		if result[i].Jenjang == result[j].Jenjang {
			return strings.ToLower(result[i].Nama) < strings.ToLower(result[j].Nama)
		}
		return result[i].Jenjang < result[j].Jenjang
	})
	return c.JSON(result)
}

func (s *Server) listLearningGroups(c *fiber.Ctx) error {
	var rows []MasterKelompokBelajar
	if err := s.db.Order("nama").Find(&rows).Error; err != nil {
		return err
	}
	return c.JSON(rows)
}
