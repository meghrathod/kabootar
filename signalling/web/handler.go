package web

import (
	"github.com/gargakshit/kabootar/signalling/util"
	"github.com/gofiber/websocket/v2"
	"github.com/puzpuzpuz/xsync"
)

type handler struct {
	rooms *xsync.MapOf[*Room]
}

func (h *handler) newRoom() (string, *Room, error) {
	roomID, err := util.GenerateRandomString(12)
	if err != nil {
		return "", nil, err
	}

	room, err := NewRoom()
	if err != nil {
		return "", nil, err
	}

	h.rooms.Store(roomID, room)
	return roomID, room, nil
}

func (h *handler) getRoom(id string) (*Room, bool) {
	return h.rooms.Load(id)
}

func (h *handler) joinRoom(
	roomID,
	key string,
	isMaster bool,
	conn *websocket.Conn,
) bool {
	if key == "" {
		return false
	}

	room, exists := h.getRoom(roomID)
	if !exists {
		return false
	}

	if isMaster {
		if room.MKey != key {
			return false
		}

		if room.Master != nil {
			return false
		}

		room.Master = conn
	} else {
		if room.CKey != key {
			return false
		}

		if room.Master != nil {
			return false
		}

		clientID, err := util.GenerateRandomString(8)
		if err != nil {
			return false
		}

		room.Clients.Store(clientID, conn)
	}

	return true
}

func (h *handler) leaveRoom(roomID string, isMaster bool, conn *websocket.Conn) {
}
