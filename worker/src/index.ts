/**
 * Kabootar on Cloudflare: this Worker serves the API and websocket
 * signalling; static assets (the PWA) are served by Workers Static Assets.
 *
 *   POST /api/rooms        create a share
 *   POST /api/join         exchange a 6-digit code for a share's client key
 *   GET  /api/info         feature flags for the app
 *   GET  /ws/room/:id      signalling websocket (Room durable object)
 *   GET  /ws/discover      nearby shares (Directory durable object)
 */
import { Directory, type RoomInfo } from "./directory";
import { type Env, maxPeers, roomTTL } from "./env";
import { hasTurn } from "./ice";
import { deriveKey, randomID, validID } from "./keys";
import { randomAvatar, roomName } from "./names";
import { behindPrivacyRelay, discoveryKeys } from "./net";
import { Room, type RoomMeta } from "./room";

export { Directory, Room };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });

const error = (code: string, status: number) => json({ error: code }, status);

function directory(env: Env) {
  return env.DIRECTORY.get(env.DIRECTORY.idFromName("global"));
}

function room(env: Env, id: string) {
  return env.ROOMS.get(env.ROOMS.idFromName(id));
}

const clientIP = (req: Request) => req.headers.get("CF-Connecting-IP") ?? "unknown";

async function body<T>(req: Request): Promise<T | undefined> {
  const text = await req.text();
  if (text.length > 4096) return undefined;
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/** Websockets are same-origin unless ALLOWED_ORIGINS says otherwise. */
function originAllowed(req: Request, env: Env): boolean {
  const origin = req.headers.get("Origin");
  if (!origin) return true; // non-browser clients
  const url = new URL(req.url);
  if (origin === url.origin) return true;
  return (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .some((o) => o === "*" || o === origin);
}

async function createRoom(req: Request, env: Env): Promise<Response> {
  const ip = clientIP(req);
  const dir = directory(env);
  if (!(await dir.allowCreate(ip))) return error("rate_limited", 429);

  const input = await body<{ discoverable?: boolean; ip?: string; ip6?: string }>(req);
  if (!input) return error("bad_request", 400);

  const id = randomID(12);
  const avatar = randomAvatar();
  const info: RoomInfo = { id, name: roomName(), emoji: avatar.emoji, color: avatar.color };
  const pin = await dir.claimPin(info);
  const now = Date.now();
  const meta: RoomMeta = {
    ...info,
    pin,
    discoverable: !!input.discoverable,
    createdAt: now,
    expiresAt: now + roomTTL(env),
    masterSeen: false,
    masterGoneAt: 0,
  };
  await room(env, id).init(meta);
  // Behind Private Relay / a VPN the addresses are shared with strangers, so
  // listing the share there would show it to the wrong people.
  const hidden = meta.discoverable && behindPrivacyRelay(req);
  const network = meta.discoverable && !hidden ? discoveryKeys(ip, input.ip, input.ip6) : [];
  if (network.length) await dir.announce(info, network);

  const [masterKey, clientKey] = await Promise.all([
    deriveKey(env.SERVER_SECRET, "m", id),
    deriveKey(env.SERVER_SECRET, "c", id),
  ]);
  return json(
    { ...info, masterKey, clientKey, pin, expiresAt: new Date(meta.expiresAt).toISOString(), network, hidden },
    201,
  );
}

async function join(req: Request, env: Env): Promise<Response> {
  const input = await body<{ pin?: string; roomId?: string }>(req);
  if (!input || typeof input.pin !== "string") return error("bad_request", 400);

  const result = await directory(env).lookup(input.pin, input.roomId || undefined, clientIP(req));
  if (result === "rate_limited") return error("rate_limited", 429);
  if (!result) return error("room_not_found", 404);
  return json({ room: result, clientKey: await deriveKey(env.SERVER_SECRET, "c", result.id) });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === "/healthz") return json({ ok: true, version: env.VERSION ?? "dev" });

    if (path.startsWith("/api/") || path.startsWith("/ws/")) {
      if (!env.SERVER_SECRET) return error("server_misconfigured", 500);

      if (path === "/api/info" && req.method === "GET") {
        return json({ version: env.VERSION ?? "dev", turn: hasTurn(env), maxPeers: maxPeers(env) });
      }
      if (path === "/api/rooms" && req.method === "POST") return createRoom(req, env);
      if (path === "/api/join" && req.method === "POST") return join(req, env);

      if (path.startsWith("/ws/")) {
        if (req.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
          return error("expected_websocket", 426);
        }
        if (!originAllowed(req, env)) return error("forbidden_origin", 403);

        const roomMatch = path.match(/^\/ws\/room\/([^/]+)$/);
        if (roomMatch) {
          const id = roomMatch[1];
          if (!validID(id)) return error("room_not_found", 404);
          const headers = new Headers(req.headers);
          headers.set("X-Client-IP", clientIP(req));
          headers.set("X-Room-Id", id);
          return room(env, id).fetch(new Request(req, { headers }));
        }
        if (path === "/ws/discover") {
          const headers = new Headers(req.headers);
          const hidden = behindPrivacyRelay(req);
          const keys = hidden ? [] : discoveryKeys(clientIP(req), url.searchParams.get("ip"), url.searchParams.get("ip6"));
          headers.set("X-Discovery-Keys", JSON.stringify(keys));
          headers.set("X-Network-Hidden", hidden ? "1" : "0");
          return directory(env).fetch(new Request(req, { headers }));
        }
      }
      return error("not_found", 404);
    }

    return env.ASSETS.fetch(req);
  },
} satisfies ExportedHandler<Env>;
