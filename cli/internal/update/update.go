// Package update finds newer releases on GitHub, replaces the running
// binary with one (kabootar update), and reminds about them at most once a
// day.
package update

import (
	"archive/tar"
	"archive/zip"
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// DefaultReleases is where releases are published. KABOOTAR_RELEASES_URL
// overrides it (tests, mirrors).
const DefaultReleases = "https://github.com/meghrathod/kabootar/releases"

func releasesURL() string {
	if u := os.Getenv("KABOOTAR_RELEASES_URL"); u != "" {
		return strings.TrimRight(u, "/")
	}
	return DefaultReleases
}

var client = &http.Client{Timeout: 5 * time.Minute}

// Latest returns the newest release tag (e.g. "v0.2.0"). It follows
// releases/latest's redirect instead of calling the GitHub API, which has a
// low rate limit for anonymous requests.
func Latest(ctx context.Context) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, releasesURL()+"/latest", nil)
	if err != nil {
		return "", err
	}
	c := *client
	c.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := c.Do(req)
	if err != nil {
		return "", err
	}
	res.Body.Close()
	loc := res.Header.Get("Location")
	if res.StatusCode/100 != 3 || loc == "" {
		return "", fmt.Errorf("no release found (HTTP %d)", res.StatusCode)
	}
	tag := path.Base(loc)
	if _, ok := parse(tag); !ok {
		return "", fmt.Errorf("unexpected release tag %q", tag)
	}
	return tag, nil
}

// parse reads "v1.2.3" or "1.2.3"; a pre-release suffix sorts lower.
func parse(v string) ([4]int, bool) {
	v = strings.TrimPrefix(strings.TrimSpace(v), "v")
	pre := 1
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		if v[i] == '-' {
			pre = 0
		}
		v = v[:i]
	}
	parts := strings.Split(v, ".")
	if len(parts) != 3 {
		return [4]int{}, false
	}
	var out [4]int
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return [4]int{}, false
		}
		out[i] = n
	}
	out[3] = pre
	return out, true
}

// Newer reports whether release is newer than current. A current version
// that isn't a release (e.g. "dev") is never out of date.
func Newer(current, release string) bool {
	c, ok1 := parse(current)
	r, ok2 := parse(release)
	if !ok1 || !ok2 {
		return false
	}
	for i := range c {
		if r[i] != c[i] {
			return r[i] > c[i]
		}
	}
	return false
}

// Method is how this copy was installed, which decides how to update it.
type Method int

const (
	SelfManaged Method = iota // install.sh, a downloaded archive, go install
	Homebrew
	Package // .deb / .rpm
)

// Detect works out the install method from the executable's location.
func Detect(exe string) Method {
	p := filepath.ToSlash(exe)
	switch {
	case strings.Contains(p, "/Caskroom/") || strings.Contains(p, "/Cellar/") ||
		strings.HasPrefix(p, "/opt/homebrew/") || strings.HasPrefix(p, "/home/linuxbrew/"):
		return Homebrew
	case p == "/usr/bin/kabootar":
		// The .deb and .rpm install here; install.sh never does.
		return Package
	}
	return SelfManaged
}

// Hint is the command that updates a copy installed with m.
func Hint(m Method) string {
	switch m {
	case Homebrew:
		return "brew upgrade --cask kabootar"
	case Package:
		return "download the new .deb or .rpm from " + releasesURL()
	}
	return "kabootar update"
}

// Executable is the running binary's real path.
func Executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(exe)
}

// Asset is the release archive for a platform, named like install.sh
// expects.
func Asset(goos, goarch string) string {
	arch := goarch
	if goarch == "arm" {
		arch = "armv7"
	}
	if goos == "windows" {
		return fmt.Sprintf("kabootar_%s_%s.zip", goos, arch)
	}
	return fmt.Sprintf("kabootar_%s_%s.tar.gz", goos, arch)
}

// Options control Apply; zero values mean the running binary and platform.
type Options struct {
	Exe    string
	GOOS   string
	GOARCH string
	// Verify runs the new binary before it replaces the old one; the
	// default runs "<new> version" and checks the output names tag.
	Verify func(path, tag string) error
	Log    func(format string, a ...any)
}

