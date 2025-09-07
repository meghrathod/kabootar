import RNFS from "react-native-fs";
import * as Sharing from "expo-sharing";

export interface FileDownloader {
  initialize(): Promise<void>;
  append(data: ArrayBuffer): Promise<void>;
  finalize(): Promise<void>;
}

export class RNFSFileDownloader implements FileDownloader {
  private filePath: string;
  private fileDescriptor: number | null = null;

  constructor(
    private name: string,
    private size: number,
  ) {
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, "_");
    this.filePath = `${RNFS.CachesDirectoryPath}/${Date.now()}_${safe}`;
  }

  async initialize(): Promise<void> {
    await RNFS.writeFile(this.filePath, "", "base64");
  }

  async append(data: ArrayBuffer): Promise<void> {
    // Convert ArrayBuffer to base64 and append
    const uint8 = new Uint8Array(data);
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < uint8.length; i += chunk) {
      binary += String.fromCharCode.apply(
        null,
        Array.from(uint8.subarray(i, i + chunk)) as any,
      );
    }
    const b64 = global.btoa(binary);
    await RNFS.appendFile(this.filePath, b64, "base64");
  }

  async finalize(): Promise<void> {
    if (await Sharing.isAvailableAsync()) {
      await Sharing.shareAsync("file://" + this.filePath, {
        dialogTitle: this.name,
      });
    }
  }
}

export function getFileDownloader(name: string, size: number): FileDownloader {
  return new RNFSFileDownloader(name, size);
}
