//go:build !windows

package ui

import "io"

func enableVT(io.Writer) {}
