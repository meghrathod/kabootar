import { describe, expect, it } from "vitest";
import { createSHA256 } from "hash-wasm";

import type { Sink } from "../sinks/types";
import { ItemClient, type ItemState } from "./client";
import {
  type Channel,
  type ItemMeta,
  MiB,
  sanitizePath,
  sanitizeName,
  validItems,
} from "./protocol";
import { ItemServer, type ShareItem } from "./server";

/** In-memory data channel pair with an asynchronous, buffered link. */
class FakeChannel implements Channel {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  peer!: FakeChannel;
  /** When set, binary payloads have this byte flipped (simulated corruption). */
  corruptAt: number | undefined;
  private delivered = 0;
  private listeners: Record<string, Set<(e?: unknown) => void>> = {};

  static pair(): [FakeChannel, FakeChannel] {
    const a = new FakeChannel();
    const b = new FakeChannel();
    a.peer = b;
    b.peer = a;
    return [a, b];
  }

  addEventListener(type: string, fn: (e?: unknown) => void) {
    (this.listeners[type] ??= new Set()).add(fn);
  }
  removeEventListener(type: string, fn: (e?: unknown) => void) {
    this.listeners[type]?.delete(fn);
  }
  private fire(type: string, e?: unknown) {
    for (const fn of [...(this.listeners[type] ?? [])]) fn(e);
  }

  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>) {
    if (this.readyState !== "open") throw new Error("InvalidStateError");
    let payload: string | ArrayBuffer;
    if (typeof data === "string") payload = data;
    else if (data instanceof ArrayBuffer) payload = data.slice(0);
    else
      payload = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      );

    if (typeof payload !== "string" && this.corruptAt !== undefined) {
      const at = this.corruptAt - this.delivered;
      if (at >= 0 && at < payload.byteLength)
        new Uint8Array(payload)[at] ^= 0xff;
      this.delivered += payload.byteLength;
    }

    const size =
      typeof payload === "string" ? payload.length : payload.byteLength;
    this.bufferedAmount += size;
    setTimeout(() => {
      this.bufferedAmount -= size;
      if (this.readyState === "open")
        this.peer.fire("message", { data: payload } as MessageEvent);
      if (this.bufferedAmount <= this.bufferedAmountLowThreshold)
        this.fire("bufferedamountlow");
    }, 0);
  }

  close() {
    for (const ch of [this, this.peer]) {
      if (ch.readyState === "closed") continue;
      ch.readyState = "closed";
      ch.fire("close");
    }
  }
}

class MemorySink implements Sink {
  readonly kind = "memory" as const;
  parts: Uint8Array[] = [];
  closed = false;
  aborted = false;
  constructor(private delayMs = 0) {}
  async write(chunk: Uint8Array) {
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
    this.parts.push(chunk.slice());
  }
  async close() {
    this.closed = true;
  }
  async abort() {
    this.aborted = true;
  }
  bytes() {
    const out = new Uint8Array(
      this.parts.reduce((n, p) => n + p.byteLength, 0),
    );
    let o = 0;
    for (const p of this.parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  }
}

function randomFile(size: number, name = "f.bin"): File {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i += 65536)
    crypto.getRandomValues(data.subarray(i, Math.min(size, i + 65536)));
  return new File([data], name, { type: "application/octet-stream" });
}

async function sha256(file: File) {
  const h = await createSHA256();
  h.update(new Uint8Array(await file.arrayBuffer()));
  return h.digest("hex");
}

function share(files: File[], texts: string[] = []): ShareItem[] {
  let id = 0;
  return [
    ...files.map((file) => ({
      file,
      meta: {
        id: id++,
        kind: "file",
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: 0,
      } as ItemMeta,
    })),
    ...texts.map((text) => ({
      meta: { id: id++, kind: "text", text } as ItemMeta,
    })),
  ];
}

function waitFor(pred: () => boolean, timeout = 10_000) {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (pred()) return resolve();
      if (Date.now() - start > timeout) return reject(new Error("timeout"));
      setTimeout(tick, 5);
    };
    tick();
  });
}

