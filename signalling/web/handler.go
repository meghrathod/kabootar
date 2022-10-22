package web

import (
	"errors"

	"github.com/gargakshit/kabootar/signalling/util"
	"github.com/gofiber/websocket/v2"
	"github.com/puzpuzpuz/xsync"
)

type handler struct {
	rooms            *xsync.MapOf[*Room]
	discoverable     *xsync.MapOf[map[*Room]struct{}]
	discoveryClients *xsync.MapOf[map[*websocket.Conn]struct{}]
}

func newHandler() *handler {
	return &handler{
		rooms:            xsync.NewMapOf[*Room](),
		discoverable:     xsync.NewMapOf[map[*Room]struct{}](),
		discoveryClients: xsync.NewMapOf[map[*websocket.Conn]struct{}](),
	}
}

func (h *handler) newRoom() (string, *Room, error) {
	roomID, err := util.GenerateRandomString(12)
	if err != nil {
		return "", nil, err
	}

	room, err := NewRoom(roomID)
	if err != nil {
		return "", nil, err
	}

	h.rooms.Store(roomID, room)
	return roomID, room, nil
}

func (h *handler) makeDiscoverable(ip string, room *Room) {
	rooms, ok := h.discoverable.Load(ip)
	if !ok {
		rooms = make(map[*Room]struct{})
		h.discoverable.Store(ip, rooms)
	}

	rooms[room] = struct{}{}
	h.notifyDiscoveryClients(ip, true, room)
}

func (h *handler) registerDiscoveryClient(ip string, conn *websocket.Conn) {
	clients, ok := h.discoveryClients.Load(ip)
	if !ok {
		clients = make(map[*websocket.Conn]struct{})
		h.discoveryClients.Store(ip, clients)
	}

	clients[conn] = struct{}{}

	rooms, ok := h.discoverable.Load(ip)
	if !ok {
		return
	}

	for room := range rooms {
		conn.WriteJSON([]string{"0", room.ID, room.Name, room.Emoji})
	}
}

func (h *handler) unregisterDiscoveryClient(ip string, conn *websocket.Conn) {
	clients, ok := h.discoveryClients.Load(ip)
	if !ok {
		return
	}

	delete(clients, conn)
}

func (h *handler) notifyDiscoveryClients(ip string, added bool, room *Room) {
	clients, ok := h.discoveryClients.Load(ip)
	if !ok {
		return
	}

	var payload []string
	if added {
		payload = []string{"0", room.ID, room.Name, room.Emoji}
	} else {
		payload = []string{"1", room.ID}
	}

	for client := range clients {
		client.WriteJSON(payload)
	}
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

		rooms, ok := h.discoverable.Load(room.DiscoveryIP)
		if ok {
			_, ok := rooms[room]
			if ok {
				delete(rooms, room)
				h.notifyDiscoveryClients(room.DiscoveryIP, false, room)
			}
		}
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
