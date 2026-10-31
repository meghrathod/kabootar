import { createSHA256, type IHasher } from "hash-wasm";

import type { Sink } from "../sinks/types";
import {
  type Channel,
  type FileMeta,
  type ItemMeta,
  type ReceiverMsg,
  type SenderMsg,
  ACK_EVERY,
  parseJSON,
  validItems,
} from "./protocol";

export type ItemStatus =
  | "idle"
  | "queued"
  | "receiving"
  | "verifying"
  | "done"
  | "error"
  | "cancelled";

export interface ItemState {
  status: ItemStatus;
  received: number;
  verified?: boolean;
  error?: string;
  /** Present when the sink kept the file in the browser (OPFS / memory). */
  file?: File;
}

export interface ClientCallbacks {
  onItems?(items: ItemMeta[]): void;
  onState?(id: number, state: ItemState): void;
  /**
   * Called after each acknowledged megabyte with the bytes safely written and
   * the hash state at exactly that point, so a download can be resumed after
   * a page reload.
   */
  onCheckpoint?(
    id: number,
    written: number,
    hashState: () => Uint8Array | undefined,
  ): void;
}

export interface ResumeFrom {
  offset: number;
  hashState?: Uint8Array;
}

interface Download {
  meta: FileMeta;
  sink: Sink | undefined;
  /** Sink opened and first request sent. */
  ready: boolean;
  hasher: IHasher | undefined;
  received: number;
  written: number;
  lastAck: number;
  /** Bytes are accepted only after a "start" matching our offset. */
  accepting: boolean;
  chain: Promise<void>;
  failed: boolean;
}

/**
 * Receives share items. Survives channel replacement: attach a new channel
 * after a reconnect and the active download resumes from the last byte
 * received, with the hash state carried over.
 */
export class ItemClient {
  items: ItemMeta[] = [];
  readonly states = new Map<number, ItemState>();

  private ch: Channel | undefined;
  private queue: {
    meta: FileMeta;
    open: () => Promise<Sink>;
    from?: ResumeFrom;
  }[] = [];
  private active: Download | undefined;

  constructor(private cb: ClientCallbacks = {}) {}

  get connected() {
    return this.ch?.readyState === "open";
  }

  get busy() {
    return !!this.active || this.queue.length > 0;
  }

  attach(ch: Channel) {
    this.detach();
    this.ch = ch;
    ch.binaryType = "arraybuffer";
    ch.addEventListener("message", this.onMessage);
    ch.addEventListener("close", this.onClose);
  }

  detach() {
    if (!this.ch) return;
    this.ch.removeEventListener("message", this.onMessage);
    this.ch.removeEventListener("close", this.onClose);
    this.ch = undefined;
    if (this.active) this.active.accepting = false;
  }

  /**
   * Queue a file for download. Pass a factory to open the sink only when the
   * file's turn comes (so queued browser downloads don't all start at once).
   */
  download(id: number, sink: Sink | (() => Promise<Sink>), from?: ResumeFrom) {
    const meta = this.items.find(
      (i): i is FileMeta => i.id === id && i.kind === "file",
    );
    if (!meta) throw new Error("Unknown item");
    if (this.active?.meta.id === id || this.queue.some((q) => q.meta.id === id))
      return;
    this.queue.push({
      meta,
      open: typeof sink === "function" ? sink : () => Promise.resolve(sink),
      from,
    });
    this.setState(id, { status: "queued", received: from?.offset ?? 0 });
    void this.next();
  }

  async cancel(id: number) {
    const q = this.queue.findIndex((x) => x.meta.id === id);
    if (q >= 0) {
      this.queue.splice(q, 1);
      this.setState(id, { status: "cancelled", received: 0 });
      return;
    }
    if (this.active?.meta.id === id) {
      this.send({ t: "cancel", id });
      await this.fail(this.active, "Cancelled", "cancelled");
    }
  }

  /** Stop the active download with an error the user can retry from. */
  async abort(id: number, error: string) {
    if (this.active?.meta.id !== id) return;
    this.send({ t: "cancel", id });
    await this.fail(this.active, error);
  }

  async cancelAll() {
    for (const q of [...this.queue]) await this.cancel(q.meta.id);
    if (this.active) await this.cancel(this.active.meta.id);
  }

  private onClose = () => this.detach();

  private send(msg: ReceiverMsg) {
    if (this.ch?.readyState === "open") this.ch.send(JSON.stringify(msg));
  }

  private setState(id: number, patch: Partial<ItemState>) {
    const prev = this.states.get(id) ?? { status: "idle", received: 0 };
    const next = { ...prev, ...patch };
    this.states.set(id, next);
    this.cb.onState?.(id, next);
  }

  private onMessage = (e: MessageEvent) => {
    if (e.data instanceof ArrayBuffer) {
      this.onChunk(new Uint8Array(e.data));
      return;
    }
    const msg = parseJSON<SenderMsg>(e.data);
    if (!msg) return;

    switch (msg.t) {
      case "hello":
        this.onHello(msg.items);
        break;
      case "start": {
        const d = this.active;
        if (!d || d.meta.id !== msg.id) return;
        if (msg.offset === d.received) {
          d.accepting = true;
          console.info(
            `[kabootar] receiving item ${msg.id} from byte ${msg.offset}`,
          );
        } else {
          d.accepting = false;
          this.send({ t: "get", id: d.meta.id, offset: d.received });
        }
        break;
      }
      case "end": {
        const d = this.active;
        if (!d || d.meta.id !== msg.id) return;
        void this.finish(d, typeof msg.sha256 === "string" ? msg.sha256 : "");
        break;
      }
      case "error": {
        const d = this.active;
        if (d && d.meta.id === msg.id)
          void this.fail(d, String(msg.message || "Sender error"));
        break;
      }
    }
  };

