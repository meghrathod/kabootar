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
	rs := newRecvState(t, stdout, isTerminal(stdout), *out, *force)
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
		rs.setNote("Cancelled.")
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
	// sameScreen: stdout is the terminal the live view is drawn on, so
	// text goes above the view instead of straight to stdout.
	sameScreen bool
	dir        string
	force      bool
	r          *session.Receiver
	meter      ui.Meter

	mu        sync.Mutex
	conn      string
	note      string
	items     []protocol.Item
	states    map[int]transfer.ItemState
	speed     float64
	started   time.Time
	total     int64
	summary   string
	finished  chan struct{}
	finishedO sync.Once
}

func newRecvState(t *ui.Term, stdout io.Writer, sameScreen bool, dir string, force bool) *recvState {
	rs := &recvState{t: t, stdout: stdout, sameScreen: sameScreen, dir: dir, force: force,
		conn: "Connecting…", states: map[int]transfer.ItemState{}, finished: make(chan struct{})}
	t.SetView(rs.view)
	rs.log("Connecting…")
	return rs
}

// log prints an event line when output isn't redrawn in place.
func (rs *recvState) log(format string, a ...any) {
	if !rs.t.Live() {
		rs.t.Printf(format, a...)
	}
}

func (rs *recvState) setConn(format string, a ...any) {
	rs.mu.Lock()
	rs.conn = fmt.Sprintf(format, a...)
	rs.mu.Unlock()
	rs.log(format, a...)
}

func (rs *recvState) setNote(format string, a ...any) {
	rs.mu.Lock()
	rs.note = fmt.Sprintf(format, a...)
	rs.mu.Unlock()
	rs.log(format, a...)
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
			rs.setConn("%s %s · waiting for the sender…", e.Room.Emoji, e.Room.Name)
		case session.RecvConnected:
			rs.setConn("%s %s · connected · %s", e.Room.Emoji, e.Room.Name, routeText(e.Route, e.Addrs))
		case session.RecvReconnecting:
			rs.setConn("%s %s · connection interrupted, reconnecting… (resumes where it stopped)", e.Room.Emoji, e.Room.Name)
		}
	case "items":
		rs.onItems(e.Items)
	case "item":
		rs.onItem(e.ID, e.State)
	case "ended":
		if e.Message != "" && !rs.allDone() {
			rs.setNote("%s", e.Message)
		}
	}
}

// printText shows a shared text snippet: on stdout so it can be piped,
// above the live view when that's the same screen.
func (rs *recvState) printText(text string) {
	if rs.sameScreen && rs.t.Live() {
		rs.t.Printf("Text:\n%s", text)
		return
	}
	rs.log("Text:")
	fmt.Fprintln(rs.stdout, text)
}

func (rs *recvState) onItems(items []protocol.Item) {
	rs.mu.Lock()
	rs.items = items
	files := rs.files()
	for _, f := range files {
		rs.total += f.Size
		rs.states[f.ID] = transfer.ItemState{Status: transfer.StatusQueued}
	}
	rs.started = time.Now()
	total := rs.total
	rs.mu.Unlock()

	for _, it := range items {
		if it.Kind == "text" {
			rs.printText(it.Text)
		}
	}
	if len(files) == 0 {
		rs.finish()
		return
	}
	rs.log("Receiving %d file%s (%s) into %s", len(files), plural(len(files)), ui.Bytes(total), rs.dir)
	ids := make([]int, len(files))
	for i, f := range files {
		ids[i] = f.ID
	}
	rs.meter.Reset(0)
	rs.r.Download(ids, rs.dir, rs.force)
}

func (rs *recvState) onItem(id int, st transfer.ItemState) {
	rs.mu.Lock()
	prev := rs.states[id]
	rs.states[id] = st
	var meta protocol.Item
	for _, it := range rs.items {
		if it.ID == id {
			meta = it
		}
	}
	received, total := rs.receivedLocked(), rs.total
	rs.mu.Unlock()

	if st.Finished() && !prev.Finished() {
		switch st.Status {
		case transfer.StatusDone:
			check := "unverified"
			if st.Verified {
				check = "verified"
			}
			rs.log("✓ %s  %s  %s → %s", displayName(meta), ui.Bytes(meta.Size), check, st.SavedAs)
		case transfer.StatusError:
			rs.log("✗ %s: %s", displayName(meta), st.Error)
		case transfer.StatusCancelled:
			rs.log("✗ %s: cancelled", displayName(meta))
		}
		if rs.allFinished() {
			rs.finish()
		}
		return
	}
	if st.Status == transfer.StatusReceiving {
		speed := rs.meter.Sample(received)
		rs.mu.Lock()
		rs.speed = speed
		rs.mu.Unlock()
		frac := 1.0
		if total > 0 {
			frac = float64(received) / float64(total)
		}
		rs.t.Progress(frac, speed)
		left := ""
		if speed > 0 {
			left = " · " + ui.Duration(time.Duration(float64(total-received)/speed*float64(time.Second))) + " left"
		}
		rs.t.Status(fmt.Sprintf("↓ %s %3.0f%%  %s / %s  %s%s", ui.Bar(received, total, 24),
			pct(received, total), ui.Bytes(received), ui.Bytes(total), ui.Speed(speed), left))
	}
}

