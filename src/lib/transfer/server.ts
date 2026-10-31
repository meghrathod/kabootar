import {
  type Channel,
  type ItemMeta,
  type ReceiverMsg,
  type SenderMsg,
  HIGH_WATER,
  LOW_WATER,
  PROTOCOL_VERSION,
  READ_BLOCK,
  WINDOW,
  parseJSON,
} from "./protocol";

export interface ShareItem {
  meta: ItemMeta;
  file?: File;
}

export type ServerEvent =
  | { type: "request"; id: number; offset: number }
  | { type: "progress"; id: number; acked: number }
  | { type: "done"; id: number; ok: boolean }
  | { type: "failed"; id: number; message: string };

export interface ServerOptions {
  chunkSize: number;
  hash: (file: File) => Promise<string>;
  onEvent?: (e: ServerEvent) => void;
}

interface Active {
  id: number;
  cancelled: boolean;
}

/**
 * Serves share items to one receiver over one data channel.
 * Files are sent one at a time, in the order the receiver asks for them.
 */
export class ItemServer {
  private queue: { id: number; offset: number }[] = [];
  private active: Active | undefined;
  private running = false;
  private closed = false;
  private sent = 0;
  private acked = 0;
  private wake: (() => void) | undefined;

  constructor(
    private ch: Channel,
    private items: ShareItem[],
    private opts: ServerOptions,
  ) {
    ch.bufferedAmountLowThreshold = LOW_WATER;
    ch.addEventListener("message", this.onMessage);
    ch.addEventListener("bufferedamountlow", this.poke);
    ch.addEventListener("close", this.close);
  }

  start() {
    this.send({ t: "hello", v: PROTOCOL_VERSION, items: this.items.map((i) => i.meta) });
  }

  close = () => {
    this.closed = true;
    if (this.active) this.active.cancelled = true;
    this.poke();
    this.ch.removeEventListener("message", this.onMessage);
    this.ch.removeEventListener("bufferedamountlow", this.poke);
    this.ch.removeEventListener("close", this.close);
  };

  private poke = () => {
    const w = this.wake;
    this.wake = undefined;
    w?.();
  };

  private send(msg: SenderMsg) {
    this.ch.send(JSON.stringify(msg));
  }

  private onMessage = (e: MessageEvent) => {
    const msg = parseJSON<ReceiverMsg>(e.data);
    if (!msg) return;

    switch (msg.t) {
      case "get": {
        if (typeof msg.id !== "number" || typeof msg.offset !== "number") return;
        // A new request for the active item (receiver resynced) or any
        // request while busy replaces the current transfer.
        if (this.active) this.active.cancelled = true;
        this.queue = this.queue.filter((q) => q.id !== msg.id);
        this.queue.unshift({ id: msg.id, offset: msg.offset });
        this.opts.onEvent?.({ type: "request", id: msg.id, offset: msg.offset });
        this.poke();
        void this.run();
        break;
      }
      case "ack":
        if (this.active?.id === msg.id && msg.received > this.acked) {
          this.acked = msg.received;
          this.opts.onEvent?.({ type: "progress", id: msg.id, acked: msg.received });
          this.poke();
        }
        break;
      case "done":
        this.opts.onEvent?.({ type: "done", id: msg.id, ok: !!msg.ok });
        break;
      case "cancel":
        if (this.active?.id === msg.id) this.active.cancelled = true;
        this.queue = this.queue.filter((q) => q.id !== msg.id);
        this.poke();
        break;
    }
  };

  private async run() {
    if (this.running) return;
    this.running = true;
    try {
      while (!this.closed && this.queue.length > 0) {
        const req = this.queue.shift()!;
        await this.sendFile(req.id, req.offset);
      }
    } finally {
      this.running = false;
    }
  }

  private async sendFile(id: number, offset: number) {
    const item = this.items.find((i) => i.meta.id === id);
    const file = item?.file;
    if (!item || !file || item.meta.kind !== "file") {
      this.send({ t: "error", id, message: "No such file" });
      return;
    }

    const active: Active = { id, cancelled: false };
    this.active = active;
    const size = file.size;
    let pos = Math.max(0, Math.min(Math.floor(offset), size));
    this.sent = pos;
    this.acked = pos;

    try {
      // Start hashing in parallel; it's awaited only at the end.
      const hash = this.opts.hash(file);
      hash.catch(() => {});

      this.send({ t: "start", id, offset: pos });

      const read = (at: number) => file.slice(at, Math.min(size, at + READ_BLOCK)).arrayBuffer();
      let next = pos < size ? read(pos) : undefined;
      while (next) {
        const block = await next;
        const blockEnd = pos + block.byteLength;
        next = blockEnd < size ? read(blockEnd) : undefined;
        if (next) next.catch(() => {});

        for (let i = 0; i < block.byteLength; i += this.opts.chunkSize) {
          if (!(await this.capacity(active))) return;
          const len = Math.min(this.opts.chunkSize, block.byteLength - i);
          this.ch.send(new Uint8Array(block, i, len));
          this.sent += len;
        }
        pos = blockEnd;
        if (block.byteLength === 0) break;
      }

      const sha256 = await hash.catch(() => "");
      if (active.cancelled || this.closed) return;
      this.send({ t: "end", id, sha256 });
    } catch (err) {
      if (active.cancelled || this.closed || this.ch.readyState !== "open") return;
      const message = err instanceof Error ? err.message : String(err);
      this.opts.onEvent?.({ type: "failed", id, message });
      try {
        this.send({ t: "error", id, message: "Sender could not read the file" });
      } catch {
        // channel gone
      }
    } finally {
      if (this.active === active) this.active = undefined;
    }
  }

  /** Waits until the channel buffer and the receiver window have room. */
  private async capacity(active: Active): Promise<boolean> {
    for (;;) {
      if (active.cancelled || this.closed || this.ch.readyState !== "open") return false;
      if (this.ch.bufferedAmount <= HIGH_WATER && this.sent - this.acked <= WINDOW) return true;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
        // Safety net in case an event is missed.
        setTimeout(resolve, 250);
      });
    }
  }
}
