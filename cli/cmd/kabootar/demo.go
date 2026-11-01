package main

import (
	"context"
	"fmt"
	"io"
	"sync"
	"time"

	"github.com/meghrathod/kabootar/cli/internal/ui"
)

// cmdDemo plays a pretend transfer so the animation can be seen without a
// second device. Not listed in the usage text.
func cmdDemo(ctx context.Context, stderr io.Writer) int {
	t := newTerm(stderr, true)
	defer t.Close()
	if !isTerminal(stderr) {
		fmt.Fprintln(stderr, "kabootar demo needs a terminal")
		return 1
	}
	const total = 3 << 30
	const duration = 12 * time.Second
	start := time.Now()
	tick := time.NewTicker(50 * time.Millisecond)
	defer tick.Stop()
	var mu sync.Mutex
	line := "  ↓ demo.bin  0% of 3.0 GB"
	t.SetView(func() []string {
		mu.Lock()
		defer mu.Unlock()
		return []string{"🕊  Demo · a pretend 3 GB transfer (Ctrl-C to stop)", line}
	})
	for {
		select {
		case <-ctx.Done():
			return 130
		case <-tick.C:
		}
		frac := min(1, time.Since(start).Seconds()/duration.Seconds())
		// Speed ramps up and down so the wingbeat changes.
		speed := float64(total) / duration.Seconds() * (0.3 + 1.4*frac*(1-frac)*2)
		t.Progress(frac, speed)
		t.Status(fmt.Sprintf("↓ %s %3.0f%%  %s", ui.Bar(int64(frac*total), total, 24), frac*100, ui.Speed(speed)))
		mu.Lock()
		line = fmt.Sprintf("  ↓ demo.bin  %.0f%% of 3.0 GB", frac*100)
		if frac >= 1 {
			line = "  ✓ demo.bin  3.0 GB · verified"
		}
		mu.Unlock()
		if frac >= 1 {
			t.Status("")
			return 0
		}
	}
}
