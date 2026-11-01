# kabootar (command line)

Send files peer-to-peer from a terminal, including over SSH on headless machines. It uses the same server as [the web app](https://kabootar.meghrathod.dev), so a terminal can send to or receive from any browser, phone or other terminal.

## Install

Linux and macOS:

```sh
curl -fsSL https://kabootar.meghrathod.dev/install.sh | sh
```

Homebrew (macOS, Linux):

```sh
brew tap meghrathod/kabootar https://github.com/meghrathod/kabootar
brew install --cask kabootar
```

Windows (PowerShell):

```powershell
irm https://kabootar.meghrathod.dev/install.ps1 | iex
```

Other options:

- `.deb` / `.rpm` packages (Ubuntu, Debian, Fedora, RHEL) and plain archives are on [GitHub Releases](https://github.com/meghrathod/kabootar/releases).
- With Go installed: `go install github.com/meghrathod/kabootar/cli/cmd/kabootar@latest`

Each binary is a single static file for linux (amd64, arm64, armv7), macOS (Intel, Apple Silicon) and Windows (amd64, arm64).

### Updating

```sh
kabootar update
```

This downloads the latest release, checks it against the release's SHA-256 checksums, makes sure the new binary runs, and only then replaces the current one. Copies installed by Homebrew or a `.deb`/`.rpm` package are left to their package manager, and `update` tells you the command to use instead (`brew upgrade --cask kabootar`, or the new package from Releases).

When a newer version is out, kabootar mentions it at most once a day. The check runs in the background, so it never slows a command down, and it only happens on an interactive terminal. Set `KABOOTAR_NO_UPDATE_CHECK=1` to turn it off. It's also off in CI.

## Use

```sh
kabootar send backup.tar.gz           # prints a 6-digit code, a link and a QR code
kabootar send ./photos notes.txt      # folders keep their structure
kabootar send big.iso --once          # exit once the first receiver has everything
kabootar send -t "wifi: hunter2"      # share a text snippet as well as, or instead of, files

kabootar receive 123456               # with the code
kabootar receive 'https://kabootar.meghrathod.dev/AbC…#k=…'   # or with the link
kabootar receive 123456 -o ~/Downloads
```

On the receiving side you can also just open the link in any browser.

Received files go to the current folder (or `-o DIR`). Existing files are never overwritten: a new copy is saved as `name (1).ext` unless you pass `--force`. Files are written to a hidden `.part` file and renamed only after the SHA-256 check passes. Text snippets go to stdout, so `kabootar receive 123456 > note.txt` works.

| Flag | Command | |
| --- | --- | --- |
| `-t`, `--text TEXT` | send | share a text snippet (repeatable) |
| `--once` | send | exit after the first receiver has every file |
| `--no-nearby` | send | don't list the share for devices on the same network |
| `--no-qr` | send | don't print the QR code |
| `-o`, `--output DIR` | receive | where to save files |
| `-f`, `--force` | receive | overwrite existing files |
| `--no-art` | both | don't draw the flying pigeon |
| `--server URL` | both | another Kabootar server (or set `KABOOTAR_SERVER`) |

Exit codes: `0` when everything arrived (or the share ended normally), `1` on errors, `130` when interrupted.

On a terminal, the progress area updates in place rather than adding lines: one line per receiver when sending; the files (done, active, up next) when receiving. Each connection line shows the route and the address pair it uses, for example `direct · same network (192.168.1.5 ↔ 192.168.1.9, host/host udp)`. When the output is piped or logged, the same events are printed as plain lines instead.

The animated pigeon only appears on an interactive terminal that's big enough. It turns off with `--no-art` or `NO_COLOR=1`. Run `kabootar demo` to see it.

## How it compares with scp

The server only introduces the two machines. Files then go directly between them over an encrypted WebRTC connection, or through Cloudflare's relay when no direct path exists. The relay can't read the data.

- **Works through NAT.** Neither machine needs a public address, an open port or SSH access to the other.
- **Resumes.** If the connection drops, the transfer picks up from the last byte received.
- **Verified.** Every file is checked with SHA-256 on arrival.
- **Raw speed:** if the two machines can already reach each other directly, as on one LAN, `scp`/`rsync` will usually be as fast or faster. WebRTC data channels carry more overhead than a single SSH stream.

## Troubleshooting

- `KABOOTAR_DEBUG=1` prints WebRTC (Pion) logs.
- Slow on your own network? Check the route on the connected line. `same network` is the LAN. `peer-to-peer` with public addresses, or `relayed`, means the traffic is leaving your network (for example through a VPN or the router's public address).
- "Couldn't establish a connection": both networks block direct connections and no relay was available. Try another network.
