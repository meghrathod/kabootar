package rtc

import (
	"net"
	"os"
	"strings"
)

// ICE gives every host candidate the same priority, so a pair through a VPN
// (Tailscale, Cloudflare WARP, WireGuard…) can win over the LAN, and the
// transfer then leaves the network and comes back through the tunnel at a
// fraction of the speed. These interfaces are skipped unless
// KABOOTAR_ALL_INTERFACES is set. LAN, internet (STUN) and relay paths are
// unaffected.

// virtualPrefixes match interface names of VPNs, overlays and container
// bridges, compared in lower case. Windows names are free-form, which is
// why addresses are checked too (vpnNets).
var virtualPrefixes = []string{
	"tailscale", "cloudflarewarp", "cloudflare warp", "warp",
	"utun", "tun", "tap", "wg", "zt", "nordlynx", "proton", "mullvad",
	"docker", "br-", "veth", "virbr", "vmnet", "vboxnet", "lxcbr", "lxdbr",
	"cni", "flannel", "cali", "cilium", "kube", "podman",
}

// vpnNets are address ranges used by common VPNs.
var vpnNets = func() []*net.IPNet {
	var out []*net.IPNet
	for _, cidr := range []string{
		"100.64.0.0/10",       // Tailscale (CGNAT range)
		"fd7a:115c:a1e0::/48", // Tailscale IPv6
		"2606:4700:110::/48",  // Cloudflare WARP IPv6
	} {
		_, n, _ := net.ParseCIDR(cidr)
		out = append(out, n)
	}
	return out
}()

func allInterfaces() bool { return os.Getenv("KABOOTAR_ALL_INTERFACES") != "" }

// keepInterface reports whether ICE should gather on an interface.
func keepInterface(name string) bool {
	n := strings.ToLower(name)
	for _, p := range virtualPrefixes {
		if strings.HasPrefix(n, p) {
			return false
		}
	}
	return true
}

// keepIP reports whether ICE should use a local address.
func keepIP(ip net.IP) bool {
	for _, n := range vpnNets {
		if n.Contains(ip) {
			return false
		}
	}
	return true
}
