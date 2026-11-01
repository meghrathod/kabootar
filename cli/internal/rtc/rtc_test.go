package rtc

import (
	"net"
	"testing"
)

func TestSameNetwork(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"192.168.1.5", "192.168.1.9", true},
		{"10.0.0.2", "192.168.1.9", true},
		{"2001:db8:1:2::8ef4", "fe80::1", true},
		{"2001:db8:1:2::1", "2001:db8:1:2::2", true},
		{"2001:db8:1:2::1", "2001:db8:1:3::2", false},
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

func TestSkipsVPNAndVirtualInterfaces(t *testing.T) {
	for name, want := range map[string]bool{
		"en0": true, "eth0": true, "enp3s0": true, "wlan0": true, "Wi-Fi": true, "Ethernet": true,
		"tailscale0": false, "Tailscale": false, "CloudflareWARP": false, "utun4": false,
		"wg0": false, "docker0": false, "br-1a2b3c": false, "veth9f": false, "zt5u4y": false,
	} {
		if got := keepInterface(name); got != want {
			t.Errorf("keepInterface(%q) = %v, want %v", name, got, want)
		}
	}
	for addr, want := range map[string]bool{
		// LAN kept; Tailscale and Cloudflare WARP dropped.
		"192.168.1.20": true, "2001:db8:1:2::20": true, "10.10.1.1": true,
		"100.101.102.103": false, "fd7a:115c:a1e0::1": false, "2606:4700:110:8000::1": false,
	} {
		if got := keepIP(net.ParseIP(addr)); got != want {
			t.Errorf("keepIP(%s) = %v, want %v", addr, got, want)
		}
	}
}
