// Package rtc holds the WebRTC pieces shared by sender and receiver (a port
// of src/lib/rtc.ts) on top of Pion.
package rtc

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"

	"github.com/pion/ice/v4"
	"github.com/pion/logging"
	"github.com/pion/webrtc/v4"
)

// ChannelLabel matches CHANNEL_LABEL in the web app.
const ChannelLabel = "kabootar"

// FallbackICEServers is used until the server sends its own list.
var FallbackICEServers = []webrtc.ICEServer{
	{URLs: []string{"stun:stun.cloudflare.com:3478", "stun:stun.l.google.com:19302"}},
}

// Signal is a payload relayed through the signalling server. Link
// identifies the sender's peer connection, so the receiver can tell a
// brand-new connection from renegotiation of the current one.
type Signal struct {
	Kind      string                     `json:"kind"`
	SDP       *webrtc.SessionDescription `json:"sdp,omitempty"`
	Candidate *webrtc.ICECandidateInit   `json:"candidate,omitempty"`
	Link      string                     `json:"link,omitempty"`
}

// ParseSignal decodes a relayed payload.
func ParseSignal(raw json.RawMessage) (Signal, bool) {
	var s Signal
	if json.Unmarshal(raw, &s) != nil || s.Kind == "" {
		return Signal{}, false
	}
	return s, true
}

// ParseICEServers accepts the browser RTCIceServer shape, where urls may be
// a string or a list, and drops entries Pion can't use.
func ParseICEServers(raw json.RawMessage) []webrtc.ICEServer {
	var list []struct {
		URLs       json.RawMessage `json:"urls"`
		Username   string          `json:"username"`
		Credential string          `json:"credential"`
	}
	if json.Unmarshal(raw, &list) != nil {
		return nil
	}
	var out []webrtc.ICEServer
	for _, s := range list {
		var urls []string
		var one string
		if json.Unmarshal(s.URLs, &one) == nil {
			urls = []string{one}
		} else {
			_ = json.Unmarshal(s.URLs, &urls)
		}
		var ok []string
		for _, u := range urls {
			if _, err := ice.ParseURL(u); err == nil {
				ok = append(ok, u)
			}
		}
		if len(ok) == 0 {
			continue
		}
		srv := webrtc.ICEServer{URLs: ok, Username: s.Username}
		if s.Credential != "" {
			srv.Credential = s.Credential
		}
		out = append(out, srv)
	}
	return out
}

// HasTurn reports whether a relay is configured.
func HasTurn(servers []webrtc.ICEServer) bool {
	for _, s := range servers {
		for _, u := range s.URLs {
			if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
				return true
			}
		}
	}
	return false
}

var (
	apiOnce sync.Once
	api     *webrtc.API
)

// API returns the shared Pion API, tuned for bulk transfer.
func API() *webrtc.API {
	apiOnce.Do(func() {
		var se webrtc.SettingEngine
		// A larger receive window keeps fast, high-latency links busy.
		se.SetSCTPMaxReceiveBufferSize(8 * 1024 * 1024)
		// Resolve the browser's obfuscated ".local" candidates on a LAN.
		se.SetICEMulticastDNSMode(ice.MulticastDNSModeQueryOnly)
		if os.Getenv("KABOOTAR_DEBUG") == "" {
			se.LoggerFactory = quietLogger{}
		}
		api = webrtc.NewAPI(webrtc.WithSettingEngine(se))
	})
	return api
}

type quietLogger struct{}

func (quietLogger) NewLogger(scope string) logging.LeveledLogger {
	l := logging.NewDefaultLeveledLoggerForScope(scope, logging.LogLevelDisabled, io.Discard)
	return l
}

// Route says which path a connection uses: "lan", "direct" or "relay".
func Route(pc *webrtc.PeerConnection) string {
	sctp := pc.SCTP()
	if sctp == nil || sctp.Transport() == nil || sctp.Transport().ICETransport() == nil {
		return ""
	}
	pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		return ""
	}
	l, r := pair.Local.Typ, pair.Remote.Typ
	switch {
	case l == webrtc.ICECandidateTypeRelay || r == webrtc.ICECandidateTypeRelay:
		return "relay"
	case l == webrtc.ICECandidateTypeHost && r == webrtc.ICECandidateTypeHost,
		// The remote is often peer-reflexive (its checks arrived before its
		// candidates); local addresses still mean the same network.
		sameNetwork(pair.Local.Address, pair.Remote.Address):
		return "lan"
	default:
		return "direct"
	}
}

// Addrs describes the selected candidate pair, e.g.
// "192.168.1.5 ↔ 192.168.1.9, host/host udp", to diagnose slow routes.
func Addrs(pc *webrtc.PeerConnection) string {
	sctp := pc.SCTP()
	if sctp == nil || sctp.Transport() == nil || sctp.Transport().ICETransport() == nil {
		return ""
	}
	pair, err := sctp.Transport().ICETransport().GetSelectedCandidatePair()
	if err != nil || pair == nil || pair.Local == nil || pair.Remote == nil {
		return ""
	}
	return fmt.Sprintf("%s ↔ %s, %s/%s %s", pair.Local.Address, pair.Remote.Address,
		pair.Local.Typ, pair.Remote.Typ, pair.Local.Protocol)
}

// sameNetwork reports whether two addresses are on one local network:
// both private, either link-local (only reachable on the same link), or
// two IPv6 addresses in the same /64.
func sameNetwork(a, b string) bool {
	ipA, ipB := net.ParseIP(a), net.ParseIP(b)
	if ipA == nil || ipB == nil {
		return false
	}
	local := func(ip net.IP) bool { return ip.IsPrivate() || ip.IsLoopback() }
	switch {
	case ipA.IsLinkLocalUnicast() || ipB.IsLinkLocalUnicast():
		return true
	case local(ipA) && local(ipB):
		return true
	case ipA.To4() == nil && ipB.To4() == nil:
		mask := net.CIDRMask(64, 128)
		return ipA.Mask(mask).Equal(ipB.Mask(mask))
	}
	return false
}

var RouteLabel = map[string]string{
	"lan":    "direct · same network",
	"direct": "direct · peer-to-peer",
	"relay":  "relayed · encrypted",
}

// CandidateQueue buffers remote ICE candidates until the remote description
// is set.
type CandidateQueue struct {
	mu    sync.Mutex
	pc    *webrtc.PeerConnection
	queue []webrtc.ICECandidateInit
}

func NewCandidateQueue(pc *webrtc.PeerConnection) *CandidateQueue {
	return &CandidateQueue{pc: pc}
}

func (q *CandidateQueue) Add(c webrtc.ICECandidateInit) {
	q.mu.Lock()
	defer q.mu.Unlock()
	if q.pc.RemoteDescription() == nil {
		q.queue = append(q.queue, c)
		return
	}
	_ = q.pc.AddICECandidate(c)
}

func (q *CandidateQueue) Flush() {
	q.mu.Lock()
	defer q.mu.Unlock()
	for _, c := range q.queue {
		_ = q.pc.AddICECandidate(c)
	}
	q.queue = nil
}

// DataChannel adapts a Pion data channel to transfer.Channel.
type DataChannel struct{ *webrtc.DataChannel }

func (d DataChannel) Open() bool { return d.ReadyState() == webrtc.DataChannelStateOpen }
