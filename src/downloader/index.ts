// import { FSFileDownloader } from "./fs";
import { BlobFileDownloader } from "./blob";
import { StreamFileDownloader } from "./stream";

export interface FileDownloader {
  name: string;
  size: number;

  initialize(): Promise<void>;

  append(data: ArrayBuffer): Promise<void>;

  finalize(): Promise<void>;
}

export function getFileDownloader(name: string, size: number): FileDownloader {
  // if ("showSaveFilePicker" in window) {
  //   return new FSFileDownloader(name, size);
  // }

  if (StreamFileDownloader.isAvailable()) {
    return new StreamFileDownloader(name, size);
  }

  return new BlobFileDownloader(name, size);
}
