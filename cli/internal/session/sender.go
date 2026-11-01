// Package session runs a share (Sender) or a download (Receiver): the
// signalling socket plus one WebRTC connection per peer. It ports
// src/lib/sender.ts and src/lib/receiver.ts.
package session

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"

	"github.com/meghrathod/kabootar/cli/internal/api"
	"github.com/meghrathod/kabootar/cli/internal/protocol"
	"github.com/meghrathod/kabootar/cli/internal/rtc"
	"github.com/meghrathod/kabootar/cli/internal/signal"
	"github.com/meghrathod/kabootar/cli/internal/transfer"
)

const (
	connectTimeout  = 30 * time.Second
	maxICERestarts  = 3
	disconnectGrace = 3 * time.Second
)

// Peer states, as in the web app.
const (
	PeerConnecting   = "connecting"
	PeerConnected    = "connected"
	PeerReconnecting = "reconnecting"
	PeerFailed       = "failed"
	PeerLeft         = "left"
)

// PeerView is what the sender knows about one receiver.
type PeerView struct {
	ID    string
	N     int // 1-based, in order of arrival
	State string
	Route string
	// Addrs is the local and remote address the connection uses.
	Addrs string
	// Current is the item being sent, with bytes acknowledged.
	Current   int
	HasCur    bool
	Acked     int64
	Completed []int
	BytesDone int64
}

// SenderEvent reports changes to the UI. Type is "status", "peer",
// "delivered" (Item set), "ended" or "error" (Message set).
type SenderEvent struct {
	Type    string
	Peer    PeerView
	Item    int
	Message string
	Signal  signal.Status
}

type SenderOptions struct {
	API          *api.Client
	UserAgent    string
	Discoverable bool
	IP4, IP6     string
	OnEvent      func(SenderEvent)
}

type Sender struct {
	opts    SenderOptions
	Created *api.CreatedRoom
	Items   []transfer.ShareItem
	Link    string

	sig *signal.Socket

	mu         sync.Mutex
	links      map[string]*senderLink
	numbers    map[string]int
	iceServers []webrtc.ICEServer
	ended      bool
	done       chan struct{}

	hashes *hashCache
}

// StartSender creates the room and starts accepting receivers.
func StartSender(ctx context.Context, items []transfer.ShareItem, opts SenderOptions) (*Sender, error) {
	created, err := opts.API.CreateRoom(ctx, opts.Discoverable, opts.IP4, opts.IP6)
	if err != nil {
		return nil, err
	}
	s := &Sender{
		opts:       opts,
		Created:    created,
		Items:      items,
		Link:       opts.API.ShareLink(created.ID, created.ClientKey),
		links:      map[string]*senderLink{},
		numbers:    map[string]int{},
		iceServers: rtc.FallbackICEServers,
		done:       make(chan struct{}),
		hashes:     &hashCache{m: map[int]string{}},
	}
	s.sig = signal.New(opts.API.WSBase(), created.ID, opts.UserAgent, s.auth, signal.Handlers{
		OnStatus:  func(st signal.Status) { s.emit(SenderEvent{Type: "status", Signal: st}) },
		OnWelcome: s.onWelcome,
		OnJoin:    s.peerJoined,
		OnLeave:   s.peerLeft,
		OnSignal:  s.onSignal,
		OnClosed:  func() { s.finish("ended", "") },
		OnError: func(code string, fatal bool) {
			if fatal {
				s.finish("error", api.Message(&api.Error{Code: code}))
			}
		},
	})
	return s, nil
}

func (s *Sender) auth() signal.Auth {
	return signal.Auth{
		Role: "master",
		Key:  s.Created.MasterKey,
		Restore: &signal.Restore{
			Name:         s.Created.Name,
			Emoji:        s.Created.Emoji,
			PIN:          s.Created.PIN,
			Discoverable: s.opts.Discoverable,
			IP:           s.opts.IP4,
			IP6:          s.opts.IP6,
		},
	}
}

func (s *Sender) emit(e SenderEvent) {
	if s.opts.OnEvent != nil {
		s.opts.OnEvent(e)
	}
}

// Done is closed when the share has ended.
func (s *Sender) Done() <-chan struct{} { return s.done }

// Relay reports whether the server offered a TURN relay.
func (s *Sender) Relay() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return rtc.HasTurn(s.iceServers)
}

