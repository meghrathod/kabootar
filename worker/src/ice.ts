import type { Env } from "./env";

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

const CF_ENDPOINT =
  "https://rtc.live.cloudflare.com/v1/turn/keys/%s/credentials/generate-ice-servers";
const TTL_SECONDS = 12 * 3600;

let cached: { servers: IceServer[]; expires: number } | undefined;

const stun = (env: Env): IceServer => ({
  urls: (
    env.STUN_URLS ??
    "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

export const hasTurn = (env: Env) =>
  !!(env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN);

/**
 * STUN plus short-lived Cloudflare TURN credentials. Credentials are shared
 * and cached per isolate (anyone can create a room and get them anyway) and
 * refreshed when less than half their lifetime remains.
 */
export async function iceServers(env: Env): Promise<IceServer[]> {
  if (!hasTurn(env)) return [stun(env)];
  const now = Date.now();
  if (cached && cached.expires - now > (TTL_SECONDS * 1000) / 2)
    return cached.servers;

  try {
    const res = await fetch(CF_ENDPOINT.replace("%s", env.CF_TURN_KEY_ID!), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ ttl: TTL_SECONDS }),
    });
    if (!res.ok) throw new Error(`TURN credentials: ${res.status}`);
    const data = (await res.json()) as {
      iceServers?: {
        urls: string | string[];
        username?: string;
        credential?: string;
      }[];
    };
    const turn: IceServer[] = [];
    for (const s of data.iceServers ?? []) {
      // Keep TURN entries only (we provide STUN) and drop port 53, which
      // browsers block and which just causes timeouts.
      const urls = [s.urls]
        .flat()
        .filter((u) => /^turns?:/.test(u) && !/:53(\?|$)/.test(u));
      if (urls.length)
        turn.push({ urls, username: s.username, credential: s.credential });
    }
    if (turn.length === 0) throw new Error("TURN credentials: empty response");
    cached = {
      servers: [stun(env), ...turn],
      expires: now + TTL_SECONDS * 1000,
    };
    return cached.servers;
  } catch (err) {
    console.warn("TURN unavailable, falling back to STUN only", err);
    if (cached && cached.expires > now) return cached.servers;
    return [stun(env)];
  }
}
