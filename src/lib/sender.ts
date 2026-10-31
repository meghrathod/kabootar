import { createRoom, errorMessage, type RoomInfo } from "./api";
import { fallbackIceServers } from "./config";
import { SpeedMeter } from "./format";
import { hashFile } from "./hash";
import { WakeLock } from "./platform";
import { type SavedShare, dropShare, saveShare } from "./resume";
import { type PublicAddresses, getPublicAddresses } from "./publicIp";
import { CHANNEL_LABEL, CandidateQueue, type Route, type SignalData, detectRoute, hasTurn, isSignal } from "./rtc";
import { SignalSocket, type SignalStatus } from "./signal";
import { Store } from "./store";
import { type ItemMeta, MAX_TEXT, chunkSizeFor } from "./transfer/protocol";
import { ItemServer, type ServerEvent, type ShareItem } from "./transfer/server";

export type PeerState = "connecting" | "connected" | "reconnecting" | "failed" | "left";

export interface PeerView {
  id: string;
  state: PeerState;
  route?: Route;
  /** Item currently being sent, with bytes acknowledged by the receiver. */
  current?: { id: number; acked: number };
  completed: number[];
  bytesDone: number;
  speed: number;
}

export interface SenderState {
  status: "live" | "ended" | "error";
  error?: string;
  signal: SignalStatus;
  room: RoomInfo;
  pin: string;
  link: string;
  items: ItemMeta[];
  totalBytes: number;
  peers: PeerView[];
  relay: boolean;
  /** Asked to be visible nearby, but a privacy relay hides this network. */
  nearbyHidden: boolean;
}

export interface Draft {
  files: { file: File; path?: string }[];
  texts: string[];
}

const CONNECT_TIMEOUT = 30_000;
const MAX_ICE_RESTARTS = 3;

/** One RTCPeerConnection to one receiver. The sender always makes the offer. */
class SenderLink {
  readonly pc: RTCPeerConnection;
  private dc: RTCDataChannel;
  private server: ItemServer | undefined;
  private ice: CandidateQueue;
  private restarts = 0;
  private disconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout>;
  private meter = new SpeedMeter();
  private closed = false;
  private readonly linkId = crypto.randomUUID().slice(0, 8);
  signallingGone = false;

  view: PeerView;

  constructor(
    id: string,
    iceServers: RTCIceServer[],
    private items: ShareItem[],
    private sendSignal: (data: SignalData) => void,
    private onChange: () => void,
    previous?: PeerView,
  ) {
    // A reconnecting receiver keeps its row and delivery history.
    this.view = {
      id,
      state: "connecting",
      completed: previous?.completed ?? [],
      bytesDone: previous?.bytesDone ?? 0,
      speed: 0,
    };
    this.pc = new RTCPeerConnection({ iceServers });
    this.ice = new CandidateQueue(this.pc);

    this.pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal({ kind: "ice", candidate: e.candidate.toJSON(), link: this.linkId });
    };
    this.pc.onnegotiationneeded = () => void this.offer();
    this.pc.oniceconnectionstatechange = () => this.onIceState();
    this.pc.onconnectionstatechange = () => {
      if (this.pc.connectionState === "connected") {
        clearTimeout(this.connectTimer);
        this.restarts = 0;
        void detectRoute(this.pc).then((route) => this.update({ route }));
      }
    };

    this.dc = this.pc.createDataChannel(CHANNEL_LABEL, { ordered: true });
    this.dc.binaryType = "arraybuffer";
    this.dc.onopen = () => this.onOpen();
    this.dc.onclose = () => {
      this.server?.close();
      if (!this.closed) this.close(this.signallingGone ? "left" : "failed");
    };

