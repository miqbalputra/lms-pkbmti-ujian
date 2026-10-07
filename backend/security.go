package main

import (
	"fmt"
	"net"
	"net/url"
	"strings"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/helmet"
	"github.com/gofiber/fiber/v2/middleware/limiter"
	"time"
)

const cbtContentSecurityPolicy = "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; media-src 'self' blob: https:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'"

func parseTrustedProxies(raw string) ([]string, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, nil
	}

	var proxies []string
	seen := make(map[string]struct{})
	for _, value := range strings.Split(raw, ",") {
		value = strings.TrimSpace(value)
		if value == "" {
			continue
		}
		if net.ParseIP(value) == nil {
			_, network, err := net.ParseCIDR(value)
			if err != nil {
				return nil, fmt.Errorf("TRUSTED_PROXY_IPS memuat alamat IP/CIDR yang tidak valid: %q", value)
			}
			prefix, bits := network.Mask.Size()
			if prefix == 0 && bits > 0 {
				return nil, fmt.Errorf("TRUSTED_PROXY_IPS tidak boleh mempercayai seluruh internet: %q", value)
			}
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		proxies = append(proxies, value)
	}
	return proxies, nil
}

func validateHTTPSBaseURL(raw string) error {
	parsed, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return fmt.Errorf("PUBLIC_BASE_URL harus berupa origin HTTPS, contohnya https://ujian.pkbmtunasilmu.sch.id")
	}
	return nil
}

func httpsRedirect(forceHTTPS bool, publicBaseURL string) fiber.Handler {
	canonicalOrigin := strings.TrimRight(strings.TrimSpace(publicBaseURL), "/")
	return func(c *fiber.Ctx) error {
		// The container health probe is intentionally local HTTP. It carries no
		// application data and must remain independent of the public TLS proxy.
		if !forceHTTPS || c.Path() == "/health" || strings.EqualFold(c.Protocol(), "https") {
			return c.Next()
		}
		return c.Redirect(canonicalOrigin+c.OriginalURL(), fiber.StatusMovedPermanently)
	}
}

func securityHeaders() fiber.Handler {
	csp := cbtContentSecurityPolicy
	if raw := env("COLLABORATION_PUBLIC_URL", ""); raw != "" && !strings.HasPrefix(raw, "/") {
		u, err := url.Parse(raw)
		if err != nil || u.Host == "" || u.User != nil || (u.Scheme != "wss" && !(u.Scheme == "ws" && (u.Hostname() == "localhost" || u.Hostname() == "127.0.0.1"))) {
			panic("COLLABORATION_PUBLIC_URL harus WSS tepercaya")
		}
		csp = strings.Replace(csp, "connect-src 'self'", "connect-src 'self' "+u.Scheme+"://"+u.Host, 1)
	}
	return helmet.New(helmet.Config{
		ContentTypeNosniff:        "nosniff",
		XFrameOptions:             "DENY",
		HSTSMaxAge:                31536000,
		HSTSExcludeSubdomains:     true,
		ContentSecurityPolicy:     csp,
		ReferrerPolicy:            "strict-origin-when-cross-origin",
		PermissionPolicy:          "camera=(), microphone=(), geolocation=()",
		CrossOriginEmbedderPolicy: "unsafe-none",
		CrossOriginOpenerPolicy:   "same-origin",
		CrossOriginResourcePolicy: "same-origin",
		XPermittedCrossDomain:     "none",
		XDownloadOptions:          "noopen",
		XDNSPrefetchControl:       "off",
	})
}

func participantRateLimit() fiber.Handler {
	return limiter.New(limiter.Config{Max: 15, Expiration: time.Minute,
		// Schools commonly share a public IP. Bound retries per IP and claimed
		// identity/code hash so normal concurrent participants are not locked out.
		Next: func(c *fiber.Ctx) bool { return strings.HasSuffix(c.Path(), "/resolve") },
		KeyGenerator: func(c *fiber.Ctx) string {
			var in struct {
				NISN string `json:"nisn"`
			}
			_ = c.BodyParser(&in)
			return c.IP() + ":" + hash(strings.TrimSpace(in.NISN))
		},
		LimitReached: func(c *fiber.Ctx) error {
			return c.Status(429).JSON(fiber.Map{"error": "Terlalu banyak percobaan. Tunggu satu menit lalu coba lagi."})
		},
	})
}

func hidePoweredBy() fiber.Handler {
	return func(c *fiber.Ctx) error {
		err := c.Next()
		c.Response().Header.Del("X-Powered-By")
		return err
	}
}
