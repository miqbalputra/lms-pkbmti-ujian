package main

import (
	"encoding/json"
	"fmt"
	"github.com/gofiber/fiber/v2"
	"gorm.io/gorm"
	"math"
	"strconv"
	"strings"
)

func validFormTheme(settings FormSettings, publishing bool) bool {
	if settings.Font != "" && settings.Font != "sans-serif" && settings.Font != "serif" && settings.Font != "monospace" {
		return false
	}
	if settings.ThemeColor == "" {
		return true
	}
	text := strings.TrimPrefix(settings.ThemeColor, "#")
	if len(text) != 6 || !strings.HasPrefix(settings.ThemeColor, "#") {
		return false
	}
	n, err := strconv.ParseUint(text, 16, 32)
	if err != nil {
		return false
	}
	lum := 0.0
	for i, weight := range []float64{0.2126, 0.7152, 0.0722} {
		v := float64((n>>uint(16-i*8))&255) / 255
		if v <= 0.04045 {
			v /= 12.92
		} else {
			v = math.Pow((v+0.055)/1.055, 2.4)
		}
		lum += v * weight
	}
	return !publishing || 1.05/(lum+0.05) >= 4.5
}

// Never serialize FormSettings: it also contains the private access code.
func attemptFormDisplay(tx *gorm.DB, attempt Attempt) (fiber.Map, error) {
	if attempt.FormVersionID == "" {
		return nil, nil
	}
	var version FormVersion
	if err := tx.First(&version, "id = ?", attempt.FormVersionID).Error; err != nil {
		return nil, err
	}
	var draft FormDraft
	if err := json.Unmarshal([]byte(version.ContentJSON), &draft); err != nil {
		return nil, fmt.Errorf("invalid published form: %w", err)
	}
	return fiber.Map{"title": draft.Title, "themeColor": draft.Settings.ThemeColor, "font": draft.Settings.Font, "progressBar": draft.Settings.ProgressBar, "confirmationMessage": draft.Settings.ConfirmationMessage, "headerImage": draft.Settings.HeaderImage}, nil
}
