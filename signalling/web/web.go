package web

import (
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/gofiber/websocket/v2"
)

func InitWeb(address, corsEndpoint string) error {
	app := fiber.New()
	app.Use(recover.New())

	app.Use(cors.New(cors.Config{
		AllowOrigins: corsEndpoint,
	}))

	app.Get("/ping", func(c *fiber.Ctx) error {
		return c.SendString("Pong!")
	})

	h := newHandler()

	app.Post("/room", h.CreateRoom)
	app.Get("/room", h.GetRoom)
	app.Get("/ws/:room_id", h.InitializeWS, websocket.New(h.HandleWS))
	app.Get("/discover", h.ValidateDiscoveryRequest,
		h.InitializeWS, websocket.New(h.HandleDiscovery))

	return app.Listen(address)
}
