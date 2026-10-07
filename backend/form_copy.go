package main

import (
	"encoding/json"
	"github.com/gofiber/fiber/v2"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"strings"
)

// Forking creates fresh card/group IDs so two resources can never share a live
// item record. The immutable original, snapshots and attempts are untouched.
func forkFormContent(source FormDraft) FormDraft {
	out := source
	out.Title = "Salinan " + firstNonEmpty(strings.TrimSpace(source.Title), "paket tanpa judul")
	out.Cards, out.Sections, out.Stimuli = map[string]FormCard{}, map[string]FormSection{}, map[string]FormStimulus{}
	ids := map[string]string{}
	for id := range source.Sections {
		ids[id] = uuid.NewString()
	}
	for id := range source.Stimuli {
		ids[id] = uuid.NewString()
	}
	for _, group := range source.Stimuli {
		group.ID = ids[group.ID]
		var blocks []map[string]any
		_ = json.Unmarshal([]byte(marshalJSON(group.Blocks)), &blocks)
		for _, b := range blocks {
			b["id"] = uuid.NewString()
		}
		group.Blocks = blocks
		out.Stimuli[group.ID] = group
	}
	for _, section := range source.Sections {
		section.ID = ids[section.ID]
		if section.Next != "submit" {
			section.Next = ids[section.Next]
		}
		out.Sections[section.ID] = section
	}
	for _, card := range source.Cards {
		card.ID, card.SourceID = uuid.NewString(), ""
		card.SectionID, card.StimulusGroupID = ids[card.SectionID], ids[card.StimulusGroupID]
		card.Config = configObject(marshalJSON(card.Config))
		branches := mapFrom(card.Config["branchToByAnswer"])
		for key, target := range branches {
			if asString(target) != "submit" {
				branches[key] = ids[asString(target)]
			}
		}
		out.Cards[card.ID] = card
	}
	// Copies never reuse an access code, schedule, or accept new participants
	// accidentally. The owner chooses these in the new draft before publication.
	out.Settings.AccessCode, out.Settings.StartsAt, out.Settings.EndsAt = "", nil, nil
	return out
}

