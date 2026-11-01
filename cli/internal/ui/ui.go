// Package ui formats terminal output: sizes, speeds and a single live
// status line that event lines can print above.
package ui

import (
	"fmt"
	"io"
	"math"
	"os"
	"runtime"
	"strings"
	"sync"
	"time"

	"github.com/meghrathod/kabootar/cli/internal/ui/pigeon"
)

var units = []string{"B", "KB", "MB", "GB", "TB"}

// Bytes formats like formatBytes in the web app (binary units).
func Bytes(n int64) string {
	if n <= 0 {
		return "0 B"
	}
	i := min(len(units)-1, int(math.Floor(math.Log(float64(n))/math.Log(1024))))
	v := float64(n) / math.Pow(1024, float64(i))
	if i == 0 || v >= 100 {
		return fmt.Sprintf("%.0f %s", v, units[i])
	}
	return fmt.Sprintf("%.1f %s", v, units[i])
}

func Speed(bps float64) string { return Bytes(int64(bps)) + "/s" }

// Duration formats like formatDuration in the web app.
func Duration(d time.Duration) string {
	s := int(math.Round(d.Seconds()))
	if d < time.Second {
		return "<1s"
	}
	h, m, r := s/3600, (s%3600)/60, s%60
	switch {
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm %02ds", m, r)
	default:
		return fmt.Sprintf("%ds", r)
	}
}

// Meter is an exponentially smoothed throughput meter.
type Meter struct {
	mu        sync.Mutex
	lastBytes int64
	lastTime  time.Time
	speed     float64
}

func (m *Meter) Reset(bytes int64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.lastBytes, m.lastTime, m.speed = bytes, time.Now(), 0
}

// Sample records the running total and returns the smoothed speed.
func (m *Meter) Sample(bytes int64) float64 {
	m.mu.Lock()
	defer m.mu.Unlock()
	now := time.Now()
	if m.lastTime.IsZero() {
		m.lastBytes, m.lastTime = bytes, now
		return 0
	}
	dt := now.Sub(m.lastTime).Seconds()
	if dt < 0.25 {
		return m.speed
	}
	inst := float64(bytes-m.lastBytes) / dt
	if m.speed == 0 {
		m.speed = inst
	} else {
		m.speed = 0.3*inst + 0.7*m.speed
	}
	m.lastBytes, m.lastTime = bytes, now
	return m.speed
}

// Term writes event lines and, on a terminal, keeps a live block below
// them: the flying pigeon (while a transfer runs) and a status line.
type Term struct {
	mu     sync.Mutex
	w      io.Writer
	live   bool
	art    bool
	size   func() (cols, rows int)
	status string
	frac   float64
	speed  float64
	moving bool
	phase  float64
	last   time.Time
	anims  map[int]*pigeon.Animation
	mode   pigeon.Mode
	drawn  int    // lines of the live block currently on screen
	shown  string // what the live block shows, to skip identical redraws
}

// NewTerm starts redrawing the live block when live is set; art adds the
// pigeon. size reports the terminal's columns and rows.
func NewTerm(w io.Writer, live, art bool, size func() (int, int)) *Term {
	t := &Term{w: w, live: live, art: art && live && ColorOK(), size: size, anims: map[int]*pigeon.Animation{}, mode: colorMode()}
	if live {
		enableVT(w)
		go func() {
			for range time.Tick(80 * time.Millisecond) {
				t.mu.Lock()
				t.redraw()
				t.mu.Unlock()
			}
		}()
	}
	return t
}

// ColorOK reports whether the environment allows colour output.
func ColorOK() bool {
	return os.Getenv("NO_COLOR") == "" && os.Getenv("TERM") != "dumb"
}

func colorMode() pigeon.Mode {
	ct := strings.ToLower(os.Getenv("COLORTERM"))
	if strings.Contains(ct, "truecolor") || strings.Contains(ct, "24bit") ||
		os.Getenv("WT_SESSION") != "" || runtime.GOOS == "windows" {
		return pigeon.TrueColor
	}
	return pigeon.Color256
}

// Printf prints an event line above the live block.
func (t *Term) Printf(format string, a ...any) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.clear()
	fmt.Fprintf(t.w, format, a...)
	if !strings.HasSuffix(format, "\n") {
		fmt.Fprintln(t.w)
	}
	t.redraw()
}

// Status sets the status line; "" hides the live block.
func (t *Term) Status(s string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.status = s
	if s == "" {
		t.moving = false
		t.clear()
	}
}

// Progress moves the pigeon: frac of the way there, at speed bytes/s.
func (t *Term) Progress(frac, speed float64) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.frac, t.speed, t.moving = frac, speed, true
}

// Close removes the live block and restores the cursor.
func (t *Term) Close() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.status = ""
	t.clear()
	t.live = false
}

