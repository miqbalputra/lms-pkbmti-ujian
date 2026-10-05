package main

import "testing"

func TestSafeSSONextPathRejectsExternalAndCallbackTargets(t *testing.T) {
	tests := []struct{ raw, want string }{
		{"", "/"},
		{"/", "/"},
		{"/soal/paket/abc?tab=detail", "/soal/paket/abc?tab=detail"},
		{"https://attacker.example/steal", "/"},
		{"//attacker.example/steal", "/"},
		{"/sso/callback", "/"},
		{"javascript:alert(1)", "/"},
	}
	for _, test := range tests {
		if got := safeSSONextPath(test.raw); got != test.want {
			t.Errorf("safeSSONextPath(%q) = %q; want %q", test.raw, got, test.want)
		}
	}
}

func TestSSOSecretMustBeStrongEnough(t *testing.T) {
	server := &Server{cfg: Config{SSOSecret: "short"}}
	if server.ssoSecretReady() {
		t.Fatal("short SSO secret must fail closed")
	}
	server.cfg.SSOSecret = "this-is-a-strong-enough-shared-sso-secret"
	if !server.ssoSecretReady() {
		t.Fatal("valid SSO secret was rejected")
	}
}
