/**
 * Hashes files in a worker, once per File, shared by all receivers.
 */
let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, { resolve: (v: string) => void; reject: (e: Error) => void }>();
const cache = new WeakMap<File, Promise<string>>();

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL("../workers/hash.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (e: MessageEvent<{ id: number; sha256?: string; error?: string }>) => {
      const p = pending.get(e.data.id);
      pending.delete(e.data.id);
      if (e.data.sha256) p?.resolve(e.data.sha256);
      else p?.reject(new Error(e.data.error ?? "hash failed"));
    };
  }
  return worker;
}

export function hashFile(file: File): Promise<string> {
  let p = cache.get(file);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      getWorker().postMessage({ id, file });
    });
    cache.set(file, p);
  }
  return p;
}
