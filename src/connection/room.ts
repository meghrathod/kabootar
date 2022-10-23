// skipcq: JS-0108
import { getPublicIP } from "./ip";
import { baseURL, httpScheme, iceServers, wsScheme } from "../config";

interface MasterEventDispatcher {
  numClientsChanged(n: number);
}

interface ClientEventDispatcher {
  receivePercentageChanged(percentage: number);
  connectionStatusChanged(connected: boolean);
  filenameChanged(name: string);
  connectionSpeed(speed: number);
}

export type RoomEventDispatcher<Master extends boolean> = Master extends true
  ? MasterEventDispatcher
  : ClientEventDispatcher;

class Room<Master extends boolean> {
  handler: MasterHandler | ClientHandler;

  private constructor(
    public isMaster: Master,
    public id: string,
    public name: string,
    public emoji: string,
    private ws: WebSocket,
    private clientKey: string,
    public file: Master extends true ? File : undefined,
    private eventDispatcher: RoomEventDispatcher<Master>,
    public pin?: string
  ) {
    this.handler = isMaster
      ? new MasterHandler(
          ws,
          file,
          eventDispatcher as RoomEventDispatcher<true>
        )
      : new ClientHandler(ws, eventDispatcher as RoomEventDispatcher<false>);

    ws.addEventListener("close", this.handleClose.bind(this));
  }

  static async create(
    file: File,
    dispatcher: RoomEventDispatcher<true>
  ): Promise<Room<true> | undefined> {
    const response = await fetch(`${httpScheme}${baseURL}/room`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(await getDiscoveryParams()),
    });

    const [roomID, masterKey, clientKey, roomName, pin, emoji] =
      await response.json();

    const ws = await this.initWS(roomID, masterKey, true);
    if (ws === undefined) {
      return undefined;
    }

    return new Room(
      true,
      roomID,
      roomName,
      emoji,
      ws,
      clientKey,
      file,
      dispatcher,
      pin
    );
  }

  static async joinDirect(
    id: string,
    key: string,
    name: string,
    emoji: string,
    dispatcher: RoomEventDispatcher<false>
  ): Promise<Room<false> | undefined> {
    const ws = await this.initWS(id, key, false);
    if (ws === undefined) {
      return undefined;
    }

    return new Room(false, id, name, emoji, ws, key, undefined, dispatcher);
  }

  static async initWS(
    id: string,
    key: string,
    isMaster: boolean
  ): Promise<WebSocket | undefined> {
    const ws = new WebSocket(
      `${wsScheme}${baseURL}/ws/${id}?k=${key}&m=${isMaster ? "t" : "f"}`
    );

    const canConnect = await new Promise<boolean>((resolve) => {
      function close(_event: CloseEvent) {
        ws.removeEventListener("close", close);
        resolve(false);
      }

      ws.addEventListener("close", close);

      function message(event: MessageEvent) {
        try {
          if (JSON.parse(event.data)[0] === "-1") {
            resolve(true);
          } else {
            resolve(false);
          }
        } catch {
          resolve(false);
        } finally {
          ws.removeEventListener("message", message);
        }
      }

      ws.addEventListener("message", message);
    });

    if (canConnect) {
      return ws;
    }

    if (ws.readyState !== ws.CLOSED || ws.readyState !== ws.CLOSING) {
      ws.close();
    }

    return undefined;
  }

  constructHash() {
    return `k=${this.clientKey}&n=${this.name}&e=${this.emoji}`;
  }

  close() {
    this.ws.close();
  }

  private handleClose(_event: CloseEvent) {
    this.handler.goodbye();
  }
}

const channelLabel = "d";

class MasterHandler {
  clients: Map<string, MasterClient>;

  constructor(
    private ws: WebSocket,
    private file: File,
    private dispatcher: RoomEventDispatcher<true>
  ) {
    ws.addEventListener("message", this.handleMessage.bind(this));
    this.clients = new Map();
  }

  goodbye() {}

  private handleMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data);

      switch (data[0]) {
        case "0":
          this.handleJoin(data);
          break;

        case "1":
          this.handleLeave(data);
          break;

        case "2":
          this.handleSignalMessage(data);
          break;
      }
    } catch {}
  }

  private handleJoin(data: string[]) {
    if (data.length < 2) {
      return;
    }
    this.clients.set(
      data[1],
      new MasterClient(
        data[1],
        this.file,
        (id, signal) => {
          this.ws.send(JSON.stringify(["0", id, signal]));
        },
        () => {
          this.clients.delete(data[1]);
          this.dispatcher.numClientsChanged(this.clients.size);
        }
      )
    );
    this.dispatcher.numClientsChanged(this.clients.size);
  }

  private handleLeave(data: string[]) {
    if (data.length < 2) {
      return;
    }

    // TODO(AG): Perform cleanup
    const client = this.clients.get(data[1]);
    if (client) {
      client.close();
    }

    this.clients.delete(data[1]);
    this.dispatcher.numClientsChanged(this.clients.size);
  }

  private handleSignalMessage(data: string[]) {
    if (data.length < 3) {
      return;
    }

    const [_, id, message] = data;
    const client = this.clients.get(id);
    if (client) {
      client.handleSignal(message);
    }
  }
}

