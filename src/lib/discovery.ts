import type { RoomInfo } from "./api";
import { wsBase } from "./config";
import { type PublicAddresses, getPublicAddresses } from "./publicIp";
import { Store } from "./store";

export interface DiscoveryState {
  rooms: RoomInfo[];
  status: "connecting" | "open" | "reconnecting";
  /** iCloud Private Relay or a VPN hides this device's network. */
  hidden: boolean;
}

/** Live list of shares on the same network, with automatic reconnect. */
export class Discovery {
  readonly store = new Store<DiscoveryState>({
    rooms: [],
    status: "connecting",
    hidden: false,
  });
  private ws: WebSocket | undefined;
  private stopped = false;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private beat: ReturnType<typeof setInterval> | undefined;
  private ip: PublicAddresses = {};

  constructor() {
    void getPublicAddresses(4000).then((ip) => {
      this.ip = ip;
      if (!this.stopped) this.connect();
    });
  }

  private connect() {
    this.cleanup();
    const params = new URLSearchParams();
    if (this.ip.v4) params.set("ip", this.ip.v4);
    if (this.ip.v6) params.set("ip6", this.ip.v6);
    const qs = params.size ? `?${params}` : "";
    const ws = new WebSocket(`${wsBase}/ws/discover${qs}`);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.store.set({ status: "open", rooms: [] });
    };
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.t === "network") {
          console.info(
            "[kabootar] nearby network (receiver):",
            (msg.keys as string[]).join(", ") || "none",
            msg.hidden ? "(hidden by a privacy relay)" : "",
          );
          this.store.set({ hidden: !!msg.hidden });
        } else if (msg.t === "add" && msg.room) {
          const rooms = this.store
            .get()
            .rooms.filter((r) => r.id !== msg.room.id);
          this.store.set({ rooms: [...rooms, msg.room] });
        } else if (msg.t === "remove") {
          this.store.set({
            rooms: this.store.get().rooms.filter((r) => r.id !== msg.id),
          });
        }
      } catch {
        // ignore malformed messages
      }
    };
    ws.onclose = () => {
      if (this.stopped || this.ws !== ws) return;
      this.store.set({ status: "reconnecting" });
      this.timer = setTimeout(
        () => this.connect(),
        Math.min(10_000, 500 * 2 ** this.attempt++),
      );
    };
    this.beat = setInterval(
      () => ws.readyState === WebSocket.OPEN && ws.send('{"t":"ping"}'),
      20_000,
    );
  }

  private cleanup() {
    clearTimeout(this.timer);
    clearInterval(this.beat);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = undefined;
    }
  }

  close() {
    this.stopped = true;
    this.cleanup();
  }
}
