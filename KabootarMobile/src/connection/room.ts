import { httpScheme, wsScheme, baseURL, iceServers } from '../config';
import { getFileDownloader } from '../downloader';

export type RoomEventDispatcher<Master extends boolean> = Master extends true
  ? { numClientsChanged(n: number): void }
  : {
      roomMetaChanged(name: string, roomName: string, emoji: string): void;
      connectionStatusChanged(connected: boolean): void;
      receivePercentageChanged(p: number): void;
      connectionSpeed(speed: number): void;
      needsStart(needs: boolean): void;
      complete(): void;
    };

export default class Room<Master extends boolean> {
  handler: any;

  private constructor(
    public isMaster: Master,
    public id: string,
    public name: string,
    public emoji: string,
    private ws: WebSocket,
    private clientKey: string,
    public file: Master extends true ? File : undefined,
    eventDispatcher: RoomEventDispatcher<Master>,
    turnServer: string,
    public pin?: string,
  ) {
    if (isMaster) {
      this.handler = new MasterClient(
        id,
        file as any,
        name,
        emoji,
        this.sendSignal.bind(this),
        () => this.close(),
        clientKey,
        turnServer,
        id,
        eventDispatcher as any,
      );
    } else {
      this.handler = new ClientHandler(
        ws,
        eventDispatcher as any,
        id,
        clientKey,
        turnServer,
      );
    }

    ws.addEventListener('message', this.handleMessage.bind(this));
    ws.addEventListener('close', this.handleClose.bind(this));
  }

  static async create(
    file: any,
    dispatcher: RoomEventDispatcher<true>,
  ): Promise<Room<true> | undefined> {
    const response = await fetch(`${httpScheme}${baseURL}/room`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const [roomID, masterKey, clientKey, roomName, pin, emoji] =
      await response.json();

    const ws = await this.initWS(roomID, masterKey, true);
    if (ws === undefined) return undefined;

    return new Room(
      true as any,
      roomID,
      roomName,
      emoji,
      ws[0],
      clientKey,
      file,
      dispatcher,
      ws[1],
      pin,
    );
  }

  static async joinDirect(
    id: string,
    key: string,
    dispatcher: RoomEventDispatcher<false>,
  ): Promise<Room<false> | undefined> {
    const ws = await this.initWS(id, key, false);
    if (!ws) return undefined;
    return new Room(false as any, id, '', '', ws[0], key, undefined as any, dispatcher, ws[1]);
  }

  static async getClientKey(id: string, pin: string): Promise<string | void> {
    try {
      const response = await fetch(
        `${httpScheme}${baseURL}/room?id=${encodeURIComponent(id)}&pin=${encodeURIComponent(pin)}`,
      );
      const [clientKey] = await response.json();
      return clientKey;
    } catch (e) {
      console.error(e);
    }
  }

  static async initWS(
    id: string,
    key: string,
    isMaster: boolean,
  ): Promise<[WebSocket, string] | undefined> {
    const ws = new WebSocket(
      `${wsScheme}${baseURL}/ws/${id}?k=${key}&m=${isMaster ? 't' : 'f'}`,
    );

    const canConnect = await new Promise<false | [true, string]>((resolve) => {
      function close(_event: any) {
        ws.removeEventListener('close', close as any);
        resolve(false);
      }
      ws.addEventListener('close', close as any);
      function message(event: any) {
        try {
          const data = JSON.parse(event.data);
          if (data[0] === '-1') {
            resolve([true, data[1]] as any);
          } else {
            resolve(false);
          }
        } catch (e) {
          resolve(false);
        } finally {
          ws.removeEventListener('message', message as any);
        }
      }
      ws.addEventListener('message', message as any);
    });

    if (canConnect) return [ws, (canConnect as any)[1]];
    if (ws.readyState !== ws.CLOSED || ws.readyState !== ws.CLOSING) ws.close();
    return undefined;
  }

  constructHash() {
    return `k=${this.clientKey}`;
  }

  dispatch(data: string) {
    this.handler.dispatch(data);
  }

  close() {
    this.ws.close();
    this.handler.close?.();
  }

  private sendSignal(id: string, signal: string) {
    this.ws.send(JSON.stringify(['0', id, signal]));
  }

  private handleMessage(event: MessageEvent) {
    const data = JSON.parse((event as any).data);
    if (data.length < 1) return;
    switch (data[0]) {
      case '0':
        (this.handler as any).handleServerMessage(data);
        break;
      case '1':
        // left
        break;
      case '2':
        // msg
        break;
      default:
        break;
    }
  }

  private handleClose(_event: CloseEvent) {}
}

// Simplified Master/Client handlers mirroring web logic
const chunkSize = 16 * 1024;

class MasterClient {
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel;
  private offset = 0;

  constructor(
    private id: string,
    private file: any,
    private name: string,
    private emoji: string,
    private sendSignal: (id: string, signal: string) => void,
    private onClose: () => void,
    private clientKey: string,
    private turnServer: string,
    private roomID: string,
    private dispatcher: { numClientsChanged(n: number): void },
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: [
        ...(iceServers.iceServers || []),
        { urls: `turn:${turnServer}?transport=tcp`, username: roomID, credential: clientKey },
      ],
      iceTransportPolicy: 'all',
    });
    this.pc.addEventListener('icecandidate', this.onIceCandidate.bind(this));
    this.pc.addEventListener('connectionstatechange', this.onConnectionStateChange.bind(this));

