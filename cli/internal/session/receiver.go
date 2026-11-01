package session

import (
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
	connectWatchdog = 15 * time.Second
	// A download with no progress for this long gets a fresh connection.
	stallTimeout = 30 * time.Second
	maxRestarts  = 4
)

// ReceiverEvent reports changes to the UI. Type is "status" (Status set),
// "items", "item" (ID and State set), or "ended" (Status "closed" or
// "error", with Message).
type ReceiverEvent struct {
	Type    string
	Status  string
	Message string
	Room    api.RoomInfo
	Route   string
	Items   []protocol.Item
	ID      int
	State   transfer.ItemState
}

type ReceiverOptions struct {
	API       *api.Client
	UserAgent string
	RoomID    string
	Key       string
	OnEvent   func(ReceiverEvent)
}

// Receiver statuses, as in the web app.
const (
	RecvConnecting   = "connecting"
	RecvWaiting      = "waiting"
	RecvConnected    = "connected"
	RecvReconnecting = "reconnecting"
	RecvClosed       = "closed"
	RecvError        = "error"
)

type Receiver struct {
	opts   ReceiverOptions
	Client *transfer.Client
	sig    *signal.Socket

	mu           sync.Mutex
	status       string
	room         api.RoomInfo
	iceServers   []webrtc.ICEServer
	peerID       string
	pc           *webrtc.PeerConnection
	pcLink       string
	ice          *rtc.CandidateQueue
	answerSent   bool
	pendingICE   []webrtc.ICECandidateInit
	senderOnline bool
	restarts     int
	watchdog     *time.Timer
	ended        bool
	done         chan struct{}
	progress     map[int]progressMark
	stop         chan struct{}
}

type progressMark struct {
	received int64
	at       time.Time
}

func StartReceiver(opts ReceiverOptions) *Receiver {
	r := &Receiver{
		opts:         opts,
		status:       RecvConnecting,
		iceServers:   rtc.FallbackICEServers,
		senderOnline: true,
		done:         make(chan struct{}),
		progress:     map[int]progressMark{},
		stop:         make(chan struct{}),
	}
	r.Client = transfer.NewClient(transfer.ClientCallbacks{
		OnItems: func(items []protocol.Item) { r.emit(ReceiverEvent{Type: "items", Items: items}) },
		OnState: func(id int, st transfer.ItemState) { r.emit(ReceiverEvent{Type: "item", ID: id, State: st}) },
	})
	r.sig = signal.New(opts.API.WSBase(), opts.RoomID, opts.UserAgent, r.auth, signal.Handlers{
		OnWelcome: r.onWelcome,
		OnSignal:  r.onSignal,
		OnMaster:  r.onMaster,
		OnClosed:  func() { r.finish(RecvClosed, "The sender stopped sharing.") },
		OnError: func(code string, fatal bool) {
			if fatal {
				r.finish(RecvError, api.Message(&api.Error{Code: code}))
			}
		},
	})
	go r.checkStalls()
	return r
}

func (r *Receiver) auth() signal.Auth {
	r.mu.Lock()
	defer r.mu.Unlock()
	return signal.Auth{Role: "peer", Key: r.opts.Key, Resume: r.peerID}
}

func (r *Receiver) emit(e ReceiverEvent) {
	if r.opts.OnEvent != nil {
		r.opts.OnEvent(e)
	}
}

// Done is closed when the session has ended.
func (r *Receiver) Done() <-chan struct{} { return r.done }

func (r *Receiver) setStatus(status, route string) {
	r.mu.Lock()
	if r.ended || (r.status == status && route == "") {
		r.mu.Unlock()
		return
	}
	r.status = status
	room := r.room
	r.mu.Unlock()
	r.emit(ReceiverEvent{Type: "status", Status: status, Room: room, Route: route})
}

func (r *Receiver) healthy() bool {
	r.mu.Lock()
	pc := r.pc
	r.mu.Unlock()
	return pc != nil && pc.ConnectionState() == webrtc.PeerConnectionStateConnected && r.Client.Connected()
}

