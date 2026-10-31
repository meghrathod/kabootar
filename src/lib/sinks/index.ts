import { canShareFiles, hasDirectoryPicker, hasOPFS, hasSavePicker, isIOS, isSafari } from "../platform";
import type { FileMeta } from "../transfer/protocol";
import { MemorySink } from "./memory";
import { OPFSSink } from "./opfs";
import { PickerSink, fileInDirectory, pickDirectory, pickSaveFile } from "./picker";
import { StreamSink } from "./stream";
import type { Sink } from "./types";

export type { Sink } from "./types";
export { clearIncoming, OPFSSink } from "./opfs";
export { pickDirectory, pickSaveFile };

/**
 * How received files reach the user's disk, best option first:
 *  picker: File System Access API (Chromium desktop), writes in place
 *  stream: service-worker streamed download (Chrome Android, Firefox)
 *  opfs:   private disk storage, then save/share (Safari, iOS)
 *  memory: in-memory blob (limited by RAM)
 */
export type Strategy = "picker" | "stream" | "opfs" | "memory";

export function bestStrategy(): Strategy {
  if (hasSavePicker) return "picker";
  if (StreamSink.available()) return "stream";
  if (hasOPFS && (isSafari || isIOS || !navigator.serviceWorker?.controller)) return "opfs";
  return "memory";
}

export const supportsFolderSave = hasDirectoryPicker;

export interface SinkTarget {
  strategy: Strategy;
  /** Picked ahead of time inside a user gesture. */
  file?: FileSystemFileHandle;
  dir?: FileSystemDirectoryHandle;
}

export async function openSink(meta: FileMeta, target: SinkTarget): Promise<Sink> {
  const sink = await chooseSink(meta, target);
  console.info(`[kabootar] saving "${meta.name}" (${meta.size} bytes) via ${sink.kind} (wanted ${target.strategy})`);
  return sink;
}

async function chooseSink(meta: FileMeta, target: SinkTarget): Promise<Sink> {
  switch (target.strategy) {
    case "picker":
      if (target.file) return PickerSink.fromHandle(target.file);
      if (target.dir) return PickerSink.fromHandle(await fileInDirectory(target.dir, meta));
      break;
    case "stream":
      try {
        return await StreamSink.open(meta);
      } catch (err) {
        console.warn("[kabootar] streamed download unavailable, falling back:", err);
      }
      break;
    case "opfs":
      break;
    case "memory":
      return new MemorySink(meta);
  }
  if (hasOPFS) {
    try {
      return await OPFSSink.open(meta);
    } catch (err) {
      console.warn("[kabootar] device storage unavailable, falling back to memory:", err);
      if (err instanceof Error && /storage space/.test(err.message)) throw err;
    }
  }
  return new MemorySink(meta);
}

/** Whether the file must be handed to the user after it lands in the browser. */
export function needsDelivery(sink: Sink) {
  return sink.kind === "opfs" || sink.kind === "memory";
}

/** Save a browser-held file with a regular download. */
export function downloadFile(file: File) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** On iOS the share sheet offers "Save to Files" / "Save to Photos". Needs a user gesture. */
export async function shareOrDownload(file: File) {
  if (isIOS && canShareFiles && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
    }
  }
  downloadFile(file);
}
