/// <reference lib="webworker" />
import { createSHA256 } from "hash-wasm";

const BLOCK = 8 * 1024 * 1024;

self.onmessage = async (e: MessageEvent<{ id: number; file: File }>) => {
  const { id, file } = e.data;
  try {
    const hasher = await createSHA256();
    for (let pos = 0; pos < file.size; pos += BLOCK) {
      hasher.update(
        new Uint8Array(await file.slice(pos, pos + BLOCK).arrayBuffer()),
      );
    }
    self.postMessage({ id, sha256: hasher.digest("hex") });
  } catch (err) {
    self.postMessage({
      id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
