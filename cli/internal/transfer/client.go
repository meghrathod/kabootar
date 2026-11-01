package transfer

import (
	"crypto/sha256"
	"encoding/hex"
	"hash"
	"slices"
	"sync"

	"github.com/meghrathod/kabootar/cli/internal/protocol"
)

// Sink is where a received file goes. Writes are sequential.
type Sink interface {
	Write(p []byte) error
	// Close finishes the file and returns where it was saved.
	Close() (string, error)
	// Abort discards a partial file.
	Abort() error
}

// Status values match the web app's ItemStatus.
const (
	StatusIdle      = "idle"
	StatusQueued    = "queued"
	StatusReceiving = "receiving"
	StatusVerifying = "verifying"
	StatusDone      = "done"
	StatusError     = "error"
	StatusCancelled = "cancelled"
)

type ItemState struct {
	Status   string
	Received int64
	Verified bool
	Error    string
	// SavedAs is the final path of a finished file.
	SavedAs string
}

// Finished reports whether the item reached a final state.
func (s ItemState) Finished() bool {
	return s.Status == StatusDone || s.Status == StatusError || s.Status == StatusCancelled
}

type ClientCallbacks struct {
	OnItems func(items []protocol.Item)
	OnState func(id int, state ItemState)
}

type queued struct {
	meta protocol.Item
	open func(protocol.Item) (Sink, error)
}

type download struct {
	meta      protocol.Item
	sink      Sink
	hasher    hash.Hash
	received  int64
	lastAck   int64
	accepting bool
	failed    bool
}

// Client receives share items. It survives channel replacement: attach a new
// channel after a reconnect and the active download resumes from the last
// byte received, with the hash state carried over.
type Client struct {
	cb ClientCallbacks

	mu     sync.Mutex
	items  []protocol.Item
	states map[int]ItemState
	ch     Channel
	queue  []queued
	active *download
	// Callbacks run after the lock is released, so they may call back in.
	pending []func()
}

func NewClient(cb ClientCallbacks) *Client {
	return &Client{cb: cb, states: map[int]ItemState{}}
}

func (c *Client) unlock() {
	fns := c.pending
	c.pending = nil
	c.mu.Unlock()
	for _, fn := range fns {
		fn()
	}
}

// Items returns the announced items (empty until the first hello).
func (c *Client) Items() []protocol.Item {
	c.mu.Lock()
	defer c.mu.Unlock()
	return slices.Clone(c.items)
}

func (c *Client) State(id int) ItemState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.states[id]
}

// Connected reports whether a channel is attached and open.
func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.ch != nil && c.ch.Open()
}

// Busy reports whether a download is active or queued.
func (c *Client) Busy() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.active != nil || len(c.queue) > 0
}

// Attach starts using a (new) channel.
func (c *Client) Attach(ch Channel) {
	c.mu.Lock()
	c.detachLocked()
	c.ch = ch
	c.mu.Unlock()
}

// Detach stops using the channel, e.g. when it closes.
func (c *Client) Detach(ch Channel) {
	c.mu.Lock()
	if c.ch == ch {
		c.detachLocked()
	}
	c.mu.Unlock()
}

func (c *Client) detachLocked() {
	c.ch = nil
	if c.active != nil {
		c.active.accepting = false
	}
}

func (c *Client) send(msg []byte) {
	if c.ch != nil && c.ch.Open() {
		_ = c.ch.SendText(string(msg))
	}
}

func (c *Client) setState(id int, patch func(*ItemState)) {
	st := c.states[id]
	if st.Status == "" {
		st.Status = StatusIdle
	}
	patch(&st)
	c.states[id] = st
	if c.cb.OnState != nil {
		c.pending = append(c.pending, func() { c.cb.OnState(id, st) })
	}
}

// Download queues a file; open is called when its turn comes.
func (c *Client) Download(id int, open func(protocol.Item) (Sink, error)) bool {
	c.mu.Lock()
	defer c.unlock()
	idx := slices.IndexFunc(c.items, func(i protocol.Item) bool { return i.ID == id && i.Kind == "file" })
	if idx < 0 {
		return false
	}
	if c.active != nil && c.active.meta.ID == id {
		return true
	}
	if slices.ContainsFunc(c.queue, func(q queued) bool { return q.meta.ID == id }) {
		return true
	}
	c.queue = append(c.queue, queued{meta: c.items[idx], open: open})
	c.setState(id, func(s *ItemState) { *s = ItemState{Status: StatusQueued} })
	c.next()
	return true
}

// Cancel stops a queued or active download.
func (c *Client) Cancel(id int) {
	c.mu.Lock()
	defer c.unlock()
	if i := slices.IndexFunc(c.queue, func(q queued) bool { return q.meta.ID == id }); i >= 0 {
		c.queue = slices.Delete(c.queue, i, i+1)
		c.setState(id, func(s *ItemState) { *s = ItemState{Status: StatusCancelled} })
		return
	}
	if c.active != nil && c.active.meta.ID == id {
		c.send(protocol.Cancel(id))
		c.fail(c.active, "Cancelled", StatusCancelled)
	}
}

// CancelAll stops everything, e.g. when the session ends.
func (c *Client) CancelAll() {
	for _, q := range c.queuedIDs() {
		c.Cancel(q)
	}
}

