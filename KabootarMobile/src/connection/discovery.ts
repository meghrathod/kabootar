import { getPublicIP } from "./ip";
import { baseURL, wsScheme } from "../config";

export type DiscoveredRoomItem = {
  id: string;
  background: string;
  name: string;
  emoji: string;
};

export default class Discovery {
  private constructor(
    private ws: WebSocket,
    private added: (room: DiscoveredRoomItem) => void,
    private removed: (id: string) => void,
  ) {
    ws.addEventListener("message", this.messageListener.bind(this));
  }

  static async connect(
    added: (room: DiscoveredRoomItem) => void,
    removed: (id: string) => void,
  ): Promise<Discovery | undefined> {
    try {
      const ip = await getPublicIP();
      const ws = new WebSocket(`${wsScheme}${baseURL}/discover?ip=${ip}`);
      return new Discovery(ws, added, removed);
    } catch (e) {
      console.error(e);
      return;
    }
  }

  close() {
    this.ws.close();
  }

  private messageListener(event: MessageEvent) {
    try {
      const data = JSON.parse((event as any).data);
      switch (data[0]) {
        case "0":
          this.onAddMessage(data);
          break;
        case "1":
          this.onRemoveMessage(data);
          break;
      }
    } catch (e) {
      console.error(e);
    }
  }

  private onAddMessage(data: string[]) {
    if (data.length < 4 || data[0] !== "0") return;
    this.added({
      id: data[1],
      background: "#00000011",
      name: data[2],
      emoji: data[3],
    });
  }

  private onRemoveMessage(data: string[]) {
    if (data.length < 2 || data[0] !== "1") return;
    this.removed(data[1]);
  }
}
