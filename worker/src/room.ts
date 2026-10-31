import { DurableObject } from "cloudflare:workers";

import type { RoomInfo } from "./directory";
import { type Env, masterGrace, maxPeers, roomTTL } from "./env";
import { iceServers } from "./ice";
import { checkKey, randomID } from "./keys";
import { findAvatar, randomAvatar, roomName } from "./names";
import { discoveryKeys } from "./net";

export interface RoomMeta extends RoomInfo {
  pin: string;
  discoverable: boolean;
  createdAt: number;
  expiresAt: number;
  masterSeen: boolean;
  /** When the sender's last socket closed; 0 while connected. */
  masterGoneAt: number;
}

/** Per-socket state that survives hibernation. */
interface Attachment {
  role?: "master" | "peer";
  peerId?: string;
  /** Client address, for discovery keys when the sender restores a room. */
  ip: string;
  roomId: string;
}

interface ClientMsg {
  t?: string;
  role?: string;
  key?: string;
  to?: string;
  data?: unknown;
  /** A reconnecting receiver's previous id. */
  resume?: string;
  restore?: {
    name?: string;
    emoji?: string;
    pin?: string;
    discoverable?: boolean;
    ip?: string;
    ip6?: string;
  };
}

const PING = '{"t":"ping"}';
const PONG = '{"t":"pong"}';
const MAX_MESSAGE = 64 * 1024;

/**
 * One share. Holds the sender ("master") and receivers ("peers") websockets
 * and relays WebRTC signalling between them. Uses the hibernation API, so an
 * idle room costs nothing while sockets stay open.
 */
