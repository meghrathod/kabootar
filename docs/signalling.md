## Signalling subsystem overview

The signalling server provides minimal orchestration for peer-to-peer file transfer using WebRTC data channels. It is responsible for:

- Creating and tracking ephemeral rooms
- Authorizing master/client WebSocket participants per room
- Relaying SDP/ICE messages between the master and clients
- Advertising discoverable rooms per public IP (LAN/nearby discovery)
- Bootstrapping a TURN server and handing out TURN connection info

Implementation: Go (Fiber, WebSocket, pion/turn). Entrypoint: `signalling/cmd/signalling/main.go` → `web.InitWeb`.

## Configuration

Source: `signalling/config/config.go` (loaded from `kabootar.toml`).

- `listen_address` (string): HTTP server bind address, e.g. `":8080"` or `"0.0.0.0:8080"`.
- `cors_endpoint` (string): Allowed origin for CORS, e.g. `"https://app.example.com"`.
- `turn_realm` (string): TURN realm (also used as host for client hint). Example: `"turn.example.com"`.
- `turn_listen_ip` (string): Local IP to bind the TURN UDP server.
- `public_ip` (string): Public IP address advertised by TURN for relays.
- `turn_port` (int): TURN UDP port.

## HTTP and WebSocket routes

Registered in `signalling/web/web.go`:

- `GET /ping` → health check, returns `"Pong!"`
- `POST /room` → create a room (JSON array body)
- `GET /room?id=<roomID>&pin=<pin>` → return client key (for PIN-gated client join)
- `GET /ws/:room_id?k=<key>&m=t|f` → WebSocket signalling for a room
- `GET /discover?ip=<public-ip>` → WebSocket discovery channel per public IP

All WebSocket routes are guarded by `InitializeWS` which rejects plain HTTP (400) if not a WS upgrade.

## Room model and lifecycle

Defined in `signalling/web/room.go` and managed by `signalling/web/handler.go`.

- Fields
  - `ID` (string): Room identifier
  - `MKey` (string): Master key (authorizes the sender/owner)
  - `CKey` (string): Client key (authorizes any receiver)
  - `TKey` ([]byte): TURN long-term credential for this room, generated via `turn.GenerateAuthKey(ID, realm, CKey)`
  - `PIN` (string): 6-digit PIN for retrieving `CKey` out-of-band
  - `DiscoveryIP` (string): Public IP under which room is advertised (if discoverable)
  - `Name` (string): Friendly random two-word name
  - `Emoji` (string): Random emoji badge
  - `Master` (\*websocket.Conn): Connected master (nil until connected)
  - `Clients` (map-like): Connected clients keyed by generated `clientID`

- Creation (`POST /room`)
  - Body: JSON array `[("t"|"f"), ip?]`
    - If first element is `"t"`, second element must be the creator's public IP. The server marks the room discoverable only if `ip` is a valid public IP.
  - Response: JSON array `[roomID, mKey, cKey, name, pin, emoji]`
  - Side effects: Room stored; if discoverable, tracked under that `ip` and immediately broadcast to discovery subscribers of that IP.

- Destruction
  - When the master disconnects: server notifies all clients with a "gone" message and closes them; the room is removed, and discovery subscribers are notified of removal.
  - When a client disconnects: server notifies the master of the departure; the room remains.
  - There is no server-side idle timeout: a room lives as long as its master stays connected. If masters disconnect due to hosting/network idle limits, the room is removed immediately.

## TURN bootstrap

Defined in `signalling/web/turn.go` and initialized from `web.InitWeb`.

- Binds a TURN UDP server on `turn_listen_ip:turn_port` with realm `turn_realm`.
- Uses `public_ip` for relayed addresses so peers outside can reach them.
- Auth handler `HandleTurnAuth(username, password, addr)` only accepts `username` equal to a known `room.ID`. It returns that room's `TKey` as the expected password.

Client hint for TURN connection is sent as the first WS message (see below) and is the string:

```json
["-1", "<turn_realm>:<turn_port>"]
```

Client convention:

- TURN URL: `turn:<turn_realm>:<turn_port>`
- TURN username: `roomID`
- TURN credential: `cKey`

Note: The server derives `TKey` internally from `(roomID, turn_realm, cKey)` to validate the credential.

## Signalling WebSocket (`/ws/:room_id`)

Connect with query params:

- `k` (string): key — `mKey` for master, `cKey` for clients
- `m` ("t"|"f"): whether this connection is the master

Join rules (implemented in `handler.joinRoom`):

- Master: `m=t` and `k == MKey`. Only one master is allowed; second master is rejected.
- Client: `m=f` and `k == CKey`. Master must already be connected; otherwise join is rejected.

On successful join the server immediately sends the TURN hint:

```json
["-1", "<turn_realm>:<turn_port>"]
```

Then the server relays signalling messages bidirectionally according to the protocol below.

On join failure the server emits a terminal error frame before closing the socket so the client can branch UI:

```json
["-2", "room_not_found" | "invalid_key" | "missing_key" | "master_exists" | "master_absent"]
```

### Message framing

- Transport: WebSocket binary/text frames (server uses JSON encoding)
- Payload: JSON-encoded string array `[type, ...fields]`
- Message types are scoped by direction; indices start at 0 (Go `iota`).

#### Server → Master

```json
["0", "<clientID>"]              // Joined (ProtoSMJoined)
["1", "<clientID>"]              // Left (ProtoSMLeft)
["2", "<clientID>", "<msg>"]    // Relay client message (ProtoSMMsg)
```

#### Master → Server

```json
["0", "<clientID>", "<msg>"] // Relay to a specific client (ProtoMSMsg)
```

#### Server → Client

```json
["0", "<msg>"]                   // Relay master message (ProtoSCMsg)
["1"]                             // Master gone; connection will close (ProtoSCGone)
```

#### Client → Server

```json
["0", "<msg>"] // Relay to master (ProtoCSMsg)
```

`<msg>` is an opaque string from the server's perspective (typically JSON SDP/ICE content). The server does not inspect it; it only forwards between participants.

## Discovery WebSocket (`/discover?ip=<public-ip>`)

Purpose: allows UIs to list rooms discoverable for a given public IP.

Guards: `ip` must be a public IP (checked by `util.IsIPPublic`), otherwise 400.

On connect the server registers the WS under that IP and immediately emits all currently discoverable rooms for that IP as add events. It then keeps the connection open and pushes subsequent add/remove events.

Message framing (server → client only):

```json
["0", "<roomID>", "<name>", "<emoji>"]   // add discoverable room
["1", "<roomID>"]                          // remove discoverable room
```

## PIN-gated client key retrieval (`GET /room`)

Endpoint: `GET /room?id=<roomID>&pin=<pin>`

- On success: `["<cKey>"]`
- On failure: `401` (invalid room or PIN) or `400` (missing params)

This is used by a receiver after the user enters the room PIN, allowing the UI to retrieve the `cKey` needed to connect to `/ws/:room_id` as a client.

## End-to-end flow

1. Sender creates a room:

```http
POST /room
Body: ["t", "<public-ip>"]  // or ["f"] if not discoverable
→ [roomID, mKey, cKey, name, pin, emoji]
```

2. Sender (master) connects signalling WS and gets TURN hint:

```http
GET /ws/<roomID>?k=<mKey>&m=t  (WebSocket)
← ["-1", "<turn_realm>:<turn_port>"]
```

3. Receiver discovers the room (optional discovery channel):

```http
GET /discover?ip=<public-ip>  (WebSocket)
← ["0", "<roomID>", "<name>", "<emoji>"]  // add events
```

4. Receiver enters PIN to obtain client key:

```http
GET /room?id=<roomID>&pin=<pin>
→ ["<cKey>"]
```

5. Receiver (client) connects signalling WS and gets TURN hint:

```http
GET /ws/<roomID>?k=<cKey>&m=f  (WebSocket)
← ["-1", "<turn_realm>:<turn_port>"]
```

6. Server assigns `clientID` and notifies master:

```json
Server → Master: ["0", "<clientID>"]  // joined
```

7. SDP/ICE relay begins:

```json
Client → Server: ["0", "<msg>"]
Server → Master: ["2", "<clientID>", "<msg>"]
Master → Server: ["0", "<clientID>", "<msg>"]
Server → Client: ["0", "<msg>"]
```

8. Disconnect semantics:

- Client leaves:
  - Server → Master: `["1", "<clientID>"]`
- Master leaves:
  - Server → all Clients: `["1"]` (gone)
  - Room deleted and removed from discovery registry

## Operational notes

- CORS: only `cors_endpoint` is allowed as origin.
- Concurrency: server uses lock-free maps via `xsync` to track rooms/clients and discovery subscribers.
- Validation: server validates keys and enforces single-master; it does not inspect signalling payloads.
- Security: keys and PIN are randomly generated; TURN auth uses long-term credentials derived from room ID, realm and client key.

## Quick reference

- Create room: `POST /room` → `[roomID, mKey, cKey, name, pin, emoji]`
- Get client key: `GET /room?id=<roomID>&pin=<pin>` → `[cKey]`
- WS signalling: `/ws/:room_id?k=<mKey|cKey>&m=t|f` (first message: `["-1", "<turn_realm>:<turn_port>"]`)
- Discovery WS: `/discover?ip=<public-ip>` → add `["0", id, name, emoji]`, remove `["1", id]`