function connect(
  items: ShareItem[],
  client: ItemClient,
  chunkSize = 64 * 1024,
) {
  const [a, b] = FakeChannel.pair();
  client.attach(b);
  const server = new ItemServer(a, items, { chunkSize, hash: sha256 });
  server.start();
  return { a, b, server };
}

describe("transfer", () => {
  it("transfers multiple files and inline text with verification", async () => {
    const files = [
      randomFile(3 * MiB + 123, "a.bin"),
      randomFile(0, "empty.txt"),
      randomFile(70_000, "b.bin"),
    ];
    const states = new Map<number, ItemState>();
    let items: ItemMeta[] = [];
    const client = new ItemClient({
      onItems: (i) => (items = i),
      onState: (id, s) => states.set(id, s),
    });
    connect(share(files, ["hello https://example.com"]), client);

    await waitFor(() => items.length === 4);
    expect(items[3]).toMatchObject({
      kind: "text",
      text: "hello https://example.com",
    });

    const sinks = files.map(() => new MemorySink());
    files.forEach((_, i) => client.download(i, sinks[i]));
    await waitFor(() =>
      files.every((_, i) => states.get(i)?.status === "done"),
    );

    for (let i = 0; i < files.length; i++) {
      expect(sinks[i].closed).toBe(true);
      expect(states.get(i)?.verified).toBe(true);
      expect(await sha256(new File([sinks[i].bytes()], "x"))).toBe(
        await sha256(files[i]),
      );
    }
  });

  it("resumes after the channel dies mid-transfer", async () => {
    const file = randomFile(6 * MiB, "big.bin");
    const items = share([file]);
    const states = new Map<number, ItemState>();
    const client = new ItemClient({ onState: (id, s) => states.set(id, s) });
    const first = connect(items, client);

    await waitFor(() => client.items.length === 1);
    const sink = new MemorySink(1);
    client.download(0, sink);
    await waitFor(() => (states.get(0)?.received ?? 0) > 1 * MiB);

    first.a.close();
    first.server.close();
    const partial = states.get(0)!.received;
    expect(partial).toBeLessThan(file.size);

    // New connection, as after an ICE failure + renegotiation.
    connect(items, client);
    await waitFor(() => states.get(0)?.status === "done");

    expect(states.get(0)?.verified).toBe(true);
    expect(await sha256(new File([sink.bytes()], "x"))).toBe(
      await sha256(file),
    );
  });

  it("resumes from a checkpoint in a brand-new client (page reload)", async () => {
    const file = randomFile(6 * MiB, "reload.bin");
    const items = share([file]);
    let checkpoint: { written: number; state?: Uint8Array } | undefined;
    const before = new ItemClient({
      onCheckpoint: (_id, written, state) =>
        (checkpoint = { written, state: state() }),
    });
    const first = connect(items, before);
    await waitFor(() => before.items.length === 1);
    const sink = new MemorySink(1);
    before.download(0, sink);
    await waitFor(() => (checkpoint?.written ?? 0) >= 2 * MiB);

    // The page goes away: the connection dies and all in-memory state is lost,
    // except the checkpoint and the bytes already on disk.
    first.a.close();
    first.server.close();
    const saved = checkpoint!;
    const onDisk = sink.bytes().slice(0, saved.written);

    const after = new ItemClient();
    connect(items, after);
    await waitFor(() => after.items.length === 1);
    const resumed = new MemorySink();
    resumed.parts.push(onDisk);
    after.download(0, resumed, {
      offset: saved.written,
      hashState: saved.state,
    });
    await waitFor(() => after.states.get(0)?.status === "done");

    expect(after.states.get(0)?.verified).toBe(true);
    expect(await sha256(new File([resumed.bytes()], "x"))).toBe(
      await sha256(file),
    );
  });

  it("finishes once when the end message arrives twice", async () => {
    // After a resync the sender can send "end" again; finishing twice used
    // to finalize the hash twice and throw.
    const file = randomFile(2 * MiB, "twice.bin");
    const states = new Map<number, ItemState>();
    const client = new ItemClient({ onState: (id, st) => states.set(id, st) });
    const { a } = connect(share([file]), client);
    const send = a.send.bind(a);
    a.send = (data) => {
      send(data);
      if (typeof data === "string" && data.includes('"t":"end"')) send(data);
    };
    await waitFor(() => client.items.length === 1);
    const sink = new MemorySink(1);
    client.download(0, sink);
    await waitFor(() => states.get(0)?.status === "done");
    await new Promise((r) => setTimeout(r, 50));
    expect(states.get(0)).toMatchObject({ status: "done", verified: true });
  });

  it("detects corruption", async () => {
    const file = randomFile(1 * MiB, "c.bin");
    const states = new Map<number, ItemState>();
    const client = new ItemClient({ onState: (id, s) => states.set(id, s) });
    const { a } = connect(share([file]), client);
    a.corruptAt = 500_000;

    await waitFor(() => client.items.length === 1);
    const sink = new MemorySink();
    client.download(0, sink);
    await waitFor(() => states.get(0)?.status === "error");
    expect(states.get(0)?.error).toMatch(/integrity/i);
    expect(sink.aborted).toBe(true);
  });

  it("applies backpressure to a slow disk", async () => {
    const file = randomFile(40 * MiB, "slow.bin");
    const client = new ItemClient();
    const { a } = connect(share([file]), client, 256 * 1024);
    await waitFor(() => client.items.length === 1);

    let maxAhead = 0;
    const sink = new MemorySink(2);
    const origWrite = sink.write.bind(sink);
    let written = 0;
    sink.write = async (c) => {
      await origWrite(c);
      written += c.byteLength;
    };
    const timer = setInterval(() => {
      maxAhead = Math.max(maxAhead, a.bufferedAmount);
    }, 1);
    client.download(0, sink);
    await waitFor(() => client.states.get(0)?.status === "done", 60_000);
    clearInterval(timer);
    expect(written).toBe(file.size);
    expect(maxAhead).toBeLessThanOrEqual(8 * MiB + 256 * 1024);
  }, 60_000);

  it("cancels a download", async () => {
    const client = new ItemClient();
    connect(share([randomFile(8 * MiB)]), client);
    await waitFor(() => client.items.length === 1);
    const sink = new MemorySink(1);
    client.download(0, sink);
    await waitFor(() => (client.states.get(0)?.received ?? 0) > 0);
    await client.cancel(0);
    expect(client.states.get(0)?.status).toBe("cancelled");
    expect(sink.aborted).toBe(true);
    expect(client.busy).toBe(false);
  });

  it("does not stall when the sink transfers (detaches) chunk buffers", async () => {
    // The OPFS and service-worker sinks transfer each chunk to another
    // context, which empties the original buffer. A file larger than the
    // sender's window only completes if acks still count those bytes.
    const file = randomFile(40 * MiB, "detached.bin");
    const client = new ItemClient();
    connect(share([file]), client, 256 * 1024);
    await waitFor(() => client.items.length === 1);

    const sink = new MemorySink();
    const write = sink.write.bind(sink);
    sink.write = async (c) => {
      await write(c);
      structuredClone(c.buffer, { transfer: [c.buffer as ArrayBuffer] });
      expect(c.byteLength).toBe(0);
    };
    client.download(0, sink);
    await waitFor(() => client.states.get(0)?.status === "done", 30_000);
    expect(client.states.get(0)?.received).toBe(file.size);
    expect(client.states.get(0)?.verified).toBe(true);
  }, 30_000);
});

describe("sanitizing", () => {
  it("strips traversal and unsafe characters", () => {
    expect(sanitizePath("../../etc/passwd")).toEqual(["etc", "passwd"]);
    expect(sanitizePath("/abs\\win\\..\\x")).toEqual(["abs", "win", "x"]);
    expect(sanitizeName("..hidden")).toBe("_hidden");
    expect(sanitizeName('a<b>:c"d|e?f*g\u0001')).toBe("a_b__c_d_e_f_g_");
    expect(sanitizeName("")).toBe("file");
  });

  it("validates hello items", () => {
    const items = validItems([
      { id: 1, kind: "file", name: "../x", size: 10, path: "../a/b.txt" },
      { id: 2, kind: "file", name: "y", size: -1 },
      { id: 3, kind: "text", text: "t" },
      { kind: "file" },
      "junk",
    ]);
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ name: "__x", path: "a/b.txt" });
  });
});
