package web

import (
	"github.com/gofiber/websocket/v2"
	"github.com/puzpuzpuz/xsync"
)

type handler struct {
	rooms *xsync.MapOf[*Room]
}

func (h *handler) addClient(roomID string, conn *websocket.Conn) {
	room, ok := h.rooms.Load(roomID)
	if !ok {
		room := &Room{Clients: []*websocket.Conn{conn}}
		h.rooms.Store(roomID, room)
	} else {
		room.lock.Lock()
		room.Clients = append(room.Clients, conn)
		room.lock.Unlock()
	}
}

func (h *handler) removeClient(roomID string, conn *websocket.Conn) {
	room, ok := h.rooms.Load(roomID)
	if !ok {
		return
	}

	room.lock.Lock()
	defer room.lock.Unlock()

	for i, c := range room.Clients {
		if conn != c {
			continue
		}

		room.Clients = append(room.Clients[:i], room.Clients[i+1:]...)
	}

	if len(room.Clients) == 0 {
		h.rooms.Delete(roomID)
	}
}

func (h *handler) broadcast(roomID string, conn *websocket.Conn, msg []byte) {
	room, ok := h.rooms.Load(roomID)
	if !ok {
		return
	}

	room.lock.RLock()
	defer room.lock.RUnlock()

	for _, client := range room.Clients {
		if client == conn {
			continue
		}

		client.WriteMessage(1, msg)
	}
}