enum MasterClientSignal {
  OFFER,
  TRICKLE_ICE,
}

enum ClientMasterSignal {
  ANSWER,
  TRICKLE_ICE,
}

const chunkSize = 16 * 1024; // 15 KiB

class MasterClient {
  private channelOpen: boolean;
  private closed: boolean;

  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel;

  constructor(
    private id: string,
    private file: File,
    private sendSignal: (id: string, signal: string) => void,
    private onClose: () => void
  ) {
    this.closed = false;

    this.pc = new RTCPeerConnection({ ...iceServers });
    this.pc.addEventListener("icecandidate", this.onIceCandidate.bind(this));
    this.pc.addEventListener(
      "connectionstatechange",
      this.onConnectionStateChange.bind(this)
    );

    this.createDataChannel();
    // noinspection JSIgnoredPromiseFromCall
    this.makeOffer();
  }

  private createDataChannel() {
    this.dataChannel = this.pc.createDataChannel(channelLabel, {
      ordered: true,
    });
    this.dataChannel.addEventListener("open", this.dataChannelOpen.bind(this));
    this.dataChannel.addEventListener(
      "close",
      this.metaChannelClose.bind(this)
    );
  }

  private onConnectionStateChange(_event: Event) {
    if (
      this.pc.connectionState === "closed" ||
      this.pc.connectionState === "disconnected"
    ) {
      this.close();
    }
  }

  public handleSignal(signal: string) {
    try {
      const data = JSON.parse(signal);

      switch (data[0]) {
        case ClientMasterSignal.ANSWER:
          // noinspection JSIgnoredPromiseFromCall
          this.handleAnswer(data);
          break;

        case ClientMasterSignal.TRICKLE_ICE:
          // noinspection JSIgnoredPromiseFromCall
          this.handleTrickleIce(data);
          break;
      }
    } catch {}
  }

  close() {
    this.closed = true;
    this.pc.close();
    this.onClose();
  }

  private onIceCandidate(event: RTCPeerConnectionIceEvent) {
    if (event.candidate) {
      this.sendSignal(
        this.id,
        JSON.stringify([MasterClientSignal.TRICKLE_ICE, event.candidate])
      );
    }
  }

  private async handleAnswer(data: any[]) {
    if (data.length < 2) {
      return;
    }

    await this.pc.setRemoteDescription(data[1]);
  }

  private async handleTrickleIce(data: any[]) {
    if (data.length < 2) {
      return;
    }

    await this.pc.addIceCandidate(data[1]);
  }

  private async makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal(
      this.id,
      JSON.stringify([MasterClientSignal.OFFER, this.pc.localDescription])
    );
  }

  private sendMetadata() {
    const message = JSON.stringify([this.file.name, this.file.size]);

    const buf = new ArrayBuffer(message.length);
    const view = new Uint8Array(buf);
    view.set(new TextEncoder().encode(message), 0);

    this.dataChannel.send(buf);
  }

  private offset: number;

  private onBufferedAmountLow(_event: Event) {
    // Send queue cleared
    this.dataChannel.onbufferedamountlow = undefined;
    this.sendFile();
  }

  private sendFile() {
    const fileReader = new FileReader();

    // TODO(AG): Handle other events
    fileReader.addEventListener("load", (event) => {
      this.dataChannel.send(event.target.result as ArrayBuffer);
      this.offset += (event.target.result as ArrayBuffer).byteLength;

      if (this.offset < this.file.size) {
        if (
          this.dataChannel.bufferedAmount <=
          this.dataChannel.bufferedAmountLowThreshold
        ) {
          readChunk(this.offset);
        } else {
          // Backpressure
          this.dataChannel.onbufferedamountlow =
            this.onBufferedAmountLow.bind(this);
        }
      } else {
        // File reading complete
      }
    });

    const readChunk = (offset) => {
      fileReader.readAsArrayBuffer(this.file.slice(offset, offset + chunkSize));
    };
    readChunk(this.offset);
  }

  private dataChannelOpen(_event: Event) {
    this.channelOpen = true;
    this.offset = 0;
    this.sendMetadata();
    this.sendFile();
  }

  private metaChannelClose(_event: Event) {
    this.channelOpen = false;
    this.close();
  }
}

