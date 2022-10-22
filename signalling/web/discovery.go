package web

import (
	"github.com/gargakshit/kabootar/signalling/util"
	"github.com/gofiber/fiber/v2"
	"github.com/gofiber/websocket/v2"
)

func (h *handler) ValidateDiscoveryRequest(c *fiber.Ctx) error {
	ip := c.Query("ip")
	if !util.IsIPPublic(ip) {
		return c.SendStatus(400)
	}

	return c.Next()
}

func (h *handler) HandleDiscovery(c *websocket.Conn) {
	ip := c.Query("ip")
	h.registerDiscoveryClient(ip, c)
	defer h.unregisterDiscoveryClient(ip, c)

	for {
		_, _, err := c.ReadMessage()
		if err != nil {
			return
		}
	}
}
