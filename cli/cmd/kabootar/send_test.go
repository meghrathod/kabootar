package main

import (
	"testing"
	"unicode/utf8"
)

func TestQRLinesAreWholeRows(t *testing.T) {
	lines := qrLines("https://kabootar.meghrathod.dev/AbCdEfGhIjKl#k=cyQiY1mBYgwas_JZg4LJnIKvsk4JsIAy")
	if len(lines) < 10 {
		t.Fatalf("got %d lines, want a square block", len(lines))
	}
	width := utf8.RuneCountInString(lines[0])
	for i, l := range lines {
		if w := utf8.RuneCountInString(l); w != width {
			t.Fatalf("line %d is %d wide, want %d", i, w, width)
		}
	}
	// Half blocks: about two modules per row, so roughly twice as wide as tall.
	if width < len(lines)*3/2 {
		t.Errorf("%d×%d doesn't look like a half-block QR", width, len(lines))
	}
}
