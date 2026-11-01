package rtc

import (
	"net"
	"sync"
	"time"

	"github.com/pion/stun/v3"
)

// PublicAddresses returns this machine's public IPv4 and IPv6 addresses as
// seen by a STUN server. The server uses them to list a share for "Nearby"
// devices on the same network, like the web app does.
func PublicAddresses(timeout time.Duration) (v4, v6 string) {
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); v4 = query("udp4", timeout) }()
	go func() { defer wg.Done(); v6 = query("udp6", timeout) }()
	wg.Wait()
	if ip := net.ParseIP(v4); ip == nil || ip.To4() == nil || isPrivate(ip) {
		v4 = ""
	}
	if ip := net.ParseIP(v6); ip == nil || ip.To4() != nil || !isPublicV6(ip) {
		v6 = ""
	}
	return v4, v6
}

func query(network string, timeout time.Duration) string {
	result := make(chan string, 1)
	go func() {
		c, err := stun.Dial(network, "stun.cloudflare.com:3478")
		if err != nil {
			result <- ""
			return
		}
		defer c.Close()
		var addr string
		_ = c.Do(stun.MustBuild(stun.TransactionID, stun.BindingRequest), func(e stun.Event) {
			if e.Error != nil {
				return
			}
			var x stun.XORMappedAddress
			if x.GetFrom(e.Message) == nil {
				addr = x.IP.String()
			}
		})
		result <- addr
	}()
	select {
	case a := <-result:
		return a
	case <-time.After(timeout):
		return ""
	}
}

func isPrivate(ip net.IP) bool {
	ip4 := ip.To4()
	return ip.IsPrivate() || ip.IsLoopback() || ip.IsUnspecified() ||
		(ip4 != nil && ip4[0] == 100 && ip4[1] >= 64 && ip4[1] < 128) // CGNAT
}

func isPublicV6(ip net.IP) bool {
	return ip[0]&0xe0 == 0x20 // 2000::/3
}
