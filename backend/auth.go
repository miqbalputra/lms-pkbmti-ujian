package main

import (
	"errors"
	"strings"
	"time"

	"github.com/gofiber/fiber/v2"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

type authClaims struct { Role string `json:"role"`; StudentID string `json:"studentId,omitempty"`; jwt.RegisteredClaims }

func (s *Server) issueToken(account CBTAccount, ttl time.Duration) (string, error) {
	return jwt.NewWithClaims(jwt.SigningMethodHS256, authClaims{Role: account.Role, StudentID: account.PesertaDidikID, RegisteredClaims: jwt.RegisteredClaims{Subject: account.ID, ExpiresAt: jwt.NewNumericDate(time.Now().Add(ttl)), IssuedAt: jwt.NewNumericDate(time.Now())}}).SignedString([]byte(s.cfg.JWTSecret))
}
func (s *Server) auth(c *fiber.Ctx) error {
	raw := strings.TrimPrefix(c.Get("Authorization"), "Bearer ")
	if raw == "" { return fiber.NewError(401, "Sesi diperlukan") }
	claims := &authClaims{}
	token, err := jwt.ParseWithClaims(raw, claims, func(token *jwt.Token) (interface{}, error) { if token.Method != jwt.SigningMethodHS256 { return nil, errors.New("metode token tidak valid") }; return []byte(s.cfg.JWTSecret), nil })
	if err != nil || !token.Valid { return fiber.NewError(401, "Sesi tidak valid atau telah berakhir") }
	var account CBTAccount
	if err := s.db.First(&account, "id = ?", claims.Subject).Error; err != nil || !account.Active { return fiber.NewError(401, "Akun tidak aktif") }
	c.Locals("account", account); return c.Next()
}
func currentAccount(c *fiber.Ctx) CBTAccount { account, _ := c.Locals("account").(CBTAccount); return account }
func requireRoles(roles ...string) fiber.Handler { return func(c *fiber.Ctx) error { account := currentAccount(c); for _, role := range roles { if account.Role == role { return c.Next() } }; return fiber.NewError(403, "Anda tidak memiliki akses untuk tindakan ini") } }
func hashPassword(raw string) (string, error) { value, err := bcrypt.GenerateFromPassword([]byte(raw), bcrypt.DefaultCost); return string(value), err }
func (s *Server) login(c *fiber.Ctx) error {
	var input struct { Username, Password string }
	if err := c.BodyParser(&input); err != nil { return fiber.NewError(400, "Data login tidak valid") }
	var account CBTAccount
	if err := s.db.Where("username = ?", strings.TrimSpace(input.Username)).First(&account).Error; err != nil || !account.Active || bcrypt.CompareHashAndPassword([]byte(account.PasswordHash), []byte(input.Password)) != nil { return fiber.NewError(401, "Username atau kata sandi tidak sesuai") }
	token, err := s.issueToken(account, 12*time.Hour); if err != nil { return fiber.NewError(500, "Sesi tidak dapat dibuat") }
	return c.JSON(fiber.Map{"accessToken": token, "user": fiber.Map{"id": account.ID, "username": account.Username, "nama": account.Nama, "role": account.Role, "pesertaDidikId": account.PesertaDidikID}})
}
