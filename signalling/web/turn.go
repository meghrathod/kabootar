package web

import (
	"net"
	"strconv"

	"github.com/pion/turn/v2"
)

func (h *handler) InitTurn() error {
	udpListener, err := net.ListenPacket(
		"udp4",
		h.cfg.TurnListenIP+":"+strconv.Itoa(h.cfg.TurnPort),
	)
	if err != nil {
		return err
	}

	s, err := turn.NewServer(turn.ServerConfig{
		Realm:       h.cfg.TurnRealm,
		AuthHandler: h.HandleTurnAuth,
		PacketConnConfigs: []turn.PacketConnConfig{{
			PacketConn: udpListener,
			RelayAddressGenerator: &turn.RelayAddressGeneratorStatic{
				RelayAddress: net.ParseIP(h.cfg.PublicIP),
				Address:      h.cfg.TurnListenIP,
			},
		}},
	})

	h.turnServer = s
	return nil
}

func (h *handler) HandleTurnAuth(username, _ string, _ net.Addr) ([]byte, bool) {
	room, ok := h.rooms.Load(username)
	if !ok {
		return nil, false
	}

	return room.TKey, true
}
