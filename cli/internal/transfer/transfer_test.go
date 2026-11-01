package transfer

import (
	"bytes"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/meghrathod/kabootar/cli/internal/protocol"
)

const MiB = protocol.MiB

// end is one side of an in-memory, ordered channel. Messages are delivered
// to the other side's handler by one goroutine, like a data channel's read
// loop, and bufferedAmount counts bytes sent but not yet delivered.
type end struct {
	peer     *end
	inbox    chan msg
	buffered atomic.Int64
	open     atomic.Bool
	closed   chan struct{}
	once     sync.Once
	onMsg    func([]byte, bool)
	onClose  func()
	onLow    func()
	// Hooks for fault injection on the sending side.
	corruptAt int64
	sentBin   int64
	dupEnd    bool
}

type msg struct {
	data     []byte
	isString bool
}

func newPair() (*end, *end) {
	a := &end{inbox: make(chan msg, 1<<16), closed: make(chan struct{})}
	b := &end{inbox: make(chan msg, 1<<16), closed: make(chan struct{})}
	a.peer, b.peer = b, a
	a.open.Store(true)
	b.open.Store(true)
	return a, b
}

func (e *end) run() {
	for {
		select {
		case m := <-e.inbox:
			if e.onMsg != nil {
				e.onMsg(m.data, m.isString)
			}
			if !m.isString {
				// The sender's buffer drains as the receiver reads.
				prev := e.peer.buffered.Add(-int64(len(m.data))) + int64(len(m.data))
				if prev > protocol.LowWater && prev-int64(len(m.data)) <= protocol.LowWater && e.peer.onLow != nil {
					e.peer.onLow()
				}
			}
		case <-e.closed:
			if e.onClose != nil {
				e.onClose()
			}
			return
		}
	}
}

func (e *end) deliver(m msg) error {
	if !e.open.Load() {
		return errors.New("closed")
	}
	select {
	case e.peer.inbox <- m:
		return nil
	case <-e.closed:
		return errors.New("closed")
	}
}

func (e *end) Send(data []byte) error {
	cp := bytes.Clone(data)
	if e.corruptAt > 0 && e.sentBin <= e.corruptAt && e.corruptAt < e.sentBin+int64(len(cp)) {
		cp[e.corruptAt-e.sentBin] ^= 0xff
	}
	e.sentBin += int64(len(cp))
	e.buffered.Add(int64(len(cp)))
	return e.deliver(msg{cp, false})
}

func (e *end) SendText(s string) error {
	if err := e.deliver(msg{[]byte(s), true}); err != nil {
		return err
	}
	if e.dupEnd && strings.Contains(s, `"t":"end"`) {
		return e.deliver(msg{[]byte(s), true})
	}
	return nil
}

func (e *end) BufferedAmount() uint64 { return uint64(max(0, e.buffered.Load())) }
func (e *end) Open() bool             { return e.open.Load() }

func (e *end) Close() {
	for _, x := range []*end{e, e.peer} {
		x.open.Store(false)
		x.once.Do(func() { close(x.closed) })
	}
}

type conn struct {
	a, b   *end // a: sender side, b: receiver side
	server *Server
}

// hashes is a HashCache for tests.
type hashes struct {
	mu sync.Mutex
	m  map[int]string
}

func (h *hashes) Get(id int) (string, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	s, ok := h.m[id]
	return s, ok
}

func (h *hashes) Put(id int, sum string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.m == nil {
		h.m = map[int]string{}
	}
	h.m[id] = sum
}

func hexString(b []byte) string {
	const digits = "0123456789abcdef"
	out := make([]byte, len(b)*2)
	for i, c := range b {
		out[i*2], out[i*2+1] = digits[c>>4], digits[c&15]
	}
	return string(out)
}

// connect wires a server for items to the client over a fresh channel.
func connect(items []ShareItem, client *Client, chunk int, setup ...func(a *end)) conn {
	a, b := newPair()
	for _, f := range setup {
		f(a)
	}
	server := NewServer(a, items, ServerOptions{ChunkSize: chunk, Hashes: &hashes{}})
	a.onMsg = server.HandleMessage
	a.onLow = server.Poke
	a.onClose = server.Close
	b.onMsg = client.HandleMessage
	b.onClose = func() { client.Detach(b) }
	client.Attach(b)
	go a.run()
	go b.run()
	server.Start()
	return conn{a, b, server}
}

func randomFile(t *testing.T, dir string, size int, name string) (string, []byte) {
	t.Helper()
	data := make([]byte, size)
	rand.Read(data)
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, data, 0o644); err != nil {
		t.Fatal(err)
	}
	return p, data
}

func share(paths ...string) []ShareItem {
	var items []ShareItem
	for i, p := range paths {
		st, _ := os.Stat(p)
		items = append(items, ShareItem{
			Path: p,
			Meta: protocol.Item{ID: i, Kind: "file", Name: filepath.Base(p), Size: st.Size(), Type: "application/octet-stream", LastModified: st.ModTime().UnixMilli()},
		})
	}
	return items
}

