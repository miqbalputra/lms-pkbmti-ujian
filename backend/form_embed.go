package main

import (
	"github.com/gofiber/fiber/v2"
	"net/url"
	"strings"
)

// Embedding is opt-in and restricted to configured HTTPS origins. Staff pages
// and API responses keep DENY; enabling a participant link never weakens them.
func embedOrigins(raw string) ([]string, error) {
	out := []string{}
	for _, part := range strings.Split(raw, ",") {
		part = strings.TrimSpace(part)
		if part == "" {
			continue
		}
		u, err := url.Parse(part)
		if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || strings.Contains(u.Host, "*") {
			return nil, fiber.NewError(400, "CBT_EMBED_ALLOWED_ORIGINS harus origin HTTPS tanpa wildcard")
		}
		out = append(out, "https://"+u.Host)
	}
	return out, nil
}
func (s *Server) embedHeaders() fiber.Handler {
	origins, err := embedOrigins(env("CBT_EMBED_ALLOWED_ORIGINS", ""))
	if err != nil {
		panic(err)
	}
	return func(c *fiber.Ctx) error {
		err := c.Next()
		if len(origins) > 0 && env("CBT_FORMS_ENABLED", "false") == "true" && (strings.HasPrefix(c.Path(), "/akses/") || strings.HasPrefix(c.Path(), "/siswa/")) {
			c.Response().Header.Del("X-Frame-Options")
			csp := string(c.Response().Header.Peek("Content-Security-Policy"))
			c.Set("Content-Security-Policy", strings.Replace(csp, "frame-ancestors 'none'", "frame-ancestors "+strings.Join(origins, " "), 1))
		}
		return err
	}
}
