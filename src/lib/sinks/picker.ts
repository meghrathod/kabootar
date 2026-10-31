import type { FileMeta } from "../transfer/protocol";
import { sanitizeName, sanitizePath } from "../transfer/protocol";
import type { Sink } from "./types";

/** Writes straight to a file the user picked (Chromium desktop). */
export class PickerSink implements Sink {
  readonly kind = "picker" as const;

  private constructor(private writable: FileSystemWritableFileStream) {}

  static async fromHandle(handle: FileSystemFileHandle): Promise<PickerSink> {
    return new PickerSink(
      await handle.createWritable({ keepExistingData: false }),
    );
  }

  async write(chunk: Uint8Array) {
    await this.writable.write(chunk as Uint8Array<ArrayBuffer>);
  }

  async close() {
    await this.writable.close();
  }

  async abort() {
    await this.writable.abort().catch(() => {});
  }
}

/** Must be called from a user gesture. */
export function pickSaveFile(meta: FileMeta): Promise<FileSystemFileHandle> {
  return window.showSaveFilePicker({ suggestedName: meta.name });
}

/** Must be called from a user gesture. */
export function pickDirectory(): Promise<FileSystemDirectoryHandle> {
  return window.showDirectoryPicker({
    mode: "readwrite",
    id: "kabootar-downloads",
    startIn: "downloads",
  });
}

async function exists(dir: FileSystemDirectoryHandle, name: string) {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Creates the file inside dir, recreating folder structure and avoiding overwrites. */
export async function fileInDirectory(
  dir: FileSystemDirectoryHandle,
  meta: FileMeta,
): Promise<FileSystemFileHandle> {
  const parts = meta.path ? sanitizePath(meta.path) : [];
  const name = parts.pop() ?? sanitizeName(meta.name);
  let target = dir;
  for (const p of parts)
    target = await target.getDirectoryHandle(p, { create: true });

  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let candidate = name;
  for (let i = 1; await exists(target, candidate); i++)
    candidate = `${base} (${i})${ext}`;
  return target.getFileHandle(candidate, { create: true });
}