export class Room extends DurableObject<Env> {
  private meta: RoomMeta | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats are answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
    void ctx.blockConcurrencyWhile(async () => {
      this.meta = await ctx.storage.get<RoomMeta>("meta");
    });
  }

  private get directory() {
    return this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName("global"));
  }

  /** Called by the entry worker right after POST /api/rooms. */
  async init(meta: RoomMeta): Promise<void> {
    this.meta = meta;
    await this.ctx.storage.put("meta", meta);
    // The sender must connect within the grace period.
    await this.ctx.storage.setAlarm(meta.createdAt + masterGrace(this.env));
  }

  async fetch(request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({
      ip: request.headers.get("X-Client-IP") ?? "",
      roomId: request.headers.get("X-Room-Id") ?? "",
    } satisfies Attachment);
    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------

  private sockets() {
    return this.ctx
      .getWebSockets()
      .map((ws) => ({ ws, att: ws.deserializeAttachment() as Attachment }));
  }

  private masters() {
    return this.sockets().filter((s) => s.att.role === "master");
  }

  private peers() {
    return this.sockets().filter((s) => s.att.role === "peer");
  }

  private send(ws: WebSocket, msg: unknown) {
    try {
      ws.send(JSON.stringify(msg));
    } catch {
      // socket is going away
    }
  }

  private fail(ws: WebSocket, code: string) {
    this.send(ws, { t: "error", code });
    try {
      ws.close(4000, code);
    } catch {
      // already closed
    }
  }

  private info(): RoomInfo {
    const m = this.meta!;
    return { id: m.id, name: m.name, emoji: m.emoji, color: m.color };
  }

  private async save() {
    if (this.meta) await this.ctx.storage.put("meta", this.meta);
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer) {
    if (typeof raw !== "string" || raw.length > MAX_MESSAGE) return;
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;

    if (!att.role) {
      if (msg.t !== "auth") return this.fail(ws, "bad_request");
      return this.auth(ws, att, msg);
    }
    if (!this.meta) return this.fail(ws, "room_not_found");

    if (msg.t === "ping") return this.send(ws, { t: "pong" });

    if (att.role === "master") {
      if (msg.t === "signal" && typeof msg.to === "string") {
        const peer = this.peers().find((p) => p.att.peerId === msg.to);
        if (peer) this.send(peer.ws, { t: "signal", data: msg.data });
        else
          this.send(ws, { t: "error", code: "peer_not_found", peer: msg.to });
      } else if (msg.t === "close") {
        await this.closeRoom();
      }
      return;
    }

    if (msg.t === "signal") {
      const masters = this.masters();
      if (masters.length === 0)
        return this.send(ws, { t: "error", code: "master_absent" });
      for (const m of masters)
        this.send(m.ws, { t: "signal", from: att.peerId, data: msg.data });
    }
  }

  private async auth(ws: WebSocket, att: Attachment, msg: ClientMsg) {
    const id = this.meta?.id ?? att.roomId;

    if (msg.role === "master") {
      if (!(await checkKey(this.env.SERVER_SECRET, "m", id, msg.key)))
        return this.fail(ws, "invalid_key");
      if (!this.meta) {
        // The room was forgotten (expired storage, manual cleanup): the
        // sender holds the master key, so it may re-create it.
        if (!msg.restore) return this.fail(ws, "room_not_found");
        await this.restore(id, att, msg.restore);
      }

      for (const m of this.masters()) {
        if (m.ws !== ws) {
          try {
            m.ws.close(4001, "replaced");
          } catch {
            // already closed
          }
        }
      }
      ws.serializeAttachment({ ...att, role: "master" } satisfies Attachment);

      const meta = this.meta!;
      meta.masterSeen = true;
      meta.masterGoneAt = 0;
      await this.save();
      await this.ctx.storage.setAlarm(meta.expiresAt);

      const peers = this.peers();
      for (const p of peers) this.send(p.ws, { t: "master", online: true });
      this.send(ws, {
        t: "welcome",
        role: "master",
        room: this.info(),
        pin: meta.pin,
        expiresAt: new Date(meta.expiresAt).toISOString(),
        peers: peers.map((p) => p.att.peerId),
        iceServers: await iceServers(this.env),
      });
      return;
    }

    if (msg.role === "peer") {
      if (!(await checkKey(this.env.SERVER_SECRET, "c", id, msg.key)))
        return this.fail(ws, "invalid_key");
      if (!this.meta) return this.fail(ws, "room_not_found");
      // A receiver that reconnects (e.g. iOS suspended the tab) reclaims its
      // id, so the sender keeps one row and can reuse the peer connection.
      // Ids are random and only ever shared with the sender, so they can't
      // be guessed by other receivers.
      const resume =
        typeof msg.resume === "string" && /^[A-Za-z0-9]{16}$/.test(msg.resume)
          ? msg.resume
          : undefined;
      const stale = resume
        ? this.peers().filter((p) => p.att.peerId === resume)
        : [];
      if (this.peers().length - stale.length >= maxPeers(this.env))
        return this.fail(ws, "room_full");

      let peerId = resume;
      if (!peerId) {
        const taken = new Set(this.peers().map((p) => p.att.peerId));
        do peerId = randomID(16);
        while (taken.has(peerId));
      }
      ws.serializeAttachment({
        ...att,
        role: "peer",
        peerId,
      } satisfies Attachment);
      for (const old of stale) {
        try {
          old.ws.close(4001, "replaced");
        } catch {
          // already closed
        }
      }

      const masters = this.masters();
      for (const m of masters) this.send(m.ws, { t: "join", peer: peerId });
      this.send(ws, {
        t: "welcome",
        role: "peer",
        peerId,
        room: this.info(),
        online: masters.length > 0,
        iceServers: await iceServers(this.env),
      });
      return;
    }

    this.fail(ws, "bad_request");
  }

  private async restore(
    id: string,
    att: Attachment,
    r: NonNullable<ClientMsg["restore"]>,
  ) {
    const avatar = findAvatar(r.emoji) ?? randomAvatar();
    const name =
      typeof r.name === "string" && r.name.length > 0 && r.name.length <= 64
        ? r.name
        : roomName();
    const info: RoomInfo = {
      id,
      name,
      emoji: avatar.emoji,
      color: avatar.color,
    };
    const pin = await this.directory.claimPin(info, r.pin);
    const now = Date.now();
    this.meta = {
      ...info,
      pin,
      discoverable: !!r.discoverable,
      createdAt: now,
      expiresAt: now + roomTTL(this.env),
      masterSeen: true,
      masterGoneAt: 0,
    };
    await this.save();
    if (r.discoverable)
      await this.directory.announce(info, discoveryKeys(att.ip, r.ip, r.ip6));
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string) {
    try {
      ws.close(code, reason);
    } catch {
      // already closed
    }
    await this.onGone(ws);
  }

  async webSocketError(ws: WebSocket) {
    await this.onGone(ws);
  }

  private async onGone(ws: WebSocket) {
    if (!this.meta) return;
    const att = ws.deserializeAttachment() as Attachment;
    if (att.role === "master") {
      if (this.masters().some((m) => m.ws !== ws)) return;
      this.meta.masterGoneAt = Date.now();
      await this.save();
      for (const p of this.peers())
        this.send(p.ws, { t: "master", online: false });
      await this.ctx.storage.setAlarm(
        this.meta.masterGoneAt + masterGrace(this.env),
      );
    } else if (att.role === "peer") {
      // Replaced by a reconnect of the same receiver: not a departure.
      if (this.peers().some((p) => p.ws !== ws && p.att.peerId === att.peerId))
        return;
      for (const m of this.masters())
        this.send(m.ws, { t: "leave", peer: att.peerId });
    }
  }

  /** Expiry: absolute lifetime, or the sender gone longer than the grace period. */
  async alarm() {
    const meta = this.meta;
    if (!meta) return;
    const now = Date.now();
    const grace = masterGrace(this.env);
    const masterPresent = this.masters().length > 0;

    const expired =
      now >= meta.expiresAt ||
      (!meta.masterSeen && now - meta.createdAt >= grace) ||
      (!masterPresent &&
        meta.masterGoneAt > 0 &&
        now - meta.masterGoneAt >= grace);
    if (expired) {
      await this.closeRoom();
      return;
    }

    let next = meta.expiresAt;
    if (!meta.masterSeen) next = Math.min(next, meta.createdAt + grace);
    else if (!masterPresent && meta.masterGoneAt > 0)
      next = Math.min(next, meta.masterGoneAt + grace);
    await this.ctx.storage.setAlarm(next);
  }

  private async closeRoom() {
    const meta = this.meta;
    if (!meta) return;
    this.meta = undefined;
    for (const { ws } of this.sockets()) {
      this.send(ws, { t: "closed" });
      try {
        ws.close(1000, "room closed");
      } catch {
        // already closed
      }
    }
    await this.directory.releasePin(meta.pin, meta.id);
    if (meta.discoverable) await this.directory.withdraw(meta.id);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}
