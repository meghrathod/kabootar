package pigeon

import (
	"fmt"
	"os"
	"strings"
	"testing"
)

// KABOOTAR_PREVIEW=1 go test -run Preview -v ./internal/ui/pigeon prints a
// wingbeat as plain text (KABOOTAR_PREVIEW=color for the coloured version).
func TestPreview(t *testing.T) {
	mode := os.Getenv("KABOOTAR_PREVIEW")
	if mode == "" {
		t.Skip("set KABOOTAR_PREVIEW=1 (or =color) to print the frames")
	}
	const rows, n = 24, 2
	for i := range n {
		p := PoseAt(float64(i) / (2 * (n - 1)))
		if mode == "color" {
			for _, r := range Render(p, rows, TrueColor).Rows {
				fmt.Println(r)
			}
			continue
		}
		cs, pw := cells(p, rows)
		for y := range rows {
			line := make([]byte, pw)
			for x := range pw {
				line[x], _ = Glyph(cs[y*pw+x])
			}
			fmt.Println(string(line))
		}
		fmt.Println()
	}
}

func TestRenderFitsWidth(t *testing.T) {
	for _, rows := range []int{12, 18, 24} {
		a := NewAnimation(rows, 4, TrueColor)
		for _, f := range a.Frames {
			if len(f.Rows) != rows {
				t.Fatalf("%d rows, want %d", len(f.Rows), rows)
			}
		}
	}
}

func TestEyeIsDrawnOnEveryFrame(t *testing.T) {
	for _, rows := range []int{12, 18, 24} {
		for i, f := range NewAnimation(rows, 12, TrueColor).Frames {
			eyes := 0
			for _, r := range f.Rows {
				eyes += strings.Count(r, ";48;")
			}
			if eyes == 0 {
				t.Errorf("%d rows, frame %d: no eye", rows, i)
			}
		}
	}
}