// memSink keeps the bytes in memory and can slow writes down.
type memSink struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	delay   time.Duration
	aborted bool
	closed  bool
}

func (s *memSink) Write(p []byte) error {
	if s.delay > 0 {
		time.Sleep(s.delay)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.buf.Write(p)
	return nil
}
func (s *memSink) Close() (string, error) { s.closed = true; return "mem", nil }
func (s *memSink) Abort() error           { s.aborted = true; return nil }
func (s *memSink) bytes() []byte {
	s.mu.Lock()
	defer s.mu.Unlock()
	return bytes.Clone(s.buf.Bytes())
}

func sinkOf(s Sink) func(protocol.Item) (Sink, error) {
	return func(protocol.Item) (Sink, error) { return s, nil }
}

func waitFor(t *testing.T, what string, timeout time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

func TestMultipleFilesAndText(t *testing.T) {
	dir := t.TempDir()
	p1, d1 := randomFile(t, dir, 3*MiB+17, "a.bin")
	p2, d2 := randomFile(t, dir, 0, "empty.bin")
	p3, d3 := randomFile(t, dir, 1000, "c.bin")
	items := append(share(p1, p2, p3), ShareItem{Meta: protocol.Item{ID: 3, Kind: "text", Text: "hello"}})

	client := NewClient(ClientCallbacks{})
	connect(items, client, 64*1024)
	waitFor(t, "hello", time.Second, func() bool { return len(client.Items()) == 4 })
	if txt := client.Items()[3]; txt.Kind != "text" || txt.Text != "hello" {
		t.Fatalf("text item = %+v", txt)
	}

	sinks := []*memSink{{}, {}, {}}
	for i, s := range sinks {
		client.Download(i, sinkOf(s))
	}
	waitFor(t, "all done", 10*time.Second, func() bool {
		return client.State(0).Status == StatusDone && client.State(1).Status == StatusDone && client.State(2).Status == StatusDone
	})
	for i, want := range [][]byte{d1, d2, d3} {
		if st := client.State(i); !st.Verified {
			t.Errorf("item %d not verified: %+v", i, st)
		}
		if !bytes.Equal(sinks[i].bytes(), want) {
			t.Errorf("item %d content mismatch", i)
		}
	}
	if client.Busy() {
		t.Error("client still busy")
	}
}

func TestResumesAfterChannelDies(t *testing.T) {
	dir := t.TempDir()
	p, data := randomFile(t, dir, 6*MiB, "big.bin")
	items := share(p)
	client := NewClient(ClientCallbacks{})
	sink := &memSink{delay: 200 * time.Microsecond}
	first := connect(items, client, 64*1024)
	waitFor(t, "hello", time.Second, func() bool { return len(client.Items()) == 1 })
	client.Download(0, sinkOf(sink))
	waitFor(t, "partial", 5*time.Second, func() bool { return client.State(0).Received > 1*MiB })

	first.a.Close()
	partial := client.State(0).Received
	if partial >= int64(len(data)) {
		t.Fatalf("finished before the channel died")
	}

	// New connection, as after an ICE failure and a fresh offer.
	connect(items, client, 64*1024)
	waitFor(t, "done", 10*time.Second, func() bool { return client.State(0).Status == StatusDone })
	if !client.State(0).Verified {
		t.Error("not verified")
	}
	if !bytes.Equal(sink.bytes(), data) {
		t.Error("content mismatch after resume")
	}
}

func TestHashIsSharedBetweenReceivers(t *testing.T) {
	dir := t.TempDir()
	p, _ := randomFile(t, dir, 3*MiB, "shared.bin")
	cache := &hashes{}
	connectWith := func(client *Client) {
		a, b := newPair()
		server := NewServer(a, share(p), ServerOptions{ChunkSize: 64 * 1024, Hashes: cache})
		a.onMsg, a.onLow, a.onClose = server.HandleMessage, server.Poke, server.Close
		b.onMsg = client.HandleMessage
		client.Attach(b)
		go a.run()
		go b.run()
		server.Start()
	}

	first := NewClient(ClientCallbacks{})
	connectWith(first)
	waitFor(t, "hello", time.Second, func() bool { return len(first.Items()) == 1 })
	first.Download(0, sinkOf(&memSink{}))
	waitFor(t, "done", 5*time.Second, func() bool { return first.State(0).Status == StatusDone })
	sum, ok := cache.Get(0)
	if !ok || len(sum) != 64 {
		t.Fatalf("hash not cached after the first transfer: %q", sum)
	}

	// The second receiver gets the cached sum: poison it to prove it's used.
	cache.Put(0, strings.Repeat("0", 64))
	second := NewClient(ClientCallbacks{})
	connectWith(second)
	waitFor(t, "hello", time.Second, func() bool { return len(second.Items()) == 1 })
	second.Download(0, sinkOf(&memSink{}))
	waitFor(t, "error", 5*time.Second, func() bool { return second.State(0).Status == StatusError })
}

func TestEndArrivingTwiceFinishesOnce(t *testing.T) {
	dir := t.TempDir()
	p, _ := randomFile(t, dir, 2*MiB, "twice.bin")
	var dones atomic.Int32
	client := NewClient(ClientCallbacks{OnState: func(id int, s ItemState) {
		if s.Status == StatusDone {
			dones.Add(1)
		}
	}})
	connect(share(p), client, 64*1024, func(a *end) { a.dupEnd = true })
	waitFor(t, "hello", time.Second, func() bool { return len(client.Items()) == 1 })
	client.Download(0, sinkOf(&memSink{}))
	waitFor(t, "done", 5*time.Second, func() bool { return client.State(0).Status == StatusDone })
	time.Sleep(50 * time.Millisecond)
	if st := client.State(0); st.Status != StatusDone || !st.Verified || dones.Load() != 1 {
		t.Errorf("state %+v after %d done events", st, dones.Load())
	}
}

func TestDetectsCorruption(t *testing.T) {
	dir := t.TempDir()
	p, _ := randomFile(t, dir, 1*MiB, "c.bin")
	client := NewClient(ClientCallbacks{})
	connect(share(p), client, 64*1024, func(a *end) { a.corruptAt = 500_000 })
	waitFor(t, "hello", time.Second, func() bool { return len(client.Items()) == 1 })
	sink := &memSink{}
	client.Download(0, sinkOf(sink))
	waitFor(t, "error", 5*time.Second, func() bool { return client.State(0).Status == StatusError })
	if !strings.Contains(strings.ToLower(client.State(0).Error), "integrity") {
		t.Errorf("error = %q", client.State(0).Error)
	}
	if !sink.aborted {
		t.Error("sink not aborted")
	}
}

func TestBackpressureOnSlowDisk(t *testing.T) {
	dir := t.TempDir()
	p, data := randomFile(t, dir, 40*MiB, "slow.bin")
	client := NewClient(ClientCallbacks{})
	c := connect(share(p), client, 256*1024)
	waitFor(t, "hello", time.Second, func() bool { return len(client.Items()) == 1 })

	var maxAhead atomic.Int64
	stop := make(chan struct{})
	go func() {
		for {
			select {
			case <-stop:
				return
			default:
				if b := c.a.buffered.Load(); b > maxAhead.Load() {
					maxAhead.Store(b)
				}
				time.Sleep(100 * time.Microsecond)
			}
		}
	}()
	sink := &memSink{delay: 300 * time.Microsecond}
	client.Download(0, sinkOf(sink))
	waitFor(t, "done", 60*time.Second, func() bool { return client.State(0).Status == StatusDone })
	close(stop)
	if got := len(sink.bytes()); got != len(data) {
		t.Fatalf("wrote %d bytes, want %d", got, len(data))
	}
	if limit := int64(protocol.HighWater + 256*1024); maxAhead.Load() > limit {
		t.Errorf("sender ran %d bytes ahead, limit %d", maxAhead.Load(), limit)
	}
}

func TestCancel(t *testing.T) {
	dir := t.TempDir()
	p, _ := randomFile(t, dir, 8*MiB, "x.bin")
	client := NewClient(ClientCallbacks{})
	connect(share(p), client, 64*1024)
	waitFor(t, "hello", time.Second, func() bool { return len(client.Items()) == 1 })
	sink := &memSink{delay: time.Millisecond}
	client.Download(0, sinkOf(sink))
	waitFor(t, "progress", 5*time.Second, func() bool { return client.State(0).Received > 0 })
	client.Cancel(0)
	if st := client.State(0); st.Status != StatusCancelled {
		t.Errorf("status = %s", st.Status)
	}
	if !sink.aborted {
		t.Error("sink not aborted")
	}
	if client.Busy() {
		t.Error("still busy")
	}
}

func TestFileSinkKeepsExistingFilesAndFolders(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.txt"), []byte("old"), 0o644)

	s, err := OpenFileSink(dir, protocol.Item{Name: "a.txt", Size: 3, LastModified: 1_700_000_000_000}, false)
	if err != nil {
		t.Fatal(err)
	}
	s.Write([]byte("new"))
	saved, err := s.Close()
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(saved) != "a (1).txt" {
		t.Errorf("saved as %s", saved)
	}
	if old, _ := os.ReadFile(filepath.Join(dir, "a.txt")); string(old) != "old" {
		t.Error("existing file overwritten")
	}
	if st, _ := os.Stat(saved); st.ModTime().UnixMilli() != 1_700_000_000_000 {
		t.Errorf("mtime = %v", st.ModTime())
	}

	s, _ = OpenFileSink(dir, protocol.Item{Name: "b.txt", Path: "../photos/2024/b.txt"}, false)
	saved, _ = s.Close()
	if want := filepath.Join(dir, "photos", "2024", "b.txt"); saved != want {
		t.Errorf("folder item saved as %s, want %s", saved, want)
	}

	s, _ = OpenFileSink(dir, protocol.Item{Name: "c.txt"}, false)
	s.Write([]byte("partial"))
	s.Abort()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".part") {
			t.Errorf("leftover %s", e.Name())
		}
	}
}
