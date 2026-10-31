# Deploying Kabootar

Kabootar runs entirely on Cloudflare's free plan: one Worker serves the PWA, the API and websocket signalling, backed by Durable Objects. No servers or containers.

## One-time setup

1. **Log in** (opens a browser):

   ```sh
   npx wrangler login
   ```

2. **Set the room-key secret.** Any long random string. Changing it invalidates existing share links.

   ```sh
   openssl rand -base64 32 | npx wrangler secret put SERVER_SECRET
   ```

3. **Optional: enable the TURN relay.** Without it most connections still work directly, but peers behind strict NATs or firewalls (some mobile carriers, corporate networks) can't connect.

   In the Cloudflare dashboard go to **Realtime → TURN Server → Create**, then:

   ```sh
   npx wrangler secret put CF_TURN_KEY_ID
   npx wrangler secret put CF_TURN_API_TOKEN
   ```

   Cloudflare TURN includes 1,000 GB/month free, then $0.05/GB. Only relayed traffic counts.

4. **Deploy:**

   ```sh
   yarn deploy
   ```

   Wrangler prints the URL, e.g. `https://kabootar.<your-subdomain>.workers.dev`.

### Custom domain

Add the domain to your Cloudflare account, then add to `wrangler.jsonc`:

```jsonc
"routes": [{ "pattern": "kabootar.example.com", "custom_domain": true }]
```

and run `yarn deploy` again.

## Continuous deployment

Deploys are done by Cloudflare's GitHub integration (Workers Builds), so no API token is stored in GitHub. `.github/workflows/ci.yml` only runs typechecks, unit tests, worker tests and the end-to-end suite on every push and pull request.

Connect the repository once in the dashboard: **Workers & Pages → kabootar → Settings → Builds → Connect** (pick this repository) and set the production branch to `develop`. The default build settings work: `wrangler deploy` runs `yarn build` itself (the `build` field in `wrangler.jsonc`), `.node-version` pins Node 24 to match CI, and the `packageManager` field in `package.json` pins the Yarn 4 release that wrote `yarn.lock`. Optionally, set the deploy command to `npx wrangler deploy --var VERSION:$WORKERS_CI_COMMIT_SHA` so `/healthz` reports the deployed commit.

Every push to `develop` is then built and deployed by Cloudflare and reported back as a **Workers Builds** check on the commit; the full build log is linked from that check. It runs alongside GitHub Actions CI, not after it, so a push that fails CI is still deployed.

Worker secrets (`SERVER_SECRET`, TURN keys) are stored in Cloudflare, not GitHub; set them once as above.

## Configuration

Plain variables live in `wrangler.jsonc` under `vars`:

| Variable               | Default             | Meaning                                                                     |
| ---------------------- | ------------------- | --------------------------------------------------------------------------- |
| `MAX_PEERS`            | `8`                 | Receivers per share                                                         |
| `ROOM_TTL_HOURS`       | `24`                | Maximum lifetime of a share                                                 |
| `MASTER_GRACE_SECONDS` | `300`               | How long a share waits for the sender to come back (reload, network change) |
| `STUN_URLS`            | Cloudflare + Google | Comma-separated STUN servers                                                |
| `ALLOWED_ORIGINS`      | —                   | Extra origins allowed to open websockets (same-origin is always allowed)    |

Secrets:

| Secret              | Required | Meaning                            |
| ------------------- | -------- | ---------------------------------- |
| `SERVER_SECRET`     | yes      | Derives room keys                  |
| `CF_TURN_KEY_ID`    | no       | Cloudflare Realtime TURN key id    |
| `CF_TURN_API_TOKEN` | no       | Cloudflare Realtime TURN API token |

## Free-plan headroom

Durable Objects on the free plan include 100,000 requests/day. File data never touches Cloudflare (it flows peer-to-peer), so only signalling counts:

- creating a share, joining, and each websocket connection: about 1 request each
- signalling messages while connecting: a few dozen per receiver, billed at 20 messages per request
- heartbeats are answered by the runtime's auto-response and idle sockets hibernate, so neither costs anything

That leaves room for thousands of shares a day. When a daily limit is hit, new requests fail until 00:00 UTC.
