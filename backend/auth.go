package main

import (
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type authClaims struct {
	Role          string   `json:"role"`
	StudentID     string   `json:"studentId,omitempty"`
	AssessmentIDs []string `json:"assessmentIds,omitempty"`
	AccessLinkID  string   `json:"accessLinkId,omitempty"`
	jwt.RegisteredClaims
}

func (s *Server) issueToken(account CBTAccount, ttl time.Duration) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, authClaims{Role: account.Role, StudentID: account.PesertaDidikID, RegisteredClaims: jwt.RegisteredClaims{Subject: account.ID, ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)), IssuedAt: jwt.NewNumericDate(time.Now())}}).SignedString([]byte(s.cfg.JWTSecret))
}
func (s *Server) auth(c *fiber.Ctx) error {
	raw := strings.TrimPrefix(c.Get("Authorization"), "Bearer ")
	if raw == "" {
		return fiber.NewError(401, "Sesi diperlukan")
	}
	claims := &authClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (interface{}, error) {
		if token.Method != jwt.SigningMethodHS256 {
			return nil, errors.New("metode token tidak valid")
		}
		return []byte(s.cfg.JWTSecret), nil
	})
	// Collaboration tickets share signing infrastructure but are never login
	// credentials. Reject foreign audiences, including legacy sessions with no aud.
	if err != nil || !token.Valid || len(claims.Audience) > 0 && !containsString(claims.Audience, "cbt-session") {
		return fiber.NewError(401, "Sesi tidak valid atau telah berakhir")
	}
	var account CBTAccount
	if err := s.db.First(&account, "id = ?", claims.Subject).Error; err != nil || !account.Active {
		return fiber.NewError(401, "Akun tidak aktif")
	}
	c.Locals("account", account)
	c.Locals("assessmentScope", claims.AssessmentIDs)
	c.Locals("accessLinkID", claims.AccessLinkID)
	if claims.AccessLinkID != "" && strings.HasPrefix(c.Path(), "/api/student/assessments") {
		var link FormAccessLink
		if s.db.First(&link, "id = ? AND revoked = false", claims.AccessLinkID).Error != nil || link.ExpiresAt != nil && !time.Now().Before(*link.ExpiresAt) {
			return fiber.NewError(403, "Tautan akses sudah dicabut atau kedaluwarsa. Percobaan aktif masih dapat dilanjutkan dari riwayat.")
		}
	}
	// A code-issued session cannot be reused for another assessment, including
	// its attempts or private attachments. Legacy account/SSO sessions are unscoped.
	if len(claims.AssessmentIDs) > 0 && strings.HasPrefix(c.Path(), "/api/student/") {
		id := c.Params("id")
		// Fiber's group middleware runs before dynamic route parameters are
		// populated. Scope checks must also resolve the URL, not silently skip it.
		parts := strings.Split(strings.Trim(c.Path(), "/"), "/")
		if id == "" && len(parts) > 3 && (parts[2] == "assessments" || parts[2] == "attempts") {
			id = parts[3]
		}
		if strings.Contains(c.Path(), "/attempts/") && id != "" {
			var attempt Attempt
			if s.db.Select("assessment_id").First(&attempt, "id = ?", id).Error != nil {
				return fiber.NewError(404, "Percobaan tidak ditemukan")
			}
			id = attempt.AssessmentID
		}
		if id != "" && !containsString(claims.AssessmentIDs, id) {
			return fiber.NewError(403, "Sesi hanya berlaku untuk asesmen yang diakses")
		}
	}
	return c.Next()
}
func currentAccount(c *fiber.Ctx) CBTAccount {
	account, _ := c.Locals("account").(CBTAccount)
	return account
}
func requireRoles(roles ...string) fiber.Handler {
	return func(c *fiber.Ctx) error {
		account := currentAccount(c)
		for _, role := range roles {
			if account.Role == role {
				return c.Next()
			}
		}
		return fiber.NewError(403, "Anda tidak memiliki akses untuk tindakan ini")
	}
}
func hashPassword(raw string) (string, error) {
	value, err := bcrypt.GenerateFromPassword([]byte(raw), bcrypt.DefaultCost)
	return string(value), err
}
func (s *Server) login(c *fiber.Ctx) error {
	var input struct{ Username, Password string }
	if err := c.BodyParser(&input); err != nil {
		return fiber.NewError(400, "Data login tidak valid")
	}
	var account CBTAccount
	if err := s.db.Where("username = ?", strings.TrimSpace(input.Username)).First(&account).Error; err != nil || !account.Active {
		return fiber.NewError(401, "Username atau kata sandi tidak sesuai")
	}
	if account.SourceUserID != "" {
		return fiber.NewError(fiber.StatusUnauthorized, "Akun ini dikelola oleh LMS. Gunakan tombol Masuk melalui akun LMS.")
	}
	if bcrypt.CompareHashAndPassword([]byte(account.PasswordHash), []byte(input.Password)) != nil {
		return fiber.NewError(401, "Username atau kata sandi tidak sesuai")
	}
	token, err := s.issueToken(account, 12*time.Hour)
	if err != nil {
		return fiber.NewError(500, "Sesi tidak dapat dibuat")
	}
	return c.JSON(fiber.Map{"accessToken": token, "user": fiber.Map{"id": account.ID, "username": account.Username, "nama": account.Nama, "role": account.Role, "pesertaDidikId": account.PesertaDidikID}})
}
