# Kabootar

Peer-to-peer file sharing in the browser. Files go straight from one device to another over an encrypted WebRTC data channel, so nothing is uploaded to a server and there's no size limit beyond the receiver's disk.

> _Kabootar_ (कबूतर) is Hindi for pigeon, after the carrier pigeons that once delivered messages.

- **Send** files, folders or text; receivers open a link, scan a QR code or type a 6-digit code.
- **Nearby**: devices on the same network see each other's shares.
- **Large files**: streamed to disk (File System Access API on desktop Chromium, a service-worker download on Android/Firefox, private storage on Safari/iOS).
- **Resumable**: transfers survive network hiccups (ICE restart) and reconnects (resume from the last byte).
- **Verified**: every file is checked with SHA-256 after transfer.
- **Installable PWA**: opens instantly from the home screen, and on Android it appears in the system share sheet. Sharing needs an internet connection: the server introduces the two devices, then the file goes directly between them.

## Command line

A terminal client for servers and headless machines (for example over SSH). It interoperates with the web app: send from a terminal to a phone, or from a browser to a server.

```sh
curl -fsSL https://kabootar.meghrathod.dev/install.sh | sh     # Linux, macOS
irm https://kabootar.meghrathod.dev/install.ps1 | iex          # Windows
brew tap meghrathod/kabootar https://github.com/meghrathod/kabootar && brew install --cask kabootar

kabootar send ./backup.tar.gz     # prints a code, a link and a QR code
kabootar receive 123456           # on the other machine (or open the link in a browser)
```

`.deb` and `.rpm` packages are on GitHub Releases. See [cli/README.md](cli/README.md), and [docs/CLI.md](docs/CLI.md) for development and releases.

## How it works

The app and its signalling run on Cloudflare: a Worker serves the PWA and API, one Durable Object per share relays WebRTC offers and answers, and Cloudflare Realtime TURN relays traffic when a direct connection isn't possible. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

Requires Node 24 and Yarn 4 (run `corepack enable` once; the version comes from `packageManager` in `package.json`).

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

`yarn deploy` after a one-time setup; Cloudflare's GitHub integration deploys every push to `develop`. See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## License

[MIT](LICENSE)
