package transfer

import (
	"errors"
	"io"
	"os"
	"slices"
	"sync"
	"time"

	"github.com/meghrathod/kabootar/cli/internal/protocol"
)

// ShareItem is an announced item; Path is the file on disk for file items.
type ShareItem struct {
	Meta protocol.Item
	Path string
}

// ServerEvent reports what a receiver is doing. Type is one of "request",
// "progress", "done" and "failed".
type ServerEvent struct {
	Type    string
	ID      int
	Offset  int64 // request
	Acked   int64 // progress
	OK      bool  // done
	Message string
}

type ServerOptions struct {
	ChunkSize int
	// Hash returns the SHA-256 (hex) of a file; it may be shared between
	// receivers and is awaited only after the last byte is sent.
	Hash    func(item ShareItem) (string, error)
	OnEvent func(ServerEvent)
}

type request struct {
	id     int
	offset int64
}

type activeSend struct {
	id        int
	cancelled bool
}

// Server serves share items to one receiver over one channel. Files are sent
// one at a time, in the order the receiver asks for them.
type Server struct {
	ch    Channel
	items []ShareItem
	opts  ServerOptions

	mu      sync.Mutex
	queue   []request
	active  *activeSend
	running bool
	closed  bool
	sent    int64
	acked   int64
	wake    chan struct{}
}

func NewServer(ch Channel, items []ShareItem, opts ServerOptions) *Server {
	if opts.ChunkSize <= 0 {
		opts.ChunkSize = 64 * protocol.KiB
	}
	return &Server{ch: ch, items: items, opts: opts, wake: make(chan struct{}, 1)}
}

// Start announces the items.
func (s *Server) Start() {
	metas := make([]protocol.Item, len(s.items))
	for i, it := range s.items {
		metas[i] = it.Meta
	}
	_ = s.ch.SendText(string(protocol.Hello(metas)))
}

// Close stops sending; call it when the channel closes.
func (s *Server) Close() {
	s.mu.Lock()
	s.closed = true
	if s.active != nil {
		s.active.cancelled = true
	}
	s.mu.Unlock()
	s.Poke()
}

// Poke wakes a sender waiting for buffer space (bufferedamountlow).
func (s *Server) Poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

func (s *Server) emit(e ServerEvent) {
	if s.opts.OnEvent != nil {
		s.opts.OnEvent(e)
	}
}

// HandleMessage processes a message from the receiver.
func (s *Server) HandleMessage(data []byte, isString bool) {
	if !isString {
		return
	}
	msg, ok := protocol.Parse(data)
	if !ok {
		return
	}
	switch msg.T {
	case "get":
		s.mu.Lock()
		// A new request for the active item (receiver resynced) or any
		// request while busy replaces the current transfer.
		if s.active != nil {
			s.active.cancelled = true
		}
		s.queue = slices.DeleteFunc(s.queue, func(q request) bool { return q.id == msg.ID })
		s.queue = append([]request{{msg.ID, msg.Offset}}, s.queue...)
		start := !s.running && !s.closed
		if start {
			s.running = true
		}
		s.mu.Unlock()
		s.emit(ServerEvent{Type: "request", ID: msg.ID, Offset: msg.Offset})
		s.Poke()
		if start {
			go s.run()
		}
	case "ack":
		s.mu.Lock()
		progressed := s.active != nil && s.active.id == msg.ID && msg.Received > s.acked
		if progressed {
			s.acked = msg.Received
		}
		s.mu.Unlock()
		if progressed {
			s.emit(ServerEvent{Type: "progress", ID: msg.ID, Acked: msg.Received})
			s.Poke()
		}
	case "done":
		s.emit(ServerEvent{Type: "done", ID: msg.ID, OK: msg.OK})
	case "cancel":
		s.mu.Lock()
		if s.active != nil && s.active.id == msg.ID {
			s.active.cancelled = true
		}
		s.queue = slices.DeleteFunc(s.queue, func(q request) bool { return q.id == msg.ID })
		s.mu.Unlock()
		s.Poke()
	}
}

