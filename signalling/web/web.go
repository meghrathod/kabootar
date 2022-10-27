package web

import (
	"github.com/gargakshit/kabootar/signalling/config"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/fiber/v2/middleware/cors"
	"github.com/gofiber/fiber/v2/middleware/recover"
	"github.com/gofiber/websocket/v2"
)

func InitWeb(cfg *config.Config) error {
	app := fiber.New()
	app.Use(recover.New())

	app.Use(cors.New(cors.Config{
		AllowOrigins: cfg.CorsEndpoint,
	}))

	app.Get("/ping", func(c *fiber.Ctx) error {
		return c.SendString("Pong!")
	})

	h := newHandler(cfg)
	err := h.InitTurn()
	if err != nil {
		return err
	}

	app.Post("/room", h.CreateRoom)
	app.Get("/room", h.GetRoom)
	app.Get("/ws/:room_id", h.InitializeWS, websocket.New(h.HandleWS))
	app.Get("/discover", h.ValidateDiscoveryRequest,
		h.InitializeWS, websocket.New(h.HandleDiscovery))

	return app.Listen(cfg.ListenAddress)
}
