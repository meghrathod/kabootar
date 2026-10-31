import { DurableObject } from "cloudflare:workers";

import type { Env } from "./env";
import { randomPIN, validPIN } from "./keys";

export interface RoomInfo {
  id: string;
  name: string;
  emoji: string;
  color: string;
}

interface PinEntry {
  info: RoomInfo;
}

interface Bucket {
  count: number;
  reset: number;
}

const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';

/**
 * The single global object: unique PINs, LAN discovery and abuse limits.
 * Everything it does is tiny, so one instance comfortably serves the app.
 *
 * Storage layout:
 *   pin:<pin>          → PinEntry
 *   net:<key>:<roomId> → RoomInfo   (discoverable rooms per network)
 *   room:<roomId>      → string[]   (the network keys a room is listed under)
 */
export class Directory extends DurableObject<Env> {
  // Rate limits are kept in memory; resetting them on eviction is harmless.
  private buckets = new Map<string, Bucket>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  /** Fixed-window limiter keyed by bucket and client. */
  allow(
    bucket: string,
    client: string,
    limit: number,
    windowMs = 60_000,
  ): boolean {
    const key = `${bucket}:${client}`;
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now >= b.reset) {
      b = { count: 0, reset: now + windowMs };
      this.buckets.set(key, b);
    }
    if (this.buckets.size > 50_000) {
      for (const [k, v] of this.buckets)
        if (now >= v.reset) this.buckets.delete(k);
    }
    return ++b.count <= limit;
  }

  /** Reserve a unique PIN for a room, keeping `preferred` if it's free. */
  async claimPin(info: RoomInfo, preferred?: string): Promise<string> {
    if (validPIN(preferred)) {
      const existing = await this.ctx.storage.get<PinEntry>(`pin:${preferred}`);
      if (!existing || existing.info.id === info.id) {
        await this.ctx.storage.put(`pin:${preferred}`, {
          info,
        } satisfies PinEntry);
        return preferred;
      }
    }
    for (;;) {
      const pin = randomPIN();
      if (!(await this.ctx.storage.get(`pin:${pin}`))) {
        await this.ctx.storage.put(`pin:${pin}`, { info } satisfies PinEntry);
        return pin;
      }
    }
  }

  async releasePin(pin: string, roomId: string): Promise<void> {
    const entry = await this.ctx.storage.get<PinEntry>(`pin:${pin}`);
    if (entry?.info.id === roomId) await this.ctx.storage.delete(`pin:${pin}`);
  }

  /**
   * Exchange a PIN for its room. PINs are only six digits, so guesses are
   * throttled hard per client address.
   */
  async lookup(
    pin: string,
    roomId: string | undefined,
    client: string,
  ): Promise<RoomInfo | "rate_limited" | null> {
    if (!this.allow("join", client, 12)) return "rate_limited";
    if (!validPIN(pin)) return null;
    const entry = await this.ctx.storage.get<PinEntry>(`pin:${pin}`);
    if (!entry || (roomId && entry.info.id !== roomId)) return null;
    return entry.info;
  }

  allowCreate(client: string): boolean {
    return this.allow("create", client, 30);
  }

  /** List a room for nearby devices and notify anyone watching those networks. */
  async announce(info: RoomInfo, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    const entries: Record<string, unknown> = { [`room:${info.id}`]: keys };
    for (const k of keys) entries[`net:${k}:${info.id}`] = info;
    await this.ctx.storage.put(entries);

    const msg = JSON.stringify({ t: "add", room: info });
    const sent = new Set<WebSocket>();
    for (const k of keys) {
      for (const ws of this.ctx.getWebSockets(k)) {
        if (sent.has(ws)) continue;
        sent.add(ws);
        safeSend(ws, msg);
      }
    }
  }

  async withdraw(roomId: string): Promise<void> {
    const keys = await this.ctx.storage.get<string[]>(`room:${roomId}`);
    if (!keys) return;
    await this.ctx.storage.delete([
      `room:${roomId}`,
      ...keys.map((k) => `net:${k}:${roomId}`),
    ]);
    const msg = JSON.stringify({ t: "remove", id: roomId });
    const sent = new Set<WebSocket>();
    for (const k of keys) {
      for (const ws of this.ctx.getWebSockets(k)) {
        if (sent.has(ws)) continue;
        sent.add(ws);
        safeSend(ws, msg);
      }
    }
  }

  /** Discovery websocket. The entry worker passes the client's network keys. */
  async fetch(request: Request): Promise<Response> {
    const keys = JSON.parse(
      request.headers.get("X-Discovery-Keys") ?? "[]",
    ) as string[];
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    // Tags let announce/withdraw find watchers by network.
    this.ctx.acceptWebSocket(server, keys.slice(0, 4));
    // Tell the client which networks it is matched on (diagnostics), and
    // whether a privacy relay hides its network entirely.
    server.send(
      JSON.stringify({
        t: "network",
        keys,
        hidden: request.headers.get("X-Network-Hidden") === "1",
      }),
    );

    const seen = new Set<string>();
    for (const k of keys) {
      const rooms = await this.ctx.storage.list<RoomInfo>({
        prefix: `net:${k}:`,
      });
      for (const info of rooms.values()) {
        if (seen.has(info.id)) continue;
        seen.add(info.id);
        server.send(JSON.stringify({ t: "add", room: info }));
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage() {
    // Watchers only receive; pings are answered by the auto-response.
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
  }
}

function safeSend(ws: WebSocket, msg: string) {
  try {
    ws.send(msg);
  } catch {
    // socket is going away
  }
}
