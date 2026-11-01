package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/meghrathod/kabootar/cli/internal/api"
	"github.com/meghrathod/kabootar/cli/internal/protocol"
	"github.com/meghrathod/kabootar/cli/internal/rtc"
	"github.com/meghrathod/kabootar/cli/internal/session"
	"github.com/meghrathod/kabootar/cli/internal/transfer"
	"github.com/meghrathod/kabootar/cli/internal/ui"
)

func cmdReceive(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	fl := newFlagSet("receive", stderr)
	out := fl.String("output", ".", "")
	fl.StringVar(out, "o", ".", "")
	force := fl.Bool("force", false, "")
	fl.BoolVar(force, "f", false, "")
	server := fl.String("server", defaultServer(), "")
	noArt := fl.Bool("no-art", false, "")
	pos, err := parse(fl, args)
	if err != nil {
		return 2
	}
	target := strings.Join(pos, "")
	if target == "" {
		fmt.Fprintln(stderr, "kabootar: give a 6-digit code or a share link. Usage: kabootar receive <code or link>")
		return 2
	}
	if err := os.MkdirAll(*out, 0o755); err != nil {
		fmt.Fprintf(stderr, "kabootar: can't use output folder: %v\n", err)
		return 1
	}

	var client *api.Client
	var roomID, key string
	if strings.Contains(target, "://") {
		base, id, k, err := api.ParseLink(target)
		if err != nil {
			fmt.Fprintf(stderr, "kabootar: %v\n", err)
			return 2
		}
		client, roomID, key = api.New(base, userAgent()), id, k
	} else {
		pin := strings.Map(func(r rune) rune {
			if r >= '0' && r <= '9' {
				return r
			}
			return -1
		}, target)
		if !api.ValidPIN(pin) {
			fmt.Fprintf(stderr, "kabootar: %q is not a 6-digit code or a share link\n", target)
			return 2
		}
		client = api.New(*server, userAgent())
		joined, err := client.Join(ctx, pin)
		if err != nil {
			fmt.Fprintf(stderr, "kabootar: %s\n", errMessage(err))
			return 1
		}
		roomID, key = joined.Room.ID, joined.ClientKey
	}

	t := newTerm(stderr, !*noArt)
	defer t.Close()
	rs := &recvState{t: t, stdout: stdout, dir: *out, force: *force, meter: &ui.Meter{}, finished: make(chan struct{})}
	t.Printf("Connecting…")
	r := session.StartReceiver(session.ReceiverOptions{
		API:       client,
		UserAgent: userAgent(),
		RoomID:    roomID,
		Key:       key,
		OnEvent:   rs.onEvent,
	})
	rs.r = r

	select {
	case <-ctx.Done():
		t.Status("")
		t.Printf("Cancelled.")
		r.Leave()
		return 130
	case <-rs.finished:
		r.Leave()
	case <-r.Done():
	}
	t.Status("")
	return rs.exitCode()
}

type recvState struct {
	t      *ui.Term
	stdout io.Writer
	dir    string
	force  bool
	r      *session.Receiver
	meter  *ui.Meter

	mu        sync.Mutex
	items     []protocol.Item
	ended     string
	endMsg    string
	started   time.Time
	total     int64
	finished  chan struct{}
	finishedO sync.Once
	reported  map[int]bool
}

func (rs *recvState) files() []protocol.Item {
	var out []protocol.Item
	for _, it := range rs.items {
		if it.Kind == "file" {
			out = append(out, it)
		}
	}
	return out
}

func displayName(it protocol.Item) string {
	if it.Path != "" {
		return it.Path
	}
	return it.Name
}

func (rs *recvState) onEvent(e session.ReceiverEvent) {
	switch e.Type {
	case "status":
		switch e.Status {
		case session.RecvWaiting:
			rs.t.Printf("Joined %s %s · waiting for the sender…", e.Room.Emoji, e.Room.Name)
		case session.RecvConnected:
			route := rtc.RouteLabel[e.Route]
			if route == "" {
				route = "peer-to-peer"
			}
			rs.t.Printf("Connected · %s", route)
		case session.RecvReconnecting:
			rs.t.Status("")
			rs.t.Printf("Connection interrupted, reconnecting… (the download resumes where it stopped)")
		}
	case "items":
		rs.onItems(e.Items)
	case "item":
		rs.onItem(e.ID, e.State)
	case "ended":
		rs.mu.Lock()
		rs.ended, rs.endMsg = e.Status, e.Message
		rs.mu.Unlock()
		if e.Message != "" && !rs.allDone() {
			rs.t.Status("")
			rs.t.Printf("%s", e.Message)
		}
	}
}

