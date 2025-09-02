package web

import (
    "time"

    "github.com/gofiber/fiber/v2"
    "github.com/gofiber/websocket/v2"
)

func (*handler) InitializeWS(c *fiber.Ctx) error {
	if websocket.IsWebSocketUpgrade(c) {
		return c.Next()
	}

	return c.Status(400).SendString("Plain HTTP request sent to WebSocket endpoint")
}

func (h *handler) HandleWS(c *websocket.Conn) {
    roomID := c.Params("room_id")

    key := c.Query("k", "")
    isMaster := c.Query("m", "f") == "t"

    status, clientID := h.joinRoom(roomID, key, isMaster, c)
    if status != "ok" {
        // Emit a terminal error frame before closing so the client can branch UI.
        // Format: ["-2", "<status>"]
        _ = c.WriteJSON([]string{"-2", status})
        _ = c.Close()
        return
    }
    c.WriteJSON([]string{"-1", h.turnURL})

    defer h.leaveRoom(roomID, clientID, isMaster)

    // Keepalive: server-side ping/pong
    const (
        writeWait  = 10 * time.Second
        pongWait   = 45 * time.Second
        pingPeriod = 15 * time.Second // must be less than pongWait
    )

    _ = c.SetReadDeadline(time.Now().Add(pongWait))
    c.SetPongHandler(func(string) error {
        return c.SetReadDeadline(time.Now().Add(pongWait))
    })

    done := make(chan struct{})
    go func() {
        ticker := time.NewTicker(pingPeriod)
        defer ticker.Stop()
        for {
            select {
            case <-ticker.C:
                // Send ping; ignore errors (read loop will exit on failure)
                _ = c.WriteControl(websocket.PingMessage, []byte{}, time.Now().Add(writeWait))
            case <-done:
                return
            }
        }
    }()
    defer close(done)

	for {
        _, payload, err := c.ReadMessage()
        if err != nil {
            return
        }

		err = h.handleMsg(roomID, clientID, payload, isMaster)
		if err != nil {
			return
		}
	}
}
