/** Shared WebRTC helpers. */

/** Payloads exchanged through the signalling server. */
export type SignalData =
  /**
   * `link` identifies the sender's peer connection, so the receiver can tell
   * a brand-new connection (sender reloaded or rebuilt it) from
   * renegotiation of the current one (ICE restart).
   */
  | { kind: "offer" | "answer"; sdp: RTCSessionDescriptionInit; link?: string }
  | { kind: "ice"; candidate: RTCIceCandidateInit; link?: string }
  /** Receiver → sender: tear down my link and offer a fresh connection. */
  | { kind: "restart" };

export type Route = "lan" | "direct" | "relay";

export const CHANNEL_LABEL = "kabootar";

export function isSignal(v: unknown): v is SignalData {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { kind?: unknown }).kind === "string"
  );
}

export function hasTurn(servers: RTCIceServer[]): boolean {
  return servers.some((s) => [s.urls].flat().some((u) => /^turns?:/.test(u)));
}

/** Buffers remote ICE candidates until the remote description is set. */
export class CandidateQueue {
  private queue: RTCIceCandidateInit[] = [];

  constructor(private pc: RTCPeerConnection) {}

  async add(c: RTCIceCandidateInit) {
    if (!this.pc.remoteDescription) {
      this.queue.push(c);
      return;
    }
    await this.pc.addIceCandidate(c).catch(() => {});
  }

  async flush() {
    const q = this.queue.splice(0);
    for (const c of q) await this.pc.addIceCandidate(c).catch(() => {});
  }
}

/** Which path the connection ended up using. */
export async function detectRoute(
  pc: RTCPeerConnection,
): Promise<Route | undefined> {
  try {
    const stats = await pc.getStats();
    let pair: RTCIceCandidatePairStats | undefined;
    stats.forEach((s) => {
      if (
        s.type === "transport" &&
        (s as RTCTransportStats).selectedCandidatePairId
      ) {
        pair = stats.get(
          (s as RTCTransportStats).selectedCandidatePairId!,
        ) as RTCIceCandidatePairStats;
      }
    });
    if (!pair) {
      stats.forEach((s) => {
        const p = s as RTCIceCandidatePairStats & { selected?: boolean };
        if (
          s.type === "candidate-pair" &&
          p.state === "succeeded" &&
          (p.nominated || p.selected)
        )
          pair ??= p;
      });
    }
    if (!pair) return undefined;
    const local = stats.get(pair.localCandidateId) as
      { candidateType?: string } | undefined;
    const remote = stats.get(pair.remoteCandidateId) as
      { candidateType?: string } | undefined;
    if (local?.candidateType === "relay" || remote?.candidateType === "relay")
      return "relay";
    if (local?.candidateType === "host" && remote?.candidateType === "host")
      return "lan";
    return "direct";
  } catch {
    return undefined;
  }
}

export const routeHelp: Record<Route, string> = {
  lan: "Both devices are on the same network, so the file goes straight between them without leaving your local network. This is the fastest path.",
  direct:
    "The devices are on different networks but found a direct path across the internet, so the file still goes device to device.",
  relay:
    "A direct path was blocked (common on cellular networks and strict Wi-Fi), so the encrypted data passes through Cloudflare's relay. The relay can't read your files; transfers may be slower.",
};

export const encryptionHelp =
  "Files travel straight between the two browsers over an encrypted WebRTC connection (DTLS). Kabootar's server only helps the devices find each other and never sees your files, even when a relay is used.";

export const relayAvailableHelp =
  "If a receiver can't connect to you directly, Kabootar automatically falls back to an encrypted relay. The relay can't read your files.";

export const verifiedHelp =
  "The received file's SHA-256 fingerprint matches the sender's original, so it arrived complete and unmodified.";

export const senderAwayHelp =
  "The sender's connection to the server dropped (for example, they switched networks or reloaded). A direct transfer already in progress can continue; otherwise it resumes when they're back.";

export const nearbyHiddenHelp =
  "iCloud Private Relay or a VPN hides your network, so this share isn't listed for devices nearby. You don't need to turn it off: receivers can join with the code, link or QR code as usual, and transfers may only be slightly slower.";

export const routeLabel: Record<Route, string> = {
  lan: "Direct · same network",
  direct: "Direct · peer-to-peer",
  relay: "Relayed · encrypted",
};