func (rs *recvState) onItems(items []protocol.Item) {
	rs.mu.Lock()
	rs.items = items
	rs.reported = map[int]bool{}
	files := rs.files()
	for _, f := range files {
		rs.total += f.Size
	}
	rs.started = time.Now()
	total := rs.total
	rs.mu.Unlock()

	for _, it := range items {
		if it.Kind == "text" {
			rs.t.Printf("Text:")
			fmt.Fprintln(rs.stdout, it.Text)
		}
	}
	if len(files) == 0 {
		rs.finish()
		return
	}
	rs.t.Printf("Receiving %d file%s (%s) into %s", len(files), plural(len(files)), ui.Bytes(total), rs.dir)
	ids := make([]int, len(files))
	for i, f := range files {
		ids[i] = f.ID
	}
	rs.meter.Reset(0)
	rs.r.Download(ids, rs.dir, rs.force)
}

func (rs *recvState) onItem(id int, st transfer.ItemState) {
	rs.mu.Lock()
	var meta protocol.Item
	for _, it := range rs.items {
		if it.ID == id {
			meta = it
		}
	}
	report := st.Finished() && !rs.reported[id]
	if report {
		rs.reported[id] = true
	}
	rs.mu.Unlock()

	if report {
		rs.t.Status("")
		switch st.Status {
		case transfer.StatusDone:
			check := "unverified"
			if st.Verified {
				check = "verified"
			}
			rs.t.Printf("✓ %s  %s  %s → %s", displayName(meta), ui.Bytes(meta.Size), check, st.SavedAs)
		case transfer.StatusError:
			rs.t.Printf("✗ %s: %s", displayName(meta), st.Error)
		case transfer.StatusCancelled:
			rs.t.Printf("✗ %s: cancelled", displayName(meta))
		}
		if rs.allDone() || rs.allFinished() {
			rs.finish()
		}
		return
	}
	if st.Status == transfer.StatusReceiving {
		received := rs.receivedTotal()
		speed := rs.meter.Sample(received)
		pct := 100.0
		if meta.Size > 0 {
			pct = float64(st.Received) * 100 / float64(meta.Size)
		}
		eta := ""
		rs.mu.Lock()
		left, total := rs.total-received, rs.total
		rs.mu.Unlock()
		frac := 1.0
		if total > 0 {
			frac = float64(received) / float64(total)
		}
		rs.t.Progress(frac, speed)
		if speed > 0 {
			eta = " · " + ui.Duration(time.Duration(float64(left)/speed*float64(time.Second))) + " left"
		}
		rs.t.Status(fmt.Sprintf("↓ %s  %s %3.0f%%  %s%s", displayName(meta), ui.Bar(st.Received, meta.Size, 20), pct, ui.Speed(speed), eta))
	}
}

func (rs *recvState) receivedTotal() int64 {
	var n int64
	for _, f := range rs.filesLocked() {
		st := rs.r.Client.State(f.ID)
		if st.Status == transfer.StatusDone {
			n += f.Size
		} else {
			n += st.Received
		}
	}
	return n
}

func (rs *recvState) filesLocked() []protocol.Item {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	return rs.files()
}

// allDone reports whether every file arrived.
func (rs *recvState) allDone() bool {
	files := rs.filesLocked()
	if rs.r == nil {
		return false
	}
	for _, f := range files {
		if rs.r.Client.State(f.ID).Status != transfer.StatusDone {
			return false
		}
	}
	return true
}

// allFinished reports whether every file reached a final state.
func (rs *recvState) allFinished() bool {
	for _, f := range rs.filesLocked() {
		if !rs.r.Client.State(f.ID).Finished() {
			return false
		}
	}
	return true
}

func (rs *recvState) finish() {
	rs.finishedO.Do(func() {
		rs.mu.Lock()
		files := rs.files()
		elapsed := time.Since(rs.started)
		total := rs.total
		rs.mu.Unlock()
		if len(files) > 0 && rs.allDone() {
			avg := ""
			if elapsed > 0 {
				avg = " · " + ui.Speed(float64(total)/elapsed.Seconds())
			}
			rs.t.Printf("Done: %d file%s, %s in %s%s", len(files), plural(len(files)), ui.Bytes(total), ui.Duration(elapsed), avg)
		}
		close(rs.finished)
	})
}

func (rs *recvState) exitCode() int {
	rs.mu.Lock()
	gotItems := rs.items != nil
	rs.mu.Unlock()
	if gotItems && rs.allDone() {
		return 0
	}
	return 1
}