func (rs *recvState) receivedLocked() int64 {
	var n int64
	for _, f := range rs.files() {
		st := rs.states[f.ID]
		if st.Status == transfer.StatusDone {
			n += f.Size
		} else {
			n += st.Received
		}
	}
	return n
}

// allDone reports whether every file arrived.
func (rs *recvState) allDone() bool {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, f := range rs.files() {
		if rs.states[f.ID].Status != transfer.StatusDone {
			return false
		}
	}
	return rs.items != nil
}

// allFinished reports whether every file reached a final state.
func (rs *recvState) allFinished() bool {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	for _, f := range rs.files() {
		if !rs.states[f.ID].Finished() {
			return false
		}
	}
	return true
}

func (rs *recvState) finish() {
	rs.finishedO.Do(func() {
		done := rs.allDone()
		rs.mu.Lock()
		files := rs.files()
		elapsed := time.Since(rs.started)
		total := rs.total
		if len(files) > 0 && done {
			avg := ""
			if elapsed > 0 {
				avg = " · " + ui.Speed(float64(total)/elapsed.Seconds())
			}
			rs.summary = fmt.Sprintf("Done: %d file%s, %s in %s%s → %s", len(files), plural(len(files)), ui.Bytes(total), ui.Duration(elapsed), avg, rs.dir)
		}
		summary := rs.summary
		rs.mu.Unlock()
		rs.t.Status("")
		if summary != "" {
			rs.log("%s", summary)
		}
		close(rs.finished)
	})
}

func (rs *recvState) exitCode() int {
	if rs.allDone() {
		return 0
	}
	return 1
}

// maxListed bounds the file list in the live view.
const maxListed = 8

// view is the live block, redrawn in place: the connection, the files
// (active and recent first, the rest summarised) and any note.
func (rs *recvState) view() []string {
	rs.mu.Lock()
	defer rs.mu.Unlock()
	lines := []string{rs.conn}
	files := rs.files()
	var active, queued, done, failed []protocol.Item
	for _, f := range files {
		switch st := rs.states[f.ID]; st.Status {
		case transfer.StatusReceiving, transfer.StatusVerifying:
			active = append(active, f)
		case transfer.StatusDone:
			done = append(done, f)
		case transfer.StatusError, transfer.StatusCancelled:
			failed = append(failed, f)
		default:
			queued = append(queued, f)
		}
	}
	row := func(f protocol.Item) string {
		st := rs.states[f.ID]
		switch st.Status {
		case transfer.StatusDone:
			check := ""
			if st.Verified {
				check = " · verified"
			}
			return fmt.Sprintf("  ✓ %s  %s%s", displayName(f), ui.Bytes(f.Size), check)
		case transfer.StatusError:
			return fmt.Sprintf("  ✗ %s  %s", displayName(f), st.Error)
		case transfer.StatusCancelled:
			return fmt.Sprintf("  ✗ %s  cancelled", displayName(f))
		case transfer.StatusReceiving:
			return fmt.Sprintf("  ↓ %s  %.0f%% of %s", displayName(f), pct(st.Received, f.Size), ui.Bytes(f.Size))
		case transfer.StatusVerifying:
			return fmt.Sprintf("  ↓ %s  verifying…", displayName(f))
		}
		return fmt.Sprintf("  · %s  %s", displayName(f), ui.Bytes(f.Size))
	}
	// Failures and the active file always show; then the latest finished
	// files, then what's next; anything else becomes a count.
	var shown []protocol.Item
	shown = append(shown, failed...)
	room := max(0, maxListed-len(shown)-len(active))
	if len(done) > room {
		done = done[len(done)-room:]
	}
	shown = append(shown, done...)
	shown = append(shown, active...)
	room = max(0, maxListed-len(shown))
	moreQueued := 0
	if len(queued) > room {
		moreQueued = len(queued) - room
		queued = queued[:room]
	}
	shown = append(shown, queued...)
	hiddenDone := 0
	for _, f := range files {
		if rs.states[f.ID].Status == transfer.StatusDone {
			hiddenDone++
		}
	}
	hiddenDone -= len(done)
	if hiddenDone > 0 {
		lines = append(lines, fmt.Sprintf("  ✓ %d more received", hiddenDone))
	}
	for _, f := range shown {
		lines = append(lines, row(f))
	}
	if moreQueued > 0 {
		lines = append(lines, fmt.Sprintf("  · %d more to come", moreQueued))
	}
	if rs.note != "" {
		lines = append(lines, rs.note)
	}
	if rs.summary != "" {
		lines = append(lines, rs.summary)
	}
	return lines
}
