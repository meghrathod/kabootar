// Package api talks to the Kabootar worker's HTTP endpoints (see
// worker/src/index.ts).
package api

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// DefaultServer is the public deployment.
const DefaultServer = "https://kabootar.meghrathod.dev"

type RoomInfo struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Emoji string `json:"emoji"`
	Color string `json:"color"`
}

type CreatedRoom struct {
	RoomInfo
	Network   []string `json:"network"`
	Hidden    bool     `json:"hidden"`
	MasterKey string   `json:"masterKey"`
	ClientKey string   `json:"clientKey"`
	PIN       string   `json:"pin"`
	ExpiresAt string   `json:"expiresAt"`
}

type Joined struct {
	Room      RoomInfo `json:"room"`
	ClientKey string   `json:"clientKey"`
}

type Info struct {
	Version  string `json:"version"`
	Turn     bool   `json:"turn"`
	MaxPeers int    `json:"maxPeers"`
}

// Error is an error response from the server, or "offline".
type Error struct {
	Code   string
	Status int
}

func (e *Error) Error() string { return e.Code }

type Client struct {
	Base      string
	UserAgent string
	HTTP      *http.Client
}

func New(base, userAgent string) *Client {
	return &Client{
		Base:      strings.TrimRight(base, "/"),
		UserAgent: userAgent,
		HTTP:      &http.Client{Timeout: 20 * time.Second},
	}
}

// WSBase is the websocket origin for the same server.
func (c *Client) WSBase() string {
	if strings.HasPrefix(c.Base, "https://") {
		return "wss://" + strings.TrimPrefix(c.Base, "https://")
	}
	return "ws://" + strings.TrimPrefix(c.Base, "http://")
}

// ShareLink is the link a browser opens to receive.
func (c *Client) ShareLink(roomID, clientKey string) string {
	return fmt.Sprintf("%s/%s#k=%s", c.Base, roomID, clientKey)
}

func (c *Client) do(ctx context.Context, method, path string, body, out any) error {
	var rd *bytes.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(b)
	} else {
		rd = bytes.NewReader(nil)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Base+path, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if c.UserAgent != "" {
		req.Header.Set("User-Agent", c.UserAgent)
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return &Error{Code: "offline"}
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		_ = json.NewDecoder(res.Body).Decode(&e)
		if e.Error == "" {
			e.Error = "unknown"
		}
		return &Error{Code: e.Error, Status: res.StatusCode}
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *Client) CreateRoom(ctx context.Context, discoverable bool, ip4, ip6 string) (*CreatedRoom, error) {
	var out CreatedRoom
	err := c.do(ctx, http.MethodPost, "/api/rooms", map[string]any{
		"discoverable": discoverable,
		"ip":           ip4,
		"ip6":          ip6,
	}, &out)
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Join(ctx context.Context, pin string) (*Joined, error) {
	var out Joined
	if err := c.do(ctx, http.MethodPost, "/api/join", map[string]any{"pin": pin, "roomId": ""}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Info(ctx context.Context) (*Info, error) {
	var out Info
	if err := c.do(ctx, http.MethodGet, "/api/info", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ParseLink splits a share link into server, room id and client key.
func ParseLink(link string) (server, roomID, key string, err error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return "", "", "", errors.New("not a share link")
	}
	roomID = strings.Trim(u.Path, "/")
	frag, _ := url.ParseQuery(u.Fragment)
	key = frag.Get("k")
	if !validID(roomID) || key == "" {
		return "", "", "", errors.New("not a share link (expected https://…/<id>#k=…)")
	}
	return u.Scheme + "://" + u.Host, roomID, key, nil
}

func validID(id string) bool {
	if len(id) != 12 {
		return false
	}
	for _, r := range id {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9') {
			return false
		}
	}
	return true
}

// ValidPIN reports whether s looks like a 6-digit share code.
func ValidPIN(s string) bool {
	if len(s) != 6 || s[0] == '0' {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// Message turns an error code into the same text the web app shows.
func Message(err error) string {
	code := err.Error()
	var e *Error
	if errors.As(err, &e) {
		code = e.Code
	}
	switch code {
	case "offline":
		return "Can't reach the Kabootar server. Check your connection."
	case "rate_limited":
		return "Too many attempts. Wait a minute and try again."
	case "room_not_found":
		return "No share found with that code."
	case "invalid_key":
		return "This share link is invalid or has expired."
	case "room_full":
		return "This share already has the maximum number of receivers."
	case "server_busy":
		return "The server is busy right now. Try again shortly."
	case "master_absent":
		return "The sender is not connected right now."
	default:
		return "Something went wrong (" + code + "). Please try again."
	}
}
