package update

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestNewer(t *testing.T) {
	cases := []struct {
		cur, rel string
		want     bool
	}{
		{"0.1.0", "v0.1.1", true},
		{"0.1.1", "v0.1.1", false},
		{"0.2.0", "v0.1.9", false},
		{"0.9.0", "v0.10.0", true},
		{"1.0.0-rc1", "v1.0.0", true},
		{"1.0.0", "v1.0.0-rc1", false},
		{"dev", "v9.9.9", false},
		{"0.1.0", "garbage", false},
	}
	for _, c := range cases {
		if got := Newer(c.cur, c.rel); got != c.want {
			t.Errorf("Newer(%q, %q) = %v, want %v", c.cur, c.rel, got, c.want)
		}
	}
}

func TestDetect(t *testing.T) {
	cases := map[string]Method{
		"/opt/homebrew/Caskroom/kabootar/0.1.0/kabootar":              Homebrew,
		"/usr/local/Caskroom/kabootar/0.1.0/kabootar":                 Homebrew,
		"/home/linuxbrew/.linuxbrew/Caskroom/kabootar/0.1.0/kabootar": Homebrew,
		"/usr/bin/kabootar":            Package,
		"/usr/local/bin/kabootar":      SelfManaged,
		"/home/me/.local/bin/kabootar": SelfManaged,
	}
	for p, want := range cases {
		if got := Detect(p); got != want {
			t.Errorf("Detect(%q) = %v, want %v", p, got, want)
		}
	}
}

func TestAssetNamesMatchInstallScript(t *testing.T) {
	cases := map[[2]string]string{
		{"linux", "amd64"}:   "kabootar_linux_amd64.tar.gz",
		{"linux", "arm"}:     "kabootar_linux_armv7.tar.gz",
		{"darwin", "arm64"}:  "kabootar_darwin_arm64.tar.gz",
		{"windows", "amd64"}: "kabootar_windows_amd64.zip",
	}
	for in, want := range cases {
		if got := Asset(in[0], in[1]); got != want {
			t.Errorf("Asset(%v) = %s, want %s", in, got, want)
		}
	}
}