func (s *Sender) onWelcome(w signal.Welcome) {
	servers := rtc.ParseICEServers(w.IceServers)
	if len(servers) == 0 {
		servers = rtc.FallbackICEServers
	}
	s.mu.Lock()
	s.iceServers = servers
	if w.PIN != "" {
		s.Created.PIN = w.PIN
	}
	s.mu.Unlock()
	for _, p := range w.Peers {
		s.peerJoined(p)
	}
}

// peerJoined handles a receiver (re)connecting to signalling.
func (s *Sender) peerJoined(peer string) {
	s.mu.Lock()
	if l := s.links[peer]; l != nil && l.connected() {
		// Its websocket dropped and came back, but the peer-to-peer
		// connection survived: keep using it.
		l.mu.Lock()
		l.signallingGone = false
		l.mu.Unlock()
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	s.addLink(peer)
}

func (s *Sender) peerLeft(peer string) {
	s.mu.Lock()
	l := s.links[peer]
	if l == nil {
		s.mu.Unlock()
		return
	}
	l.mu.Lock()
	l.signallingGone = true
	l.mu.Unlock()
	// Keep established connections: the receiver's websocket may drop
	// while the peer-to-peer transfer carries on.
	drop := !l.connected()
	s.mu.Unlock()
	if drop {
		l.close(PeerLeft)
	}
}

func (s *Sender) onSignal(raw json.RawMessage, from string) {
	data, ok := rtc.ParseSignal(raw)
	if from == "" || !ok {
		return
	}
	if data.Kind == "restart" {
		s.addLink(from)
		return
	}
	s.mu.Lock()
	l := s.links[from]
	s.mu.Unlock()
	if l != nil {
		l.handleSignal(data)
	}
}

func (s *Sender) addLink(peer string) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	prev := s.links[peer]
	delete(s.links, peer)
	n := s.numbers[peer]
	if n == 0 {
		n = len(s.numbers) + 1
		s.numbers[peer] = n
	}
	servers := s.iceServers
	s.mu.Unlock()

	var history *PeerView
	if prev != nil {
		v := prev.snapshot()
		history = &v
		prev.closeQuiet()
	}
	l, err := newSenderLink(s, peer, n, servers, history)
	if err != nil {
		s.emit(SenderEvent{Type: "error", Message: "Could not create a connection: " + err.Error()})
		return
	}
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		l.closeQuiet()
		return
	}
	s.links[peer] = l
	s.mu.Unlock()
	l.start()
}

// hashCache shares finished file hashes between receivers; each transfer
// hashes the file as it reads it, so it's only read once.
type hashCache struct {
	mu sync.Mutex
	m  map[int]string
}

func (h *hashCache) Get(id int) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	sum, ok := h.m[id]
	return sum, ok
}

func (h *hashCache) Put(id int, sum string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.m[id] = sum
}

// End stops sharing and tells receivers.
func (s *Sender) End() {
	s.sig.Close(true)
	s.finish("ended", "")
}

func (s *Sender) finish(kind, message string) {
	s.mu.Lock()
	if s.ended {
		s.mu.Unlock()
		return
	}
	s.ended = true
	links := s.links
	s.links = map[string]*senderLink{}
	s.mu.Unlock()
	for _, l := range links {
		l.close(PeerLeft)
	}
	s.sig.Close(false)
	s.emit(SenderEvent{Type: kind, Message: message})
	close(s.done)
}

func (s *Sender) fileSize(id int) int64 {
	for _, it := range s.Items {
		if it.Meta.ID == id && it.Meta.Kind == "file" {
			return it.Meta.Size
		}
	}
	return 0
}

// senderLink is one peer connection to one receiver. The sender always
// makes the offer.
type senderLink struct {
	s      *Sender
	pc     *webrtc.PeerConnection
	dc     *webrtc.DataChannel
	ice    *rtc.CandidateQueue
	peer   string
	linkID string

	mu             sync.Mutex
	server         *transfer.Server
	view           PeerView
	restarts       int
	closed         bool
	signallingGone bool
	offerSent      bool
	pendingICE     []webrtc.ICECandidateInit
	disconnect     *time.Timer
	connectTimer   *time.Timer
}

