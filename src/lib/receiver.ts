import { errorMessage, type RoomInfo } from "./api";
import { fallbackIceServers } from "./config";
import { SpeedMeter } from "./format";
import { WakeLock, isIOS } from "./platform";
import {
  CandidateQueue,
  type Route,
  type SignalData,
  detectRoute,
  hasTurn,
  isSignal,
} from "./rtc";
import { SignalSocket, type SignalStatus } from "./signal";
import {
  OPFSSink,
  type SinkTarget,
  bestStrategy,
  downloadFile,
  openSink,
} from "./sinks";
import {
  dropDownload,
  fromBase64,
  saveDownload,
  savedDownloads,
  toBase64,
} from "./resume";
import { Store } from "./store";
import { ItemClient, type ItemState } from "./transfer/client";
import type { FileMeta, ItemMeta } from "./transfer/protocol";

export type ReceiverStatus =
  | "connecting" // talking to the signalling server
  | "waiting" // in the room, establishing the peer connection
  | "connected"
  | "reconnecting"
  | "closed" // sender ended the share
  | "error";

export interface ReceiverState {
  status: ReceiverStatus;
  error?: string;
  signal: SignalStatus;
  senderOnline: boolean;
  room?: RoomInfo;
  items: ItemMeta[];
  states: Record<number, ItemState>;
  route?: Route;
  relay: boolean;
  speed: number;
  /** Bytes received across all files in this session. */
  received: number;
}

const CONNECT_WATCHDOG = 15_000;
/** A download with no progress for this long is reported as stalled. */
const STALL_TIMEOUT = 20_000;
const MAX_RESTARTS = 4;

export class ReceiverSession {
  readonly store = new Store<ReceiverState>(
    {
      status: "connecting",
      signal: "connecting",
      senderOnline: true,
      items: [],
      states: {},
      relay: false,
      speed: 0,
      received: 0,
    },
    120,
  );
  readonly client: ItemClient;

  private signal: SignalSocket;
  private iceServers: RTCIceServer[] = fallbackIceServers;
  private peerId: string | undefined;
  private pc: RTCPeerConnection | undefined;
  /** The sender's connection id that `pc` belongs to. */
  private pcLink: string | undefined;
  /** OPFS folders of active downloads, for reload checkpoints. */
  private opfsDirs = new Map<number, string>();
  private ice: CandidateQueue | undefined;
  private watchdog: ReturnType<typeof setTimeout> | undefined;
  private restarts = 0;
  private meter = new SpeedMeter();
  private wake = new WakeLock();
  private ended = false;
  private progressAt = new Map<number, { received: number; at: number }>();
  private stallTimer: ReturnType<typeof setInterval>;

  constructor(
    readonly roomId: string,
    key: string,
  ) {
    this.client = new ItemClient({
      onItems: (items) => {
        this.store.set({ items }, true);
        this.resumeSaved(items);
      },
      onState: (id, s) => this.onItemState(id, s),
      onCheckpoint: (id, written, state) => {
        const dir = this.opfsDirs.get(id);
        const meta = this.store
          .get()
          .items.find((i): i is FileMeta => i.id === id && i.kind === "file");
        if (!dir || !meta) return;
        const st = state();
        saveDownload(roomId, id, {
          dir,
          name: meta.name,
          size: meta.size,
          written,
          state: st && toBase64(st),
        });
      },
    });

    // Survives reconnects and, via sessionStorage, iOS reloading the tab.
    const idKey = `kabootar:peer:${roomId}`;
    this.peerId = sessionStorage.getItem(idKey) ?? undefined;
    this.signal = new SignalSocket(roomId, () => ({
      role: "peer",
      key,
      resume: this.peerId,
    }));
    this.signal.on("status", (signal) => {
      this.store.set({ signal }, true);
      if (signal === "reconnecting" && this.store.get().status === "connecting")
        return;
    });
    this.signal.on("welcome", (w) => {
      this.peerId = w.peerId;
      if (w.peerId) sessionStorage.setItem(idKey, w.peerId);
      this.iceServers = w.iceServers?.length
        ? w.iceServers
        : fallbackIceServers;
      this.store.set(
        {
          room: w.room,
          senderOnline: w.online !== false,
          relay: hasTurn(this.iceServers),
        },
        true,
      );
      if (!this.healthy) {
        this.setStatus("waiting");
        this.armWatchdog();
      }
    });
    this.signal.on("signal", (data) => {
      if (isSignal(data)) void this.onSignal(data);
    });
    this.signal.on("master", (online) => {
      this.store.set({ senderOnline: online }, true);
      // The sender is back; if our connection died meanwhile, ask again
      // with a fresh budget of attempts.
      if (online && !this.healthy && this.pc) {
        this.restarts = 0;
        this.requestRestart();
        this.armWatchdog();
      }
    });
    this.signal.on("closed", () => this.finish("closed"));
    this.signal.on("error", (code, fatal) => {
      if (fatal) this.finish("error", errorMessage(new Error(code)));
    });

    window.addEventListener("beforeunload", this.beforeUnload);
    this.stallTimer = setInterval(() => this.checkStalls(), 5000);
  }

