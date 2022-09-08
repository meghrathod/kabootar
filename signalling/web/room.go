package web

import (
	"sync"

	"github.com/gofiber/websocket/v2"
)

type Room struct {
	lock    sync.RWMutex
	Clients []*websocket.Conn
}
