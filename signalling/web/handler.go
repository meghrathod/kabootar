package web

import (
	"github.com/gargakshit/kabootar/signalling/util"
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