// Apply downloads tag, checks it against the release's checksums.txt and
// replaces the executable with it.
func Apply(ctx context.Context, tag string, o Options) error {
	if o.GOOS == "" {
		o.GOOS = runtime.GOOS
	}
	if o.GOARCH == "" {
		o.GOARCH = runtime.GOARCH
	}
	if o.Exe == "" {
		exe, err := Executable()
		if err != nil {
			return err
		}
		o.Exe = exe
	}
	if o.Verify == nil {
		o.Verify = verifyVersion
	}
	logf := o.Log
	if logf == nil {
		logf = func(string, ...any) {}
	}

	asset := Asset(o.GOOS, o.GOARCH)
	base := releasesURL() + "/download/" + tag + "/"
	logf("Downloading %s…", asset)
	archive, err := fetch(ctx, base+asset)
	if err != nil {
		return err
	}
	sums, err := fetch(ctx, base+"checksums.txt")
	if err != nil {
		return err
	}
	want := checksum(sums, asset)
	if want == "" {
		return fmt.Errorf("checksums.txt has no entry for %s", asset)
	}
	got := sha256.Sum256(archive)
	if hex.EncodeToString(got[:]) != want {
		return fmt.Errorf("checksum mismatch for %s; not installing it", asset)
	}

	name := "kabootar"
	if o.GOOS == "windows" {
		name += ".exe"
	}
	bin, err := extract(archive, name, o.GOOS == "windows")
	if err != nil {
		return err
	}

	// Write next to the executable so the final rename stays on one
	// filesystem (and is atomic).
	dir := filepath.Dir(o.Exe)
	tmp, err := os.CreateTemp(dir, ".kabootar-update-*")
	if err != nil {
		if errors.Is(err, os.ErrPermission) {
			return fmt.Errorf("no permission to write to %s; run with sudo, or re-run the install script", dir)
		}
		return err
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := tmp.Write(bin); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tmpPath, 0o755); err != nil {
		return err
	}
	if err := o.Verify(tmpPath, tag); err != nil {
		return fmt.Errorf("the new version didn't run: %w", err)
	}
	return replace(o.Exe, tmpPath)
}

// replace swaps the new binary in. Windows can't overwrite a running
// executable but can rename it, so the old one is moved aside first and
// removed on a later run (see Cleanup).
func replace(exe, newPath string) error {
	if runtime.GOOS != "windows" {
		return os.Rename(newPath, exe)
	}
	old := exe + ".old"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		return err
	}
	if err := os.Rename(newPath, exe); err != nil {
		os.Rename(old, exe)
		return err
	}
	return nil
}

// Cleanup removes a binary left behind by an update on Windows.
func Cleanup() {
	if runtime.GOOS != "windows" {
		return
	}
	if exe, err := Executable(); err == nil {
		os.Remove(exe + ".old")
	}
}

func verifyVersion(p, tag string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, p, "version").Output()
	if err != nil {
		return err
	}
	if !strings.Contains(string(out), strings.TrimPrefix(tag, "v")) {
		return fmt.Errorf("it reports %q", strings.TrimSpace(string(out)))
	}
	return nil
}

func fetch(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	res, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("download failed: %w", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download failed: %s (HTTP %d)", url, res.StatusCode)
	}
	return io.ReadAll(io.LimitReader(res.Body, 200<<20))
}

func checksum(sums []byte, asset string) string {
	sc := bufio.NewScanner(bytes.NewReader(sums))
	for sc.Scan() {
		f := strings.Fields(sc.Text())
		if len(f) == 2 && strings.TrimPrefix(f[1], "*") == asset {
			return strings.ToLower(f[0])
		}
	}
	return ""
}

func extract(archive []byte, name string, isZip bool) ([]byte, error) {
	if isZip {
		zr, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
		if err != nil {
			return nil, err
		}
		for _, f := range zr.File {
			if path.Base(f.Name) == name {
				rc, err := f.Open()
				if err != nil {
					return nil, err
				}
				defer rc.Close()
				return io.ReadAll(io.LimitReader(rc, 200<<20))
			}
		}
		return nil, fmt.Errorf("%s not found in the archive", name)
	}
	gz, err := gzip.NewReader(bytes.NewReader(archive))
	if err != nil {
		return nil, err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil, fmt.Errorf("%s not found in the archive", name)
		}
		if err != nil {
			return nil, err
		}
		if h.Typeflag == tar.TypeReg && path.Base(h.Name) == name {
			return io.ReadAll(io.LimitReader(tr, 200<<20))
		}
	}
}
