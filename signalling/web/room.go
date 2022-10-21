package web

import (
	"github.com/gargakshit/kabootar/signalling/util"
	"github.com/gofiber/websocket/v2"
	"github.com/puzpuzpuz/xsync"
)

type Room struct {
	MKey string
	CKey string

	PIN         string
	DiscoveryIP string
	Name        string
	Emoji       string

	Master  *websocket.Conn
	Clients *xsync.MapOf[*websocket.Conn]
}

func NewRoom() (*Room, error) {
	mKey, err := util.GenerateRandomString(24)
	if err != nil {
		return nil, err
	}

	cKey, err := util.GenerateRandomString(24)
	if err != nil {
		return nil, err
	}

	pin, err := util.GeneratePIN()
	if err != nil {
		return nil, err
	}

	return &Room{
		MKey:    mKey,
		CKey:    cKey,
		PIN:     pin,
		Name:    util.GenerateRandomWord() + " " + util.GenerateRandomWord(),
		Emoji:   util.GenerateRandomEmoji(),
		Master:  nil,
		Clients: xsync.NewMapOf[*websocket.Conn](),
	}, nil
}
