package web

import (
    "bytes"
    "encoding/json"
    "errors"
    "net"
    "net/http"
    "strconv"
    "strings"
    "sync"
    "time"

    "github.com/gargakshit/kabootar/signalling/config"
    "github.com/gargakshit/kabootar/signalling/util"
    "github.com/gofiber/websocket/v2"
    "github.com/pion/turn/v2"
    "github.com/puzpuzpuz/xsync"
)

type handler struct {
	rooms            *xsync.MapOf[*Room]
	discoverable     *xsync.MapOf[map[*Room]struct{}]
	discoveryClients *xsync.MapOf[map[*websocket.Conn]struct{}]
	cfg              *config.Config
	turnServer       *turn.Server
	turnURL          string
}

var (
	cfTurnCache      interface{}
	cfTurnCacheTime  time.Time
	cfTurnCacheMutex sync.Mutex
)

type cloudflareTurnResponse struct {
	IceServers interface{} `json:"iceServers"`
}

func (h *handler) getExternalTurnCredentials() (interface{}, error) {
	if h.cfg.CloudflareTurnKeyID != "" && h.cfg.CloudflareTurnAPIToken != "" {
		cfTurnCacheMutex.Lock()
		defer cfTurnCacheMutex.Unlock()

		if cfTurnCache != nil && time.Since(cfTurnCacheTime) < 12*time.Hour {
			return cfTurnCache, nil
		}

		url := "https://rtc.live.cloudflare.com/v1/turn/keys/" + h.cfg.CloudflareTurnKeyID + "/credentials/generate"
		req, err := http.NewRequest("POST", url, bytes.NewBuffer([]byte(`{"ttl": 86400}`)))
		if err == nil {
			req.Header.Set("Authorization", "Bearer "+h.cfg.CloudflareTurnAPIToken)
			req.Header.Set("Content-Type", "application/json")

			client := &http.Client{Timeout: 10 * time.Second}
			resp, err := client.Do(req)
			if err == nil {
				defer resp.Body.Close()
				if resp.StatusCode == http.StatusOK {
					var cfResp cloudflareTurnResponse
					if err := json.NewDecoder(resp.Body).Decode(&cfResp); err == nil {
						cfTurnCache = cfResp.IceServers
						cfTurnCacheTime = time.Now()
						return cfTurnCache, nil
					}
				}
			}
		}
	}

	if len(h.cfg.ExternalICEServers) > 0 {
		return h.cfg.ExternalICEServers, nil
	}

	return []map[string]interface{}{
		{
			"urls":       []string{"turn:openrelay.metered.ca:80", "turn:openrelay.metered.ca:443", "turn:openrelay.metered.ca:443?transport=tcp"},
			"username":   "openrelayproject",
			"credential": "openrelayproject",
		},
	}, nil
}

func newHandler(cfg *config.Config) *handler {
    turnHost := cfg.TurnRealm
    // If a port was accidentally provided in TurnRealm, strip it and use cfg.TurnPort
    if strings.Contains(turnHost, ":") {
        if h, _, err := net.SplitHostPort(turnHost); err == nil {
            turnHost = h
        }
    }

    return &handler{
        rooms:            xsync.NewMapOf[*Room](),
        discoverable:     xsync.NewMapOf[map[*Room]struct{}](),
        discoveryClients: xsync.NewMapOf[map[*websocket.Conn]struct{}](),
        cfg:              cfg,
        turnURL:          turnHost + ":" + strconv.Itoa(cfg.TurnPort),
    }
}

func (h *handler) newRoom() (string, *Room, error) {
	roomID, err := util.GenerateRandomString(12)
	if err != nil {
		return "", nil, err
	}

	room, err := NewRoom(roomID, h.cfg.TurnRealm)
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
	room.DiscoveryIP = ip
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

// joinRoom attempts to join a room and returns a status code and optional clientID.
// Status codes:
//   "ok"                - join successful
//   "missing_key"       - missing key query param
//   "room_not_found"    - room does not exist
//   "invalid_key"       - key does not match expected role
//   "master_exists"     - a master is already connected
//   "master_absent"     - client attempted to join before master connected
func (h *handler) joinRoom(
    roomID,
    key string,
    isMaster bool,
    conn *websocket.Conn,
) (string, string) {
    if key == "" {
        return "missing_key", ""
    }

    room, exists := h.getRoom(roomID)
    if !exists {
        return "room_not_found", ""
    }

    if isMaster {
        if room.MKey != key {
            return "invalid_key", ""
        }

        if room.Master != nil {
            return "master_exists", ""
        }

        room.Master = conn
        return "ok", ""
    }

    if room.CKey != key {
        return "invalid_key", ""
    }

    if room.Master == nil {
        return "master_absent", ""
    }

    clientID, err := util.GenerateRandomString(8)
    if err != nil {
        return "invalid_key", ""
    }

    msg, err := MarshalSMsg(&ProtoSMJoinedPayload{ClientID: clientID})
    if err != nil {
        return "invalid_key", ""
    }

    err = room.Master.WriteMessage(1, msg)
    if err != nil {
        return "invalid_key", ""
    }

    room.Clients.Store(clientID, conn)
    return "ok", clientID
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
