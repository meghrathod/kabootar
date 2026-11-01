#!/bin/sh
# Installs the kabootar command-line client.
#
#   curl -fsSL https://kabootar.meghrathod.dev/install.sh | sh
#
# Environment:
#   KABOOTAR_VERSION      release to install, e.g. v0.1.0 (default: latest)
#   KABOOTAR_INSTALL_DIR  where to put the binary (default: /usr/local/bin if
#                         writable, otherwise ~/.local/bin)
set -eu

repo="meghrathod/kabootar"
version="${KABOOTAR_VERSION:-latest}"

say() { printf '%s\n' "$*" >&2; }
fail() { say "kabootar install: $*"; exit 1; }

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) fail "unsupported system $(uname -s); on Windows use install.ps1" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  aarch64 | arm64) arch=arm64 ;;
  armv7* | armv6*) arch=armv7 ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac

if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL "$1" -o "$2"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -q "$1" -O "$2"; }
else
  fail "needs curl or wget"
fi

if [ "$version" = "latest" ]; then
  base="https://github.com/$repo/releases/latest/download"
else
  base="https://github.com/$repo/releases/download/$version"
fi
archive="kabootar_${os}_${arch}.tar.gz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading $archive…"
fetch "$base/$archive" "$tmp/$archive" || fail "download failed: $base/$archive"
fetch "$base/checksums.txt" "$tmp/checksums.txt" || fail "couldn't download checksums"

expected="$(grep " $archive\$" "$tmp/checksums.txt" | cut -d' ' -f1)"
[ -n "$expected" ] || fail "no checksum for $archive"
if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "$tmp/$archive" | cut -d' ' -f1)"
else
  actual="$(shasum -a 256 "$tmp/$archive" | cut -d' ' -f1)"
fi
[ "$expected" = "$actual" ] || fail "checksum mismatch for $archive"

tar -xzf "$tmp/$archive" -C "$tmp" kabootar

dir="${KABOOTAR_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ -w /usr/local/bin ]; then
    dir=/usr/local/bin
  else
    dir="$HOME/.local/bin"
  fi
fi
mkdir -p "$dir"
mv "$tmp/kabootar" "$dir/kabootar"
chmod +x "$dir/kabootar"

say "Installed $("$dir/kabootar" version) to $dir/kabootar"
case ":$PATH:" in
  *":$dir:"*) ;;
  *) say "Add $dir to your PATH to run it as 'kabootar'." ;;
esac
say "Try: kabootar send <file>"
