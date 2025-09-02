## Web app architecture and flow

SolidJS + Vite frontend that orchestrates file sharing over a WebRTC data channel, using a lightweight signalling server for room management, discovery, and TURN bootstrap.

Key areas in `src/`:

- `config.ts`: runtime configuration and ICE servers
- `connection/`: signalling WS, discovery, public IP extraction, room orchestration
- `downloader/`: file saving strategies (Stream, Blob)
- `pages/`: UI pages for create/share/discover flows
- `components/`: dialogs and UI elements (PIN entry, QR, buttons)
- `utils/`: browser helpers and share target plumbing
- `sw.ts`: service worker for streaming downloads + Web Share Target

## Configuration (`src/config.ts`)

- `iceServers`: Google STUNs and pool size
- `secure` (boolean): toggles `httpScheme` and `wsScheme` between http/ws and https/wss
- `baseURL` (string): host:port for signalling
- Derived: `httpScheme`, `wsScheme`

Used everywhere the app talks to the signalling server and during WebRTC peer connection construction.

## Room orchestration (`src/connection/room.ts`)

`Room<Master extends boolean>` encapsulates all frontend P2P operations and signalling.

Public API:

- `Room.create(file, dispatcher)` → Promise<Room<true> | undefined>
  - POST `/room` with discovery params
  - Receives `[roomID, mKey, cKey, roomName, pin, emoji]`
  - Opens WS `/ws/:id?k=<mKey>&m=t`, expects first message `[-1, turnHost:port]`
  - Returns a master `Room` instance (sender)

- `Room.joinDirect(id, key, dispatcher)` → Promise<{ room?: Room<false>; error?: string }>
  - Opens WS `/ws/:id?k=<cKey>&m=f`, expects first message `[-1, turnHost:port]`
  - On failure receives a terminal error `[-2, reason]` and returns `{ error: reason }`
  - Returns `{ room }` with a client `Room` instance (receiver) on success

- `Room.getClientKey(id, pin)` → Promise<string | void>
  - GET `/room?id=<id>&pin=<pin>` → `[cKey]`

- `room.constructHash()` → `"k=<clientKey>"`
- `room.dispatch(event)` → forwards to handler (used by receiver to send `ready`)
- `room.close()` → closes the signalling WS

Event dispatchers (callbacks provided by pages):

- Master: `{ numClientsChanged(n: number) }`
- Client: `{ receivePercentageChanged, connectionStatusChanged, needsStart, roomMetaChanged, connectionSpeed, complete }`

### Master flow

Handled by `MasterHandler` once a master `Room` is created:

- Listens to server WS messages:
  - `["0", clientID]` → a client joined; instantiate `MasterClient`
  - `["1", clientID]` → client left; close and remove
  - `["2", clientID, msg]` → signalling from that client

- `MasterClient` per receiver:
  - Builds `RTCPeerConnection` with STUN + TURN:
    - `urls: turn:<turnServer>?transport=tcp`, `username: roomID`, `credential: clientKey`
  - Creates data channel label `"d"` and immediately creates offer
  - Sends signalling to server via WS: `["0", clientID, JSON.stringify([OFFER|TRICKLE_ICE, payload])]`
  - First data-channel payload is metadata as ArrayBuffer: JSON `[fileName, fileSize, roomName, emoji]`
  - File send loop:
    - Slices file into 16 KiB chunks
    - Uses `bufferedAmountLowThreshold` to handle backpressure and resume sending
    - Waits for client to send `"ready"` before streaming

### Client flow

Handled by `ClientHandler` after `joinDirect` or a share link open:

- Builds `RTCPeerConnection` with STUN + TURN:
  - `urls: turn:<turnServer>?transport=tcp`, `username: roomID`, `credential: cKey`
- On `datachannel` with label `"d"`:
  - First message parsed as metadata
  - Chooses a `FileDownloader` strategy and updates UI
  - Sets `needsStart(true)`; when user clicks start → `dispatch("ready")` → initialize downloader and send `"ready"`
- Signalling WS messages:
  - `["0", msg]` → signalling from master; handles OFFER and TRICKLE_ICE
  - `["1"]` → master gone; mark disconnected and surface `masterGone()` callback
- Tracks progress, instantaneous speed, and completion

## Discovery (`src/connection/discovery.ts`)

- Computes public IP via STUN (see `ip.ts` below)
- Connects to WS `/discover?ip=<public-ip>`
- Server messages:
  - `["0", id, name, emoji]` → add room
  - `["1", id]` → remove room
- Provides `added(room)` and `removed(id)` callbacks to UI

## Public IP extraction (`src/connection/ip.ts`)

- Creates a temporary `RTCPeerConnection` using the configured ICE servers
- Parses ICE candidates to find the first public IPv4 address
- Resolves with the discovered IP or rejects on failure

