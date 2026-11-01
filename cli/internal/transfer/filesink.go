package transfer

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/meghrathod/kabootar/cli/internal/protocol"
)

// FileSink writes to "<name>.part" next to the destination and renames it
// once the file is complete and verified, so a half-received file never
// looks finished.
type FileSink struct {
	f       *os.File
	dir     string
	name    string
	modTime time.Time
	force   bool
}

// OpenFileSink creates the sink for an item under dir, recreating its
// relative folder path. Existing files are kept unless force is set; the
// new file then gets a " (1)" style suffix.
func OpenFileSink(dir string, meta protocol.Item, force bool) (*FileSink, error) {
	parts := []string{protocol.SanitizeName(meta.Name)}
	if meta.Path != "" {
		if p := protocol.SanitizePath(meta.Path); len(p) > 0 {
			parts = p
		}
	}
	target := filepath.Join(append([]string{dir}, parts...)...)
	folder := filepath.Dir(target)
	if err := os.MkdirAll(folder, 0o755); err != nil {
		return nil, err
	}
	f, err := os.CreateTemp(folder, "."+filepath.Base(target)+".*.part")
	if err != nil {
		return nil, err
	}
	var mod time.Time
	if meta.LastModified > 0 {
		mod = time.UnixMilli(meta.LastModified)
	}
	return &FileSink{f: f, dir: folder, name: filepath.Base(target), modTime: mod, force: force}, nil
}

func (s *FileSink) Write(p []byte) error {
	_, err := s.f.Write(p)
	return err
}

func (s *FileSink) Close() (string, error) {
	tmp := s.f.Name()
	if err := s.f.Close(); err != nil {
		os.Remove(tmp)
		return "", err
	}
	dest := filepath.Join(s.dir, s.name)
	if !s.force {
		dest = unusedName(dest)
	}
	if err := os.Rename(tmp, dest); err != nil {
		os.Remove(tmp)
		return "", err
	}
	if !s.modTime.IsZero() {
		_ = os.Chtimes(dest, s.modTime, s.modTime)
	}
	return dest, nil
}

func (s *FileSink) Abort() error {
	s.f.Close()
	return os.Remove(s.f.Name())
}

// unusedName returns path, or "name (n).ext" if path already exists.
func unusedName(path string) string {
	if _, err := os.Lstat(path); os.IsNotExist(err) {
		return path
	}
	ext := filepath.Ext(path)
	base := strings.TrimSuffix(path, ext)
	for n := 1; ; n++ {
		p := fmt.Sprintf("%s (%d)%s", base, n, ext)
		if _, err := os.Lstat(p); os.IsNotExist(err) {
			return p
		}
	}
}
