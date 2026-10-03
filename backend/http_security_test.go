package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/gofiber/fiber/v2"
)

func securityTestApp(forceHTTPS bool, trustedProxies []string) *fiber.App {
	app := fiber.New(fiber.Config{EnableTrustedProxyCheck: true, TrustedProxies: trustedProxies})
	app.Use(securityHeaders())
	app.Use(httpsRedirect(forceHTTPS, "https://ujian.pkbmtunasilmu.sch.id"))
	app.Use(hidePoweredBy())
	app.Get("/health", func(c *fiber.Ctx) error { return c.SendString("ok") })
	app.Get("/*", func(c *fiber.Ctx) error {
		c.Set("X-Powered-By", "must-be-removed")
		return c.SendString("ok")
	})
	return app
}

func TestHTTPSRedirectDoesNotTrustSpoofedForwardedProto(t *testing.T) {
	app := securityTestApp(true, nil)
	req, err := http.NewRequest(http.MethodGet, "http://cbt.local/ujian/42?mode=practice", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	response, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusMovedPermanently {
		t.Fatalf("expected 301 for an untrusted proxy header, got %d", response.StatusCode)
	}
	if got, want := response.Header.Get("Location"), "https://ujian.pkbmtunasilmu.sch.id/ujian/42?mode=practice"; got != want {
		t.Fatalf("redirect target = %q, want %q", got, want)
	}
	if got := response.Header.Get("X-Powered-By"); got != "" {
		t.Fatalf("X-Powered-By leaked: %q", got)
	}
}

func TestTrustedHTTPSProxyReceivesHSTSAndSecurityHeaders(t *testing.T) {
	app := securityTestApp(true, []string{"0.0.0.0"})
	req, err := http.NewRequest(http.MethodGet, "http://cbt.local/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Proto", "https")
	response, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("expected secure proxied request to proceed, got %d", response.StatusCode)
	}
	if got, want := response.Header.Get("Strict-Transport-Security"), "max-age=31536000"; got != want {
		t.Fatalf("HSTS = %q, want %q", got, want)
	}
	for header, want := range map[string]string{
		"X-Content-Type-Options": "nosniff",
		"X-Frame-Options":        "DENY",
		"Referrer-Policy":        "strict-origin-when-cross-origin",
		"Permissions-Policy":     "camera=(), microphone=(), geolocation=()",
	} {
		if got := response.Header.Get(header); got != want {
			t.Errorf("%s = %q, want %q", header, got, want)
		}
	}
	if got := response.Header.Get("Content-Security-Policy"); !strings.Contains(got, "frame-ancestors 'none'") || !strings.Contains(got, "object-src 'none'") {
		t.Errorf("CSP is missing critical directives: %q", got)
	}
	if got := response.Header.Get("X-Powered-By"); got != "" {
		t.Errorf("X-Powered-By leaked: %q", got)
	}
}

func TestHTTPSRedirectLeavesInternalHealthProbeAvailable(t *testing.T) {
	app := securityTestApp(true, []string{"0.0.0.0"})
	req, err := http.NewRequest(http.MethodGet, "http://cbt.local/health", nil)
	if err != nil {
		t.Fatal(err)
	}
	response, err := app.Test(req)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("health probe returned %d, want 200", response.StatusCode)
	}
}

func TestParseTrustedProxies(t *testing.T) {
	got, err := parseTrustedProxies(" 10.0.0.2,10.0.0.0/24, 10.0.0.2 ")
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0] != "10.0.0.2" || got[1] != "10.0.0.0/24" {
		t.Fatalf("unexpected normalized proxies: %#v", got)
	}
	if _, err := parseTrustedProxies("10.0.0.999/88"); err == nil {
		t.Fatal("expected invalid proxy range to be rejected")
	}
	for _, wildcard := range []string{"0.0.0.0/0", "::/0"} {
		if _, err := parseTrustedProxies(wildcard); err == nil {
			t.Errorf("wildcard proxy range %q must be rejected", wildcard)
		}
	}
}

func TestValidateHTTPSBaseURL(t *testing.T) {
	for _, raw := range []string{"https://ujian.pkbmtunasilmu.sch.id", "https://ujian.pkbmtunasilmu.sch.id/"} {
		if err := validateHTTPSBaseURL(raw); err != nil {
			t.Errorf("valid URL %q rejected: %v", raw, err)
		}
	}
	for _, raw := range []string{"http://ujian.pkbmtunasilmu.sch.id", "https://", "https://example.test/path", "https://example.test/?next=https://evil.test"} {
		if err := validateHTTPSBaseURL(raw); err == nil {
			t.Errorf("invalid HTTPS origin %q was accepted", raw)
		}
	}
}
