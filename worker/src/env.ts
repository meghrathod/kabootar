import type { Directory } from "./directory";
import type { Room } from "./room";

export interface Env {
  ROOMS: DurableObjectNamespace<Room>;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ASSETS: Fetcher;

  /** Secret used to derive room keys. Set with `wrangler secret put SERVER_SECRET`. */
  SERVER_SECRET: string;
  /** Cloudflare Realtime TURN key; TURN is disabled when unset. */
  CF_TURN_KEY_ID?: string;
  CF_TURN_API_TOKEN?: string;

  MAX_PEERS?: string;
  ROOM_TTL_HOURS?: string;
  MASTER_GRACE_SECONDS?: string;
  STUN_URLS?: string;
  /** Extra origins allowed to open websockets (comma separated). */
  ALLOWED_ORIGINS?: string;
  VERSION?: string;
}

type AppEnv = Env;
declare global {
  namespace Cloudflare {
    // Lets `env` from cloudflare:test / cloudflare:workers carry our bindings.
    // eslint-disable-next-line @typescript-eslint/no-empty-object-type
    interface Env extends AppEnv {}
  }
}

export const maxPeers = (env: Env) => Number(env.MAX_PEERS ?? 8);
export const roomTTL = (env: Env) =>
  Number(env.ROOM_TTL_HOURS ?? 24) * 3_600_000;
export const masterGrace = (env: Env) =>
  Number(env.MASTER_GRACE_SECONDS ?? 300) * 1000;
