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
	st := &sendState{t: t, items: items, meters: map[string]*ui.Meter{}, last: map[string]string{}, complete: make(chan struct{})}
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
		t.Status("")
		t.Printf("Stopping the share…")
		s.End()
		return 130
	case <-s.Done():
		t.Status("")
		if st.failed != "" {
			fmt.Fprintf(stderr, "kabootar: %s\n", st.failed)
			return 1
		}
		t.Printf("The share has ended.")
		return 0
	case <-st.onceDone(*once):
		// Give the last messages a moment to reach the receiver.
		time.Sleep(time.Second)
		t.Status("")
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
	meters   map[string]*ui.Meter
	last     map[string]string
	failed   string
	complete chan struct{}
	closed   bool
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

func (st *sendState) name(id int) string {
	for _, it := range st.items {
		if it.Meta.ID == id {
			if it.Meta.Path != "" {
				return it.Meta.Path
			}
			return it.Meta.Name
		}
	}
	return fmt.Sprintf("item %d", id)
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
	st.t.Printf("Waiting for receivers… (Ctrl-C to stop sharing)\n")
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
		st.t.Printf("Receiver %d ✓ %s", e.Peer.N, st.name(e.Item))
		n, _ := st.files()
		if len(e.Peer.Completed) >= n {
			st.t.Status("")
			st.t.Printf("Receiver %d has everything.", e.Peer.N)
			st.markComplete()
		}
	case "status":
		if e.Signal == "reconnecting" {
			st.t.Printf("Lost the connection to the server; reconnecting… (transfers in progress continue)")
		}
	case "error":
		st.mu.Lock()
		st.failed = e.Message
		st.mu.Unlock()
		st.t.Printf("%s", e.Message)
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

func (st *sendState) onPeer(p session.PeerView) {
	st.mu.Lock()
	prev := st.last[p.ID]
	st.last[p.ID] = p.State
	m := st.meters[p.ID]
	if m == nil {
		m = &ui.Meter{}
		st.meters[p.ID] = m
	}
	st.mu.Unlock()

	if p.State != prev {
		switch p.State {
		case session.PeerConnected:
			route := rtc.RouteLabel[p.Route]
			if route == "" {
				route = "peer-to-peer"
			}
			st.t.Printf("Receiver %d connected · %s", p.N, route)
			m.Reset(p.BytesDone)
			n, _ := st.files()
			if n == 0 {
				// Text only: delivered as soon as the receiver has the list.
				st.markComplete()
			}
		case session.PeerReconnecting:
			st.t.Printf("Receiver %d: connection interrupted, reconnecting…", p.N)
		case session.PeerFailed:
			st.t.Status("")
			st.t.Printf("Receiver %d: connection failed", p.N)
		case session.PeerLeft:
			if prev != "" {
				st.t.Status("")
				st.t.Printf("Receiver %d left", p.N)
			}
		}
	}
	if p.State == session.PeerConnected && p.HasCur {
		size := int64(0)
		for _, it := range st.items {
			if it.Meta.ID == p.Current {
				size = it.Meta.Size
			}
		}
		speed := m.Sample(p.BytesDone)
		pct := 100.0
		if size > 0 {
			pct = float64(p.Acked) * 100 / float64(size)
		}
		_, total := st.files()
		frac := 1.0
		if total > 0 {
			frac = float64(p.BytesDone) / float64(total)
		}
		st.t.Progress(frac, speed)
		st.t.Status(fmt.Sprintf("↑ Receiver %d  %s  %s %3.0f%%  %s", p.N, st.name(p.Current), ui.Bar(p.Acked, size, 20), pct, ui.Speed(speed)))
	}
}
