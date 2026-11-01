// Package signal is the room websocket (a port of src/lib/signal.ts): it
// authenticates, relays WebRTC signalling, keeps a heartbeat and reconnects
// with backoff.
package signal

import (
	"context"
	"encoding/json"
	"math/rand/v2"
	"net/http"
	"net/url"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/meghrathod/kabootar/cli/internal/api"
)

type Status string

const (
	Connecting   Status = "connecting"
	Open         Status = "open"
	Reconnecting Status = "reconnecting"
	Failed       Status = "failed"
	Closed       Status = "closed"
)

type Welcome struct {
	Role       string          `json:"role"`
	Room       api.RoomInfo    `json:"room"`
	IceServers json.RawMessage `json:"iceServers"`
	PIN        string          `json:"pin"`
	Peers      []string        `json:"peers"`
	PeerID     string          `json:"peerId"`
	Online     *bool           `json:"online"`
}

type Restore struct {
	Name         string `json:"name"`
	Emoji        string `json:"emoji"`
	PIN          string `json:"pin"`
	Discoverable bool   `json:"discoverable"`
	IP           string `json:"ip,omitempty"`
	IP6          string `json:"ip6,omitempty"`
}

type Auth struct {
	Role    string   `json:"role"`
	Key     string   `json:"key"`
	Resume  string   `json:"resume,omitempty"`
	Restore *Restore `json:"restore,omitempty"`
}

// Handlers are called one at a time from the socket's reader goroutine.
type Handlers struct {
	OnStatus  func(Status)
	OnWelcome func(Welcome)
	OnJoin    func(peer string)
	OnLeave   func(peer string)
	OnSignal  func(data json.RawMessage, from string)
	OnMaster  func(online bool)
	OnClosed  func()
	OnError   func(code string, fatal bool)
}

var fatalCodes = map[string]bool{"invalid_key": true, "room_full": true, "bad_request": true}

const (
	heartbeat = 15 * time.Second
	deadAfter = 40 * time.Second
)

type Socket struct {
	url       string
	userAgent string
	auth      func() Auth
	h         Handlers

	mu            sync.Mutex
	conn          *websocket.Conn
	status        Status
	stopped       bool
	everOpened    bool
	notFoundSince time.Time
	stop          chan struct{}
	done          chan struct{}
}

func New(wsBase, roomID, userAgent string, auth func() Auth, h Handlers) *Socket {
	s := &Socket{
		url:       wsBase + "/ws/room/" + url.PathEscape(roomID),
		userAgent: userAgent,
		auth:      auth,
		h:         h,
		status:    Connecting,
		stop:      make(chan struct{}),
		done:      make(chan struct{}),
	}
	go s.loop()
	return s
}

func (s *Socket) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *Socket) setStatus(st Status) {
	s.mu.Lock()
	changed := s.status != st
	s.status = st
	s.mu.Unlock()
	if changed && s.h.OnStatus != nil {
		s.h.OnStatus(st)
	}
}

// Send writes a message if the socket is open and authenticated.
func (s *Socket) Send(msg any) bool {
	s.mu.Lock()
	c := s.conn
	open := s.status == Open
	s.mu.Unlock()
	if c == nil || !open {
		return false
	}
	b, err := json.Marshal(msg)
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return c.Write(ctx, websocket.MessageText, b) == nil
}

// Signal relays a WebRTC payload; the sender must name the receiver.
func (s *Socket) Signal(data any, to string) bool {
	if to != "" {
		return s.Send(map[string]any{"t": "signal", "to": to, "data": data})
	}
	return s.Send(map[string]any{"t": "signal", "data": data})
}

// Close disconnects; with endRoom the sender also ends the share.
func (s *Socket) Close(endRoom bool) {
	if endRoom {
		s.Send(map[string]string{"t": "close"})
	}
	s.mu.Lock()
	already := s.stopped
	s.stopped = true
	c := s.conn
	s.mu.Unlock()
	if !already {
		close(s.stop)
	}
	if c != nil {
		c.Close(websocket.StatusNormalClosure, "")
	}
	s.setStatus(Closed)
}

// Done is closed when the socket has stopped for good.
func (s *Socket) Done() <-chan struct{} { return s.done }

func (s *Socket) isStopped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopped
}

