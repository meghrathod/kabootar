// Package protocol mirrors src/lib/transfer/protocol.ts: the messages
// exchanged over the data channel once two peers are connected.
//
// Control messages are JSON text messages; file bytes are binary messages
// that belong to the transfer most recently announced with "start". The
// channel is ordered and reliable, so no framing is needed.
//
//	sender                         receiver
//	hello {items}          ──▶
//	                       ◀──     get {id, offset}
//	start {id, offset}     ──▶
//	<binary chunks>        ──▶     (writes, hashes)
//	                       ◀──     ack {id, received}     every AckEvery bytes
//	end {id, sha256}       ──▶
//	                       ◀──     done {id, ok}
package protocol

import (
	"encoding/json"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

// Version must match PROTOCOL_VERSION in the web app.
const Version = 2

const (
	KiB = 1024
	MiB = 1024 * KiB

	// Window is the max bytes in flight beyond the receiver's last ack.
	Window = 32 * MiB
	// AckEvery is how often (in bytes written) the receiver acks.
	AckEvery = 1 * MiB
	// HighWater pauses sending when the channel buffer exceeds it.
	HighWater = 8 * MiB
	// LowWater resumes sending when the channel buffer drops below it.
	LowWater = 1 * MiB
	// ReadBlock is the number of bytes read from disk at a time.
	ReadBlock = 4 * MiB
	// MaxText bounds text items carried inline in "hello".
	MaxText = 64 * KiB
)

// Item is a file or text entry announced in "hello". Kind is "file" or "text".
type Item struct {
	ID           int    `json:"id"`
	Kind         string `json:"kind"`
	Name         string `json:"name,omitempty"`
	Size         int64  `json:"size"`
	Type         string `json:"type"`
	LastModified int64  `json:"lastModified,omitempty"`
	// Path is the relative path for folder shares, e.g. "photos/2024/a.jpg".
	Path string `json:"path,omitempty"`
	Text string `json:"text,omitempty"`
}

// MarshalJSON writes only the fields that belong to the item's kind, so the
// browser sees exactly the FileMeta / TextMeta shapes it expects.
func (it Item) MarshalJSON() ([]byte, error) {
	if it.Kind == "text" {
		return json.Marshal(struct {
			ID   int    `json:"id"`
			Kind string `json:"kind"`
			Text string `json:"text"`
		}{it.ID, it.Kind, it.Text})
	}
	return json.Marshal(struct {
		ID           int    `json:"id"`
		Kind         string `json:"kind"`
		Name         string `json:"name"`
		Size         int64  `json:"size"`
		Type         string `json:"type"`
		LastModified int64  `json:"lastModified"`
		Path         string `json:"path,omitempty"`
	}{it.ID, it.Kind, it.Name, it.Size, it.Type, it.LastModified, it.Path})
}

// Msg is any control message in either direction; T says which.
type Msg struct {
	T        string          `json:"t"`
	V        int             `json:"v,omitempty"`
	Items    json.RawMessage `json:"items,omitempty"`
	ID       int             `json:"id"`
	Offset   int64           `json:"offset"`
	Received int64           `json:"received"`
	SHA256   string          `json:"sha256"`
	OK       bool            `json:"ok"`
	Message  string          `json:"message"`
}

// Encoders keep the wire shapes identical to the TypeScript types.

func Hello(items []Item) []byte {
	return mustJSON(struct {
		T     string `json:"t"`
		V     int    `json:"v"`
		Items []Item `json:"items"`
	}{"hello", Version, items})
}

func Start(id int, offset int64) []byte {
	return mustJSON(struct {
		T      string `json:"t"`
		ID     int    `json:"id"`
		Offset int64  `json:"offset"`
	}{"start", id, offset})
}

func End(id int, sha256 string) []byte {
	return mustJSON(struct {
		T      string `json:"t"`
		ID     int    `json:"id"`
		SHA256 string `json:"sha256"`
	}{"end", id, sha256})
}

func Error(id int, message string) []byte {
	return mustJSON(struct {
		T       string `json:"t"`
		ID      int    `json:"id"`
		Message string `json:"message"`
	}{"error", id, message})
}

func Get(id int, offset int64) []byte {
	return mustJSON(struct {
		T      string `json:"t"`
		ID     int    `json:"id"`
		Offset int64  `json:"offset"`
	}{"get", id, offset})
}

func Ack(id int, received int64) []byte {
	return mustJSON(struct {
		T        string `json:"t"`
		ID       int    `json:"id"`
		Received int64  `json:"received"`
	}{"ack", id, received})
}

func Done(id int, ok bool) []byte {
	return mustJSON(struct {
		T  string `json:"t"`
		ID int    `json:"id"`
		OK bool   `json:"ok"`
	}{"done", id, ok})
}

func Cancel(id int) []byte {
	return mustJSON(struct {
		T  string `json:"t"`
		ID int    `json:"id"`
	}{"cancel", id})
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// Parse decodes a control message, or returns false for anything malformed.
func Parse(data []byte) (Msg, bool) {
	var m Msg
	if err := json.Unmarshal(data, &m); err != nil || m.T == "" {
		return Msg{}, false
	}
	return m, true
}

// ChunkSize is the largest message both peers accept, capped for fairness
// between peers (same rule as chunkSizeFor in the web app).
func ChunkSize(maxMessageSize uint32) int {
	limit := int(maxMessageSize)
	if limit <= 0 {
		limit = 64 * KiB
	}
	return min(max(16*KiB, limit), 256*KiB)
}

var unsafeChars = regexp.MustCompile(`[\x00-\x1f\x7f<>:"\\|?*]`)
var leadingDots = regexp.MustCompile(`^\.+`)
var separators = regexp.MustCompile(`[\\/]+`)

// SanitizeName makes a single path segment from a peer safe to use as a
// file name.
func SanitizeName(name string) string {
	n := unsafeChars.ReplaceAllString(name, "_")
	n = strings.TrimSpace(strings.ReplaceAll(n, "/", "_"))
	n = leadingDots.ReplaceAllString(n, "_")
	if n == "" {
		n = "file"
	}
	return truncate(n, 200)
}

// SanitizePath makes a relative path from a peer safe: no traversal, no
// absolute paths.
func SanitizePath(path string) []string {
	var out []string
	for _, s := range separators.Split(path, -1) {
		if s == "" || s == "." || s == ".." {
			continue
		}
		out = append(out, SanitizeName(s))
		if len(out) == 16 {
			break
		}
	}
	return out
}

// truncate cuts s to at most n UTF-16 code units, like String.slice in JS,
// without splitting a character.
func truncate(s string, n int) string {
	units := 0
	for i, r := range s {
		w := 1
		if r > 0xffff {
			w = 2
		}
		if units+w > n {
			return s[:i]
		}
		units += w
	}
	return s
}

// ValidItems validates a hello from the sender; never trust a peer's shapes.
func ValidItems(raw json.RawMessage) []Item {
	var list []any
	if err := json.Unmarshal(raw, &list); err != nil {
		return nil
	}
	if len(list) > 10_000 {
		list = list[:10_000]
	}
	var out []Item
	for _, entry := range list {
		it, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		id, ok := it["id"].(float64)
		if !ok {
			continue
		}
		switch it["kind"] {
		case "file":
			name, ok1 := it["name"].(string)
			size, ok2 := it["size"].(float64)
			if !ok1 || !ok2 || size < 0 {
				continue
			}
			item := Item{ID: int(id), Kind: "file", Name: SanitizeName(name), Size: int64(size)}
			if t, ok := it["type"].(string); ok {
				item.Type = truncate(t, 200)
			}
			if lm, ok := it["lastModified"].(float64); ok {
				item.LastModified = int64(lm)
			} else {
				item.LastModified = time.Now().UnixMilli()
			}
			if p, ok := it["path"].(string); ok {
				item.Path = strings.Join(SanitizePath(p), "/")
			}
			out = append(out, item)
		case "text":
			text, ok := it["text"].(string)
			if !ok {
				continue
			}
			out = append(out, Item{ID: int(id), Kind: "text", Text: truncate(text, MaxText)})
		}
	}
	return out
}

// ClampText trims and bounds a text item before sending.
func ClampText(s string) string {
	s = strings.TrimSpace(s)
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	return truncate(s, MaxText)
}
