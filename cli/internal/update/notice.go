package update

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// How often to look for a release, and to mention one.
const interval = 24 * time.Hour

type state struct {
	CheckedAt  time.Time `json:"checkedAt"`
	Latest     string    `json:"latest"`
	NotifiedAt time.Time `json:"notifiedAt"`
}

// Notifier reminds about a newer release at most once a day. It reads what
// the last check found, so it never delays a command; when that's over a
// day old it checks again in the background for next time.
type Notifier struct {
	current string
	file    string
	now     func() time.Time
	latest  func(context.Context) (string, error)
	print   func(current, latest string)

	mu    sync.Mutex
	st    state
	shown bool
	done  chan struct{}
}

// Enabled reports whether reminders make sense: a release build, on an
// interactive terminal, not in CI, not turned off.
func Enabled(current string, interactive bool) bool {
	if !interactive || os.Getenv("KABOOTAR_NO_UPDATE_CHECK") != "" || os.Getenv("CI") != "" {
		return false
	}
	_, ok := parse(current)
	return ok
}

// StateFile is where the last check is remembered.
func StateFile() string {
	dir, err := os.UserCacheDir()
	if err != nil {
		return ""
	}
	return filepath.Join(dir, "kabootar", "update.json")
}

// NewNotifier prepares reminders; print shows one. file "" disables
// remembering, which also disables checks.
func NewNotifier(current, file string, print func(current, latest string)) *Notifier {
	n := &Notifier{current: current, file: file, now: time.Now, latest: Latest, print: print}
	n.load()
	return n
}

func (n *Notifier) load() {
	if n.file == "" {
		return
	}
	if b, err := os.ReadFile(n.file); err == nil {
		_ = json.Unmarshal(b, &n.st)
	}
}

func (n *Notifier) save() {
	if n.file == "" {
		return
	}
	b, _ := json.Marshal(n.st)
	if os.MkdirAll(filepath.Dir(n.file), 0o755) == nil {
		_ = os.WriteFile(n.file, b, 0o644)
	}
}

// Start shows a reminder if the last check found a newer release, and
// starts a fresh check if the last one is over a day old.
func (n *Notifier) Start() {
	if n.file == "" {
		return
	}
	n.mu.Lock()
	n.maybeShowLocked()
	stale := n.now().Sub(n.st.CheckedAt) >= interval
	n.mu.Unlock()
	if !stale {
		return
	}
	n.done = make(chan struct{})
	go func() {
		defer close(n.done)
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		tag, err := n.latest(ctx)
		n.mu.Lock()
		defer n.mu.Unlock()
		// Record the attempt even when it fails, so an offline machine
		// doesn't retry on every run.
		n.st.CheckedAt = n.now()
		if err == nil {
			n.st.Latest = tag
		}
		n.save()
	}()
}

// Finish waits briefly for a background check (so quick commands still
// record it) and shows a reminder if it found something new.
func (n *Notifier) Finish(wait time.Duration) {
	if n.done != nil {
		select {
		case <-n.done:
		case <-time.After(wait):
			return
		}
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	n.maybeShowLocked()
}

func (n *Notifier) maybeShowLocked() {
	if n.shown || !Newer(n.current, n.st.Latest) || n.now().Sub(n.st.NotifiedAt) < interval {
		return
	}
	n.shown = true
	n.st.NotifiedAt = n.now()
	n.save()
	n.print(n.current, n.st.Latest)
}
