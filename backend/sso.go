package main

import (
	"crypto/subtle"
	"net/url"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

const (
	ssoIssuer   = "pkbmti-lms"
	ssoAudience = "pkbmti-cbt"
)

type CBTSSOState struct {
	StateHash  string     `gorm:"primaryKey"`
	NextPath   string     `gorm:"type:text;not null"`
	ExpiresAt  time.Time  `gorm:"index;not null"`
	ConsumedAt *time.Time `gorm:"index"`
}

type cbtSSOClaims struct {
	Username       string `json:"username"`
	Nama           string `json:"nama"`
	Role           string `json:"role"`
	TutorID        string `json:"tutorId,omitempty"`
	PesertaDidikID string `json:"pesertaDidikId,omitempty"`
	State          string `json:"state"`
	jwt.RegisteredClaims
}

func (s *Server) ssoSecretReady() bool {
	return len(strings.TrimSpace(s.cfg.SSOSecret)) >= 32
}

func safeSSONextPath(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "/"
	}
	parsed, err := url.ParseRequestURI(raw)
	if err != nil || parsed.IsAbs() || parsed.Host != "" || !strings.HasPrefix(parsed.Path, "/") || strings.HasPrefix(parsed.Path, "//") || parsed.Path == "/sso/callback" {
		return "/"
	}
	return parsed.RequestURI()
}

// startSSO is intentionally a top-level navigation. It sets a first-party,
// HttpOnly state cookie before redirecting to LMS, avoiding third-party-cookie
// dependence and preventing login-CSRF through a copied assertion URL.
func (s *Server) startSSO(c *fiber.Ctx) error {
	if !s.ssoSecretReady() {
		return fiber.NewError(fiber.StatusServiceUnavailable, "SSO LMS belum dikonfigurasi oleh Administrator")
	}
	state := uuid.NewString()
	now := time.Now().UTC()
	row := CBTSSOState{StateHash: hash(state), NextPath: safeSSONextPath(c.Query("next")), ExpiresAt: now.Add(5 * time.Minute)}
	if err := s.db.Create(&row).Error; err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Permintaan SSO tidak dapat dimulai")
	}
	_ = s.db.Where("expires_at < ? OR consumed_at IS NOT NULL", now.Add(-time.Hour)).Delete(&CBTSSOState{}).Error
	secure := s.cfg.Env == "production"
	c.Cookie(&fiber.Cookie{Name: "cbt_sso_state", Value: state, HTTPOnly: true, Secure: secure, SameSite: "Lax", Expires: row.ExpiresAt, MaxAge: 300, Path: "/api/auth/sso/exchange"})
	launchURL := strings.TrimRight(s.cfg.LMSPublicURL, "/") + "/cbt-sso/launch?state=" + url.QueryEscape(state)
	return c.Redirect(launchURL, fiber.StatusTemporaryRedirect)
}