func (s *Socket) loop() {
	defer close(s.done)
	attempt := 0
	for !s.isStopped() {
		opened := s.session()
		if s.isStopped() {
			return
		}
		if opened {
			attempt = 0
		}
		s.setStatus(Reconnecting)
		delay := float64(min(10_000, 500*(1<<attempt))) * (0.75 + rand.Float64()*0.5)
		attempt = min(attempt+1, 6)
		select {
		case <-time.After(time.Duration(delay) * time.Millisecond):
		case <-s.stop:
			return
		}
	}
}

// session runs one connection until it drops; reports whether it got a welcome.
func (s *Socket) session() (welcomed bool) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-s.stop:
			cancel()
		case <-ctx.Done():
		}
	}()

	dialCtx, dialCancel := context.WithTimeout(ctx, 15*time.Second)
	hdr := http.Header{}
	if s.userAgent != "" {
		hdr.Set("User-Agent", s.userAgent)
	}
	c, _, err := websocket.Dial(dialCtx, s.url, &websocket.DialOptions{HTTPHeader: hdr})
	dialCancel()
	if err != nil {
		return false
	}
	c.SetReadLimit(1 << 20)
	defer c.CloseNow()

	s.mu.Lock()
	s.conn = c
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.conn == c {
			s.conn = nil
		}
		s.mu.Unlock()
	}()

	authMsg, _ := json.Marshal(struct {
		T string `json:"t"`
		Auth
	}{"auth", s.auth()})
	if err := c.Write(ctx, websocket.MessageText, authMsg); err != nil {
		return false
	}

	// Application-level heartbeat; the server answers {"t":"pong"}.
	go func() {
		t := time.NewTicker(heartbeat)
		defer t.Stop()
		for {
			select {
			case <-t.C:
				wctx, wcancel := context.WithTimeout(ctx, 5*time.Second)
				_ = c.Write(wctx, websocket.MessageText, []byte(`{"t":"ping"}`))
				wcancel()
			case <-ctx.Done():
				return
			}
		}
	}()

	for {
		rctx, rcancel := context.WithTimeout(ctx, deadAfter)
		_, data, err := c.Read(rctx)
		rcancel()
		if err != nil {
			return welcomed
		}
		var msg map[string]json.RawMessage
		if json.Unmarshal(data, &msg) != nil {
			continue
		}
		if s.handle(msg, data) {
			welcomed = true
		}
		if s.isStopped() {
			return welcomed
		}
	}
}

func str(raw json.RawMessage) string {
	var v string
	_ = json.Unmarshal(raw, &v)
	return v
}

// handle dispatches one message; reports whether it was a welcome.
func (s *Socket) handle(msg map[string]json.RawMessage, data []byte) bool {
	switch str(msg["t"]) {
	case "welcome":
		var w Welcome
		if json.Unmarshal(data, &w) != nil {
			return false
		}
		s.mu.Lock()
		s.everOpened = true
		s.notFoundSince = time.Time{}
		s.mu.Unlock()
		s.setStatus(Open)
		if s.h.OnWelcome != nil {
			s.h.OnWelcome(w)
		}
		return true
	case "join":
		if s.h.OnJoin != nil {
			s.h.OnJoin(str(msg["peer"]))
		}
	case "leave":
		if s.h.OnLeave != nil {
			s.h.OnLeave(str(msg["peer"]))
		}
	case "signal":
		if s.h.OnSignal != nil {
			s.h.OnSignal(msg["data"], str(msg["from"]))
		}
	case "master":
		var online bool
		_ = json.Unmarshal(msg["online"], &online)
		if s.h.OnMaster != nil {
			s.h.OnMaster(online)
		}
	case "closed":
		s.Close(false)
		if s.h.OnClosed != nil {
			s.h.OnClosed()
		}
	case "error":
		code := str(msg["code"])
		fatal := fatalCodes[code]
		if code == "room_not_found" {
			// After a redeploy the sender restores the room when it
			// reconnects; receivers already in the room keep retrying.
			s.mu.Lock()
			if s.notFoundSince.IsZero() {
				s.notFoundSince = time.Now()
			}
			fatal = !s.everOpened || time.Since(s.notFoundSince) > 2*time.Minute
			s.mu.Unlock()
		}
		if fatal {
			s.Close(false)
			s.setStatus(Failed)
		}
		if s.h.OnError != nil {
			s.h.OnError(code, fatal)
		}
	}
	return false
}
