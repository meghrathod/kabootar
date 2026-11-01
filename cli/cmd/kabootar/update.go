package main

import (
	"context"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/meghrathod/kabootar/cli/internal/update"
)

func cmdUpdate(ctx context.Context, args []string, stderr io.Writer) int {
	fl := newFlagSet("update", stderr)
	force := fl.Bool("force", false, "")
	if _, err := parse(fl, args); err != nil {
		return 2
	}

	exe, err := update.Executable()
	if err != nil {
		fmt.Fprintf(stderr, "kabootar: can't find this program's location: %v\n", err)
		return 1
	}
	method := update.Detect(exe)

	lctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	latest, err := update.Latest(lctx)
	cancel()
	if err != nil {
		fmt.Fprintf(stderr, "kabootar: couldn't check for updates: %v\n", err)
		return 1
	}
	current := strings.TrimPrefix(version, "v")
	if !update.Newer(current, latest) && !*force {
		fmt.Fprintf(stderr, "kabootar %s is the latest version.\n", current)
		return 0
	}
	if method != update.SelfManaged {
		// Replacing a file a package manager owns would confuse it.
		fmt.Fprintf(stderr, "kabootar %s is available (you have %s).\nThis copy was installed by a package manager; to update: %s\n",
			strings.TrimPrefix(latest, "v"), current, update.Hint(method))
		return 1
	}

	err = update.Apply(ctx, latest, update.Options{
		Exe: exe,
		Log: func(format string, a ...any) { fmt.Fprintf(stderr, format+"\n", a...) },
	})
	if err != nil {
		fmt.Fprintf(stderr, "kabootar: update failed: %v\n", err)
		return 1
	}
	fmt.Fprintf(stderr, "Updated kabootar %s → %s (%s)\n", current, strings.TrimPrefix(latest, "v"), exe)
	return 0
}

// notifier reminds about new releases at most once a day on interactive
// terminals; see update.Notifier.
func notifier(stderr io.Writer) *update.Notifier {
	if !update.Enabled(strings.TrimPrefix(version, "v"), isTerminal(stderr)) {
		return nil
	}
	hint := "kabootar update"
	if exe, err := update.Executable(); err == nil {
		hint = update.Hint(update.Detect(exe))
	}
	return update.NewNotifier(strings.TrimPrefix(version, "v"), update.StateFile(), func(current, latest string) {
		fmt.Fprintf(stderr, "A new version of kabootar is available: %s → %s. To update: %s\n",
			current, strings.TrimPrefix(latest, "v"), hint)
	})
}
