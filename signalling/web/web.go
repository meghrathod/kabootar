package web

import (
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
)

func InitWeb(address string) error {
	app := fiber.New()

	app.Get("/ping", func(c *fiber.Ctx) error {
		return c.SendString("Pong!")
	})

	h := &handler{}
	app.Get("/ws/:room_id", h.InitializeWS, websocket.New(h.HandleWS))

	return app.Listen(address)
}
