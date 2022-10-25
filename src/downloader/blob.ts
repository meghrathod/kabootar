import { FileDownloader } from "./index";

export class BlobFileDownloader implements FileDownloader {
  private parts: ArrayBuffer[];

  constructor(public name: string, public size: number) {}

  // skipcq: JS-0116, JS-0376
  async initialize() {
    this.parts = [];
  }

  // skipcq: JS-0116, JS-0376
  async append(data: ArrayBuffer) {
    this.parts.push(data);
  }

  // skipcq: JS-0116, JS-0376
  async finalize() {
    const blob = new Blob(this.parts);
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.download = this.name;
    a.href = url;
    a.click();

    URL.revokeObjectURL(url);
  }
}
