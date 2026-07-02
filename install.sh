#!/usr/bin/env bash
# GEOly CLI installer (macOS / Linux) — https://www.geoly.ai
#   curl -fsSL https://geoly.ai/install.sh | sh
#   (mirror: https://raw.githubusercontent.com/geoly-ai/GEOly-Cli/main/install.sh)
#
# Zero-interaction by design (agents run this): no prompts, no sudo,
# installs to ~/.local/bin, verifies sha256 from the release manifest.
# Options:  --version vX.Y.Z   pin a release      --dir <path>   install dir
# Env:      GEOLY_INSTALL_BASE  override the release download base URL
set -euo pipefail

REPO_BASE="${GEOLY_INSTALL_BASE:-https://github.com/geoly-ai/GEOly-Cli/releases}"
VERSION=""
INSTALL_DIR="${HOME}/.local/bin"

while [ $# -gt 0 ]; do
  case "$1" in
    --version) VERSION="$2"; shift 2 ;;
    --dir) INSTALL_DIR="$2"; shift 2 ;;
    -h|--help)
      echo "usage: install.sh [--version vX.Y.Z] [--dir <path>]" >&2; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*" >&2; }
fail() { say "geoly install: $*"; exit 1; }

command -v curl >/dev/null 2>&1 || fail "curl is required"

# --- Detect platform -------------------------------------------------------
OS="$(uname -s)"
case "$OS" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "unsupported OS: $OS (Windows: irm https://geoly.ai/install.ps1 | iex)" ;;
esac
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) fail "unsupported architecture: $ARCH" ;;
esac
# Apple Silicon running the installer under Rosetta reports x86_64.
if [ "$OS" = "darwin" ] && [ "$ARCH" = "x64" ]; then
  if [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = "1" ]; then
    say "==> Apple Silicon detected (Rosetta shell); using arm64 binary"
    ARCH=arm64
  fi
fi
[ -n "${GEOLY_ARCH:-}" ] && ARCH="$GEOLY_ARCH" # escape hatch (e.g. x64-baseline)

# --- Fetch manifest ---------------------------------------------------------
if [ -n "$VERSION" ]; then
  MANIFEST_URL="${REPO_BASE}/download/${VERSION}/manifest.json"
else
  MANIFEST_URL="${REPO_BASE}/latest/download/manifest.json"
fi
say "==> Fetching manifest: ${MANIFEST_URL}"
MANIFEST="$(curl -fsSL --retry 2 "$MANIFEST_URL")" || fail "could not download the release manifest (no release published yet?)"

LATEST="$(printf '%s' "$MANIFEST" | sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$LATEST" ] || fail "manifest is malformed (no latest version)"

# Pick the {os, arch} entry without jq: flatten, split objects, match keys.
pick_entry() {
  printf '%s' "$MANIFEST" | tr -d '\n\r\t ' | sed 's/},{/}\n{/g' \
    | grep -F "\"os\":\"$OS\"" | grep -F "\"arch\":\"$1\"" | head -n1
}
ENTRY="$(pick_entry "$ARCH")"
[ -z "$ENTRY" ] && ENTRY="$(pick_entry "${ARCH}-baseline")"
[ -n "$ENTRY" ] || fail "no binary published for ${OS}/${ARCH}"

URL="$(printf '%s' "$ENTRY" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
SHA="$(printf '%s' "$ENTRY" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')"
[ -n "$URL" ] && [ -n "$SHA" ] || fail "manifest entry is missing url/sha256"

# --- Download + verify + install -------------------------------------------
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
PKG="$TMP_DIR/geoly.gz"
say "==> Downloading geoly v${LATEST} (${OS}/${ARCH})"
curl -fsSL --retry 2 -o "$PKG" "$URL" || fail "download failed: $URL"

if command -v sha256sum >/dev/null 2>&1; then
  GOT="$(sha256sum "$PKG" | cut -d' ' -f1)"
else
  GOT="$(shasum -a 256 "$PKG" | cut -d' ' -f1)"
fi
[ "$GOT" = "$SHA" ] || fail "checksum mismatch (expected $SHA, got $GOT) — refusing to install"

mkdir -p "$INSTALL_DIR"
BIN="$INSTALL_DIR/geoly"
gunzip -c "$PKG" > "$BIN.tmp"
chmod +x "$BIN.tmp"
mv -f "$BIN.tmp" "$BIN"
say "==> Installed: $BIN (v${LATEST})"

# --- PATH guidance (exact line so agents can apply it verbatim) -------------
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    say ""
    say "==> $INSTALL_DIR is not on your PATH. Add it with:"
    say "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.$(basename "${SHELL:-bash}")rc && export PATH=\"\$HOME/.local/bin:\$PATH\""
    ;;
esac
say "==> Try: geoly tools    (first call opens your browser to authorize)"
