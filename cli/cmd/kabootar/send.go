package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/mdp/qrterminal/v3"

	"github.com/meghrathod/kabootar/cli/internal/api"
	"github.com/meghrathod/kabootar/cli/internal/protocol"
	"github.com/meghrathod/kabootar/cli/internal/rtc"
	"github.com/meghrathod/kabootar/cli/internal/session"
	"github.com/meghrathod/kabootar/cli/internal/transfer"
	"github.com/meghrathod/kabootar/cli/internal/ui"
)

func cmdSend(ctx context.Context, args []string, stderr io.Writer) int {
	fl := newFlagSet("send", stderr)
	var texts multiFlag
	fl.Var(&texts, "text", "")
	fl.Var(&texts, "t", "")
	once := fl.Bool("once", false, "")
	noNearby := fl.Bool("no-nearby", false, "")
	noQR := fl.Bool("no-qr", false, "")
	noArt := fl.Bool("no-art", false, "")
	server := fl.String("server", defaultServer(), "")
	paths, err := parse(fl, args)
	if err != nil {
		return 2
	}

	items, err := collectItems(paths, texts)
	if err != nil {
		fmt.Fprintf(stderr, "kabootar: %v\n", err)
		return 1
	}
	if len(items) == 0 {
		fmt.Fprintln(stderr, "kabootar: nothing to send. Usage: kabootar send <file or folder>... [--text TEXT]")
		return 2
	}

	t := newTerm(stderr, !*noArt)
	defer t.Close()
	var ip4, ip6 string
	if !*noNearby {
		ip4, ip6 = rtc.PublicAddresses(2 * time.Second)
	}

	client := api.New(*server, userAgent())
	st := newSendState(t, items)
	s, err := session.StartSender(ctx, items, session.SenderOptions{
		API:          client,
		UserAgent:    userAgent(),
		Discoverable: !*noNearby,
		IP4:          ip4,
		IP6:          ip6,
		OnEvent:      st.onEvent,
	})
	if err != nil {
		fmt.Fprintf(stderr, "kabootar: %s\n", errMessage(err))
		return 1
	}
	st.printHeader(s, !*noQR && isTerminal(stderr))

	select {
	case <-ctx.Done():
		st.setNote("Stopped sharing.")
		s.End()
		return 130
	case <-s.Done():
		if st.failed != "" {
			return 1
		}
		st.setNote("The share has ended.")
		return 0
	case <-st.onceDone(*once):
		// Give the last messages a moment to reach the receiver.
		time.Sleep(time.Second)
		st.setNote("Delivered; stopped sharing.")
		s.End()
		return 0
	}
}

