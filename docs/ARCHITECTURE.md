# Architecture

```
 sender browser ◀──── WebRTC data channel (DTLS, peer-to-peer) ────▶ receiver browser
       │                     (or via Cloudflare TURN)                      │
       └──────────── websocket signalling ─────┐   ┌──── websocket ────────┘
                                               ▼   ▼
                          Cloudflare Worker  (worker/src/index.ts)
                          ├─ static assets: the PWA (dist/)
                          ├─ Room durable object   × one per share
                          └─ Directory durable object × 1 (PINs, nearby, rate limits)
```

## Repository layout

| Path                               | What                                                                             |
| ---------------------------------- | -------------------------------------------------------------------------------- |
| `src/`                             | React PWA                                                                        |
| `src/lib/transfer/`                | Transport-agnostic transfer protocol (`ItemServer` sends, `ItemClient` receives) |
| `src/lib/sender.ts`, `receiver.ts` | WebRTC sessions: peer connections, ICE restart, reconnects                       |
| `src/lib/signal.ts`                | Signalling websocket with reconnect and heartbeat                                |
| `src/lib/sinks/`                   | Where received bytes go: save picker, service-worker stream, OPFS, memory        |
| `src/sw.ts`                        | Service worker: cached app shell, share target, streamed downloads                  |
| `worker/src/`                      | Cloudflare Worker and durable objects                                            |
| `e2e/`                             | Playwright tests                                                                 |

## Signalling

### HTTP

| Request                                 | Response                                                         |
| --------------------------------------- | ---------------------------------------------------------------- |
| `POST /api/rooms` `{discoverable, ip?}` | `{id, name, emoji, color, masterKey, clientKey, pin, expiresAt}` |
| `POST /api/join` `{pin, roomId?}`       | `{room, clientKey}`, rate limited per client                     |
| `GET /api/info`                         | `{version, turn, maxPeers}`                                      |

`ip` is the browser's public IPv4 address from STUN, used only to match devices for "Nearby".

### Room websocket: `GET /ws/room/:id`

The first client message authenticates (keys never appear in URLs):

```jsonc
{ "t": "auth", "role": "master" | "peer", "key": "…", "restore": { … } }
```

| Server → client  |                                                            |
| ---------------- | ---------------------------------------------------------- |
| `welcome`        | `{role, room, iceServers, pin?, peers?, peerId?, online?}` |
| `join` / `leave` | (to sender) a receiver connected / disconnected            |
| `signal`         | relayed WebRTC payload (`from` is set for the sender)      |
| `master`         | (to receivers) sender online/offline                       |
| `closed`         | the share ended                                            |
| `error`          | `{code}`: `invalid_key`, `room_not_found`, `room_full`, …  |

Clients send `signal` (`to` is required from the sender), `close` (sender ends the share) and the heartbeat `{"t":"ping"}`. The runtime answers heartbeats directly, so they don't wake the durable object.

**Room keys** are `HMAC(SERVER_SECRET, role | roomId)`. Because they're derived, a sender can re-create a room the server has forgotten by sending `restore` with its master key. The share link only contains the client key, so a receiver can never act as the sender.

**Lifecycle**: a share closes when the sender ends it, when the sender has been disconnected for `MASTER_GRACE_SECONDS`, or after `ROOM_TTL_HOURS` (durable object alarms). A sender that reconnects takes over from its stale socket and is told which receivers are waiting.

### Nearby: `GET /ws/discover?ip=…`

The Directory object lists discoverable shares per network: the same public IPv4 address, or the same IPv6 /64. Watchers get `add` / `remove` events.

## Transfer protocol (data channel)

Control messages are JSON strings; file bytes are binary messages. See `src/lib/transfer/protocol.ts`.

```
sender                          receiver
hello {items}          ──▶
                       ◀──      get {id, offset}
start {id, offset}     ──▶
<binary chunks>        ──▶      writes to sink, hashes
                       ◀──      ack {id, received}     every 1 MiB written
end {id, sha256}       ──▶
                       ◀──      done {id, ok}
```

- **Throughput**: chunks up to 256 KiB (bounded by the negotiated SCTP max message size); the sender keeps up to 8 MiB buffered in the channel.
- **Backpressure**: the sender never runs more than 32 MiB ahead of the receiver's last ack, so a slow disk can't make the receiver buffer gigabytes.
- **Integrity**: the sender hashes each file in a worker; the receiver hashes incrementally and compares.
- **Resume**: a brief network change triggers an ICE restart, which keeps the data channel, so nothing is lost. If the connection dies, the receiver asks for a fresh one and re-requests the file from the last byte it received, keeping its hash state.

## Receiving large files

| Browser                 | Strategy                                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------- |
| Chromium desktop        | File System Access API: writes directly to the chosen file or folder                                |
| Chrome Android, Firefox | Service-worker streamed download                                                                    |
| Safari macOS / iOS      | Origin Private File System (worker + sync access handle), then save via download or the share sheet |
| Fallback                | In-memory blob                                                                                      |

iOS has no save picker, so writing to private storage first is what lets it receive files larger than its in-memory blob limit.