  /** Fail downloads that stopped moving while the connection looks fine. */
  private checkStalls() {
    if (!this.healthy) return;
    const now = Date.now();
    for (const [id, st] of Object.entries(this.store.get().states)) {
      if (st.status !== "receiving") continue;
      const p = this.progressAt.get(Number(id));
      if (!p || p.received !== st.received) {
        this.progressAt.set(Number(id), { received: st.received, at: now });
      } else if (now - p.at > STALL_TIMEOUT) {
        this.progressAt.delete(Number(id));
        void this.client.abort(
          Number(id),
          "Transfer stalled. Tap download to retry.",
        );
      }
    }
  }

  private get healthy() {
    return this.pc?.connectionState === "connected" && this.client.connected;
  }

  private setStatus(status: ReceiverStatus) {
    if (this.ended) return;
    this.store.set({ status }, true);
  }

  private async onSignal(data: SignalData) {
    if (this.ended) return;
    if (data.kind === "offer") {
      // An offer from a different sender connection (sender reloaded or
      // rebuilt the link) needs a fresh peer connection; the same link means
      // renegotiation (ICE restart) of the current one.
      if (
        !this.pc ||
        data.link !== this.pcLink ||
        ["failed", "closed"].includes(this.pc.connectionState)
      ) {
        this.newConnection(data.link);
      }
      const pc = this.pc!;
      try {
        await pc.setRemoteDescription(data.sdp);
        await this.ice!.flush();
        await pc.setLocalDescription(await pc.createAnswer());
        this.signal.signal({
          kind: "answer",
          sdp: pc.localDescription!.toJSON(),
          link: data.link,
        });
      } catch (err) {
        console.warn("answer failed", err);
      }
    } else if (data.kind === "ice" && this.pc && data.link === this.pcLink) {
      await this.ice!.add(data.candidate);
    }
  }

