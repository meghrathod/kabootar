/// <reference lib="webworker" />
import { clientsClaim } from "workbox-core";
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from "workbox-precaching";
import { NavigationRoute, registerRoute } from "workbox-routing";

import { putShared } from "./lib/shareStore";

declare const self: ServiceWorkerGlobalScope & { __WB_MANIFEST: Array<{ url: string; revision: string | null }> };

// App shell: works offline and loads instantly on repeat visits.
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();
registerRoute(
  new NavigationRoute(createHandlerBoundToURL("/index.html"), {
    denylist: [/^\/api\//, /^\/ws\//, /^\/healthz/, /^\/share-target/, /^\/dl\//],
  }),
);

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") void self.skipWaiting();
  if (event.data?.type === "download") registerDownload(event);
});
clientsClaim();

// ---------------------------------------------------------------------------
// Web Share Target: files/text shared from other apps arrive as a POST.

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === "POST" && url.pathname === "/share-target") {
    event.respondWith(handleShare(event.request));
    return;
  }
  if (url.pathname.startsWith("/dl/")) {
    const res = serveDownload(url.pathname);
    if (res) event.respondWith(res);
  }
});

async function handleShare(request: Request): Promise<Response> {
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size >= 0 && f.name !== "");
    const id = crypto.randomUUID();
    await putShared(id, {
      files,
      title: (form.get("title") as string | null) ?? undefined,
      text: (form.get("text") as string | null) ?? undefined,
      url: (form.get("url") as string | null) ?? undefined,
      timestamp: Date.now(),
    });
    return Response.redirect(`/?shared=${id}`, 303);
  } catch (err) {
    console.error("share target failed", err);
    return Response.redirect("/?shared=error", 303);
  }
}

// ---------------------------------------------------------------------------
// Streamed downloads: the page pushes received chunks through a MessagePort
// and the browser saves the response like any other download, so large files
// never sit in memory.

interface PendingDownload {
  name: string;
  size: number;
  mime: string;
  port: MessagePort;
  created: number;
}

const downloads = new Map<string, PendingDownload>();

function registerDownload(event: ExtendableMessageEvent) {
  const port = event.ports[0];
  if (!port) return;
  const { name, size, mime } = event.data as { name: string; size: number; mime: string };
  const id = crypto.randomUUID();
  downloads.set(`/dl/${id}`, { name: String(name), size: Number(size), mime: String(mime), port, created: Date.now() });
  port.postMessage({ url: `/dl/${id}` });
  for (const [k, d] of downloads) if (Date.now() - d.created > 60_000) downloads.delete(k);
}

function serveDownload(path: string): Response | undefined {
  const d = downloads.get(path);
  if (!d) return undefined;
  downloads.delete(path);

  const { port } = d;
  const stream = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        // Tell the page the browser really started the download; if it never
        // does (blocked or prompted), the page falls back to another sink.
        port.postMessage({ started: true });
        port.onmessage = (e) => {
          const msg = e.data;
          if (msg.chunk) {
            controller.enqueue(new Uint8Array(msg.chunk));
            // Grant another write once the queue has room.
            if ((controller.desiredSize ?? 0) > 0) port.postMessage({ credit: 1 });
            else pendingCredits++;
          } else if (msg.done) {
            controller.close();
            port.close();
          } else if (msg.abort) {
            controller.error(new Error("aborted"));
            port.close();
          }
        };
      },
      pull() {
        if (pendingCredits > 0) {
          port.postMessage({ credit: pendingCredits });
          pendingCredits = 0;
        }
      },
      cancel() {
        port.postMessage({ cancelled: true });
        port.close();
      },
    },
    new CountQueuingStrategy({ highWaterMark: 32 }),
  );
  let pendingCredits = 0;

  const encoded = encodeURIComponent(d.name).replace(/['()]/g, escape);
  const ascii = d.name.replace(/[^\x20-\x7e]|["\\]/g, "_");
  return new Response(stream, {
    headers: {
      "Content-Type": d.mime || "application/octet-stream",
      "Content-Length": String(d.size),
      "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`,
      "X-Content-Type-Options": "nosniff",
    },
  });
}
