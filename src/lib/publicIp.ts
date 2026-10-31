import { fallbackIceServers } from "./config";

export interface PublicAddresses {
  v4?: string;
  v6?: string;
}

function isPrivateV4(ip: string) {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b < 128) || a === 0;
}

const isPublicV6 = (ip: string) => /^[23][0-9a-f]{3}:/i.test(ip);

let cached: Promise<PublicAddresses> | undefined;

/**
 * Public addresses as seen by a STUN server. They identify the network for
 * "Nearby" even when the browser's web traffic reaches the server some other
 * way (iCloud Private Relay, IPv4 on one device and IPv6 on another).
 */
export function getPublicAddresses(timeoutMs = 3500): Promise<PublicAddresses> {
  cached ??= new Promise<PublicAddresses>((resolve) => {
    const found: PublicAddresses = {};
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: fallbackIceServers });
    } catch {
      resolve(found);
      return;
    }
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      pc.close();
      resolve(found);
    };
    const timer = setTimeout(finish, timeoutMs);
    pc.onicecandidate = (e) => {
      if (!e.candidate) return finish();
      if (e.candidate.type !== "srflx") return;
      const addr = e.candidate.address ?? e.candidate.candidate.split(" ")[4] ?? "";
      if (/^\d+\.\d+\.\d+\.\d+$/.test(addr) && !isPrivateV4(addr)) found.v4 ??= addr;
      else if (addr.includes(":") && isPublicV6(addr)) found.v6 ??= addr;
      if (found.v4 && found.v6) finish();
    };
    pc.createDataChannel("probe");
    pc.createOffer()
      .then((o) => pc.setLocalDescription(o))
      .catch(finish);
  });
  return cached;
}
