/**
 * Per-tab memory that lets transfers survive a page reload (sessionStorage:
 * scoped to the tab, kept across reloads, gone when the tab closes).
 */

export interface SavedDownload {
  /** OPFS folder holding the partial file. */
  dir: string;
  name: string;
  size: number;
  written: number;
  /** hash-wasm SHA-256 state at `written`, base64. */
  state?: string;
}

const dlKey = (roomId: string) => `kabootar:dl:${roomId}`;

function read<T>(key: string): T | undefined {
  try {
    const v = sessionStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : undefined;
  } catch {
    return undefined;
  }
}

function write(key: string, value: unknown) {
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // storage full or disabled: resuming just won't be available
  }
}

export function savedDownloads(roomId: string): Record<number, SavedDownload> {
  return read<Record<number, SavedDownload>>(dlKey(roomId)) ?? {};
}

export function saveDownload(roomId: string, id: number, d: SavedDownload) {
  write(dlKey(roomId), { ...savedDownloads(roomId), [id]: d });
}

export function dropDownload(roomId: string, id: number) {
  const all = savedDownloads(roomId);
  delete all[id];
  if (Object.keys(all).length) write(dlKey(roomId), all);
  else sessionStorage.removeItem(dlKey(roomId));
}

/** OPFS folders that belong to resumable downloads in this tab. */
export function resumableDirs(): Set<string> {
  const dirs = new Set<string>();
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (!k?.startsWith("kabootar:dl:")) continue;
    for (const d of Object.values(read<Record<number, SavedDownload>>(k) ?? {})) dirs.add(d.dir);
  }
  return dirs;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function fromBase64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

// ---------------------------------------------------------------------------
// Sender: the share survives a reload, but browsers don't keep access to the
// picked files, so the user re-adds them and the same room resumes.

export interface SavedShare {
  created: {
    id: string;
    name: string;
    emoji: string;
    color: string;
    masterKey: string;
    clientKey: string;
    pin: string;
    expiresAt: string;
  };
  discoverable: boolean;
  ip?: import("./publicIp").PublicAddresses;
  items: import("./transfer/protocol").ItemMeta[];
}

const shareKey = (roomId: string) => `kabootar:send:${roomId}`;

export const savedShare = (roomId: string) => read<SavedShare>(shareKey(roomId));
export const saveShare = (s: SavedShare) => write(shareKey(s.created.id), s);
export const dropShare = (roomId: string) => sessionStorage.removeItem(shareKey(roomId));
