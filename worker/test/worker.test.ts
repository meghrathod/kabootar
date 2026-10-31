import { SELF, env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const BASE = "https://kabootar.test";

interface Created {
  id: string;
  name: string;
  emoji: string;
  masterKey: string;
  clientKey: string;
  pin: string;
}

async function createRoom(ip = "203.0.113.10", discoverable = true): Promise<Created> {
  const res = await SELF.fetch(`${BASE}/api/rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ discoverable }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

/** A websocket client that queues incoming messages. */
async function connect(path: string, ip = "203.0.113.10") {
  const res = await SELF.fetch(`${BASE}${path}`, { headers: { Upgrade: "websocket", "CF-Connecting-IP": ip } });
  expect(res.status).toBe(101);
  const ws = res.webSocket!;
  ws.accept();
  const queue: Record<string, unknown>[] = [];
  const waiters: ((m: Record<string, unknown>) => void)[] = [];
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data as string);
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  const next = () =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const q = queue.shift();
      if (q) return resolve(q);
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), 3000);
      waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  return {
    ws,
    send: (m: unknown) => ws.send(typeof m === "string" ? m : JSON.stringify(m)),
    next,
    async expect(t: string) {
      const m = await next();
      expect(m.t, JSON.stringify(m)).toBe(t);
      return m;
    },
  };
}

describe("signalling", () => {
  it("creates a room, joins by code and relays signals", async () => {
    const room = await createRoom();
    expect(room.id).toMatch(/^[A-Za-z0-9]{12}$/);
    expect(room.pin).toMatch(/^[1-9]\d{5}$/);

    const master = await connect(`/ws/room/${room.id}`);
    master.send({ t: "auth", role: "master", key: room.masterKey });
    const welcome = await master.expect("welcome");
    expect(welcome.pin).toBe(room.pin);
    expect(welcome.iceServers).toBeTruthy();

    const joined = await SELF.fetch(`${BASE}/api/join`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.1" },
      body: JSON.stringify({ pin: room.pin }),
    });
    expect(joined.status).toBe(200);
    const { clientKey, room: info } = (await joined.json()) as { clientKey: string; room: { id: string } };
    expect(clientKey).toBe(room.clientKey);
    expect(info.id).toBe(room.id);

    const peer = await connect(`/ws/room/${room.id}`);
    peer.send({ t: "auth", role: "peer", key: clientKey });
    const pw = await peer.expect("welcome");
    expect(pw.online).toBe(true);
    const peerId = pw.peerId as string;
    expect((await master.expect("join")).peer).toBe(peerId);

    master.send({ t: "signal", to: peerId, data: { kind: "offer" } });
    expect((await peer.expect("signal")).data).toEqual({ kind: "offer" });
    peer.send({ t: "signal", data: { kind: "answer" } });
    expect((await master.expect("signal")).from).toBe(peerId);

    master.send({ t: "signal", to: "nobody", data: {} });
    expect((await master.expect("error")).code).toBe("peer_not_found");

    master.send({ t: "close" });
    await peer.expect("closed");
    const after = await SELF.fetch(`${BASE}/api/join`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.2" },
      body: JSON.stringify({ pin: room.pin }),
    });
    expect(after.status).toBe(404);
  });

  it("rejects wrong keys and enforces roles", async () => {
    const room = await createRoom();
    const asMaster = await connect(`/ws/room/${room.id}`);
    asMaster.send({ t: "auth", role: "master", key: room.clientKey });
    expect((await asMaster.expect("error")).code).toBe("invalid_key");

    const unknown = await connect(`/ws/room/AAAAAAAAAAAA`);
    unknown.send({ t: "auth", role: "peer", key: room.clientKey });
    expect((await unknown.expect("error")).code).toBe("invalid_key");

    const bad = await SELF.fetch(`${BASE}/ws/room/not-a-room!`, { headers: { Upgrade: "websocket" } });
    expect(bad.status).toBe(404);
  });

  it("tells the sender when a receiver leaves and receivers when the sender drops", async () => {
    const room = await createRoom();
    const master = await connect(`/ws/room/${room.id}`);
    master.send({ t: "auth", role: "master", key: room.masterKey });
    await master.expect("welcome");
    const peer = await connect(`/ws/room/${room.id}`);
    peer.send({ t: "auth", role: "peer", key: room.clientKey });
    const { peerId } = await peer.expect("welcome");
    await master.expect("join");

    master.ws.close(1000, "bye");
    expect((await peer.expect("master")).online).toBe(false);

    // A reconnecting sender sees the waiting receiver.
    const again = await connect(`/ws/room/${room.id}`);
    again.send({ t: "auth", role: "master", key: room.masterKey });
    expect((await again.expect("welcome")).peers).toEqual([peerId]);
    expect((await peer.expect("master")).online).toBe(true);

    peer.ws.close(1000, "bye");
    expect((await again.expect("leave")).peer).toBe(peerId);
  });

  it("lets a reconnecting receiver keep its identity", async () => {
    const room = await createRoom();
    const master = await connect(`/ws/room/${room.id}`);
    master.send({ t: "auth", role: "master", key: room.masterKey });
    await master.expect("welcome");

    const first = await connect(`/ws/room/${room.id}`);
    first.send({ t: "auth", role: "peer", key: room.clientKey });
    const { peerId } = await first.expect("welcome");
    expect(peerId).toMatch(/^[A-Za-z0-9]{16}$/);
    expect((await master.expect("join")).peer).toBe(peerId);

    // Same receiver comes back (the old socket may still look open).
    const again = await connect(`/ws/room/${room.id}`);
    again.send({ t: "auth", role: "peer", key: room.clientKey, resume: peerId });
    expect((await again.expect("welcome")).peerId).toBe(peerId);
    expect((await master.expect("join")).peer).toBe(peerId);

    // Signals reach the new socket, and no "leave" was announced.
    master.send({ t: "signal", to: peerId, data: { kind: "offer" } });
    expect((await again.expect("signal")).data).toEqual({ kind: "offer" });
    master.send({ t: "ping-check" });
    await new Promise((r) => setTimeout(r, 200));
    const extra = await Promise.race([master.next(), new Promise((r) => setTimeout(() => r(null), 300))]);
    expect(extra).toBeNull();
  });

  it("lets the sender restore a forgotten room with the same code", async () => {
    const room = await createRoom();
    const stub = env.ROOMS.get(env.ROOMS.idFromName(room.id));
    // Close the room, as if the server had expired it.
    const m1 = await connect(`/ws/room/${room.id}`);
    m1.send({ t: "auth", role: "master", key: room.masterKey });
    await m1.expect("welcome");
    m1.send({ t: "close" });
    await m1.expect("closed");

    const m2 = await connect(`/ws/room/${room.id}`);
    m2.send({
      t: "auth",
      role: "master",
      key: room.masterKey,
      restore: { name: room.name, emoji: room.emoji, pin: room.pin, discoverable: false },
    });
    const w = await m2.expect("welcome");
    expect(w.pin).toBe(room.pin);
    expect((w.room as { name: string }).name).toBe(room.name);

    // The original share link keeps working.
    const peer = await connect(`/ws/room/${room.id}`);
    peer.send({ t: "auth", role: "peer", key: room.clientKey });
    await peer.expect("welcome");
    expect(stub).toBeTruthy();
  });

  it("expires a room whose sender never connects", async () => {
    const room = await createRoom();
    await new Promise((r) => setTimeout(r, 1200));
    // The alarm may already have fired on its own; run it if it hasn't.
    await runDurableObjectAlarm(env.ROOMS.get(env.ROOMS.idFromName(room.id)));
    const res = await SELF.fetch(`${BASE}/api/join`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "198.51.100.3" },
      body: JSON.stringify({ pin: room.pin }),
    });
    expect(res.status).toBe(404);
  });
});

describe("discovery", () => {
  it("lists shares from the same network, live", async () => {
    const watcher = await connect(`/ws/discover`, "192.0.2.50");
    expect((await watcher.expect("network")).keys).toEqual(["192.0.2.50"]);
    const room = await createRoom("192.0.2.50");
    const add = await watcher.expect("add");
    expect((add.room as { id: string }).id).toBe(room.id);

    // A late watcher gets existing rooms; other networks see nothing.
    const late = await connect(`/ws/discover`, "192.0.2.50");
    await late.expect("network");
    expect(((await late.expect("add")).room as { id: string }).id).toBe(room.id);

    const master = await connect(`/ws/room/${room.id}`, "192.0.2.50");
    master.send({ t: "auth", role: "master", key: room.masterKey });
    await master.expect("welcome");
    master.send({ t: "close" });
    expect((await watcher.expect("remove")).id).toBe(room.id);
  });

  it("matches IPv6 clients by /64 and via a reported public IPv4", async () => {
    const v6 = await connect(`/ws/discover?ip=192.0.2.77`, "2001:db8:1:2::abcd");
    expect((await v6.expect("network")).keys).toEqual(["2001:db8:1:2::/64", "192.0.2.77"]);
    const room = await createRoom("192.0.2.77");
    expect(((await v6.expect("add")).room as { id: string }).id).toBe(room.id);
  });

  it("matches a Private Relay client through its STUN-reported IPv6 prefix", async () => {
    // The watcher's web traffic comes from a relay address; STUN still sees
    // the home network's IPv6 prefix, which the sender shares.
    const watcher = await connect(`/ws/discover?ip6=2600:4040:aa:bb::1234`, "104.28.1.1");
    await watcher.expect("network");
    const res = await SELF.fetch(`${BASE}/api/rooms`, {
      method: "POST",
      headers: { "CF-Connecting-IP": "2600:4040:aa:bb::99" },
      body: JSON.stringify({ discoverable: true }),
    });
    const room = (await res.json()) as { id: string; network: string[] };
    expect(room.network).toEqual(["2600:4040:aa:bb::/64"]);
    expect(((await watcher.expect("add")).room as { id: string }).id).toBe(room.id);
  });
});

describe("privacy relays", () => {
  it("keeps Private Relay / VPN clients out of Nearby and says why", async () => {
    const relayed = { cf: { asn: 54113 } } as RequestInit;
    const res = await SELF.fetch(`${BASE}/ws/discover?ip=146.75.245.79`, {
      ...relayed,
      headers: { Upgrade: "websocket", "CF-Connecting-IP": "146.75.245.79" },
    });
    const ws = res.webSocket!;
    ws.accept();
    const first = await new Promise<Record<string, unknown>>((r) =>
      ws.addEventListener("message", (e) => r(JSON.parse(e.data as string)), { once: true }),
    );
    expect(first).toEqual({ t: "network", keys: [], hidden: true });

    const created = await SELF.fetch(`${BASE}/api/rooms`, {
      ...relayed,
      method: "POST",
      headers: { "CF-Connecting-IP": "146.75.245.79" },
      body: JSON.stringify({ discoverable: true, ip: "146.75.245.79" }),
    });
    expect(await created.json()).toMatchObject({ network: [], hidden: true });
  });
});

describe("api", () => {
  it("rate limits PIN guessing", async () => {
    let limited = false;
    for (let i = 0; i < 20 && !limited; i++) {
      const res = await SELF.fetch(`${BASE}/api/join`, {
        method: "POST",
        headers: { "CF-Connecting-IP": "203.0.113.99" },
        body: JSON.stringify({ pin: "123456" }),
      });
      limited = res.status === 429;
    }
    expect(limited).toBe(true);
  });

  it("answers health and info, rejects cross-origin websockets", async () => {
    expect((await SELF.fetch(`${BASE}/healthz`)).status).toBe(200);
    const info = (await (await SELF.fetch(`${BASE}/api/info`)).json()) as { turn: boolean; maxPeers: number };
    expect(info).toMatchObject({ turn: false, maxPeers: 8 });
    const res = await SELF.fetch(`${BASE}/ws/discover`, {
      headers: { Upgrade: "websocket", Origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});