## File download strategies (`src/downloader/*`)

Interface: `FileDownloader { initialize, append, finalize }`.

- `StreamFileDownloader`
  - Preferred when a service worker is active and not Safari
  - Creates a `ReadableStream` and posts a message to the SW with `{ name, size, seed, port, stream }`
  - Receives a one-time URL from SW; loads it in a hidden iframe to trigger a streamed download with correct headers
  - Appends chunks via `controller.enqueue` and closes the stream on completion

- `BlobFileDownloader`
  - Fallback path; collects chunks in memory, builds a Blob, and programmatically clicks a download link

Selection: `getFileDownloader(name, size)` picks Stream then Blob.

## Service worker (`src/sw.ts`)

Registered in `src/index.tsx` as `/sw.js` with scope `/`.

Responsibilities:

- Streaming downloads
  - Maintains a map of in-flight stream URLs → metadata
  - Receives `type: "stream"` messages to register a new stream URL
  - Serves `GET /stream/<seed>` with proper `Content-Type`, `Content-Length`, and `Content-Disposition`, responding with the provided `ReadableStream`
  - Supports a simple `/stream/ping` check

- Web Share Target POST (`/share-target`)
  - Accepts incoming files, title, text, url
  - Persists payload into IndexedDB store `incoming/latest`
  - Redirects to `/` with `?share-target=1` so `Home` can fetch and use the payload

## Share Target utilities (`src/utils/shareTarget.ts`)

- Opens IndexedDB `kabootar-share-target`
- Exposes `takeSharedPayload()` which reads and clears `incoming/latest`
- Used by `Home` to auto-start a share when launched via the OS/Web Share Target

## Browser helpers (`src/utils/browser.ts`)

- Detects Safari/iOS and exposes `MAX_SAFARI_FILE_SIZE` (2GB)
- `validateFileSize(file)` helper for pre-validating large files on constrained platforms

## Pages

### `Home.tsx`

- Drag-and-drop or file picker to select a file and call `Room.create`
- Navigates to `/:roomID#k=<clientKey>` and stores the `Room` in a shared signal
- Detects Share Target launches (`?share-target=1`) and initiates sharing with the first shared file

### `Discover.tsx`

- Connects `Discovery` client and renders rooms as they appear
- On room click: opens `PinEntryDialog`; on PIN submit, fetches `cKey` and navigates to `/:id#k=<cKey>`

### `Share.tsx`

- If a `Room` is present (sender) → shows share UI and peer count; otherwise attempts to join as client using URL hash
- Client UI shows metadata, connection status, explicit start button, progress, and speed; dispatches `ready` to start receiving
- Cleans up by closing `Room` on unload
- Handles connection failure reasons and navigates accordingly:
  - `room-not-found` for invalid/expired link
  - `room-unavailable` when the sender isn’t connected yet
  - `room-closed` when the sender disconnects while on the page

### Error pages

- `RoomNotFound.tsx` → invalid/expired link
- `RoomUnavailable.tsx` → sender not connected yet
- `RoomClosed.tsx` → sender closed the room

## Components

- `PinEntryDialog`: Modal to collect the 6-digit room PIN
- `QRDialog`: Renders a QR code for the share URL (uses `qrcode-svg`)
- `DiscoveredRoom`: List item for a discoverable room (uses `emojiBackground`)
- `Button`: `PrimaryButton` and `SexyButton` used across pages

## Routing (`src/App.tsx`)

- `/` → `Home`
- `/discover` → `Discover`
- `/:id` → `Share`

## End-to-end flows

### Sender

1. Select file on `Home` → `Room.create`
2. Server responds with room + keys; master WS opens and emits TURN hint
3. UI navigates to `/:roomID#k=<cKey>`; displays share URL and QR
4. For each joining client, a `MasterClient` sends offer → receives answer → streams chunks after `"ready"`

### Receiver

1. Discover rooms on `Discover` (optional) or navigate directly via share URL
2. If discovering: enter PIN → fetch `cKey` → navigate to `/:id#k=<cKey>`
3. Client WS opens and receives TURN hint; WebRTC sets up
4. On data channel open, metadata arrives; user clicks Start → download begins (Stream or Blob strategy)
5. UI shows progress and instantaneous speed; finalizes and returns to Home

## Quick reference

- Create: `Room.create(file, dispatcher)`
- Join: `Room.joinDirect(id, cKey, dispatcher)`
- PIN → key: `Room.getClientKey(id, pin)`
- WS first message: `[-1, turnHost:port]`
- Data channel label: `"d"`, metadata is first message as ArrayBuffer JSON `[fileName, fileSize, roomName, emoji]`
- Chunk size: 16 KiB; backpressure via `bufferedAmountLowThreshold`
