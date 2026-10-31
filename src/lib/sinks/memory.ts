import type { FileMeta } from "../transfer/protocol";
import type { Sink } from "./types";

/** Last resort: keeps the file in memory. Limited by available RAM. */
export class MemorySink implements Sink {
  readonly kind = "memory" as const;
  private parts: BlobPart[] = [];

  constructor(private meta: FileMeta) {}

  async write(chunk: Uint8Array) {
    this.parts.push(chunk as Uint8Array<ArrayBuffer>);
  }

  async close() {
    const file = new File(this.parts, this.meta.name, {
      type: this.meta.type,
      lastModified: this.meta.lastModified,
    });
    this.parts = [];
    return file;
  }

  async abort() {
    this.parts = [];
  }
}
