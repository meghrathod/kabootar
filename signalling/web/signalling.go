package web

import (
	"log"

	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
)

func (h *handler) InitializeWS(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		return c.Next()
	}

	return c.Status(400).SendString("Plain HTTP request sent to WebSocket endpoint")
}

func (h *handler) HandleWS(c *websocket.Conn) {
	log.Println("Got a connection on room ID", c.Params("room_id"))

	for {
		_, msg, err := c.ReadMessage()
		if err != nil {
			log.Println("Error", err)
			return
		}

		c.WriteMessage(1, msg)
	}
}
