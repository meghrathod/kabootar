#!/bin/sh
# Installs the kabootar command-line client.
#
#   curl -fsSL https://kabootar.meghrathod.dev/install.sh | sh
#
# Environment:
#   KABOOTAR_VERSION      release to install, e.g. v0.1.0 (default: latest)
#   KABOOTAR_INSTALL_DIR  where to put the binary (default: /usr/local/bin if
#                         writable, otherwise ~/.local/bin)
#   KABOOTAR_NO_MODIFY_PATH=1  don't add the install directory to the shell's
#                         startup file when it isn't already on PATH
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

say "Downloading ${archive}..."
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
# The shell that ran `curl ... | sh` is our parent; fall back to the login shell.
shell_name() {
  name="$(ps -p "$PPID" -o comm= 2>/dev/null || true)"
  case "${name##*/}" in
    -*) name="${name#-}" ;;
  esac
  case "${name##*/}" in
    zsh | bash | fish) printf '%s' "${name##*/}" ;;
    *) printf '%s' "${SHELL##*/}" ;;
  esac
}

# Appends a PATH line to the shell's startup file, once.
add_to_path() {
  case "$(shell_name)" in
    zsh)
      rc="${ZDOTDIR:-$HOME}/.zshrc"
      line="export PATH=\"$dir:\$PATH\""
      now="$line"
      ;;
    bash)
      # macOS Terminal opens login shells, which read .bash_profile, not .bashrc.
      if [ "$os" = darwin ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      line="export PATH=\"$dir:\$PATH\""
      now="$line"
      ;;
    fish)
      rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/conf.d/kabootar.fish"
      line="fish_add_path \"$dir\""
      now="$line"
      ;;
    *) return 1 ;;
  esac
  mkdir -p "$(dirname "$rc")" || return 1
  if ! grep -qsF "$line" "$rc"; then
    printf '\n# Added by the kabootar installer\n%s\n' "$line" >>"$rc" || return 1
  fi
  say "Added $dir to PATH in $rc. Open a new terminal, or run:"
  say "  $now"
}

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    if [ "${KABOOTAR_NO_MODIFY_PATH:-}" = 1 ] || ! add_to_path; then
      say "Add $dir to your PATH to run it as 'kabootar'."
    fi
    ;;
esac
say "Try: kabootar send <file>"
