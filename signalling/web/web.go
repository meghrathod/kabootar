package web

import (
	"github.com/gofiber/fiber/v2"
)

func InitWeb(address string) error {
	app := fiber.New()

	app.Get("/", func(c *fiber.Ctx) error {
		return c.SendString("Hello World")
	})

	return app.Listen(address)
}
