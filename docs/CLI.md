# Command-line client

`cli/` is a Go module with a terminal client that speaks the same protocol as the web app. User docs are in [cli/README.md](../cli/README.md).

## Layout

| Path | Port of | What |
| --- | --- | --- |
| `internal/protocol` | `src/lib/transfer/protocol.ts` | Data-channel messages, constants, sanitizing |
| `internal/transfer` | `src/lib/transfer/{server,client}.ts` | `Server` sends items, hashing as it reads (one pass over the file, with read-ahead) and sharing the result between receivers. `Client` receives into `FileSink` (`.part`, then rename) |
| `internal/signal` | `src/lib/signal.ts` | Room websocket: auth, heartbeat, reconnect with backoff |
| `internal/session` | `src/lib/{sender,receiver}.ts` | One Pion peer connection per receiver; ICE restart, fresh links on `restart`, stall detection |
| `internal/rtc` | `src/lib/rtc.ts`, `publicIp.ts` | Signal payloads, ICE server parsing, route detection, STUN lookup for Nearby |
| `internal/api` | `src/lib/api.ts` | `POST /api/rooms`, `POST /api/join`, share links |
| `internal/ui` | | Terminal output: a live block redrawn in place (the command's view, the pigeon, a status line); plain event lines when not a terminal |
| `internal/update` | | `kabootar update` (download, verify the checksum, check that it runs, swap in) and the once-a-day new-version notice |
| `internal/ui/pigeon` | | Renders `public/assets/logo-mark.png` as coloured ASCII and animates the wingbeat |

The worker needs no changes: it already accepts websockets without an `Origin` header (non-browser clients).

**Keeping the two in step:** a change to the data-channel protocol, the signalling messages or `PROTOCOL_VERSION` has to be made in both `src/lib/` and `cli/internal/`. `e2e/cli.spec.ts` runs the CLI against real browsers in both directions to catch drift.

## Pigeon art

`internal/ui/pigeon/pigeon.png` is a downscaled copy of the logo. After changing `public/assets/logo-mark.png`, regenerate it:

```sh
cd cli && go generate ./internal/ui/pigeon
```

Each terminal cell is matched against glyph shapes (a 2×4 grid of coverage × brightness), so edges get `/ \ _ ( )` and the inside gets dense characters, coloured with 24-bit colour (or 256 colours). The flap reuses the web app's `kb-fly` keyframes plus a wing fold, and beats faster at higher speeds. `KABOOTAR_PREVIEW=1 go test -run Preview -v ./internal/ui/pigeon` prints the frames as text; `kabootar demo` animates it.

## Development

```sh
cd cli
go test -race ./...
go run ./cmd/kabootar send --server http://localhost:8787 some-file   # against `yarn dev:worker`
```

`yarn test:e2e` builds the CLI and runs `e2e/cli.spec.ts` with the browser tests (it needs Go installed).

## Releasing

Push a tag like `v0.1.0`. `.github/workflows/release-cli.yml` runs GoReleaser (`.goreleaser.yaml`), which publishes to GitHub Releases:

- `kabootar_<os>_<arch>.tar.gz` (`.zip` on Windows) for linux amd64/arm64/armv7, darwin amd64/arm64 and windows amd64/arm64
- `.deb` and `.rpm` packages
- `checksums.txt`

`public/install.sh` and `public/install.ps1` (served by the worker at `/install.sh` and `/install.ps1`) download from the latest release and verify the checksum. So the install commands only work once the first release exists.

**Homebrew:** the cask lives in this repo at `Casks/kabootar.rb`, so there's no separate tap repo. `develop` requires a reviewed PR, so on each release GoReleaser opens a PR updating the cask; merge it to publish the new version to brew users (prereleases skip this). Users tap this repo by URL, since it isn't named `homebrew-*`:

```sh
brew tap meghrathod/kabootar https://github.com/meghrathod/kabootar
brew install --cask kabootar
brew upgrade --cask kabootar   # later
```

**macOS:** the binaries aren't notarized. Gatekeeper doesn't check files downloaded by curl or install.sh, and the cask strips the quarantine flag Homebrew adds. Only a binary downloaded with a browser needs `xattr -d com.apple.quarantine kabootar`.
