package ui

import (
	"io"
	"os"

	"golang.org/x/sys/windows"
)

// enableVT turns on ANSI escape handling in the Windows console.
func enableVT(w io.Writer) {
	f, ok := w.(*os.File)
	if !ok {
		return
	}
	h := windows.Handle(f.Fd())
	var mode uint32
	if windows.GetConsoleMode(h, &mode) == nil {
		_ = windows.SetConsoleMode(h, mode|windows.ENABLE_VIRTUAL_TERMINAL_PROCESSING)
	}
}