func (c *Client) queuedIDs() []int {
	c.mu.Lock()
	defer c.mu.Unlock()
	var ids []int
	for _, q := range c.queue {
		ids = append(ids, q.meta.ID)
	}
	if c.active != nil {
		ids = append(ids, c.active.meta.ID)
	}
	return ids
}

// HandleMessage processes a message from the sender. Messages arrive in
// order from one goroutine, and writes happen inline, so a slow disk
// naturally slows the channel down.
func (c *Client) HandleMessage(data []byte, isString bool) {
	c.mu.Lock()
	defer c.unlock()
	if !isString {
		c.onChunk(data)
		return
	}
	msg, ok := protocol.Parse(data)
	if !ok {
		return
	}
	d := c.active
	switch msg.T {
	case "hello":
		c.onHello(msg.Items)
	case "start":
		if d == nil || d.meta.ID != msg.ID {
			return
		}
		if msg.Offset == d.received {
			d.accepting = true
		} else {
			d.accepting = false
			c.send(protocol.Get(d.meta.ID, d.received))
		}
	case "end":
		if d == nil || d.meta.ID != msg.ID {
			return
		}
		c.finish(d, msg.SHA256)
	case "error":
		if d != nil && d.meta.ID == msg.ID {
			m := msg.Message
			if m == "" {
				m = "Sender error"
			}
			c.fail(d, m, StatusError)
		}
	}
}

func (c *Client) onHello(raw []byte) {
	items := protocol.ValidItems(raw)
	if len(c.items) == 0 {
		c.items = items
		for _, it := range items {
			if _, ok := c.states[it.ID]; !ok {
				c.states[it.ID] = ItemState{Status: StatusIdle}
			}
		}
		if c.cb.OnItems != nil {
			list := slices.Clone(items)
			c.pending = append(c.pending, func() { c.cb.OnItems(list) })
		}
	}
	// Reconnected mid-transfer: resume from where we stopped.
	if d := c.active; d != nil && !d.failed {
		d.accepting = false
		c.send(protocol.Get(d.meta.ID, d.received))
	} else {
		c.next()
	}
}

func (c *Client) next() {
	if c.active != nil || len(c.queue) == 0 {
		return
	}
	q := c.queue[0]
	c.queue = c.queue[1:]
	d := &download{meta: q.meta, hasher: sha256.New()}
	c.active = d
	c.setState(q.meta.ID, func(s *ItemState) { *s = ItemState{Status: StatusReceiving} })

	sink, err := q.open(q.meta)
	if err != nil {
		c.fail(d, err.Error(), StatusError)
		return
	}
	d.sink = sink
	c.send(protocol.Get(q.meta.ID, 0))
}

func (c *Client) onChunk(chunk []byte) {
	d := c.active
	if d == nil || !d.accepting || d.failed {
		return
	}
	if d.received+int64(len(chunk)) > d.meta.Size {
		c.fail(d, "Received more data than expected", StatusError)
		return
	}
	// Hash in write order so the hash state always matches the bytes on disk.
	d.hasher.Write(chunk)
	if err := d.sink.Write(chunk); err != nil {
		c.send(protocol.Cancel(d.meta.ID))
		c.fail(d, err.Error(), StatusError)
		return
	}
	d.received += int64(len(chunk))
	if d.received-d.lastAck >= protocol.AckEvery || d.received == d.meta.Size {
		d.lastAck = d.received
		c.send(protocol.Ack(d.meta.ID, d.received))
	}
	received := d.received
	c.setState(d.meta.ID, func(s *ItemState) { s.Received = received })
}

func (c *Client) finish(d *download, expected string) {
	if d.failed || c.active != d {
		return
	}
	if d.received != d.meta.Size {
		// Missed bytes (e.g. a reconnect raced with the end); ask again.
		d.accepting = false
		c.send(protocol.Get(d.meta.ID, d.received))
		return
	}

	c.setState(d.meta.ID, func(s *ItemState) { s.Status = StatusVerifying })
	actual := hex.EncodeToString(d.hasher.Sum(nil))
	verifiable := expected != ""
	if verifiable && actual != expected {
		c.send(protocol.Done(d.meta.ID, false))
		c.fail(d, "Integrity check failed: the file was corrupted in transit", StatusError)
		return
	}

	saved, err := d.sink.Close()
	if err != nil {
		c.send(protocol.Done(d.meta.ID, false))
		c.fail(d, err.Error(), StatusError)
		return
	}
	c.send(protocol.Done(d.meta.ID, true))
	size := d.meta.Size
	c.setState(d.meta.ID, func(s *ItemState) {
		*s = ItemState{Status: StatusDone, Received: size, Verified: verifiable, SavedAs: saved}
	})
	c.active = nil
	c.next()
}

func (c *Client) fail(d *download, msg, status string) {
	if d.failed {
		return
	}
	d.failed = true
	d.accepting = false
	if d.sink != nil {
		_ = d.sink.Abort()
	}
	c.setState(d.meta.ID, func(s *ItemState) {
		s.Status = status
		if status == StatusError {
			s.Error = msg
		}
	})
	if c.active == d {
		c.active = nil
	}
	c.next()
}
