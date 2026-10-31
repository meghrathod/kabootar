import type { FileMeta } from "../transfer/protocol";
import { sanitizeName } from "../transfer/protocol";
import type { Sink } from "./types";

/**
 * Writes to the Origin Private File System (disk), then hands back a File the
 * user can save or share. Used on Safari/iOS, which has no save picker.
 */
export class OPFSSink implements Sink {
  readonly kind = "opfs" as const;

  private worker: Worker;
  private rid = 0;
  private pending = new Map<
    number,
    { resolve: (position?: number) => void; reject: (e: Error) => void }
  >();
  /** Folder inside OPFS holding this file; persisted to resume after a reload. */
  readonly dir: string;
  startAt = 0;
  private name: string;

  private constructor(meta: FileMeta, dir?: string) {
    this.dir = dir ?? crypto.randomUUID();
    this.name = sanitizeName(meta.name);
    this.worker = new Worker(
      new URL("../../workers/opfs.worker.ts", import.meta.url),
      { type: "module" },
    );
    this.worker.onmessage = (
      e: MessageEvent<{
        rid: number;
        ok: boolean;
        error?: string;
        position?: number;
      }>,
    ) => {
      const p = this.pending.get(e.data.rid);
      this.pending.delete(e.data.rid);
      if (e.data.ok) p?.resolve(e.data.position);
      else p?.reject(new Error(e.data.error ?? "write failed"));
    };
    this.worker.onerror = () => {
      for (const p of this.pending.values())
        p.reject(new Error("Storage worker crashed"));
      this.pending.clear();
    };
  }

  /** Open a new file, or reopen a partial one at `resume.offset` after a reload. */
  static async open(
    meta: FileMeta,
    resume?: { dir: string; offset: number },
  ): Promise<OPFSSink> {
    const estimate = await navigator.storage
      .estimate?.()
      .catch(() => undefined);
    const needed = meta.size - (resume?.offset ?? 0);
    if (
      estimate?.quota &&
      estimate.usage !== undefined &&
      estimate.quota - estimate.usage < needed
    ) {
      throw new Error("Not enough storage space on this device for this file");
    }
    const sink = new OPFSSink(meta, resume?.dir);
    try {
      sink.startAt =
        (await sink.call(
          {
            op: "open",
            dir: sink.dir,
            name: sink.name,
            at: resume?.offset ?? 0,
          },
          [],
          8000,
        )) ?? 0;
      return sink;
    } catch (err) {
      sink.worker.terminate();
      throw err;
    }
  }

  /**
   * Round-trip to the storage worker. Times out rather than hanging: on some
   * iOS versions OPFS can stop answering, and a silent hang would leave the
   * transfer stuck at 0%.
   */
  private call(
    msg: Record<string, unknown>,
    transfer: Transferable[] = [],
    timeoutMs = 20_000,
  ): Promise<number | undefined> {
    const rid = this.rid++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        reject(new Error("Device storage stopped responding"));
      }, timeoutMs);
      this.pending.set(rid, {
        resolve: (position) => (clearTimeout(timer), resolve(position)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.worker.postMessage({ ...msg, rid }, transfer);
    });
  }

  async write(chunk: Uint8Array) {
    const buf =
      chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? (chunk.buffer as ArrayBuffer)
        : chunk.slice().buffer;
    await this.call({ op: "write", data: buf }, [buf]);
  }

  async close(): Promise<File> {
    await this.call({ op: "close" });
    this.worker.terminate();
    const root = await navigator.storage.getDirectory();
    const dir = await (
      await root.getDirectoryHandle("incoming")
    ).getDirectoryHandle(this.dir);
    return (await dir.getFileHandle(this.name)).getFile();
  }

  async abort() {
    await this.call({ op: "abort" }).catch(() => {});
    this.worker.terminate();
  }
}

/**
 * Remove files left over from previous visits, except partial downloads this
 * tab can still resume. Files held open by another tab are locked and
 * survive the attempt.
 */
export async function clearIncoming(keep: Set<string> = new Set()) {
  try {
    const root = await navigator.storage.getDirectory();
    const incoming = await root.getDirectoryHandle("incoming");
    for await (const name of (
      incoming as FileSystemDirectoryHandle & { keys(): AsyncIterable<string> }
    ).keys()) {
      if (!keep.has(name))
        await incoming.removeEntry(name, { recursive: true }).catch(() => {});
    }
  } catch {
    // nothing to clear
  }
}
