// Package transfer is a port of src/lib/transfer: ItemServer sends share
// items over one data channel, ItemClient receives them. Neither knows about
// WebRTC; the session feeds them channel events.
package transfer

// Channel is the subset of a WebRTC data channel the transfer layer uses.
type Channel interface {
	Send(data []byte) error
	SendText(s string) error
	BufferedAmount() uint64
	Open() bool
}