func randomID() string {
	b := make([]byte, 4)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func newSenderLink(s *Sender, peer string, n int, servers []webrtc.ICEServer, prev *PeerView) (*senderLink, error) {
	pc, err := rtc.API().NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return nil, err
	}
	l := &senderLink{s: s, pc: pc, ice: rtc.NewCandidateQueue(pc), peer: peer, linkID: randomID()}
	// A reconnecting receiver keeps its delivery history.
	l.view = PeerView{ID: peer, N: n, State: PeerConnecting}
	if prev != nil {
		l.view.Completed = prev.Completed
		l.view.BytesDone = prev.BytesDone
	}
	return l, nil
}

func (l *senderLink) start() {
	pc := l.pc
	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		l.mu.Lock()
		// The receiver drops candidates that arrive before the offer.
		if !l.offerSent {
			l.pendingICE = append(l.pendingICE, init)
			l.mu.Unlock()
			return
		}
		l.mu.Unlock()
		l.signal(rtc.Signal{Kind: "ice", Candidate: &init, Link: l.linkID})
	})
	pc.OnICEConnectionStateChange(l.onICEState)
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateConnected {
			l.mu.Lock()
			if l.connectTimer != nil {
				l.connectTimer.Stop()
			}
			l.restarts = 0
			l.mu.Unlock()
			if route := rtc.Route(pc); route != "" {
				addrs := rtc.Addrs(pc)
				l.update(func(v *PeerView) { v.Route, v.Addrs = route, addrs })
			}
		}
	})

	ordered := true
	dc, err := pc.CreateDataChannel(rtc.ChannelLabel, &webrtc.DataChannelInit{Ordered: &ordered})
	if err != nil {
		l.close(PeerFailed)
		return
	}
	l.dc = dc
	dc.OnOpen(l.onOpen)
	dc.OnClose(func() {
		l.mu.Lock()
		srv := l.server
		gone := l.signallingGone
		l.mu.Unlock()
		if srv != nil {
			srv.Close()
		}
		if gone {
			l.close(PeerLeft)
		} else {
			l.close(PeerFailed)
		}
	})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		l.mu.Lock()
		srv := l.server
		l.mu.Unlock()
		if srv != nil {
			srv.HandleMessage(m.Data, m.IsString)
		}
	})
	dc.SetBufferedAmountLowThreshold(protocol.LowWater)
	dc.OnBufferedAmountLow(func() {
		l.mu.Lock()
		srv := l.server
		l.mu.Unlock()
		if srv != nil {
			srv.Poke()
		}
	})

	l.mu.Lock()
	l.connectTimer = time.AfterFunc(connectTimeout, func() {
		if l.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
			l.close(PeerFailed)
		}
	})
	l.mu.Unlock()
	l.s.emit(SenderEvent{Type: "peer", Peer: l.snapshot()})
	l.offer(false)
}

func (l *senderLink) signal(data rtc.Signal) {
	l.s.sig.Signal(data, l.peer)
}

func (l *senderLink) offer(iceRestart bool) {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	var opts *webrtc.OfferOptions
	if iceRestart {
		opts = &webrtc.OfferOptions{ICERestart: true}
	}
	offer, err := l.pc.CreateOffer(opts)
	if err != nil {
		return
	}
	if err := l.pc.SetLocalDescription(offer); err != nil {
		return
	}
	l.signal(rtc.Signal{Kind: "offer", SDP: l.pc.LocalDescription(), Link: l.linkID})
	l.mu.Lock()
	l.offerSent = true
	pending := l.pendingICE
	l.pendingICE = nil
	l.mu.Unlock()
	for i := range pending {
		l.signal(rtc.Signal{Kind: "ice", Candidate: &pending[i], Link: l.linkID})
	}
}

func (l *senderLink) handleSignal(data rtc.Signal) {
	l.mu.Lock()
	closed := l.closed
	l.mu.Unlock()
	if closed {
		return
	}
	switch data.Kind {
	case "answer":
		if data.SDP == nil || l.pc.SignalingState() != webrtc.SignalingStateHaveLocalOffer {
			return
		}
		if err := l.pc.SetRemoteDescription(*data.SDP); err != nil {
			return
		}
		l.ice.Flush()
	case "ice":
		if data.Candidate != nil {
			l.ice.Add(*data.Candidate)
		}
	}
}