interface FileMetadata {
  name: string;
  size: number;
}

class ClientHandler {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel;

  private fileChunks: BlobPart[];
  private metadata?: FileMetadata;
  private received: number;

  constructor(
    private ws: WebSocket,
    private dispatcher: RoomEventDispatcher<false>
  ) {
    ws.addEventListener("message", this.handleMessage.bind(this));
    this.dispatcher.connectionStatusChanged(false);

    this.pc = new RTCPeerConnection({ ...iceServers });
    this.pc.addEventListener("icecandidate", this.onIceCandidate.bind(this));
    this.pc.addEventListener("datachannel", this.onDataChannel.bind(this));
  }

  goodbye() {}

  private onIceCandidate(event: RTCPeerConnectionIceEvent) {
    if (event.candidate) {
      this.sendSignal(
        JSON.stringify([ClientMasterSignal.TRICKLE_ICE, event.candidate])
      );
    }
  }

  private onDataChannel(event: RTCDataChannelEvent) {
    if (event.channel.label === channelLabel) {
      this.dataChannel = event.channel;
      this.dataChannel.binaryType = "arraybuffer";
      this.dataChannel.addEventListener(
        "message",
        this.onDataChannelMessage.bind(this)
      );
      this.dispatcher.connectionStatusChanged(true);
    }
  }

  private onDataChannelMessage(event: MessageEvent<ArrayBuffer>) {
    try {
      const buf = event.data;
      const view = new Uint8Array(buf);

      if (!this.metadata) {
        this.handleMetadata(view);
      } else {
        this.handleChunk(view);
      }
    } catch (e) {
      console.error(e);
    }
  }

  private handleMetadata(view: Uint8Array) {
    const [name, size] = JSON.parse(new TextDecoder().decode(view));
    this.fileChunks = [];
    this.metadata = { name, size };
    this.dispatcher.filenameChanged(name);
    this.received = 0;
    this.lastSpeedSampleTime = Date.now();
    this.lastSampleReceived = 0;
    this.speed = 0;
  }

  private lastSpeedSampleTime: number;
  private lastSampleReceived: number;
  private speed: number;

  private handleChunk(chunk: Uint8Array) {
    this.fileChunks.push(chunk);
    this.received += chunk.length;

    const now = Date.now();
    // Sample the speed every 1s
    if (now > this.lastSpeedSampleTime + 1000) {
      this.speed =
        ((this.received - this.lastSampleReceived) * 1000) /
        (now - this.lastSpeedSampleTime);
      this.lastSampleReceived = this.received;
      this.lastSpeedSampleTime = now;
      this.dispatcher.connectionSpeed(this.speed);
    }

    this.dispatcher.receivePercentageChanged(
      Math.floor((this.received * 100) / this.metadata.size)
    );

    if (this.received === this.metadata.size) {
      this.handleEnd();
    }
  }

  private handleEnd() {
    const blob = new Blob(this.fileChunks);

    const a = document.createElement("a");
    a.download = this.metadata.name;
    a.href = URL.createObjectURL(blob);

    a.click();
  }

  private handleMessage(event: MessageEvent) {
    try {
      const data = JSON.parse(event.data);

      switch (data[0]) {
        case "0":
          this.handleSignalMessage(data);
          break;

        case "1":
          this.handleGone(data);
          break;
      }
    } catch {}
  }

  private handleSignalMessage(data: string[]) {
    if (data.length < 2) {
      return;
    }

    const peerMessage = JSON.parse(data[1]);

    switch (peerMessage[0]) {
      case MasterClientSignal.OFFER:
        // noinspection JSIgnoredPromiseFromCall
        this.handleOffer(peerMessage);
        break;

      case MasterClientSignal.TRICKLE_ICE:
        // noinspection JSIgnoredPromiseFromCall
        this.handleTrickleIce(peerMessage);
        break;
    }
  }

  private async handleTrickleIce(data: any[]) {
    if (data.length < 2) {
      return;
    }

    await this.pc.addIceCandidate(data[1]);
  }

  private async handleOffer(data: any[]) {
    if (data.length < 2) {
      return;
    }

    await this.pc.setRemoteDescription(data[1]);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);
    this.sendSignal(
      JSON.stringify([ClientMasterSignal.ANSWER, this.pc.localDescription])
    );
  }

  private sendSignal(message: string) {
    this.ws.send(JSON.stringify(["0", message]));
  }

  private handleGone(_data: string[]) {
    this.dispatcher.connectionStatusChanged(false);
  }
}

async function getDiscoveryParams() {
  try {
    const ip = await getPublicIP();
    if (ip !== undefined) {
      return ["t", ip];
    }

    return ["f", ""];
  } catch {
    return ["f", ""];
  }
}

export default Room;