func (r *Receiver) onWelcome(w signal.Welcome) {
	servers := rtc.ParseICEServers(w.IceServers)
	if len(servers) == 0 {
		servers = rtc.FallbackICEServers
	}
	r.mu.Lock()
	r.peerID = w.PeerID
	r.iceServers = servers
	r.room = w.Room
	r.senderOnline = w.Online == nil || *w.Online
	r.mu.Unlock()
	if !r.healthy() {
		r.setStatus(RecvWaiting, "")
		r.armWatchdog()
	}
}

func (r *Receiver) onMaster(online bool) {
	r.mu.Lock()
	r.senderOnline = online
	hasPC := r.pc != nil
	r.mu.Unlock()
	// The sender is back; if our connection died meanwhile, ask again with
	// a fresh budget of attempts.
	if online && hasPC && !r.healthy() {
		r.mu.Lock()
		r.restarts = 0
		r.mu.Unlock()
		r.requestRestart()
		r.armWatchdog()
	}
}

func (r *Receiver) onSignal(raw json.RawMessage, _ string) {
	data, ok := rtc.ParseSignal(raw)
	if !ok {
		return
	}
	r.mu.Lock()
	if r.ended {
		r.mu.Unlock()
		return
	}
	switch data.Kind {
	case "offer":
		if data.SDP == nil {
			r.mu.Unlock()
			return
		}
		// An offer from a different sender connection needs a fresh peer
		// connection; the same link means renegotiation (ICE restart).
		if r.pc == nil || data.Link != r.pcLink || isDead(r.pc) {
			if err := r.newConnectionLocked(data.Link); err != nil {
				r.mu.Unlock()
				return
			}
		}
		pc, q := r.pc, r.ice
		r.mu.Unlock()
		if err := pc.SetRemoteDescription(*data.SDP); err != nil {
			return
		}
		q.Flush()
		answer, err := pc.CreateAnswer(nil)
		if err != nil {
			return
		}
		if err := pc.SetLocalDescription(answer); err != nil {
			return
		}
		r.sig.Signal(rtc.Signal{Kind: "answer", SDP: pc.LocalDescription(), Link: data.Link}, "")
		r.mu.Lock()
		var pending []webrtc.ICECandidateInit
		if r.pc == pc {
			r.answerSent = true
			pending = r.pendingICE
			r.pendingICE = nil
		}
		r.mu.Unlock()
		for i := range pending {
			r.sig.Signal(rtc.Signal{Kind: "ice", Candidate: &pending[i]}, "")
		}
	case "ice":
		if r.pc == nil || data.Link != r.pcLink || data.Candidate == nil {
			r.mu.Unlock()
			return
		}
		q := r.ice
		r.mu.Unlock()
		q.Add(*data.Candidate)
	default:
		r.mu.Unlock()
	}
}

func isDead(pc *webrtc.PeerConnection) bool {
	st := pc.ConnectionState()
	return st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed
}

func (r *Receiver) newConnectionLocked(link string) error {
	if old := r.pc; old != nil {
		go old.Close()
	}
	pc, err := rtc.API().NewPeerConnection(webrtc.Configuration{ICEServers: r.iceServers})
	if err != nil {
		return err
	}
	r.pc = pc
	r.pcLink = link
	r.ice = rtc.NewCandidateQueue(pc)
	r.answerSent = false
	r.pendingICE = nil

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		r.mu.Lock()
		if r.pc != pc {
			r.mu.Unlock()
			return
		}
		if !r.answerSent {
			r.pendingICE = append(r.pendingICE, init)
			r.mu.Unlock()
			return
		}
		r.mu.Unlock()
		r.sig.Signal(rtc.Signal{Kind: "ice", Candidate: &init}, "")
	})
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		ch := rtc.DataChannel{DataChannel: dc}
		r.Client.Attach(ch)
		dc.OnMessage(func(m webrtc.DataChannelMessage) { r.Client.HandleMessage(m.Data, m.IsString) })
		dc.OnOpen(func() {
			r.mu.Lock()
			r.restarts = 0
			if r.watchdog != nil {
				r.watchdog.Stop()
			}
			r.mu.Unlock()
			r.setStatus(RecvConnected, rtc.Route(pc))
		})
		dc.OnClose(func() {
			r.Client.Detach(ch)
			r.mu.Lock()
			current := r.pc == pc
			r.mu.Unlock()
			if current {
				r.onConnectionLost()
			}
		})
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		r.mu.Lock()
		current := r.pc == pc
		r.mu.Unlock()
		if !current {
			return
		}
		switch st {
		case webrtc.PeerConnectionStateFailed:
			r.onConnectionLost()
		case webrtc.PeerConnectionStateDisconnected:
			r.setStatus(RecvReconnecting, "")
		case webrtc.PeerConnectionStateConnected:
			if r.Client.Connected() {
				r.setStatus(RecvConnected, rtc.Route(pc))
			}
		}
	})
	return nil
}