func (s *Server) ssoExchange(c *fiber.Ctx) error {
	if !s.ssoSecretReady() {
		return fiber.NewError(fiber.StatusServiceUnavailable, "SSO LMS belum dikonfigurasi oleh Administrator")
	}
	var input struct {
		Ticket string `json:"ticket"`
	}
	if err := c.BodyParser(&input); err != nil || strings.TrimSpace(input.Ticket) == "" || len(input.Ticket) > 8192 {
		return fiber.NewError(fiber.StatusBadRequest, "Tiket SSO tidak valid")
	}
	claims := &cbtSSOClaims{}
	token, err := jwt.ParseWithClaims(strings.TrimSpace(input.Ticket), claims, func(token *jwt.Token) (any, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, fiber.NewError(fiber.StatusUnauthorized, "Metode tanda tangan SSO tidak valid")
		}
		return []byte(s.cfg.SSOSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer(ssoIssuer), jwt.WithAudience(ssoAudience), jwt.WithLeeway(15*time.Second))
	if err != nil || token == nil || !token.Valid {
		return fiber.NewError(fiber.StatusUnauthorized, "Tiket SSO tidak valid atau kedaluwarsa. Silakan mulai lagi dari LMS.")
	}
	stateCookie := c.Cookies("cbt_sso_state")
	if stateCookie == "" || claims.State == "" || subtle.ConstantTimeCompare([]byte(stateCookie), []byte(claims.State)) != 1 {
		return fiber.NewError(fiber.StatusUnauthorized, "Permintaan SSO tidak cocok dengan browser ini. Silakan mulai lagi dari LMS.")
	}
	if claims.Subject == "" || claims.ID == "" || strings.TrimSpace(claims.Username) == "" || strings.TrimSpace(claims.Nama) == "" {
		return fiber.NewError(fiber.StatusUnauthorized, "Identitas pada tiket SSO tidak lengkap")
	}
	if claims.Role != "admin" && claims.Role != "guru" && claims.Role != "kepala_sekolah" && claims.Role != "siswa" {
		return fiber.NewError(fiber.StatusForbidden, "Peran akun tidak diizinkan di CBT")
	}
	if claims.Role == "siswa" && strings.TrimSpace(claims.PesertaDidikID) == "" {
		return fiber.NewError(fiber.StatusForbidden, "Akun siswa belum terhubung ke data peserta didik")
	}
	var account CBTAccount
	var nextPath string
	now := time.Now().UTC()
	err = s.db.Transaction(func(tx *gorm.DB) error {
		var state CBTSSOState
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).First(&state, "state_hash = ? AND expires_at > ? AND consumed_at IS NULL", hash(stateCookie), now).Error; err != nil {
			return fiber.NewError(fiber.StatusUnauthorized, "Permintaan SSO sudah dipakai atau kedaluwarsa. Silakan mulai lagi dari LMS.")
		}
		nextPath = safeSSONextPath(state.NextPath)
		if claims.Role == "siswa" {
			var student MasterPeserta
			if err := tx.First(&student, "id = ? AND active = ?", claims.PesertaDidikID, true).Error; err != nil {
				return fiber.NewError(fiber.StatusForbidden, "Data siswa belum tersinkron atau sudah tidak aktif. Minta administrator menyinkronkan data LMS.")
			}
		}
		err := tx.Where("source_user_id = ?", claims.Subject).First(&account).Error
		if err != nil && err != gorm.ErrRecordNotFound {
			return err
		}
		if err == gorm.ErrRecordNotFound {
			var collision CBTAccount
			collisionErr := tx.Where("username = ?", strings.TrimSpace(claims.Username)).First(&collision).Error
			if collisionErr == nil {
				// Preserve the bootstrap administrator's CBT-owned content when the
				// matching, currently authenticated LMS account is also an admin.
				if claims.Role != "admin" || collision.Role != "admin" || collision.SourceUserID != "" {
					return fiber.NewError(fiber.StatusConflict, "Username LMS sudah digunakan oleh akun CBT lain. Minta administrator meninjau pemetaan akun.")
				}
				account = collision
			} else if collisionErr != gorm.ErrRecordNotFound {
				return collisionErr
			}
			account.SourceUserID = claims.Subject
		}
		account.Username = strings.TrimSpace(claims.Username)
		account.Nama = strings.TrimSpace(claims.Nama)
		account.Role = claims.Role
		account.TutorID = strings.TrimSpace(claims.TutorID)
		account.PesertaDidikID = strings.TrimSpace(claims.PesertaDidikID)
		account.Active = true
		account.SourceUpdatedAt = now.Unix()
		if err := tx.Save(&account).Error; err != nil {
			return fiber.NewError(fiber.StatusConflict, "Akun CBT tidak dapat dipetakan ke identitas LMS")
		}
		state.ConsumedAt = &now
		if err := tx.Save(&state).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return err
	}
	ticket, err := s.issueToken(account, time.Hour)
	if err != nil {
		return fiber.NewError(fiber.StatusInternalServerError, "Sesi CBT tidak dapat dibuat")
	}
	c.Cookie(&fiber.Cookie{Name: "cbt_sso_state", Value: "", HTTPOnly: true, Secure: s.cfg.Env == "production", SameSite: "Lax", MaxAge: -1, Expires: time.Unix(1, 0), Path: "/api/auth/sso/exchange"})
	s.audit(account.ID, "sso_login", claims.Subject)
	return c.JSON(fiber.Map{"accessToken": ticket, "user": fiber.Map{"id": account.ID, "username": account.Username, "nama": account.Nama, "role": account.Role, "pesertaDidikId": account.PesertaDidikID}, "nextPath": nextPath})
}
