/// <reference lib="webworker" />
/**
 * Writes incoming files to the Origin Private File System with a synchronous
 * access handle. Data lands on disk instead of in memory, which is what
 * allows Safari/iOS to receive files larger than its ~2 GB blob limit.
 */

type Req =
  | { op: "open"; rid: number; dir: string; name: string; at?: number }
  | { op: "write"; rid: number; data: ArrayBuffer }
  | { op: "close"; rid: number }
  | { op: "abort"; rid: number };

let handle: FileSystemSyncAccessHandle | undefined;
let fileHandle: FileSystemFileHandle | undefined;
let dirHandle: FileSystemDirectoryHandle | undefined;
let parentHandle: FileSystemDirectoryHandle | undefined;
let dirName = "";
let position = 0;

async function open(dir: string, name: string, at = 0) {
  const root = await navigator.storage.getDirectory();
  parentHandle = await root.getDirectoryHandle("incoming", { create: true });
  dirHandle = await parentHandle.getDirectoryHandle(dir, { create: true });
  dirName = dir;
  fileHandle = await dirHandle.getFileHandle(name, { create: true });
  handle = await (fileHandle as FileSystemFileHandle & {
    createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
  }).createSyncAccessHandle();
  // Resuming keeps the bytes before `at`; anything after it is a partial
  // chunk from the interrupted session and is discarded. If the file is
  // shorter than expected, start over rather than leave a gap.
  position = handle.getSize() >= at ? at : 0;
  handle.truncate(position);
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const req = e.data;
  try {
    switch (req.op) {
      case "open":
        await open(req.dir, req.name, req.at);
        break;
      case "write": {
        if (!handle) throw new Error("not open");
        const view = new Uint8Array(req.data);
        let written = 0;
        while (written < view.byteLength) {
          written += handle.write(view.subarray(written), { at: position + written });
        }
        position += view.byteLength;
        break;
      }
      case "close":
        handle?.flush();
        handle?.close();
        handle = undefined;
        break;
      case "abort":
        handle?.close();
        handle = undefined;
        if (parentHandle && dirName) await parentHandle.removeEntry(dirName, { recursive: true }).catch(() => {});
        break;
    }
    self.postMessage({ rid: req.rid, ok: true, position });
  } catch (err) {
    self.postMessage({ rid: req.rid, ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};
