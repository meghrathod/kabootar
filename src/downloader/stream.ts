import { FileDownloader } from "./index";

export interface DownloadableStreamMetadata {
  name: string;
  size: number;
  seed: number;
  port: MessagePort;
  stream: ReadableStream;
}

export class StreamFileDownloader implements FileDownloader {
  sw: ServiceWorker;
  controller: ReadableStreamController<ArrayBuffer>;
  seed: number;

  constructor(public name: string, public size: number) {
    this.sw = navigator.serviceWorker.controller;
  }

  static isAvailable() {
    return navigator.serviceWorker.controller.state === "activated";
  }

  async initialize() {
    this.seed = Math.floor(Math.random() * 1_000_000_000);

    const stream = new ReadableStream<ArrayBuffer>({
      start: (controller) => {
        this.controller = controller;
      },
      cancel: () => {
        // TODO(AG): handle cancellation
      },
    });
    const channel = new MessageChannel();
    this.sw.postMessage(
      {
        type: "stream",
        data: {
          name: this.name,
          size: this.size,
          seed: this.seed,
          port: channel.port2,
          stream: stream,
        } as DownloadableStreamMetadata,
      },
      [channel.port2, stream as unknown as Transferable]
    );

    const url = await new Promise<string>((resolve) => {
      channel.port1.onmessage = (event) => {
        resolve(event.data);
        channel.port1.close();
        channel.port2.close();
      };
    });

    const iframe = document.createElement("iframe");
    iframe.hidden = true;
    iframe.src = url;
    iframe.name = "iframe";
    document.body.appendChild(iframe);
  }

  async append(data: ArrayBuffer) {
    this.controller.enqueue(data);
  }

  async finalize() {
    this.controller.close();
  }
}