    this.dataChannel = this.pc.createDataChannel('file');
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.onopen = () => {};
    this.dataChannel.onmessage = (e) => this.handleDataChannelMessage(e as any);
    this.dataChannel.bufferedAmountLowThreshold = 1 << 20;

    // noinspection JSIgnoredPromiseFromCall
    this.makeOffer();
  }

  private async makeOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
  }

  private onIceCandidate(event: RTCPeerConnectionIceEvent) {
    if (event.candidate) {
      this.sendSignal(this.id, JSON.stringify({ t: 1, c: event.candidate }));
    }
  }

  private onConnectionStateChange() {
    if (this.pc.connectionState === 'failed' || this.pc.connectionState === 'closed') {
      this.onClose();
    }
  }

  private sendFile() {
    const reader = new FileReader();
    reader.addEventListener('load', (event) => {
      const buf = (event.target as any).result as ArrayBuffer;
      this.dataChannel.send(buf);
      this.offset += buf.byteLength;
      if (this.offset < this.file.size) {
        if (this.dataChannel.bufferedAmount <= this.dataChannel.bufferedAmountLowThreshold) {
          readChunk(this.offset);
        } else {
          this.dataChannel.onbufferedamountlow = () => readChunk(this.offset);
        }
      }
    });
    const readChunk = (offset: number) => {
      reader.readAsArrayBuffer(this.file.slice(offset, offset + chunkSize));
    };
    readChunk(this.offset);
  }

  private handleDataChannelMessage(event: MessageEvent<string>) {
    if ((event as any).data === 'ready') this.sendFile();
  }

  public handleServerMessage(data: any[]) {
    // [2, clientID, msg]
    if (data[0] !== '2') return;
    const clientID = data[1];
    const msg = JSON.parse(data[2]);
    if (msg.t === 0) {
      // answer
      this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    } else if (msg.t === 1) {
      this.pc.addIceCandidate(new RTCIceCandidate(msg.c));
    } else if (msg.t === 2) {
      // metadata ack
    }
  }

  public dispatch(_data: string) {}
}

class ClientHandler {
  private pc: RTCPeerConnection;
  private dataChannel?: RTCDataChannel;
  private metadata?: { name: string; size: number };
  private downloader = getFileDownloader('file', 0);
  private downloaderInitialized = false;
  private received = 0;
  private lastSpeedSampleTime = Date.now();
  private lastSampleReceived = 0;

  constructor(
    private ws: WebSocket,
    private dispatcher: any,
    private id: string,
    private clientKey: string,
    private turnServer: string,
  ) {
    this.pc = new RTCPeerConnection({
      iceServers: [
        ...(iceServers.iceServers || []),
        { urls: `turn:${turnServer}?transport=tcp`, username: id, credential: clientKey },
      ],
      iceTransportPolicy: 'all',
    });
    this.pc.addEventListener('icecandidate', this.onIceCandidate.bind(this));
    this.pc.addEventListener('datachannel', this.onDataChannel.bind(this));
  }

  private onIceCandidate(event: RTCPeerConnectionIceEvent) {
    if (event.candidate) {
      this.ws.send(JSON.stringify(['0', '', JSON.stringify({ t: 1, c: event.candidate })]));
    }
  }

  private onDataChannel(event: RTCDataChannelEvent) {
    this.dataChannel = event.channel;
    this.dataChannel.binaryType = 'arraybuffer';
    this.dataChannel.onmessage = (e) => this.onDataMessage(e as any);
  }

  private async onDataMessage(e: MessageEvent<ArrayBuffer>) {
    const buf = (e as any).data as ArrayBuffer;
    const view = new Uint8Array(buf);
    if (!this.metadata) {
      const [name, size, roomName, emoji] = JSON.parse(new TextDecoder().decode(view));
      this.metadata = { name, size };
      this.dispatcher.roomMetaChanged(name, roomName, emoji);
      this.dispatcher.connectionStatusChanged(true);
      this.dispatcher.needsStart(true);
    } else {
      // append chunk
      if (!this.downloaderInitialized) return;
      await this.downloader.append(buf);
      this.received += view.length;
      const now = Date.now();
      if (now > this.lastSpeedSampleTime + 1000) {
        const speed = ((this.received - this.lastSampleReceived) * 1000) / (now - this.lastSpeedSampleTime);
        this.lastSampleReceived = this.received;
        this.lastSpeedSampleTime = now;
        this.dispatcher.connectionSpeed(speed);
      }
      this.dispatcher.receivePercentageChanged(Math.floor((this.received * 100) / (this.metadata.size || 1)));
      if (this.received === this.metadata.size) {
        await this.downloader.finalize();
        this.dispatcher.complete();
      }
    }
  }

  public async handleServerMessage(data: any[]) {
    // [0] SM joined => create answer or signalling
    if (data[0] === '2') {
      const msg = JSON.parse(data[2]);
      if (msg.t === 0) {
        await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        this.ws.send(
          JSON.stringify(['0', '', JSON.stringify({ t: 0, sdp: this.pc.localDescription })]),
        );
      } else if (msg.t === 1) {
        await this.pc.addIceCandidate(new RTCIceCandidate(msg.c));
      }
    }
  }

  public async dispatch(data: string) {
    if (data === 'ready') {
      if (!this.metadata) return;
      this.downloader = getFileDownloader(this.metadata.name, this.metadata.size);
      await this.downloader.initialize();
      this.downloaderInitialized = true;
      this.dispatcher.needsStart(false);
      this.dataChannel?.send('ready');
    }
  }
}