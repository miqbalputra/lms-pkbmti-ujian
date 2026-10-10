package main

import "github.com/gofiber/fiber/v2"

func publicUIConfig(baseURL string) fiber.Map {
	return fiber.Map{
		"publicBaseUrl":    baseURL,
		"formsEnabled":     env("CBT_FORMS_ENABLED", "false") == "true",
		"studentUxEnabled": env("CBT_STUDENT_UX_ENABLED", "false") == "true",
	}
}
