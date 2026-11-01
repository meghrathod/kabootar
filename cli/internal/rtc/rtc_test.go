package rtc

import "testing"

func TestSameNetwork(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"192.168.1.5", "192.168.1.9", true},
		{"10.0.0.2", "192.168.1.9", true},
		{"2600:4041:41d4:f900:48a:d969:74a1:8ef4", "fe80::c1f:5745:1", true},
		{"2600:4041:41d4:f900::1", "2600:4041:41d4:f900::2", true},
		{"2600:4041:41d4:f900::1", "2600:4041:41d4:aaaa::2", false},
		{"203.0.113.5", "192.168.1.9", false},
		{"203.0.113.5", "198.51.100.7", false},
		{"abcd.local", "192.168.1.9", false},
	}
	for _, c := range cases {
		if got := sameNetwork(c.a, c.b); got != c.want {
			t.Errorf("sameNetwork(%s, %s) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

func TestParseICEServers(t *testing.T) {
	got := ParseICEServers([]byte(`[
		{"urls": "stun:stun.cloudflare.com:3478"},
		{"urls": ["turn:turn.example.com:3478?transport=udp", "bogus:x"], "username": "u", "credential": "p"},
		{"urls": ["nope:"]}
	]`))
	if len(got) != 2 || len(got[1].URLs) != 1 || got[1].Username != "u" {
		t.Fatalf("got %+v", got)
	}
	if !HasTurn(got) {
		t.Error("TURN not detected")
	}
}