  private newConnection(link: string | undefined) {
    this.pc?.close();
    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    this.pc = pc;
    this.pcLink = link;
    this.ice = new CandidateQueue(pc);

    pc.onicecandidate = (e) => {
      if (e.candidate && this.pc === pc)
        this.signal.signal({ kind: "ice", candidate: e.candidate.toJSON() });
    };
    pc.ondatachannel = (e) => {
      const dc = e.channel;
      this.client.attach(dc);
      const opened = () => {
        this.restarts = 0;
        clearTimeout(this.watchdog);
        this.setStatus("connected");
        void detectRoute(pc).then((route) => this.store.set({ route }, true));
      };
      if (dc.readyState === "open") opened();
      else dc.addEventListener("open", opened);
      dc.addEventListener("close", () => {
        if (this.pc === pc) this.onConnectionLost();
      });
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "failed") this.onConnectionLost();
      if (pc.connectionState === "disconnected") this.setStatus("reconnecting");
      if (pc.connectionState === "connected" && this.client.connected)
        this.setStatus("connected");
    };
  }

  /** The peer connection died for good; ask the sender for a fresh one. */
  private onConnectionLost() {
    if (this.ended) return;
    this.setStatus("reconnecting");
    // If the sender is away (e.g. reloading), wait for it to come back
    // instead of spending reconnect attempts.
    if (this.store.get().senderOnline) this.requestRestart();
    this.armWatchdog();
  }

  private requestRestart() {
    if (this.restarts >= MAX_RESTARTS) {
      this.finish(
        "error",
        "Couldn't establish a connection to the sender. Try a different network, or ask them to keep the app open.",
      );
      return;
    }
    this.restarts++;
    this.signal.signal({ kind: "restart" });
  }

  private armWatchdog() {
    clearTimeout(this.watchdog);
    this.watchdog = setTimeout(
      () => {
        if (this.healthy || this.ended) return;
        if (this.store.get().senderOnline && this.signal.status === "open")
          this.requestRestart();
        this.armWatchdog();
      },
      CONNECT_WATCHDOG * (1 + this.restarts * 0.5),
    );
  }

  /** After a reload, continue downloads that were going to device storage. */
  private resumeSaved(items: ItemMeta[]) {
    for (const [key, saved] of Object.entries(savedDownloads(this.roomId))) {
      const id = Number(key);
      const meta = items.find(
        (i): i is FileMeta => i.id === id && i.kind === "file",
      );
      if (!meta || meta.name !== saved.name || meta.size !== saved.size) {
        dropDownload(this.roomId, id);
        continue;
      }
      console.info(
        `[kabootar] resuming "${meta.name}" from byte ${saved.written} after reload`,
      );
      this.opfsDirs.set(id, saved.dir);
      this.client.download(
        id,
        () => OPFSSink.open(meta, { dir: saved.dir, offset: saved.written }),
        {
          offset: saved.written,
          hashState: saved.state ? fromBase64(saved.state) : undefined,
        },
      );
    }
  }

  private onItemState(id: number, s: ItemState) {
    if (["done", "error", "cancelled"].includes(s.status)) {
      this.opfsDirs.delete(id);
      dropDownload(this.roomId, id);
    }
    const states = { ...this.store.get().states, [id]: s };
    let received = 0;
    for (const st of Object.values(states)) received += st.received;
    const busy = this.client.busy;
    this.store.set({
      states,
      received,
      speed: busy ? this.meter.sample(received) : 0,
    });
    if (busy) void this.wake.acquire();
    else this.wake.release();

    // Files held by the browser (OPFS/memory) still need saving. iOS needs a
    // tap for the share sheet, so the UI offers a button there instead.
    if (s.status === "done" && s.file && !isIOS) downloadFile(s.file);
  }

  /**
   * Queue files for download. `target` should be prepared inside the click
   * handler (save pickers require a user gesture).
   */
  download(ids: number[], target: SinkTarget = { strategy: bestStrategy() }) {
    if (!this.client.busy) this.meter.reset(this.store.get().received);
    for (const id of ids) {
      const meta = this.store
        .get()
        .items.find((i): i is FileMeta => i.id === id && i.kind === "file");
      if (!meta) continue;
      const st = this.store.get().states[id];
      if (st && ["queued", "receiving", "verifying"].includes(st.status))
        continue;
      this.client.download(id, async () => {
        const sink = await openSink(meta, target);
        if (sink instanceof OPFSSink) this.opfsDirs.set(id, sink.dir);
        return sink;
      });
    }
  }

  cancel(id: number) {
    return this.client.cancel(id);
  }

  private beforeUnload = (e: BeforeUnloadEvent) => {
    if (this.client.busy) e.preventDefault();
  };

  private finish(status: "closed" | "error", error?: string) {
    if (this.ended) return;
    // If the sender closed after we got everything, that's a happy ending.
    this.store.set({ status, error }, true);
    this.ended = true;
    clearTimeout(this.watchdog);
    clearInterval(this.stallTimer);
    void this.client.cancelAll();
    this.signal.close();
    this.pc?.close();
    this.wake.release();
    window.removeEventListener("beforeunload", this.beforeUnload);
  }

  leave() {
    this.finish("closed");
  }
}