  private onHello(raw: unknown) {
    const items = validItems(raw);
    if (this.items.length === 0) {
      this.items = items;
      for (const it of items)
        if (!this.states.has(it.id))
          this.states.set(it.id, { status: "idle", received: 0 });
      this.cb.onItems?.(items);
    }
    // Reconnected mid-transfer: resume from where we stopped.
    if (this.active?.ready && !this.active.failed) {
      this.active.accepting = false;
      this.send({
        t: "get",
        id: this.active.meta.id,
        offset: this.active.received,
      });
    } else {
      void this.next();
    }
  }

  private async next() {
    if (this.active || this.queue.length === 0) return;
    const { meta, open, from } = this.queue.shift()!;
    let offset = Math.min(from?.offset ?? 0, meta.size);
    const d: Download = {
      meta,
      sink: undefined,
      hasher: undefined,
      received: offset,
      written: offset,
      lastAck: offset,
      accepting: false,
      chain: Promise.resolve(),
      failed: false,
      ready: false,
    };
    this.active = d;
    this.setState(meta.id, { status: "receiving", received: offset });

    try {
      d.sink = await open();
    } catch (err) {
      await this.fail(
        d,
        err instanceof Error ? err.message : "Could not save file",
      );
      return;
    }
    if (
      offset > 0 &&
      d.sink.startAt !== undefined &&
      d.sink.startAt !== offset
    ) {
      // The partial file wasn't what we expected; the sink started over.
      offset = 0;
      d.received = d.written = d.lastAck = 0;
      this.setState(meta.id, { received: 0 });
    }
    try {
      d.hasher = await createSHA256();
      if (offset > 0) {
        // Without the hash state for the bytes already on disk the file
        // can't be verified, so skip verification rather than fail it.
        if (from?.hashState) d.hasher.load(from.hashState);
        else d.hasher = undefined;
      }
    } catch {
      // WebAssembly unavailable: transfer still works, just unverified.
      d.hasher = undefined;
    }
    if (d.failed) {
      await d.sink.abort().catch(() => {});
      return;
    }
    d.ready = true;
    this.send({ t: "get", id: meta.id, offset });
  }

  private onChunk(chunk: Uint8Array) {
    const d = this.active;
    if (!d || !d.accepting || d.failed) return;

    if (d.received + chunk.byteLength > d.meta.size) {
      void this.fail(d, "Received more data than expected");
      return;
    }
    // Sinks may transfer the buffer to a worker, which detaches it (its
    // length becomes 0), so take the length before handing it over.
    const len = chunk.byteLength;
    d.received += len;

    d.chain = d.chain.then(async () => {
      if (d.failed) return;
      try {
        // Hash in write order so the hash state always matches the bytes on
        // disk, which is what makes resuming after a reload possible.
        d.hasher?.update(chunk);
        await d.sink!.write(chunk);
      } catch (err) {
        this.send({ t: "cancel", id: d.meta.id });
        await this.fail(
          d,
          err instanceof Error ? err.message : "Could not save file",
        );
        return;
      }
      d.written += len;
      if (d.written - d.lastAck >= ACK_EVERY || d.written === d.meta.size) {
        d.lastAck = d.written;
        this.send({ t: "ack", id: d.meta.id, received: d.written });
        this.cb.onCheckpoint?.(d.meta.id, d.written, () => d.hasher?.save());
      }
      this.setState(d.meta.id, { received: d.written });
    });
  }

  private async finish(d: Download, expected: string) {
    await d.chain;
    if (d.failed || this.active !== d) return;

    if (d.received !== d.meta.size) {
      // Missed bytes (e.g. a reconnect raced with the end); ask again.
      d.accepting = false;
      this.send({ t: "get", id: d.meta.id, offset: d.received });
      return;
    }

    this.setState(d.meta.id, { status: "verifying" });
    const actual = d.hasher?.digest("hex");
    const verifiable = !!expected && !!actual;
    if (verifiable && actual !== expected) {
      this.send({ t: "done", id: d.meta.id, ok: false });
      await this.fail(
        d,
        "Integrity check failed: the file was corrupted in transit",
      );
      return;
    }

    try {
      const file = await d.sink!.close();
      this.send({ t: "done", id: d.meta.id, ok: true });
      this.setState(d.meta.id, {
        status: "done",
        received: d.meta.size,
        verified: verifiable,
        file: file || undefined,
      });
    } catch (err) {
      this.send({ t: "done", id: d.meta.id, ok: false });
      await this.fail(
        d,
        err instanceof Error ? err.message : "Could not save file",
      );
      return;
    }
    this.active = undefined;
    void this.next();
  }

  private async fail(d: Download, error: string, status: ItemStatus = "error") {
    if (d.failed) return;
    if (status === "error")
      console.warn(
        `[kabootar] item ${d.meta.id} failed after ${d.written}/${d.received} bytes:`,
        error,
      );
    d.failed = true;
    d.accepting = false;
    await d.sink?.abort().catch(() => {});
    this.setState(d.meta.id, {
      status,
      error: status === "error" ? error : undefined,
    });
    if (this.active === d) this.active = undefined;
    void this.next();
  }
}
