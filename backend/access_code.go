package main

import (
	"crypto/aes"
	"crypto/cipher"
	cryptorand "crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"strings"
)

func assessmentCodeKey(secret string) []byte {
	key := sha256.Sum256([]byte("pkbm-cbt-assessment-access-code-v1\x00" + secret))
	return key[:]
}

func encryptAssessmentCode(secret, raw string) (string, error) {
	code := strings.TrimSpace(raw)
	if code == "" {
		return "", nil
	}
	block, err := aes.NewCipher(assessmentCodeKey(secret))
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := io.ReadFull(cryptorand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := aead.Seal(nonce, nonce, []byte(code), nil)
	return base64.RawURLEncoding.EncodeToString(sealed), nil
}

func decryptAssessmentCode(secret, encoded string) (string, error) {
	if strings.TrimSpace(encoded) == "" {
		return "", nil
	}
	sealed, err := base64.RawURLEncoding.DecodeString(encoded)
	if err != nil {
		return "", errors.New("kode akses tersimpan tidak valid")
	}
	block, err := aes.NewCipher(assessmentCodeKey(secret))
	if err != nil {
		return "", err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(sealed) < aead.NonceSize()+aead.Overhead() {
		return "", errors.New("kode akses tersimpan tidak lengkap")
	}
	nonce, ciphertext := sealed[:aead.NonceSize()], sealed[aead.NonceSize():]
	plain, err := aead.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return "", errors.New("kode akses tidak dapat dibuka dengan kunci aplikasi saat ini")
	}
	return string(plain), nil
}

func (s *Server) setAssessmentAccessCode(row *Assessment, raw *string) error {
	if raw == nil {
		return nil
	}
	code := strings.TrimSpace(*raw)
	if code == "" {
		// Older records only have a one-way hash; preserve it when an old
		// client submits an empty value because the original code is unknowable.
		if row.AccessCodeHash != "" && row.AccessCodeCiphertext == "" {
			return nil
		}
		row.AccessCodeHash = ""
		row.AccessCodeCiphertext = ""
		return nil
	}
	row.AccessCodeHash = hash(code)
	ciphertext, err := encryptAssessmentCode(s.cfg.JWTSecret, code)
	if err != nil {
		return err
	}
	row.AccessCodeCiphertext = ciphertext
	return nil
}