func (l *senderLink) onICEState(st webrtc.ICEConnectionState) {
	l.mu.Lock()
	if l.disconnect != nil {
		l.disconnect.Stop()
	}
	l.mu.Unlock()
	switch st {
	case webrtc.ICEConnectionStateConnected, webrtc.ICEConnectionStateCompleted:
		l.update(func(v *PeerView) {
			if v.State == PeerReconnecting {
				v.State = PeerConnected
			}
		})
	case webrtc.ICEConnectionStateDisconnected:
		// Often recovers by itself (e.g. a brief Wi-Fi hiccup); restart if not.
		l.mu.Lock()
		l.disconnect = time.AfterFunc(disconnectGrace, l.restartICE)
		l.mu.Unlock()
	case webrtc.ICEConnectionStateFailed:
		l.restartICE()
	}
}

// restartICE keeps the SCTP association, so transfers continue without loss.
func (l *senderLink) restartICE() {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return
	}
	if l.signallingGone || l.restarts >= maxICERestarts {
		l.mu.Unlock()
		if l.pc.ICEConnectionState() == webrtc.ICEConnectionStateFailed {
			l.close(PeerFailed)
		}
		return
	}
	l.restarts++
	l.mu.Unlock()
	l.update(func(v *PeerView) { v.State = PeerReconnecting })
	if l.pc.SignalingState() == webrtc.SignalingStateStable {
		l.offer(true)
	}
}

func (l *senderLink) onOpen() {
	chunk := protocol.ChunkSize(l.pc.SCTP().GetCapabilities().MaxMessageSize)
	srv := transfer.NewServer(rtc.DataChannel{DataChannel: l.dc}, l.s.Items, transfer.ServerOptions{
		ChunkSize: chunk,
		Hashes:    l.s.hashes,
		OnEvent:   l.onServerEvent,
	})
	l.mu.Lock()
	l.server = srv
	l.mu.Unlock()
	srv.Start()
	l.update(func(v *PeerView) { v.State = PeerConnected })
}

func (l *senderLink) onServerEvent(e transfer.ServerEvent) {
	doneBytes := func(completed []int) int64 {
		var n int64
		for _, id := range completed {
			n += l.s.fileSize(id)
		}
		return n
	}
	switch e.Type {
	case "request":
		l.update(func(v *PeerView) { v.Current, v.HasCur, v.Acked = e.ID, true, e.Offset })
	case "progress":
		l.update(func(v *PeerView) {
			v.Current, v.HasCur, v.Acked = e.ID, true, e.Acked
			v.BytesDone = doneBytes(v.Completed) + e.Acked
		})
	case "done":
		delivered := false
		l.update(func(v *PeerView) {
			if e.OK && !contains(v.Completed, e.ID) {
				v.Completed = append(append([]int{}, v.Completed...), e.ID)
				delivered = true
			}
			v.HasCur = false
			v.BytesDone = doneBytes(v.Completed)
		})
		if delivered {
			l.s.emit(SenderEvent{Type: "delivered", Peer: l.snapshot(), Item: e.ID})
		}
	case "failed":
		l.update(func(v *PeerView) { v.HasCur = false })
	}
}

func contains(list []int, id int) bool {
	for _, x := range list {
		if x == id {
			return true
		}
	}
	return false
}

func (l *senderLink) update(patch func(*PeerView)) {
	l.mu.Lock()
	patch(&l.view)
	v := l.view
	l.mu.Unlock()
	l.s.emit(SenderEvent{Type: "peer", Peer: v})
}

func (l *senderLink) snapshot() PeerView {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.view
}

// connected must be called without l.mu held.
func (l *senderLink) connected() bool {
	return l.pc.ConnectionState() == webrtc.PeerConnectionStateConnected &&
		l.dc != nil && l.dc.ReadyState() == webrtc.DataChannelStateOpen
}

func (l *senderLink) close(state string) {
	if !l.shutdown() {
		return
	}
	l.update(func(v *PeerView) { v.State = state })
}

// closeQuiet replaces a link without reporting it as gone.
func (l *senderLink) closeQuiet() { l.shutdown() }

func (l *senderLink) shutdown() bool {
	l.mu.Lock()
	if l.closed {
		l.mu.Unlock()
		return false
	}
	l.closed = true
	if l.connectTimer != nil {
		l.connectTimer.Stop()
	}
	if l.disconnect != nil {
		l.disconnect.Stop()
	}
	srv := l.server
	l.mu.Unlock()
	if srv != nil {
		srv.Close()
	}
	// Closing can block on the network; never hold up the caller.
	go l.pc.Close()
	return true
}
