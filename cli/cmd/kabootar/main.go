// Command kabootar shares files peer-to-peer from the terminal, using the
// same server and protocol as the Kabootar web app, so it can send to and
// receive from browsers as well as other terminals.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	ossignal "os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/meghrathod/kabootar/cli/internal/api"
	"github.com/meghrathod/kabootar/cli/internal/ui"
	"github.com/meghrathod/kabootar/cli/internal/update"
)

// Set at build time with -ldflags "-X main.version=…".
var version = "dev"

const usage = `Kabootar: send files peer-to-peer, straight from one device to another.

Usage:
  kabootar send [flags] <file or folder>...   share files and print a code
  kabootar receive [flags] <code or link>     download a share
  kabootar update                             update to the latest release
  kabootar version

Send flags:
  -t, --text TEXT     also share a text snippet (repeatable)
      --once          exit after the first receiver has every file
      --no-nearby     don't list the share for devices on this network
      --no-qr         don't print the QR code
      --no-art        don't draw the flying pigeon

Receive flags:
  -o, --output DIR    save files here (default: current directory)
  -f, --force         overwrite existing files instead of renaming
      --no-art        don't draw the flying pigeon

Common flags:
      --server URL    Kabootar server (default $KABOOTAR_SERVER or ` + api.DefaultServer + `)

Receivers can also open the printed link in any browser. Kabootar mentions
new releases at most once a day (KABOOTAR_NO_UPDATE_CHECK=1 turns that off).
`

func main() {
	ctx, stop := ossignal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], os.Stdout, os.Stderr))
}

func run(ctx context.Context, args []string, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		fmt.Fprint(stderr, usage)
		return 2
	}
	update.Cleanup()
	if args[0] != "update" && args[0] != "demo" {
		if n := notifier(stderr); n != nil {
			n.Start()
			defer n.Finish(1500 * time.Millisecond)
		}
	}
	switch args[0] {
	case "send", "s":
		return cmdSend(ctx, args[1:], stderr)
	case "receive", "recv", "r", "get":
		return cmdReceive(ctx, args[1:], stdout, stderr)
	case "update", "upgrade":
		return cmdUpdate(ctx, args[1:], stderr)
	case "demo":
		return cmdDemo(ctx, stderr)
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "kabootar %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return 0
	case "help", "--help", "-h":
		fmt.Fprint(stdout, usage)
		return 0
	default:
		fmt.Fprintf(stderr, "kabootar: unknown command %q\n\n%s", args[0], usage)
		return 2
	}
}

func userAgent() string {
	return fmt.Sprintf("kabootar-cli/%s (%s/%s)", version, runtime.GOOS, runtime.GOARCH)
}

func defaultServer() string {
	if s := os.Getenv("KABOOTAR_SERVER"); s != "" {
		return s
	}
	return api.DefaultServer
}

// parse parses flags that may appear before, between or after positional
// arguments, which is what people type ("send big.iso --once").
func parse(fs *flag.FlagSet, args []string) ([]string, error) {
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		rest := fs.Args()
		if len(rest) == 0 {
			return pos, nil
		}
		if rest[0] == "--" {
			return append(pos, rest[1:]...), nil
		}
		pos = append(pos, rest[0])
		args = rest[1:]
	}
}

type multiFlag []string

func (m *multiFlag) String() string     { return strings.Join(*m, ", ") }
func (m *multiFlag) Set(v string) error { *m = append(*m, v); return nil }

func isTerminal(w io.Writer) bool {
	f, ok := w.(*os.File)
	return ok && term.IsTerminal(int(f.Fd()))
}

// newTerm sets up terminal output on stderr.
func newTerm(stderr io.Writer, art bool) *ui.Term {
	live := isTerminal(stderr)
	return ui.NewTerm(stderr, live, art, func() (int, int) {
		if f, ok := stderr.(*os.File); ok {
			if c, r, err := term.GetSize(int(f.Fd())); err == nil {
				return c, r
			}
		}
		return 0, 0
	})
}

func newFlagSet(name string, stderr io.Writer) *flag.FlagSet {
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(stderr)
	fs.Usage = func() { fmt.Fprint(stderr, usage) }
	return fs
}

func errMessage(err error) string {
	var e *api.Error
	if errors.As(err, &e) {
		return api.Message(err)
	}
	return err.Error()
}