func (s *Server) copyForm(c *fiber.Ctx) error {
	a := currentAccount(c)
	original, err := s.loadForm(a, c.Params("kind"), c.Params("id"))
	if err != nil {
		return err
	}
	if !formEditable(s.formRole(s.db, a, original)) || a.Role == "kepala_sekolah" {
		return fiber.NewError(403, "Pemilik atau editor dapat menyimpan salinan paket ini")
	}
	var in struct {
		Content        *FormDraft `json:"content"`
		ResourceType   string     `json:"resourceType"`
		AssessmentKind string     `json:"assessmentKind"`
	}
	if len(c.Body()) > 0 && c.BodyParser(&in) != nil {
		return fiber.NewError(400, "Draf salinan tidak valid")
	}
	var source FormDraft
	if in.Content != nil {
		source = *in.Content
	} else if json.Unmarshal([]byte(original.ContentJSON), &source) != nil {
		return fiber.NewError(400, "Dokumen tidak dapat dibaca")
	}
	if err := validateForm(source, false); err != nil {
		return err
	}
	content := forkFormContent(source)
	if a.ID != original.OwnerID {
		// Shared editors get a private draft, not inherited access to classes
		// outside their own roster. They choose their own targets before publish.
		content.Settings.ClassIDs, content.Settings.StudentIDs = nil, nil
	}
	doc := FormDocument{OwnerID: a.ID, SourceDocumentID: original.ID, ResourceType: original.ResourceType, Revision: 1, ContentJSON: marshalJSON(content), MaterializedJSON: "{}"}
	if in.ResourceType != "" {
		if in.ResourceType != "assessment" || original.ResourceType != "package" {
			return fiber.NewError(400, "Salinan lintas modul hanya dari Bank Soal ke asesmen")
		}
		if in.AssessmentKind != "ujian_online" && in.AssessmentKind != "simulasi" {
			return fiber.NewError(400, "Jenis asesmen tidak valid")
		}
		doc.ResourceType = "assessment"
		content.Settings.Kind = in.AssessmentKind
		doc.ContentJSON = marshalJSON(content)
	}
	err = s.db.Transaction(func(tx *gorm.DB) error {
		// Validate borrowed media under the source document's permissions before
		// granting those exact files to the new private copy.
		var persisted FormDraft
		if json.Unmarshal([]byte(original.ContentJSON), &persisted) != nil {
			return fiber.NewError(500, "Sumber tidak dapat dibaca")
		}
		sharedMedia := map[string]bool{}
		if persisted.Settings.HeaderImage != nil {
			sharedMedia[persisted.Settings.HeaderImage.AssetID] = true
		}
		for _, q := range orderedCards(persisted) {
			stimulus := "[]"
			if group, ok := persisted.Stimuli[q.StimulusGroupID]; ok {
				stimulus = marshalJSON(group.Blocks)
			}
			for _, mediaID := range questionMediaIDs(stimulus, marshalJSON(q.Config)) {
				sharedMedia[mediaID] = true
			}
		}
		mediaIDs := map[string]bool{}
		if source.Settings.HeaderImage != nil {
			if err := s.validateFormHeader(tx, original, source.Settings, false); err != nil {
				return err
			}
			mediaID := source.Settings.HeaderImage.AssetID
			if a.ID != original.OwnerID && a.Role != "admin" && !sharedMedia[mediaID] {
				var owned QuestionMedia
				if tx.First(&owned, "id = ? AND owner_id = ? AND deleted_at IS NULL", mediaID, a.ID).Error != nil {
					return fiber.NewError(403, "Gambar header tidak termasuk dokumen yang dibagikan")
				}
			}
			mediaIDs[mediaID] = true
		}
		for _, card := range orderedCards(source) {
			stimulus := "[]"
			if group, ok := source.Stimuli[card.StimulusGroupID]; ok {
				stimulus = marshalJSON(group.Blocks)
			}
			config := marshalJSON(card.Config)
			if err := s.validateFormMedia(tx, original, stimulus, config, false); err != nil {
				return err
			}
			for _, mediaID := range questionMediaIDs(stimulus, config) {
				if a.ID != original.OwnerID && a.Role != "admin" && !sharedMedia[mediaID] {
					var owned QuestionMedia
					if tx.First(&owned, "id = ? AND owner_id = ? AND deleted_at IS NULL", mediaID, a.ID).Error != nil {
						return fiber.NewError(403, "Media tidak termasuk dokumen yang dibagikan")
					}
				}
				mediaIDs[mediaID] = true
			}
		}
		if doc.ResourceType == "assessment" {
			row := Assessment{OwnerID: doc.OwnerID, Title: content.Title, Kind: content.Settings.Kind, Status: "draft", DurationMinute: content.Settings.DurationMinute, MaxAttempts: content.Settings.MaxAttempts, Revision: 1}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			doc.ResourceID = row.ID
		} else {
			row := QuestionPackage{OwnerID: doc.OwnerID, Title: content.Title, Status: "draft"}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			doc.ResourceID = row.ID
		}
		if err := tx.Create(&doc).Error; err != nil {
			return err
		}
		for mediaID := range mediaIDs {
			if err := tx.Create(&FormMediaGrant{DocumentID: doc.ID, MediaID: mediaID}).Error; err != nil {
				return err
			}
		}
		if err := s.materializeForm(tx, a, &doc, content); err != nil {
			return err
		}
		if err := tx.Save(&doc).Error; err != nil {
			return err
		}
		return tx.Create(&AuditLog{ActorID: a.ID, Action: "copy_form_document", Resource: doc.ID, Detail: original.ID}).Error
	})
	if err != nil {
		return err
	}
	return c.Status(201).JSON(formResponse(doc, content, "owner"))
}