// onConnectionLost asks the sender for a fresh connection.
func (r *Receiver) onConnectionLost() {
	r.mu.Lock()
	if r.ended {
		r.mu.Unlock()
		return
	}
	online := r.senderOnline
	r.mu.Unlock()
	r.setStatus(RecvReconnecting, "")
	// If the sender is away, wait for it instead of spending attempts.
	if online {
		r.requestRestart()
	}
	r.armWatchdog()
}

func (r *Receiver) requestRestart() {
	r.mu.Lock()
	if r.restarts >= maxRestarts {
		r.mu.Unlock()
		r.finish(RecvError, "Couldn't establish a connection to the sender. Try a different network, or ask them to keep Kabootar open.")
		return
	}
	r.restarts++
	r.mu.Unlock()
	r.sig.Signal(rtc.Signal{Kind: "restart"}, "")
}

func (r *Receiver) armWatchdog() {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.watchdog != nil {
		r.watchdog.Stop()
	}
	delay := time.Duration(float64(connectWatchdog) * (1 + float64(r.restarts)*0.5))
	r.watchdog = time.AfterFunc(delay, func() {
		r.mu.Lock()
		ended := r.ended
		online := r.senderOnline
		r.mu.Unlock()
		if ended || r.healthy() {
			return
		}
		if online && r.sig.Status() == signal.Open {
			r.requestRestart()
		}
		r.armWatchdog()
	})
}

// checkStalls replaces connections whose download stopped moving.
func (r *Receiver) checkStalls() {
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-r.stop:
			return
		case <-t.C:
		}
		if !r.healthy() {
			continue
		}
		now := time.Now()
		stalled := false
		r.mu.Lock()
		for _, it := range r.Client.Items() {
			st := r.Client.State(it.ID)
			if st.Status != transfer.StatusReceiving {
				delete(r.progress, it.ID)
				continue
			}
			p, ok := r.progress[it.ID]
			if !ok || p.received != st.Received {
				r.progress[it.ID] = progressMark{st.Received, now}
			} else if now.Sub(p.at) > stallTimeout {
				delete(r.progress, it.ID)
				stalled = true
			}
		}
		r.mu.Unlock()
		if stalled {
			// The data channel resumes from the last byte on a new link.
			r.requestRestart()
			r.armWatchdog()
		}
	}
}

// Download queues files to be saved under dir.
func (r *Receiver) Download(ids []int, dir string, force bool) {
	for _, id := range ids {
		r.Client.Download(id, func(meta protocol.Item) (transfer.Sink, error) {
			return transfer.OpenFileSink(dir, meta, force)
		})
	}
}

// Leave ends the session without error.
func (r *Receiver) Leave() { r.finish(RecvClosed, "") }

func (r *Receiver) finish(status, message string) {
	r.mu.Lock()
	if r.ended {
		r.mu.Unlock()
		return
	}
	r.ended = true
	if r.watchdog != nil {
		r.watchdog.Stop()
	}
	pc := r.pc
	r.mu.Unlock()
	close(r.stop)
	r.Client.CancelAll()
	r.sig.Close(false)
	if pc != nil {
		go pc.Close()
	}
	r.emit(ReceiverEvent{Type: "ended", Status: status, Message: message})
	close(r.done)
}
