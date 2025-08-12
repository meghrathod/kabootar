/// <reference lib="WebWorker" />

import { DownloadableStreamMetadata } from "./downloader/stream";

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("install", () => {
  self.skipWaiting();
  console.info("Service worker installed");
});

self.addEventListener("activate", () => {
  self.clients.claim();
  console.info("Service worker activated");
});

const downloadable = new Map<string, DownloadableStreamMetadata>();
const streamURLBase = "stream";

self.addEventListener("message", (event) => {
  if (event.data.type === "stream") {
    const metadata = event.data.data as DownloadableStreamMetadata;
    const url = `${self.registration.scope}${streamURLBase}/${metadata.seed}`;

    downloadable.set(url, metadata);
    // event.ports[0].postMessage(url);
    metadata.port.postMessage(url);
  }
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Handle Web Share Target POST
  const requestUrl = new URL(url);
  if (
    event.request.method === "POST" &&
    requestUrl.pathname === "/share-target"
  ) {
    event.respondWith(handleShareTarget(event));
    return;
  }
  if (url.endsWith("/stream/ping")) {
    return event.respondWith(new Response("pong"));
  }

  if (!downloadable.has(url)) {
    return;
  }

  const stream = downloadable.get(url);
  downloadable.delete(url);

  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Length": stream.size.toString(),
    "Content-Disposition": `attachment; filename="${encodeURIComponent(
      stream.name,
    )}"`,
  });

  event.respondWith(new Response(stream.stream, { headers }));
});

async function handleShareTarget(event: FetchEvent): Promise<Response> {
  try {
    const formData = await event.request.formData();
    const files = formData.getAll("files") as File[];
    const title = formData.get("title") as string | null;
    const text = formData.get("text") as string | null;
    const sharedUrl = formData.get("url") as string | null;

    await putSharedPayload({
      timestamp: Date.now(),
      files,
      title: title ?? undefined,
      text: text ?? undefined,
      url: sharedUrl ?? undefined,
    });

    const redirectUrl = new URL("/", self.registration.scope);
    redirectUrl.searchParams.set("share-target", "1");
    return Response.redirect(redirectUrl.toString(), 303);
  } catch (err) {
    console.error("Failed to handle share target:", err);
    return new Response("Failed to process share", { status: 500 });
  }
}

interface SharedPayload {
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

async function putSharedPayload(payload: SharedPayload): Promise<void> {
  const db = await openShareDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction("incoming", "readwrite");
    const store = tx.objectStore("incoming");
    store.put(payload, "latest");
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}