// collectItems turns paths (files or folders) and texts into share items.
func collectItems(paths, texts []string) ([]transfer.ShareItem, error) {
	var items []transfer.ShareItem
	add := func(path, rel string, info fs.FileInfo) {
		typ := mime.TypeByExtension(filepath.Ext(path))
		items = append(items, transfer.ShareItem{
			Path: path,
			Meta: protocol.Item{
				ID:           len(items),
				Kind:         "file",
				Name:         info.Name(),
				Size:         info.Size(),
				Type:         typ,
				LastModified: info.ModTime().UnixMilli(),
				Path:         rel,
			},
		})
	}
	for _, p := range paths {
		abs, err := filepath.Abs(p)
		if err != nil {
			return nil, err
		}
		info, err := os.Stat(abs)
		if err != nil {
			return nil, fmt.Errorf("can't read %s: %w", p, unwrapPathErr(err))
		}
		if !info.IsDir() {
			if !info.Mode().IsRegular() {
				return nil, fmt.Errorf("%s is not a regular file", p)
			}
			add(abs, "", info)
			continue
		}
		// Folder shares keep their structure, rooted at the folder's name,
		// like a browser folder upload ("photos/2024/a.jpg").
		root := filepath.Dir(abs)
		err = filepath.WalkDir(abs, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if !d.Type().IsRegular() {
				return nil
			}
			info, err := d.Info()
			if err != nil {
				return err
			}
			rel, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			add(path, filepath.ToSlash(rel), info)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	for _, txt := range texts {
		if t := protocol.ClampText(txt); t != "" {
			items = append(items, transfer.ShareItem{Meta: protocol.Item{ID: len(items), Kind: "text", Text: t}})
		}
	}
	return items, nil
}

func unwrapPathErr(err error) error {
	if pe, ok := err.(*fs.PathError); ok {
		return pe.Err
	}
	return err
}

type sendState struct {
	t     *ui.Term
	items []transfer.ShareItem

	mu       sync.Mutex
	peers    map[string]*peerRow
	order    []string
	note     string
	ended    string
	failed   string
	complete chan struct{}
	closed   bool
}

// peerRow is one receiver as shown in the live view.
type peerRow struct {
	view  session.PeerView
	meter ui.Meter
	speed float64
}

func newSendState(t *ui.Term, items []transfer.ShareItem) *sendState {
	st := &sendState{t: t, items: items, peers: map[string]*peerRow{}, complete: make(chan struct{})}
	t.SetView(st.view)
	return st
}

// log prints an event line when output isn't redrawn in place; on a
// terminal the live view shows the same thing.
func (st *sendState) log(format string, a ...any) {
	if !st.t.Live() {
		st.t.Printf(format, a...)
	}
}

func (st *sendState) setNote(format string, a ...any) {
	st.mu.Lock()
	st.note = fmt.Sprintf(format, a...)
	st.mu.Unlock()
	st.log(format, a...)
}

func (st *sendState) onceDone(enabled bool) <-chan struct{} {
	if !enabled {
		return nil
	}
	return st.complete
}

func (st *sendState) files() (n int, total int64) {
	for _, it := range st.items {
		if it.Meta.Kind == "file" {
			n++
			total += it.Meta.Size
		}
	}
	return n, total
}

func (st *sendState) item(id int) protocol.Item {
	for _, it := range st.items {
		if it.Meta.ID == id {
			return it.Meta
		}
	}
	return protocol.Item{Name: fmt.Sprintf("item %d", id)}
}

func (st *sendState) name(id int) string {
	it := st.item(id)
	if it.Path != "" {
		return it.Path
	}
	return it.Name
}

func (st *sendState) printHeader(s *session.Sender, qr bool) {
	n, total := st.files()
	texts := len(st.items) - n
	what := fmt.Sprintf("%d file%s (%s)", n, plural(n), ui.Bytes(total))
	if n == 0 {
		what = ""
	}
	if texts > 0 {
		if what != "" {
			what += " + "
		}
		what += fmt.Sprintf("%d text%s", texts, plural(texts))
	}
	pin := s.Created.PIN
	if len(pin) == 6 {
		pin = pin[:3] + " " + pin[3:]
	}
	st.t.Printf("\n%s %s · sharing %s\n", s.Created.Emoji, s.Created.Name, what)
	st.t.Printf("  Code  %s", pin)
	st.t.Printf("  Link  %s\n", s.Link)
	if qr {
		for _, line := range qrLines(s.Link) {
			st.t.Printf("  %s", line)
		}
	}
	st.t.Printf("On the other device: kabootar receive %s   (or open the link in a browser)", s.Created.PIN)
	if s.Created.Hidden {
		st.t.Printf("Note: a VPN or privacy relay hides this network, so the share isn't listed for nearby devices.")
	}
	if !st.t.Live() {
		st.t.Printf("Waiting for receivers… (Ctrl-C to stop sharing)\n")
	}
}

// qrLines renders a QR code with half blocks, two modules per character
// row. The library writes in small pieces, so collect it and split it into
// whole lines before printing.
func qrLines(text string) []string {
	var buf bytes.Buffer
	qrterminal.GenerateWithConfig(text, qrterminal.Config{
		Level:          qrterminal.L,
		Writer:         &buf,
		HalfBlocks:     true,
		BlackChar:      qrterminal.BLACK_BLACK,
		WhiteBlackChar: qrterminal.WHITE_BLACK,
		WhiteChar:      qrterminal.WHITE_WHITE,
		BlackWhiteChar: qrterminal.BLACK_WHITE,
		QuietZone:      1,
	})
	return strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

func (st *sendState) onEvent(e session.SenderEvent) {
	switch e.Type {
	case "peer":
		st.onPeer(e.Peer)
	case "delivered":
		st.onPeer(e.Peer)
		st.log("Receiver %d ✓ %s", e.Peer.N, st.name(e.Item))
		n, _ := st.files()
		if len(e.Peer.Completed) >= n {
			st.log("Receiver %d has everything.", e.Peer.N)
			st.markComplete()
		}
	case "status":
		switch e.Signal {
		case "reconnecting":
			st.setNote("Lost the connection to the server; reconnecting… (transfers in progress continue)")
		case "open":
			st.mu.Lock()
			st.note = ""
			st.mu.Unlock()
		}
	case "error":
		st.mu.Lock()
		st.failed = e.Message
		st.mu.Unlock()
		st.setNote("%s", e.Message)
	}
}

func (st *sendState) markComplete() {
	st.mu.Lock()
	defer st.mu.Unlock()
	if !st.closed {
		st.closed = true
		close(st.complete)
	}
}

func routeText(route, addrs string) string {
	r := rtc.RouteLabel[route]
	if r == "" {
		r = "peer-to-peer"
	}
	if addrs != "" {
		r += " (" + addrs + ")"
	}
	return r
}

func (st *sendState) onPeer(p session.PeerView) {
	st.mu.Lock()
	row := st.peers[p.ID]
	if row == nil {
		row = &peerRow{}
		st.peers[p.ID] = row
		st.order = append(st.order, p.ID)
	}
	prev := row.view.State
	row.view = p
	if p.State != prev && p.State == session.PeerConnected {
		row.meter.Reset(p.BytesDone)
	}
	if p.State == session.PeerConnected && p.HasCur {
		row.speed = row.meter.Sample(p.BytesDone)
	} else if !p.HasCur {
		row.speed = 0
	}
	speed := row.speed
	st.mu.Unlock()

	n, total := st.files()
	if p.State != prev {
		switch p.State {
		case session.PeerConnected:
			st.log("Receiver %d connected · %s", p.N, routeText(p.Route, p.Addrs))
			if n == 0 {
				// Text only: delivered as soon as the receiver has the list.
				st.markComplete()
			}
		case session.PeerReconnecting:
			st.log("Receiver %d: connection interrupted, reconnecting…", p.N)
		case session.PeerFailed:
			st.log("Receiver %d: connection failed", p.N)
		case session.PeerLeft:
			if prev != "" {
				st.log("Receiver %d left", p.N)
			}
		}
	}
	if p.State == session.PeerConnected && p.HasCur {
		frac := 1.0
		if total > 0 {
			frac = float64(p.BytesDone) / float64(total)
		}
		st.t.Progress(frac, speed)
		left := ""
		if speed > 0 {
			left = " · " + ui.Duration(time.Duration(float64(total-p.BytesDone)/speed*float64(time.Second))) + " left"
		}
		st.t.Status(fmt.Sprintf("↑ %s %3.0f%%  %s / %s  %s%s", ui.Bar(p.BytesDone, total, 24),
			pct(p.BytesDone, total), ui.Bytes(p.BytesDone), ui.Bytes(total), ui.Speed(speed), left))
	} else if !st.anyActive() {
		st.t.Status("")
	}
}

func (st *sendState) anyActive() bool {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, r := range st.peers {
		if r.view.State == session.PeerConnected && r.view.HasCur {
			return true
		}
	}
	return false
}

func pct(done, total int64) float64 {
	if total <= 0 {
		return 100
	}
	return float64(done) * 100 / float64(total)
}

// view is the live block: one line per receiver, redrawn in place.
func (st *sendState) view() []string {
	st.mu.Lock()
	defer st.mu.Unlock()
	n, _ := st.files()
	var lines []string
	if len(st.order) == 0 {
		lines = append(lines, "Waiting for receivers… (Ctrl-C to stop sharing)")
	}
	for _, id := range st.order {
		r := st.peers[id]
		p := r.view
		var state string
		switch p.State {
		case session.PeerConnecting:
			state = "connecting…"
		case session.PeerConnected:
			state = routeText(p.Route, p.Addrs)
		case session.PeerReconnecting:
			state = "reconnecting…"
		case session.PeerFailed:
			state = "connection failed"
		case session.PeerLeft:
			state = "left"
		}
		line := fmt.Sprintf("Receiver %d  %s", p.N, state)
		if n > 0 {
			mark := " "
			if len(p.Completed) >= n {
				mark = "✓"
			}
			line = fmt.Sprintf("%s Receiver %d  %d/%d file%s  %s", mark, p.N, len(p.Completed), n, plural(n), state)
		}
		if p.State == session.PeerConnected && p.HasCur {
			line += fmt.Sprintf("  ↑ %s %.0f%%", st.name(p.Current), pct(p.Acked, st.item(p.Current).Size))
		}
		lines = append(lines, line)
	}
	if st.note != "" {
		lines = append(lines, st.note)
	}
	return lines
}
