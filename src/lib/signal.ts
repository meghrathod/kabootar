import { wsBase } from "./config";
import type { RoomInfo } from "./api";
import { Emitter } from "./store";

export interface Welcome {
  role: "master" | "peer";
  room: RoomInfo;
  iceServers: RTCIceServer[];
  pin?: string;
  peers?: string[];
  peerId?: string;
  online?: boolean;
}

export type SignalStatus = "connecting" | "open" | "reconnecting" | "failed" | "closed";

type Events = {
  status: [SignalStatus];
  welcome: [Welcome];
  join: [string];
  leave: [string];
  signal: [data: unknown, from: string | undefined];
  master: [boolean];
  closed: [];
  error: [code: string, fatal: boolean];
};

export interface Auth {
  role: "master" | "peer";
  key: string;
  /** Receiver id from a previous connection, to keep the same identity. */
  resume?: string;
  restore?: { name: string; emoji: string; pin: string; discoverable: boolean; ip?: string; ip6?: string };
}

const FATAL = new Set(["invalid_key", "room_full", "bad_request"]);
const HEARTBEAT_MS = 15_000;
const DEAD_MS = 40_000;

/**
 * Room websocket with automatic reconnect, an application-level heartbeat
 * (browsers can't see protocol pings, so half-open sockets are otherwise
 * invisible) and fast reconnect when the network comes back.
 */
export class SignalSocket extends Emitter<Events> {
  status: SignalStatus = "connecting";

  private ws: WebSocket | undefined;
  private attempt = 0;
  private stopped = false;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private beatTimer: ReturnType<typeof setInterval> | undefined;
  private lastSeen = 0;
  /** Peers retry "room_not_found" for a while: the sender may be restoring the room after a redeploy. */
  private notFoundSince = 0;
  private everOpened = false;

  constructor(
    private roomId: string,
    private auth: () => Auth,
  ) {
    super();
    window.addEventListener("online", this.reconnectNow);
    document.addEventListener("visibilitychange", this.onVisible);
    this.connect();
  }

  send(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN || this.status !== "open") return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  signal(data: unknown, to?: string) {
    return this.send(to ? { t: "signal", to, data } : { t: "signal", data });
  }

  close(endRoom = false) {
    if (endRoom) this.send({ t: "close" });
    this.stopped = true;
    this.cleanup();
    window.removeEventListener("online", this.reconnectNow);
    document.removeEventListener("visibilitychange", this.onVisible);
    this.setStatus("closed");
  }

  private setStatus(s: SignalStatus) {
    if (this.status === s) return;
    this.status = s;
    this.emit("status", s);
  }

  private connect() {
    if (this.stopped) return;
    this.cleanup();
    const ws = new WebSocket(`${wsBase}/ws/room/${encodeURIComponent(this.roomId)}`);
    this.ws = ws;
    this.lastSeen = Date.now();

    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", ...this.auth() }));
    ws.onmessage = (e) => {
      this.lastSeen = Date.now();
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      this.handle(msg);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.scheduleReconnect();
    };

    this.beatTimer = setInterval(() => {
      if (Date.now() - this.lastSeen > DEAD_MS) {
        this.scheduleReconnect();
        return;
      }
      if (ws.readyState === WebSocket.OPEN) ws.send('{"t":"ping"}');
    }, HEARTBEAT_MS);
  }

  private handle(msg: Record<string, unknown>) {
    switch (msg.t) {
      case "welcome":
        this.attempt = 0;
        this.notFoundSince = 0;
        this.everOpened = true;
        this.setStatus("open");
        this.emit("welcome", msg as unknown as Welcome);
        break;
      case "join":
        this.emit("join", String(msg.peer));
        break;
      case "leave":
        this.emit("leave", String(msg.peer));
        break;
      case "signal":
        this.emit("signal", msg.data, msg.from as string | undefined);
        break;
      case "master":
        this.emit("master", !!msg.online);
        break;
      case "closed":
        this.stopped = true;
        this.emit("closed");
        this.close();
        break;
      case "error": {
        const code = String(msg.code);
        let fatal = FATAL.has(code);
        if (code === "room_not_found") {
          // After a redeploy the sender restores the room when it reconnects;
          // receivers that were already in the room keep retrying meanwhile.
          this.notFoundSince ||= Date.now();
          fatal = !this.everOpened || Date.now() - this.notFoundSince > 120_000;
        }
        if (fatal) {
          this.stopped = true;
          this.setStatus("failed");
          this.cleanup();
        }
        this.emit("error", code, fatal);
        break;
      }
    }
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.cleanup();
    this.setStatus("reconnecting");
    const delay = Math.min(10_000, 500 * 2 ** this.attempt) * (0.75 + Math.random() * 0.5);
    this.attempt = Math.min(this.attempt + 1, 6);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  private reconnectNow = () => {
    if (this.stopped || this.status === "open") return;
    this.attempt = 0;
    this.connect();
  };

  private onVisible = () => {
    if (document.visibilityState !== "visible" || this.stopped) return;
    if (this.status !== "open" || Date.now() - this.lastSeen > HEARTBEAT_MS * 2) this.reconnectNow();
  };

  private cleanup() {
    clearTimeout(this.retryTimer);
    clearInterval(this.beatTimer);
    const ws = this.ws;
    this.ws = undefined;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
    }
  }
}

/** Close a share by id with its master key, without a full session. */
export function endShare(roomId: string, masterKey: string): Promise<void> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${wsBase}/ws/room/${encodeURIComponent(roomId)}`);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => (ws.close(), done()), 5000);
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", role: "master", key: masterKey }));
    ws.onmessage = (e) => {
      if (String(e.data).includes('"welcome"')) ws.send('{"t":"close"}');
      else if (String(e.data).includes('"closed"') || String(e.data).includes('"error"')) ws.close();
    };
    ws.onclose = done;
  });
}