func (s *Server) run() {
	for {
		s.mu.Lock()
		if s.closed || len(s.queue) == 0 {
			s.running = false
			s.mu.Unlock()
			return
		}
		req := s.queue[0]
		s.queue = s.queue[1:]
		active := &activeSend{id: req.id}
		s.active = active
		s.mu.Unlock()
		s.sendFile(active, req.offset)
	}
}

func (s *Server) find(id int) *ShareItem {
	for i := range s.items {
		if s.items[i].Meta.ID == id {
			return &s.items[i]
		}
	}
	return nil
}

func (s *Server) sendFile(active *activeSend, offset int64) {
	id := active.id
	defer func() {
		s.mu.Lock()
		if s.active == active {
			s.active = nil
		}
		s.mu.Unlock()
	}()

	item := s.find(id)
	if item == nil || item.Meta.Kind != "file" || item.Path == "" {
		_ = s.ch.SendText(string(protocol.Error(id, "No such file")))
		return
	}
	size := item.Meta.Size
	pos := max(0, min(offset, size))
	s.mu.Lock()
	s.sent = pos
	s.acked = pos
	s.mu.Unlock()

	fail := func(err error) {
		if s.stopped(active) {
			return
		}
		s.emit(ServerEvent{Type: "failed", ID: id, Message: err.Error()})
		_ = s.ch.SendText(string(protocol.Error(id, "Sender could not read the file")))
	}

	// Start hashing in parallel; it's awaited only at the end.
	type hashResult struct {
		sum string
		err error
	}
	hashed := make(chan hashResult, 1)
	go func() {
		sum, err := s.hash(*item)
		hashed <- hashResult{sum, err}
	}()

	f, err := os.Open(item.Path)
	if err != nil {
		fail(err)
		return
	}
	defer f.Close()
	if _, err := f.Seek(pos, io.SeekStart); err != nil {
		fail(err)
		return
	}

	if err := s.ch.SendText(string(protocol.Start(id, pos))); err != nil {
		return
	}
	chunk := s.opts.ChunkSize
	for pos < size {
		// A fresh buffer per block: the channel may still hold the last one.
		block := make([]byte, min(int64(protocol.ReadBlock), size-pos))
		n, err := io.ReadFull(f, block)
		if err != nil {
			if errors.Is(err, io.ErrUnexpectedEOF) || errors.Is(err, io.EOF) {
				err = errors.New("file changed size while sharing")
			}
			fail(err)
			return
		}
		for i := 0; i < n; i += chunk {
			if !s.capacity(active) {
				return
			}
			end := min(i+chunk, n)
			if err := s.ch.Send(block[i:end]); err != nil {
				return
			}
			s.mu.Lock()
			s.sent += int64(end - i)
			s.mu.Unlock()
		}
		pos += int64(n)
	}

	res := <-hashed
	if s.stopped(active) {
		return
	}
	sum := ""
	if res.err == nil {
		sum = res.sum
	}
	_ = s.ch.SendText(string(protocol.End(id, sum)))
}

func (s *Server) hash(item ShareItem) (string, error) {
	if s.opts.Hash == nil {
		return "", errors.New("no hasher")
	}
	return s.opts.Hash(item)
}

func (s *Server) stopped(a *activeSend) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return a.cancelled || s.closed || !s.ch.Open()
}

// capacity waits until the channel buffer and the receiver window have room.
func (s *Server) capacity(a *activeSend) bool {
	for {
		s.mu.Lock()
		stop := a.cancelled || s.closed
		inFlight := s.sent - s.acked
		s.mu.Unlock()
		if stop || !s.ch.Open() {
			return false
		}
		if s.ch.BufferedAmount() <= protocol.HighWater && inFlight <= protocol.Window {
			return true
		}
		select {
		case <-s.wake:
		// Safety net in case an event is missed.
		case <-time.After(250 * time.Millisecond):
		}
	}
}
