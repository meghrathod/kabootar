package ui

import (
	"io"
	"math"
	"testing"
	"time"
)

func TestMeterNeverGoesNegative(t *testing.T) {
	var m Meter
	m.Reset(0)
	m.lastTime = time.Now().Add(-time.Second)
	if s := m.Sample(10 << 20); s <= 0 {
		t.Fatalf("speed %v after progress", s)
	}
	// A resume from an earlier byte makes the total drop.
	m.lastTime = time.Now().Add(-time.Second)
	if s := m.Sample(2 << 20); s != 0 {
		t.Fatalf("speed %v after the total went back, want 0", s)
	}
}

func TestFlapPeriodIsAlwaysSane(t *testing.T) {
	for _, speed := range []float64{-5e9, -1, 0, 1, 1 << 20, 1e12, math.NaN(), math.Inf(1), math.Inf(-1)} {
		p := flapPeriod(speed)
		if math.IsNaN(p) || p < 0.35 || p > 0.75 {
			t.Errorf("flapPeriod(%v) = %v", speed, p)
		}
	}
}

// The pigeon used to panic (index out of range [-8]) when a negative speed
// turned its animation phase into NaN.
func TestPigeonSurvivesBadSpeeds(t *testing.T) {
	term := NewTerm(io.Discard, false, true, func() (int, int) { return 120, 50 })
	term.art, term.moving = true, true
	for _, speed := range []float64{-5e9, math.NaN(), math.Inf(1), 3e7} {
		term.speed = speed
		term.last = time.Now().Add(-time.Second)
		if lines := term.pigeonLines(120, 40); len(lines) == 0 {
			t.Fatalf("no pigeon at speed %v", speed)
		}
	}
	term.phase = math.NaN()
	term.pigeonLines(120, 40)
}
