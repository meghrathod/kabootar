/**
 * Room identifiers and keys. Keys are HMACs of the room id under
 * SERVER_SECRET, so the sender can re-register a room the server forgot
 * without anything having been persisted, and holding only the client key
 * (the share link) never lets someone act as the sender.
 */

const enc = new TextEncoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string) {
  let k = keyCache.get(secret);
  if (!k) {
    k = crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCache.set(secret, k);
  }
  return k;
}

function base64url(buf: ArrayBuffer) {
  let s = "";
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export type Role = "m" | "c";

export async function deriveKey(
  secret: string,
  role: Role,
  id: string,
): Promise<string> {
  const sig = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    enc.encode(`${role}|${id}`),
  );
  return base64url(sig).slice(0, 32);
}

export async function checkKey(
  secret: string,
  role: Role,
  id: string,
  key: unknown,
): Promise<boolean> {
  if (typeof key !== "string" || key.length !== 32) return false;
  const expected = enc.encode(await deriveKey(secret, role, id));
  const given = enc.encode(key);
  return crypto.subtle.timingSafeEqual(expected, given);
}

const ID_ALPHABET = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function randomID(n: number): string {
  const out: string[] = [];
  const buf = new Uint8Array(n * 2);
  while (out.length < n) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      // Rejection sampling keeps the distribution uniform.
      if (b < 256 - (256 % ID_ALPHABET.length) && out.length < n)
        out.push(ID_ALPHABET[b % ID_ALPHABET.length]);
    }
  }
  return out.join("");
}

export function randomPIN(): string {
  const buf = new Uint32Array(1);
  for (;;) {
    crypto.getRandomValues(buf);
    if (buf[0] < 4_294_800_000) return String(100_000 + (buf[0] % 900_000));
  }
}

export const validID = (id: unknown): id is string =>
  typeof id === "string" && /^[A-Za-z0-9]{12}$/.test(id);
export const validPIN = (pin: unknown): pin is string =>
  typeof pin === "string" && /^[1-9]\d{5}$/.test(pin);