    this.connectTimer = setTimeout(() => {
      if (this.pc.connectionState !== "connected") this.close("failed");
    }, CONNECT_TIMEOUT);
  }

  private update(patch: Partial<PeerView>) {
    this.view = { ...this.view, ...patch };
    this.onChange();
  }

  private async offer() {
    if (this.closed || this.pc.signalingState !== "stable") return;
    try {
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.sendSignal({ kind: "offer", sdp: this.pc.localDescription!.toJSON(), link: this.linkId });
    } catch (err) {
      console.warn("offer failed", err);
    }
  }

  async handleSignal(data: SignalData) {
    if (this.closed) return;
    switch (data.kind) {
      case "answer":
        if (this.pc.signalingState !== "have-local-offer") return;
        await this.pc.setRemoteDescription(data.sdp).catch((e) => console.warn(e));
        await this.ice.flush();
        break;
      case "ice":
        await this.ice.add(data.candidate);
        break;
    }
  }

  private onIceState() {
    const s = this.pc.iceConnectionState;
    clearTimeout(this.disconnectTimer);
    if (s === "connected" || s === "completed") {
      if (this.view.state === "reconnecting") this.update({ state: "connected" });
    } else if (s === "disconnected") {
      // Often recovers by itself (e.g. a brief Wi-Fi hiccup); restart if not.
      this.disconnectTimer = setTimeout(() => this.restartIce(), 3000);
    } else if (s === "failed") {
      this.restartIce();
    }
  }

  /** ICE restart keeps the SCTP association, so transfers continue without loss. */
  private restartIce() {
    if (this.closed) return;
    if (this.signallingGone || this.restarts >= MAX_ICE_RESTARTS) {
      if (this.pc.iceConnectionState === "failed") this.close("failed");
      return;
    }
    this.restarts++;
    this.update({ state: "reconnecting" });
    this.pc.restartIce();
  }

  private onOpen() {
    const chunkSize = chunkSizeFor(this.pc.sctp?.maxMessageSize);
    this.server = new ItemServer(this.dc, this.items, {
      chunkSize,
      hash: hashFile,
      onEvent: (e) => this.onServerEvent(e),
    });
    this.server.start();
    this.meter.reset(this.view.bytesDone);
    this.update({ state: "connected" });
  }

  private onServerEvent(e: ServerEvent) {
    const size = (id: number) => {
      const m = this.items.find((i) => i.meta.id === id)?.meta;
      return m?.kind === "file" ? m.size : 0;
    };
    const doneBytes = (completed: number[]) => completed.reduce((n, id) => n + size(id), 0);

    switch (e.type) {
      case "request":
        this.update({ current: { id: e.id, acked: e.offset } });
        break;
      case "progress": {
        const bytesDone = doneBytes(this.view.completed) + e.acked;
        this.update({ current: { id: e.id, acked: e.acked }, bytesDone, speed: this.meter.sample(bytesDone) });
        break;
      }
      case "done": {
        const completed = e.ok && !this.view.completed.includes(e.id) ? [...this.view.completed, e.id] : this.view.completed;
        this.update({ completed, current: undefined, bytesDone: doneBytes(completed), speed: 0 });
        break;
      }
      case "failed":
        this.update({ current: undefined, speed: 0 });
        break;
    }
  }

  setIceServers(iceServers: RTCIceServer[]) {
    try {
      this.pc.setConfiguration({ ...this.pc.getConfiguration(), iceServers });
    } catch {
      // Some browsers reject changes they consider incompatible.
    }
  }

  get connected() {
    return this.pc.connectionState === "connected" && this.dc.readyState === "open";
  }

  close(state: PeerState = "left") {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    clearTimeout(this.disconnectTimer);
    this.server?.close();
    this.dc.close();
    this.pc.close();
    this.update({ state, speed: 0 });
  }
}

export class SenderSession {
  readonly store: Store<SenderState>;
  private signal: SignalSocket;
  private links = new Map<string, SenderLink>();
  private iceServers: RTCIceServer[] = fallbackIceServers;
  private wake = new WakeLock();
  private ended = false;

  private constructor(
    private created: Awaited<ReturnType<typeof createRoom>>,
    private items: ShareItem[],
    private discoverable: boolean,
    private ip: PublicAddresses | undefined,
  ) {
    const link = `${location.origin}/${created.id}#k=${created.clientKey}`;
    this.store = new Store<SenderState>(
      {
        status: "live",
        signal: "connecting",
        room: { id: created.id, name: created.name, emoji: created.emoji, color: created.color },
        pin: created.pin,
        link,
        items: items.map((i) => i.meta),
        totalBytes: items.reduce((n, i) => n + (i.meta.kind === "file" ? i.meta.size : 0), 0),
        peers: [],
        relay: false,
        nearbyHidden: !!created.hidden,
      },
      120,
    );

    this.signal = new SignalSocket(created.id, () => ({
      role: "master",
      key: created.masterKey,
      restore: {
        name: this.store.get().room.name,
        emoji: this.store.get().room.emoji,
        pin: this.store.get().pin,
        discoverable: this.discoverable,
        ip: this.ip?.v4,
        ip6: this.ip?.v6,
      },
    }));
    this.signal.on("status", (signal) => this.store.set({ signal }, true));
    this.signal.on("welcome", (w) => {
      this.iceServers = w.iceServers?.length ? w.iceServers : fallbackIceServers;
      this.store.set({ room: w.room, pin: w.pin ?? this.store.get().pin, relay: hasTurn(this.iceServers) }, true);
      for (const l of this.links.values()) l.setIceServers(this.iceServers);
      for (const p of w.peers ?? []) this.peerJoined(p);
    });
    this.signal.on("join", (p) => this.peerJoined(p));
    this.signal.on("leave", (p) => {
      const l = this.links.get(p);
      if (!l) return;
      l.signallingGone = true;
      // Keep established connections: the receiver's websocket may drop
      // while the peer-to-peer transfer carries on.
      if (!l.connected) this.removeLink(p, "left");
    });
    this.signal.on("signal", (data, from) => {
      if (!from || !isSignal(data)) return;
      if (data.kind === "restart") {
        this.addLink(from);
        return;
      }
      void this.links.get(from)?.handleSignal(data);
    });
    this.signal.on("error", (code, fatal) => {
      if (fatal) this.store.set({ status: "error", error: errorMessage(new Error(code)) }, true);
    });
    this.signal.on("closed", () => this.finish("ended"));

    window.addEventListener("beforeunload", this.beforeUnload);
    void this.wake.acquire();
    saveShare({ created, discoverable, ip, items: items.map((i) => i.meta) });
  }

