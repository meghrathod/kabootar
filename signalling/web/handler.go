package web

import (
	"errors"

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
) (bool, string) {
	if key == "" {
		return false, ""
	}

	room, exists := h.getRoom(roomID)
	if !exists {
		return false, ""
	}

	if isMaster {
		if room.MKey != key {
			return false, ""
		}

		if room.Master != nil {
			return false, ""
		}

		room.Master = conn
	} else {
		if room.CKey != key {
			return false, ""
		}

		if room.Master == nil {
			return false, ""
		}

		clientID, err := util.GenerateRandomString(8)
		if err != nil {
			return false, ""
		}

		msg, err := MarshalSMsg(&ProtoSMJoinedPayload{ClientID: clientID})
		if err != nil {
			return false, ""
		}

		err = room.Master.WriteMessage(1, msg)
		if err != nil {
			return false, ""
		}

		room.Clients.Store(clientID, conn)
		return true, clientID
	}

	return true, ""
}

func (h *handler) leaveRoom(
	roomID,
	clientID string,
	isMaster bool,
) {
	room, exists := h.getRoom(roomID)
	if !exists {
		return
	}

	if isMaster {
		room.Clients.Range(func(_ string, c *websocket.Conn) bool {
			msg, err := MarshalSMsg(&ProtoSCGonePayload{})
			if err != nil {
				return false
			}

			c.WriteMessage(1, msg)
			c.Close()
			return true
		})

		h.rooms.Delete(roomID)
	} else {
		room.Clients.Delete(clientID)

		msg, err := MarshalSMsg(&ProtoSMLeftPayload{ClientID: clientID})
		if err != nil {
			return
		}

		room.Master.WriteMessage(1, msg)
	}
}

func (h *handler) handleMsg(
	roomID,
	clientID string,
	payload []byte,
	isMaster bool,
) error {
	room, exists := h.getRoom(roomID)
	if !exists {
		return errors.New("invalid room")
	}

	msg, err := UnmarshalPMsg(payload, isMaster)
	if err != nil {
		return err
	}

	switch msg := msg.(type) {
	case *ProtoCSMsgPayload:
		m, err := MarshalSMsg(&ProtoSMMsgPayload{Msg: msg.Msg, ClientID: clientID})
		if err != nil {
			return err
		}

		return room.Master.WriteMessage(1, m)

	case *ProtoMSMsgPayload:
		m, err := MarshalSMsg(&ProtoSCMsgPayload{Msg: msg.Msg})
		if err != nil {
			return err
		}

		client, exists := room.Clients.Load(msg.ClientID)
		if !exists {
			return errors.New("client does not exist")
		}

		return client.WriteMessage(1, m)
	default:
		return errors.New("invalid payload")
	}
}
