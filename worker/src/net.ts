/** Client network helpers for LAN discovery. */

/**
 * Networks that relay traffic for privacy services: Akamai (36183), Fastly
 * (54113) and Cloudflare (13335) operate iCloud Private Relay egress, and
 * Cloudflare also runs WARP. Clients behind them all share a few addresses
 * with strangers, and the relay hides their real network even from STUN, so
 * they can't take part in "Nearby".
 */
const PRIVACY_RELAY_ASNS = new Set([36183, 54113, 13335]);

export function behindPrivacyRelay(req: Request): boolean {
  const asn = Number((req as Request & { cf?: { asn?: number } }).cf?.asn);
  return PRIVACY_RELAY_ASNS.has(asn);
}

/** Expand an IPv6 address to 8 hextets, or undefined if invalid. */
function ipv6Hextets(ip: string): number[] | undefined {
  if (!/^[0-9a-fA-F:.]+$/.test(ip) || ip.split("::").length > 2) return undefined;
  const [head, tail] = ip.includes("::") ? ip.split("::") : [ip, undefined];
  const parse = (part: string) => (part ? part.split(":") : []);
  const h = parse(head);
  const t = tail === undefined ? [] : parse(tail);
  // Embedded IPv4 (e.g. ::ffff:1.2.3.4) is handled by the caller.
  if ([...h, ...t].some((x) => x.includes("."))) return undefined;
  const missing = 8 - h.length - t.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return undefined;
  const all = [...h, ...Array(missing).fill("0"), ...t].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => n >= 0 && n <= 0xffff) ? all : undefined;
}

function ipv4(ip: string): number[] | undefined {
  const m = ip.match(/^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i);
  if (!m) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : undefined;
}

function isPrivateV4([a, b]: number[]) {
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b < 32) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b < 128);
}

/**
 * Devices behind the same NAT share a public IPv4 address; on IPv6 they
 * share a /64 prefix.
 */
export function networkKey(ip: string | null | undefined): string | undefined {
  if (!ip) return undefined;
  const v4 = ipv4(ip.trim());
  if (v4) return v4.join(".");
  const v6 = ipv6Hextets(ip.trim());
  if (v6) return `${v6.slice(0, 4).map((n) => n.toString(16)).join(":")}::/64`;
  return undefined;
}

/**
 * Keys for discovery: the address Cloudflare saw, plus the public IPv4 and
 * IPv6 addresses the browser learned via STUN (so devices still match when
 * one reaches us over IPv6 and the other over IPv4, or through iCloud
 * Private Relay).
 */
export function discoveryKeys(observed: string | null, reported: unknown, reported6?: unknown): string[] {
  const keys: string[] = [];
  const add = (k: string | undefined) => k && !keys.includes(k) && keys.push(k);
  add(networkKey(observed));
  if (typeof reported === "string") {
    const v4 = ipv4(reported.trim());
    if (v4 && !isPrivateV4(v4)) add(v4.join("."));
  }
  if (typeof reported6 === "string" && /^[23]/.test(reported6.trim())) add(networkKey(reported6));
  return keys.slice(0, 4);
}