  static async start(draft: Draft, discoverable = true): Promise<SenderSession> {
    const items = toShareItems(draft);
    if (items.length === 0) throw new Error("Nothing to share");
    const ip = discoverable ? await getPublicAddresses() : undefined;
    const created = await createRoom(discoverable, ip);
    if (created.network) {
      console.info("[kabootar] nearby network (sender):", created.network.join(", ") || "none", created.hidden ? "(hidden by a privacy relay)" : "");
    }
    return new SenderSession(created, items, discoverable, ip);
  }

  /**
   * Continue a share after a page reload. `files` are the files the user
   * re-added, matched to the original items by name and size.
   */
  static resume(saved: SavedShare, files: Map<number, File>): SenderSession {
    const items: ShareItem[] = saved.items.map((meta) => ({
      meta,
      file: meta.kind === "file" ? files.get(meta.id) : undefined,
    }));
    return new SenderSession(saved.created, items, saved.discoverable, saved.ip);
  }

  get id() {
    return this.created.id;
  }

  /** A receiver (re)connected to signalling. */
  private peerJoined(peerId: string) {
    const existing = this.links.get(peerId);
    if (existing?.connected) {
      // Its websocket dropped and came back, but the peer-to-peer
      // connection survived: keep using it.
      existing.signallingGone = false;
      return;
    }
    this.addLink(peerId);
  }

  private addLink(peerId: string) {
    const previous = this.links.get(peerId);
    const history = previous?.view;
    if (previous) {
      // Drop the old link without letting it remove the row.
      this.links.delete(peerId);
      previous.close("left");
    }
    const link = new SenderLink(
      peerId,
      this.iceServers,
      this.items,
      (data) => this.signal.signal(data, peerId),
      () => this.syncPeers(),
      history,
    );
    this.links.set(peerId, link);
    this.syncPeers();
  }

  private removeLink(peerId: string, state: PeerState) {
    this.links.get(peerId)?.close(state);
    this.syncPeers();
  }

  private syncPeers() {
    const peers: PeerView[] = [];
    for (const [id, l] of this.links) {
      const finalState = l.view.state === "left" || l.view.state === "failed";
      if (finalState && l.view.completed.length === 0) {
        this.links.delete(id);
        continue;
      }
      peers.push(l.view);
    }
    this.store.set({ peers });
  }

  private beforeUnload = (e: BeforeUnloadEvent) => {
    if (!this.ended) e.preventDefault();
  };

  end() {
    this.signal.close(true);
    this.finish("ended");
  }

  private finish(status: "ended" | "error") {
    if (this.ended) return;
    this.ended = true;
    for (const l of this.links.values()) l.close("left");
    this.signal.close();
    this.wake.release();
    window.removeEventListener("beforeunload", this.beforeUnload);
    dropShare(this.created.id);
    this.store.set({ status }, true);
  }
}

function toShareItems(draft: Draft): ShareItem[] {
  let id = 0;
  const items: ShareItem[] = [];
  for (const { file, path } of draft.files) {
    items.push({
      file,
      meta: {
        id: id++,
        kind: "file",
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        path: path && path !== file.name ? path : undefined,
      },
    });
  }
  for (const text of draft.texts) {
    const t = text.trim();
    if (t) items.push({ meta: { id: id++, kind: "text", text: t.slice(0, MAX_TEXT) } });
  }
  return items;
}

/** The active share survives route changes; there is at most one. */
export const senderSlot = new Store<{ session?: SenderSession }>({});
