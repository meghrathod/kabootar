import { isIOS, isSafari } from "../platform";
import type { FileMeta } from "../transfer/protocol";
import type { Sink } from "./types";

const CREDITS = 16;

/**
 * Streams the file through the service worker as a regular browser download,
 * so nothing is held in memory (Chrome on Android, Firefox).
 */
export class StreamSink implements Sink {
  readonly kind = "stream" as const;

  private credits = CREDITS;
  private waiters: (() => void)[] = [];
  private cancelled: string | undefined;

  private constructor(private port: MessagePort) {
    port.onmessage = (e) => {
      if (e.data?.credit) {
        this.credits += e.data.credit;
        this.waiters.splice(0).forEach((w) => w());
      } else if (e.data?.cancelled) {
        this.cancelled = "Download was cancelled in the browser";
        this.waiters.splice(0).forEach((w) => w());
      }
    };
  }

  static available(): boolean {
    return !isSafari && !isIOS && !!navigator.serviceWorker?.controller;
  }

  static async open(meta: FileMeta): Promise<StreamSink> {
    const sw = navigator.serviceWorker.controller;
    if (!sw) throw new Error("Service worker not active");
    const { port1, port2 } = new MessageChannel();

    // The service worker replies with the download URL, then with
    // `started` once the browser actually requests it. If the browser blocks
    // or prompts for the download and never requests it, we'd otherwise wait
    // forever, so give up and let the caller fall back to another sink.
    let iframe: HTMLIFrameElement | undefined;
    await new Promise<void>((resolve, reject) => {
      const fail = (msg: string) => {
        iframe?.remove();
        port1.close();
        reject(new Error(msg));
      };
      let timer = setTimeout(
        () => fail("Service worker did not respond"),
        5000,
      );
      port1.onmessage = (e) => {
        if (e.data?.url) {
          clearTimeout(timer);
          timer = setTimeout(
            () => fail("Browser did not start the download"),
            6000,
          );
          iframe = document.createElement("iframe");
          iframe.hidden = true;
          iframe.src = e.data.url;
          document.body.appendChild(iframe);
        } else if (e.data?.started) {
          clearTimeout(timer);
          resolve();
        }
      };
      sw.postMessage(
        {
          type: "download",
          name: meta.name,
          size: meta.size,
          mime: meta.type || "application/octet-stream",
        },
        [port2],
      );
    });

    const frame = iframe;
    setTimeout(() => frame?.remove(), 60_000);
    return new StreamSink(port1);
  }

  async write(chunk: Uint8Array) {
    while (this.credits <= 0 && !this.cancelled)
      await new Promise<void>((r) => this.waiters.push(r));
    if (this.cancelled) throw new Error(this.cancelled);
    this.credits--;
    const buf =
      chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength
        ? (chunk.buffer as ArrayBuffer)
        : chunk.slice().buffer;
    this.port.postMessage({ chunk: buf }, [buf]);
  }

  async close() {
    this.port.postMessage({ done: true });
  }

  async abort() {
    this.port.postMessage({ abort: true });
    this.port.close();
  }
}