func tarGz(t *testing.T, name string, body []byte) []byte {
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range []struct {
		name string
		body []byte
	}{{"LICENSE", []byte("MIT")}, {name, body}} {
		tw.WriteHeader(&tar.Header{Name: f.name, Mode: 0o755, Size: int64(len(f.body)), Typeflag: tar.TypeReg})
		tw.Write(f.body)
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

func zipFile(t *testing.T, name string, body []byte) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	w, _ := zw.Create(name)
	w.Write(body)
	zw.Close()
	return buf.Bytes()
}

// release serves a fake GitHub releases page for tag with the given files.
func release(t *testing.T, tag string, files map[string][]byte, badSum bool) {
	var sums strings.Builder
	for name, b := range files {
		h := sha256.Sum256(b)
		sum := hex.EncodeToString(h[:])
		if badSum {
			sum = strings.Repeat("0", 64)
		}
		fmt.Fprintf(&sums, "%s  %s\n", sum, name)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/latest":
			http.Redirect(w, r, "/tag/"+tag, http.StatusFound)
		case r.URL.Path == "/download/"+tag+"/checksums.txt":
			w.Write([]byte(sums.String()))
		case strings.HasPrefix(r.URL.Path, "/download/"+tag+"/"):
			b, ok := files[strings.TrimPrefix(r.URL.Path, "/download/"+tag+"/")]
			if !ok {
				http.NotFound(w, r)
				return
			}
			w.Write(b)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	t.Setenv("KABOOTAR_RELEASES_URL", srv.URL)
}

func fakeExe(t *testing.T) string {
	p := filepath.Join(t.TempDir(), "kabootar")
	if err := os.WriteFile(p, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

func noVerify(string, string) error { return nil }

func TestLatestFollowsRedirect(t *testing.T) {
	release(t, "v0.3.1", nil, false)
	tag, err := Latest(context.Background())
	if err != nil || tag != "v0.3.1" {
		t.Fatalf("Latest = %q, %v", tag, err)
	}
}

func TestApplyReplacesTheBinary(t *testing.T) {
	release(t, "v0.2.0", map[string][]byte{
		"kabootar_linux_amd64.tar.gz": tarGz(t, "kabootar", []byte("new linux")),
		"kabootar_windows_amd64.zip":  zipFile(t, "kabootar.exe", []byte("new windows")),
	}, false)

	exe := fakeExe(t)
	var verified string
	err := Apply(context.Background(), "v0.2.0", Options{
		Exe: exe, GOOS: "linux", GOARCH: "amd64",
		Verify: func(p, tag string) error { verified = tag; return nil },
	})
	if err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "new linux" {
		t.Errorf("binary is %q", b)
	}
	if st, _ := os.Stat(exe); st.Mode().Perm()&0o100 == 0 {
		t.Errorf("not executable: %v", st.Mode())
	}
	if verified != "v0.2.0" {
		t.Errorf("new binary wasn't verified")
	}
	leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(exe), ".kabootar-update-*"))
	if len(leftovers) > 0 {
		t.Errorf("left %v behind", leftovers)
	}

	// The zip path (Windows archives) extracts too.
	exe = fakeExe(t)
	if err := Apply(context.Background(), "v0.2.0", Options{Exe: exe, GOOS: "windows", GOARCH: "amd64", Verify: noVerify}); err != nil && !strings.Contains(err.Error(), "rename") {
		t.Fatal(err)
	}
}

func TestApplyRefusesABadChecksum(t *testing.T) {
	release(t, "v0.2.0", map[string][]byte{
		"kabootar_linux_amd64.tar.gz": tarGz(t, "kabootar", []byte("tampered")),
	}, true)
	exe := fakeExe(t)
	err := Apply(context.Background(), "v0.2.0", Options{Exe: exe, GOOS: "linux", GOARCH: "amd64", Verify: noVerify})
	if err == nil || !strings.Contains(err.Error(), "checksum mismatch") {
		t.Fatalf("err = %v", err)
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Error("binary was replaced despite the bad checksum")
	}
}

func TestApplyKeepsTheOldBinaryIfTheNewOneFails(t *testing.T) {
	release(t, "v0.2.0", map[string][]byte{
		"kabootar_linux_amd64.tar.gz": tarGz(t, "kabootar", []byte("broken")),
	}, false)
	exe := fakeExe(t)
	err := Apply(context.Background(), "v0.2.0", Options{
		Exe: exe, GOOS: "linux", GOARCH: "amd64",
		Verify: func(string, string) error { return errors.New("exec format error") },
	})
	if err == nil {
		t.Fatal("expected an error")
	}
	if b, _ := os.ReadFile(exe); string(b) != "old" {
		t.Error("binary was replaced by one that doesn't run")
	}
}

func TestApplyMissingAsset(t *testing.T) {
	release(t, "v0.2.0", map[string][]byte{}, false)
	err := Apply(context.Background(), "v0.2.0", Options{Exe: fakeExe(t), GOOS: "linux", GOARCH: "amd64", Verify: noVerify})
	if err == nil {
		t.Fatal("expected an error for a missing archive")
	}
}

type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

func newTestNotifier(t *testing.T, current, file string, c *clock, latest string, shown *[]string) *Notifier {
	n := NewNotifier(current, file, func(cur, l string) { *shown = append(*shown, cur+"→"+l) })
	n.now = c.now
	n.latest = func(context.Context) (string, error) { return latest, nil }
	return n
}

func TestNoticeAtMostOnceADay(t *testing.T) {
	file := filepath.Join(t.TempDir(), "update.json")
	c := &clock{time.Date(2026, 11, 1, 9, 0, 0, 0, time.UTC)}
	var shown []string

	// First run: nothing known yet; the background check finds v0.2.0 and
	// the reminder shows at the end of the run.
	n := newTestNotifier(t, "0.1.1", file, c, "v0.2.0", &shown)
	n.Start()
	n.Finish(time.Second)
	if len(shown) != 1 || shown[0] != "0.1.1→v0.2.0" {
		t.Fatalf("first run showed %v", shown)
	}

	// Same day, many runs: no repeat, and no new check.
	c.t = c.t.Add(3 * time.Hour)
	checks := 0
	n = newTestNotifier(t, "0.1.1", file, c, "v0.2.0", &shown)
	n.latest = func(context.Context) (string, error) { checks++; return "v0.2.0", nil }
	n.Start()
	n.Finish(time.Second)
	if len(shown) != 1 || checks != 0 {
		t.Fatalf("same day: shown %v, %d checks", shown, checks)
	}

	// Next day: reminded again, straight away from what's remembered.
	c.t = c.t.Add(24 * time.Hour)
	n = newTestNotifier(t, "0.1.1", file, c, "v0.2.0", &shown)
	n.Start()
	if len(shown) != 2 {
		t.Fatalf("next day, before the check finished: shown %v", shown)
	}
	n.Finish(time.Second)
	if len(shown) != 2 {
		t.Fatalf("shown twice in one run: %v", shown)
	}

	// After updating, nothing to say.
	c.t = c.t.Add(48 * time.Hour)
	n = newTestNotifier(t, "0.2.0", file, c, "v0.2.0", &shown)
	n.Start()
	n.Finish(time.Second)
	if len(shown) != 2 {
		t.Fatalf("up to date but reminded: %v", shown)
	}
}

func TestNoticeSurvivesBeingOffline(t *testing.T) {
	file := filepath.Join(t.TempDir(), "update.json")
	c := &clock{time.Now()}
	var shown []string
	n := newTestNotifier(t, "0.1.0", file, c, "", &shown)
	calls := 0
	n.latest = func(context.Context) (string, error) { calls++; return "", errors.New("offline") }
	n.Start()
	n.Finish(time.Second)

	// The failed attempt counts as today's check.
	n = newTestNotifier(t, "0.1.0", file, c, "", &shown)
	n.latest = func(context.Context) (string, error) { calls++; return "", errors.New("offline") }
	n.Start()
	n.Finish(time.Second)
	if calls != 1 || len(shown) != 0 {
		t.Fatalf("%d checks, shown %v", calls, shown)
	}
}

func TestEnabled(t *testing.T) {
	t.Setenv("CI", "")
	t.Setenv("KABOOTAR_NO_UPDATE_CHECK", "")
	if !Enabled("0.1.0", true) {
		t.Error("release build on a terminal should check")
	}
	if Enabled("dev", true) || Enabled("0.1.0", false) {
		t.Error("dev builds and pipes shouldn't check")
	}
	t.Setenv("KABOOTAR_NO_UPDATE_CHECK", "1")
	if Enabled("0.1.0", true) {
		t.Error("KABOOTAR_NO_UPDATE_CHECK should turn it off")
	}
}
