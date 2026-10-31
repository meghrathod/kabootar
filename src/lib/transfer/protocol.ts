/**
 * Data-channel protocol (v2).
 *
 * Control messages are JSON strings; file bytes are binary messages that
 * belong to the transfer most recently announced with "start". The channel is
 * ordered and reliable, so no framing is needed.
 *
 *   sender                         receiver
 *   hello {items}          ──▶
 *                          ◀──     get {id, offset}
 *   start {id, offset}     ──▶
 *   <binary chunks>        ──▶     (writes, hashes)
 *                          ◀──     ack {id, received}     every ACK_EVERY bytes
 *   end {id, sha256}       ──▶
 *                          ◀──     done {id, ok}
 *
 * The sender never runs more than WINDOW bytes ahead of the last ack, which
 * gives end-to-end backpressure when the receiver's disk is slower than the
 * network. Resuming after a reconnect is just "get" with a non-zero offset.
 */

export const PROTOCOL_VERSION = 2;

export const KiB = 1024;
export const MiB = 1024 * KiB;

/** Max bytes in flight beyond the receiver's last ack. */
export const WINDOW = 32 * MiB;
/** Receiver acks after writing this many bytes. */
export const ACK_EVERY = 1 * MiB;
/** Pause sending when the channel buffer exceeds this. */
export const HIGH_WATER = 8 * MiB;
/** Resume sending when the channel buffer drops below this. */
export const LOW_WATER = 1 * MiB;
/** Bytes read from disk per File.slice() call. */
export const READ_BLOCK = 4 * MiB;
/** Upper bound for text items carried inline in "hello". */
export const MAX_TEXT = 64 * KiB;

export interface FileMeta {
  id: number;
  kind: "file";
  name: string;
  size: number;
  type: string;
  lastModified: number;
  /** Relative path for folder shares, e.g. "photos/2024/a.jpg". */
  path?: string;
}

export interface TextMeta {
  id: number;
  kind: "text";
  text: string;
}

export type ItemMeta = FileMeta | TextMeta;

export type SenderMsg =
  | { t: "hello"; v: number; items: ItemMeta[] }
  | { t: "start"; id: number; offset: number }
  | { t: "end"; id: number; sha256: string }
  | { t: "error"; id: number; message: string };

export type ReceiverMsg =
  | { t: "get"; id: number; offset: number }
  | { t: "ack"; id: number; received: number }
  | { t: "done"; id: number; ok: boolean }
  | { t: "cancel"; id: number };

/** Subset of RTCDataChannel used by the transfer layer (so tests can fake it). */
export interface Channel {
  readonly readyState: RTCDataChannelState;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  binaryType: BinaryType;
  send(data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>): void;
  // Listener types are loose so RTCDataChannel and test fakes both fit.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  addEventListener(type: "message" | "open" | "close" | "bufferedamountlow", fn: (e: any) => void): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  removeEventListener(type: string, fn: (e: any) => void): void;
  close(): void;
}

/** Largest message both peers accept, capped for fairness between peers. */
export function chunkSizeFor(maxMessageSize: number | null | undefined): number {
  const max = maxMessageSize && maxMessageSize > 0 ? maxMessageSize : 64 * KiB;
  return Math.max(16 * KiB, Math.min(256 * KiB, max));
}

export function parseJSON<T>(data: unknown): T | undefined {
  if (typeof data !== "string") return undefined;
  try {
    return JSON.parse(data) as T;
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line no-control-regex
const unsafeChars = /[\u0000-\u001f\u007f<>:"\\|?*]/g;

/** Make a single path segment from a peer safe to use as a file name. */
export function sanitizeName(name: string): string {
  let n = String(name).replace(unsafeChars, "_").replace(/\//g, "_").trim();
  n = n.replace(/^\.+/, "_");
  if (!n) n = "file";
  return n.slice(0, 200);
}

/** Make a relative path from a peer safe: no traversal, no absolute paths. */
export function sanitizePath(path: string): string[] {
  return String(path)
    .split(/[\\/]+/)
    .filter((s) => s && s !== "." && s !== "..")
    .map(sanitizeName)
    .slice(0, 16);
}

/** Validate a hello from the sender; never trust a peer's shapes. */
export function validItems(items: unknown): ItemMeta[] {
  if (!Array.isArray(items)) return [];
  const out: ItemMeta[] = [];
  for (const raw of items.slice(0, 10_000)) {
    if (!raw || typeof raw !== "object") continue;
    const it = raw as Record<string, unknown>;
    if (typeof it.id !== "number") continue;
    if (it.kind === "file" && typeof it.name === "string" && typeof it.size === "number" && it.size >= 0) {
      out.push({
        id: it.id,
        kind: "file",
        name: sanitizeName(it.name),
        size: it.size,
        type: typeof it.type === "string" ? it.type.slice(0, 200) : "",
        lastModified: typeof it.lastModified === "number" ? it.lastModified : Date.now(),
        path: typeof it.path === "string" ? sanitizePath(it.path).join("/") || undefined : undefined,
      });
    } else if (it.kind === "text" && typeof it.text === "string") {
      out.push({ id: it.id, kind: "text", text: it.text.slice(0, MAX_TEXT) });
    }
  }
  return out;
}
