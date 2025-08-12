export interface SharedPayload {
  timestamp: number;
  files: File[];
  title?: string;
  text?: string;
  url?: string;
}

function openShareDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kabootar-share-target", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("incoming")) {
        db.createObjectStore("incoming");
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function takeSharedPayload(): Promise<SharedPayload | undefined> {
  const db = await openShareDb();
  const value = await new Promise<SharedPayload | undefined>((resolve, reject) => {
    const tx = db.transaction("incoming", "readwrite");
    const store = tx.objectStore("incoming");
    const getReq = store.get("latest");
    getReq.onsuccess = () => {
      const payload = getReq.result as SharedPayload | undefined;
      // Clear after reading
      store.delete("latest");
      resolve(payload);
    };
    getReq.onerror = () => reject(getReq.error);
  });
  db.close();
  return value;
}


