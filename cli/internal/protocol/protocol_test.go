package protocol

import (
	"encoding/json"
	"slices"
	"testing"
)

func TestSanitize(t *testing.T) {
	if got := SanitizePath("../../etc/passwd"); !slices.Equal(got, []string{"etc", "passwd"}) {
		t.Errorf("SanitizePath traversal = %v", got)
	}
	if got := SanitizePath(`/abs\win\..\x`); !slices.Equal(got, []string{"abs", "win", "x"}) {
		t.Errorf("SanitizePath mixed = %v", got)
	}
	cases := map[string]string{
		"..hidden":              "_hidden",
		"a<b>:c\"d|e?f*g\u0001": "a_b__c_d_e_f_g_",
		"":                      "file",
		"  ":                    "file",
	}
	for in, want := range cases {
		if got := SanitizeName(in); got != want {
			t.Errorf("SanitizeName(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestValidItems(t *testing.T) {
	raw := json.RawMessage(`[
		{"id": 1, "kind": "file", "name": "../x", "size": 10, "path": "../a/b.txt"},
		{"id": 2, "kind": "file", "name": "y", "size": -1},
		{"id": 3, "kind": "text", "text": "t"},
		{"kind": "file"},
		"junk"
	]`)
	items := ValidItems(raw)
	if len(items) != 2 {
		t.Fatalf("got %d items, want 2: %+v", len(items), items)
	}
	if items[0].Name != "__x" || items[0].Path != "a/b.txt" {
		t.Errorf("file item = %+v", items[0])
	}
	if items[1].Kind != "text" || items[1].Text != "t" {
		t.Errorf("text item = %+v", items[1])
	}
}

func TestWireShapes(t *testing.T) {
	hello := string(Hello([]Item{
		{ID: 0, Kind: "file", Name: "a.txt", Size: 3, Type: "text/plain", LastModified: 5},
		{ID: 1, Kind: "text", Text: "hi"},
	}))
	want := `{"t":"hello","v":2,"items":[{"id":0,"kind":"file","name":"a.txt","size":3,"type":"text/plain","lastModified":5},{"id":1,"kind":"text","text":"hi"}]}`
	if hello != want {
		t.Errorf("hello =\n%s\nwant\n%s", hello, want)
	}
	if got := string(Get(2, 10)); got != `{"t":"get","id":2,"offset":10}` {
		t.Errorf("get = %s", got)
	}
}

func TestChunkSize(t *testing.T) {
	for in, want := range map[uint32]int{0: 64 * KiB, 1000: 16 * KiB, 262144: 256 * KiB, 1 << 30: 256 * KiB} {
		if got := ChunkSize(in); got != want {
			t.Errorf("ChunkSize(%d) = %d, want %d", in, got, want)
		}
	}
}

func TestTruncateKeepsCharacters(t *testing.T) {
	s := ""
	for range 150 {
		s += "😀" // 2 UTF-16 units each
	}
	if got := SanitizeName(s); len([]rune(got)) != 100 {
		t.Errorf("truncated to %d runes, want 100", len([]rune(got)))
	}
}
