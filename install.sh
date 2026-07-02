#!/usr/bin/env bash
# GEOly CLI installer (macOS / Linux) — https://www.geoly.ai
#   curl -fsSL https://geoly.ai/install.sh | sh
#   (mirror: https://raw.githubusercontent.com/geoly-ai/GEOly-Cli/main/install.sh)
#
# Zero-interaction by design (agents run this): no prompts, no sudo,
# installs to ~/.local/bin, verifies sha256 from the release manifest.
# Everything runs inside main() invoked on the last line, so a truncated
# curl|sh download can never execute a partial script.
# Options:  --version vX.Y.Z   pin a release      --dir <path>   install dir
# Env:      GEOLY_INSTALL_BASE  override the release base URL (https, allow-listed hosts only)
set -euo pipefail

say() { printf '%s\n' "$*" >&2; }
fail() { say "geoly install: $*"; exit 1; }

# Only https + known hosts may serve the manifest and binaries — a poisoned
# env var must not be able to redirect the install to an attacker host
# (the sha256 in an attacker manifest would just match the attacker binary).
allowed_url() {
  case "$1" in
    https://*) ;;
    *) return 1 ;;
  esac
  local host="${1#https://}"
  host="${host%%/*}"
  host="${host%%:*}"
  case "$host" in
    github.com|objects.githubusercontent.com|raw.githubusercontent.com|geoly.ai|*.geoly.ai) return 0 ;;
    *) return 1 ;;
  esac
}

main() {
  local REPO_BASE="${GEOLY_INSTALL_BASE:-https://github.com/geoly-ai/GEOly-Cli/releases}"
  local VERSION=""
  local INSTALL_DIR="${HOME}/.local/bin"

  while [ $# -gt 0 ]; do
    case "$1" in
      --version) VERSION="$2"; shift 2 ;;
      --dir) INSTALL_DIR="$2"; shift 2 ;;
      -h|--help)
        echo "usage: install.sh [--version vX.Y.Z] [--dir <path>]" >&2; return 0 ;;
      *) fail "unknown option: $1" ;;
    esac
  done

  command -v curl >/dev/null 2>&1 || fail "curl is required"
  allowed_url "$REPO_BASE/x" || fail "GEOLY_INSTALL_BASE must be https on github.com / *.geoly.ai, got: $REPO_BASE"

  # --- Detect platform -------------------------------------------------------
  local OS ARCH
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

  # --- Fetch manifest --------------------------------------------------------
  local MANIFEST_URL
  if [ -n "$VERSION" ]; then
    MANIFEST_URL="${REPO_BASE}/download/${VERSION}/manifest.json"
  else
    MANIFEST_URL="${REPO_BASE}/latest/download/manifest.json"
  fi
  say "==> Fetching manifest: ${MANIFEST_URL}"
  local MANIFEST
  MANIFEST="$(curl -fsSL --retry 2 "$MANIFEST_URL")" || fail "could not download the release manifest (no release published yet?)"

  local LATEST
  LATEST="$(printf '%s' "$MANIFEST" | sed -n 's/.*"latest"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ -n "$LATEST" ] || fail "manifest is malformed (no latest version)"

  # Pick the {os, arch} entry without jq: flatten, split objects, match keys.
  pick_entry() {
    printf '%s' "$MANIFEST" | tr -d '\n\r\t ' | sed 's/},{/}\n{/g' \
      | grep -F "\"os\":\"$OS\"" | grep -F "\"arch\":\"$1\"" | head -n1
  }
  local ENTRY
  ENTRY="$(pick_entry "$ARCH")"
  [ -z "$ENTRY" ] && ENTRY="$(pick_entry "${ARCH}-baseline")"
  [ -n "$ENTRY" ] || fail "no binary published for ${OS}/${ARCH}"

  local URL SHA
  URL="$(printf '%s' "$ENTRY" | sed -n 's/.*"url":"\([^"]*\)".*/\1/p')"
  SHA="$(printf '%s' "$ENTRY" | sed -n 's/.*"sha256":"\([^"]*\)".*/\1/p')"
  [ -n "$URL" ] && [ -n "$SHA" ] || fail "manifest entry is missing url/sha256"
  allowed_url "$URL" || fail "refusing binary from untrusted URL: $URL"

  # --- Download + verify + install ------------------------------------------
  local TMP_DIR PKG
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  PKG="$TMP_DIR/geoly.gz"
  say "==> Downloading geoly v${LATEST} (${OS}/${ARCH})"
  curl -fsSL --retry 2 -o "$PKG" "$URL" || fail "download failed: $URL"

  local GOT
  if command -v sha256sum >/dev/null 2>&1; then
    GOT="$(sha256sum "$PKG" | cut -d' ' -f1)"
  else
    GOT="$(shasum -a 256 "$PKG" | cut -d' ' -f1)"
  fi
  [ "$GOT" = "$SHA" ] || fail "checksum mismatch (expected $SHA, got $GOT) — refusing to install"

  mkdir -p "$INSTALL_DIR"
  local BIN="$INSTALL_DIR/geoly"
  gunzip -c "$PKG" > "$BIN.tmp"
  chmod +x "$BIN.tmp"
  mv -f "$BIN.tmp" "$BIN"
  say "==> Installed: $BIN (v${LATEST})"

  # --- PATH guidance (exact line so agents can apply it verbatim) -----------
  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *)
      say ""
      say "==> $INSTALL_DIR is not on your PATH. Add it with:"
      say "    echo 'export PATH=\"\$HOME/.local/bin:\$PATH\"' >> ~/.$(basename "${SHELL:-bash}")rc && export PATH=\"\$HOME/.local/bin:\$PATH\""
      ;;
  esac
  say "==> Try: geoly tools    (first call opens your browser to authorize)"
}

main "$@"
