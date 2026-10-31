/**
 * Hand-off of content shared to Kabootar from other apps (Web Share Target).
 * The service worker stores the POSTed payload here and redirects to the app,
 * which picks it up. Used from both the service worker and the page.
 */

export interface SharedPayload {
  files: File[];
  title?: string;
  text?: string;
  url?: string;
  timestamp: number;
}

const DB = "kabootar-share-target";
const STORE = "incoming";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putShared(id: string, payload: SharedPayload): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(payload, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function takeShared(id: string): Promise<SharedPayload | undefined> {
  const db = await open();
  const value = await new Promise<SharedPayload | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.get(id);
    req.onsuccess = () => {
      store.delete(id);
      resolve(req.result as SharedPayload | undefined);
    };
    req.onerror = () => reject(req.error);
  });
  db.close();
  return value;
}

/** Drop payloads older than a day that were never picked up. */
export async function pruneShared(): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const req = store.openCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      if (Date.now() - (cur.value as SharedPayload).timestamp > 86_400_000) cur.delete();
      cur.continue();
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  });
  db.close();
}
