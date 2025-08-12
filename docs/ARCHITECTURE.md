### Kabootar Architecture

This document maps the high-level architecture and call flows for the P2P file sharing app. It complements `docs/signalling.md`.

## Overview

- **Frontend**: SolidJS + Vite in `src/`.
- **Signalling**: Go (Fiber, WebSocket) in `signalling/` with a built-in UDP TURN server (pion/turn).
- **Transport**: WebRTC data channels; metadata first, then file chunks.

## Frontend layout

- `src/config.ts`: STUN list, `secure`, `baseURL`, schemes.
- `src/connection/room.ts`: Orchestrates signalling and WebRTC.
  - `Room.create(file, dispatcher)` → POST `/room` then WS to `/ws/:id?k=<mKey>&m=t`.
  - `Room.joinDirect(id, cKey, dispatcher)` → WS `/ws/:id?k=<cKey>&m=f`.
  - First server message is `["-1", turnHost:port]` used to augment ICE servers.
  - `MasterHandler` creates offer, sends metadata and file chunks.
  - `ClientHandler` answers, initializes downloader, tracks speed/percent.
- `src/connection/discovery.ts`: LAN/WAN discovery via WS `/discover?ip=<public-ip>`.
- `src/connection/ip.ts`: obtains public IP via STUN candidates.
- UI pages: `src/pages/Home.tsx`, `src/pages/Discover.tsx`, `src/pages/Share.tsx`.
- Downloaders: `src/downloader/stream.ts` (Service Worker stream) → `src/downloader/blob.ts` fallback.
- Service worker: `src/sw.ts` serves streamed downloads via `fetch` handler.

## Signalling layout

- Entry point: `signalling/cmd/signalling/main.go`.
- App init/routes: `signalling/web/web.go`.
- Handler core: `signalling/web/handler.go` (rooms, discovery clients, TURN, routing of WS messages).
- WS upgrade guard + room WS: `signalling/web/signalling.go`.
- Room model: `signalling/web/room.go` (keys, PIN, name, emoji, TURN key).
- Protocol: `signalling/web/protocol.go` (numeric message types, marshal/unmarshal helpers).
- REST:
  - `POST /room` → `signalling/web/create_room.go`
  - `GET /room` (PIN exchange) and `WS /discover` → `signalling/web/discovery.go`
- TURN: `signalling/web/turn.go` (UDP listener, auth bound to room credentials).
- Config: `signalling/config/config.go` + `kabootar.toml`.

## Protocols

### HTTP

- `POST /room` with body `["t"|"f", ip?]` returns `[roomID, mKey, cKey, name, pin, emoji]`.
  - If body is `t,<public-ip>` and public, room is discoverable under that IP.
- `GET /room?id=<roomID>&pin=<6-digit>` returns `[cKey]` for the receiver.

### WebSocket: Room

- Path: `/ws/:room_id?k=<key>&m=t|f`.
- First server → client message: `["-1", "<turn-host>:<port>"]`.
- Server → Master
  - Join: `["0", clientID]`
  - Leave: `["1", clientID]`
  - Relay client signal: `["2", clientID, msg]`
- Master → Server: `["0", clientID, msg]` (send offer/ice to a client)
- Server → Client: `["0", msg]` (relay), `["1"]` (master gone)
- Client → Server: `["0", msg]` (answer/ice)

Message payloads are encoded as string arrays for compactness. See `signalling/web/protocol.go`.

### WebSocket: Discovery

- Path: `/discover?ip=<public-ip>`
- Server → Client messages:
  - Add: `["0", id, name, emoji]`
  - Remove: `["1", id]`

## WebRTC

- Data channel label: `d`.
- Metadata: first data-channel message from master is JSON `[fileName, fileSize, roomName, emoji]` encoded as ArrayBuffer.
- Chunking: 16 KiB slices with backpressure using `bufferedAmountLowThreshold`.
- ICE servers: Google STUNs + dynamic TURN from first WS server message.
  - Master TURN username = roomID; Client TURN username = client ID; credential = `cKey`.

## Flows

1.  Sender

- Picks file on Home → `Room.create` → server creates room → sender navigates to `/:id#k=<cKey>` for sharing link.
- Waits for clients; on join, master creates offer and initiates transfer per client.

2.  Receiver (via Discovery)

- Discover page obtains its public IP via STUN, opens `/discover` WS.
- Picks a room, enters PIN → GET `/room` to receive `cKey` → navigates to `/:id#k=<cKey>` → `Room.joinDirect`.

3.  Transfer

- Master data channel open → sends metadata → client prepares downloader and shows Start button → on Start, client sends `"ready"` → master streams file chunks.

## Config and deployment

- Frontend: configure `src/config.ts` (`secure`, `baseURL`).
- Signalling: `kabootar.toml` (`listen_address`, `cors_endpoint`, TURN realm/port, public/listen IPs).
- Ensure CORS allows the FE origin; FE scheme must match `wsScheme/httpScheme`.
