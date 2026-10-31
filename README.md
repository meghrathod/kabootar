# Kabootar

Peer-to-peer file sharing in the browser. Files go straight from one device to another over an encrypted WebRTC data channel, so nothing is uploaded to a server and there's no size limit beyond the receiver's disk.

> _Kabootar_ (कबूतर) is Hindi for pigeon, after the carrier pigeons that once delivered messages.

- **Send** files, folders or text; receivers open a link, scan a QR code or type a 6-digit code.
- **Nearby**: devices on the same network see each other's shares.
- **Large files**: streamed to disk (File System Access API on desktop Chromium, a service-worker download on Android/Firefox, private storage on Safari/iOS).
- **Resumable**: transfers survive network hiccups (ICE restart) and reconnects (resume from the last byte).
- **Verified**: every file is checked with SHA-256 after transfer.
- **Installable PWA**: works offline, and on Android it appears in the system share sheet.

## How it works

The app and its signalling run on Cloudflare: a Worker serves the PWA and API, one Durable Object per share relays WebRTC offers and answers, and Cloudflare Realtime TURN relays traffic when a direct connection isn't possible. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

Requires Node 24 and Yarn 1.

```sh
yarn install
yarn build          # the worker serves dist/, so build once first
yarn dev:worker     # Worker + Durable Objects locally on :8787
yarn dev            # app with hot reload on http://localhost:3000
```

Or run the production build locally: `yarn preview` (http://localhost:8080).

Local secrets live in `.dev.vars` (git-ignored):

```
SERVER_SECRET=anything-for-local-dev
```

Testing on a phone needs HTTPS (service workers, clipboard and private storage are disabled on plain-HTTP LAN addresses). A free tunnel works: `cloudflared tunnel --url http://localhost:8080`.

### Tests

```sh
yarn typecheck
yarn test          # transfer engine: multi-file, resume, integrity, backpressure
yarn test:worker   # signalling worker inside workerd with real Durable Objects
yarn test:e2e      # two browsers doing a real WebRTC transfer (needs `yarn build`)
```

## Deployment

`yarn deploy` after a one-time setup; CI deploys every push to `develop`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## License

[MIT](LICENSE)