// clear removes the live block, leaving the cursor where it started.
func (t *Term) clear() {
	if !t.live || t.drawn == 0 {
		return
	}
	fmt.Fprint(t.w, "\r"+strings.Repeat("\033[A", t.drawn-1)+"\033[J\033[?25h")
	t.drawn = 0
	t.shown = ""
}

func (t *Term) redraw() {
	if !t.live {
		return
	}
	if t.status == "" {
		t.clear()
		return
	}
	cols, rows := 80, 24
	if t.size != nil {
		if c, r := t.size(); c > 0 && r > 0 {
			cols, rows = c, r
		}
	}
	var lines []string
	if t.art && t.moving {
		lines = t.pigeonLines(cols, rows)
	}
	lines = append(lines, fit(t.status, cols-1))
	content := strings.Join(lines, "\n")
	if t.drawn > 0 && content == t.shown {
		return
	}
	t.shown = content

	// Overwrite in place (no flicker): back to the block's first line,
	// rewrite each line, clear what's left.
	var sb strings.Builder
	if t.drawn > 0 {
		sb.WriteString("\r" + strings.Repeat("\033[A", t.drawn-1))
	} else {
		sb.WriteString("\033[?25l")
	}
	for i, l := range lines {
		if i > 0 {
			sb.WriteString("\n")
		}
		sb.WriteString(l + "\033[0m\033[K")
	}
	sb.WriteString("\033[J")
	fmt.Fprint(t.w, sb.String())
	t.drawn = len(lines)
}

const pigeonFrames = 12

func (t *Term) pigeonLines(cols, rows int) []string {
	size := 0
	switch {
	case rows >= 46 && cols >= 100:
		size = 24
	case rows >= 36 && cols >= 80:
		size = 18
	case rows >= 26 && cols >= 60:
		size = 12
	}
	if size == 0 {
		return nil
	}
	anim := t.anims[size]
	if anim == nil {
		anim = pigeon.NewAnimation(size, pigeonFrames, t.mode)
		t.anims[size] = anim
	}

	// Wingbeats speed up with the transfer, like the web app's logo.
	now := time.Now()
	if !t.last.IsZero() {
		effort := math.Min(1, math.Log10(t.speed/(1<<20)+1)/2)
		period := 0.75 - 0.4*effort
		t.phase += now.Sub(t.last).Seconds() / period
	}
	t.last = now
	frameIdx := int(t.phase*pigeonFrames) % pigeonFrames
	frame := anim.Frames[frameIdx]

	track := min(cols-1, 100)
	offset := int(math.Round(math.Max(0, math.Min(1, t.frac)) * float64(max(0, track-frame.Width))))
	lines := make([]string, len(frame.Rows))
	for i, row := range frame.Rows {
		lines[i] = t.wind(i, len(frame.Rows), offset, frameIdx) + row
	}
	return lines
}

// wind draws speed lines trailing behind the bird on two rows.
func (t *Term) wind(row, rows, width, frame int) string {
	if width == 0 {
		return ""
	}
	streak := -1
	switch row {
	case rows * 38 / 100:
		streak = 0
	case rows * 58 / 100:
		streak = 1
	}
	if streak < 0 || t.speed <= 0 {
		return strings.Repeat(" ", width)
	}
	// A dashed line drifting backwards, brightest next to the bird.
	const pattern = "━━━━━━  ━━━  ━   "
	shift := frame*2 + streak*5
	var sb strings.Builder
	length := min(width, 24-streak*8)
	sb.WriteString(strings.Repeat(" ", width-length))
	for i := range length {
		c := []rune(pattern)[(i+shift)%len([]rune(pattern))]
		fade := float64(i+1) / float64(length)
		sb.WriteString(skyColor(fade, t.mode))
		sb.WriteRune(c)
	}
	sb.WriteString("\033[0m")
	return sb.String()
}

// skyColor is the app's sky blue, faded towards the tail.
func skyColor(fade float64, mode pigeon.Mode) string {
	r, g, b := 56.0, 189.0, 248.0
	k := 0.25 + 0.75*fade
	if mode == pigeon.TrueColor {
		return fmt.Sprintf("\033[38;2;%d;%d;%dm", int(r*k), int(g*k), int(b*k))
	}
	codes := []int{24, 31, 38, 39}
	return fmt.Sprintf("\033[38;5;%dm", codes[min(len(codes)-1, int(fade*float64(len(codes))))])
}

func fit(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:max(0, n-1)]) + "…"
}

// Bar renders a fixed-width progress bar.
func Bar(done, total int64, width int) string {
	frac := 1.0
	if total > 0 {
		frac = math.Min(1, float64(done)/float64(total))
	}
	full := int(frac * float64(width))
	return strings.Repeat("█", full) + strings.Repeat("░", width-full)
}
