#!/usr/bin/env bash
# get-model.sh — fetch the llama.cpp llama-server binary and a tiny default
# GGUF into gitignored models/ for Milton's self-contained mode.
# Idempotent: skips anything already present. Pass --force to re-download.
set -euo pipefail

FORCE=0
for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    -h|--help)
      echo "usage: scripts/get-model.sh [--force]"
      echo "env: MILTON_MODEL_URL (model override), LLAMA_CPP_VERSION (pin llama.cpp release)"
      exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 1 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL_DIR="$ROOT/models"
BIN_DIR="$MODEL_DIR/bin"
mkdir -p "$BIN_DIR"

# ---- platform -----------------------------------------------------------------
OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS-$ARCH" in
  Linux-x86_64)        PLAT="ubuntu-x64" ;;
  Linux-aarch64|Linux-arm64) PLAT="ubuntu-arm64" ;;
  Darwin-arm64)        PLAT="macos-arm64" ;;
  Darwin-x86_64)       PLAT="macos-x64" ;;
  *) echo "unsupported platform: $OS $ARCH" >&2; exit 1 ;;
esac

# ---- llama-server binary --------------------------------------------------------
BIN="$BIN_DIR/llama-server"
if [ -x "$BIN" ] && [ "$FORCE" -eq 0 ]; then
  echo "llama-server already present: $BIN (use --force to re-fetch)"
else
  TAG="${LLAMA_CPP_VERSION:-}"
  if [ -z "$TAG" ]; then
    echo "resolving latest llama.cpp binary release…"
    # NOTE: /releases/latest now points at a source-only tag; the prebuilt
    # binaries ship on bNNNN nightly releases, so scan the release list for
    # the newest b-tag that actually carries our platform asset.
    if command -v python3 >/dev/null 2>&1; then
      TAG="$(curl -fsSL "https://api.github.com/repos/ggerganov/llama.cpp/releases?per_page=30" | python3 -c "
import json,sys
plat = '$PLAT'
for d in json.load(sys.stdin):
    t = d.get('tag_name','')
    if t.startswith('b') and t[1:].isdigit() and any(a['name'] == f'llama-{t}-bin-{plat}.tar.gz' for a in d['assets']):
        print(t); break
" 2>/dev/null)"
    else
      TAG="$(curl -fsSL "https://api.github.com/repos/ggerganov/llama.cpp/releases?per_page=30" | grep -o '\"tag_name\": *\"b[0-9][0-9]*\"' | head -1 | cut -d'\"' -f4)"
    fi
  fi
  [ -n "$TAG" ] || { echo "couldn't resolve a llama.cpp binary release — set LLAMA_CPP_VERSION (e.g. b11057)" >&2; exit 1; }
  URL="https://github.com/ggerganov/llama.cpp/releases/download/${TAG}/llama-${TAG}-bin-${PLAT}.tar.gz"
  echo "downloading llama-server ${TAG} for ${PLAT}…"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  curl -fsSL -o "$TMP/llama.tar.gz" "$URL"
  tar -xzf "$TMP/llama.tar.gz" -C "$TMP"
  SRV="$(find "$TMP" -name 'llama-server*' -type f | head -1)"
  [ -n "$SRV" ] || { echo "llama-server not found in the release archive" >&2; exit 1; }
  cp "$SRV" "$BIN"; chmod +x "$BIN"
  # the binary links its companions via RUNPATH $ORIGIN: ship the .so files
  # from the (flat) release archive next to it, preserving symlinks.
  find "$(dirname "$SRV")" -maxdepth 1 -name '*.so*' -exec cp -P {} "$BIN_DIR/" \;
  echo "installed: $BIN (+ shared libraries)"
fi

# ---- model -----------------------------------------------------------------------
MODEL_URL="${MILTON_MODEL_URL:-https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/resolve/main/Qwen3-0.6B-Q4_K_M.gguf}"
MODEL_FILE="$MODEL_DIR/$(basename "$MODEL_URL" | cut -d'?' -f1)"
if [ -f "$MODEL_FILE" ] && [ "$FORCE" -eq 0 ]; then
  echo "model already present: $MODEL_FILE (use --force to re-fetch)"
else
  echo "downloading model (~400MB)…"
  curl -fSL -o "$MODEL_FILE" "$MODEL_URL"
  echo "saved: $MODEL_FILE"
fi

SIZE="$(du -sh "$MODEL_DIR" | cut -f1)"
echo ""
echo "self-contained model ready in $MODEL_DIR ($SIZE on disk)"
echo "  binary: $BIN"
echo "  model:  $MODEL_FILE"
echo "  RAM:    ~1GB free recommended for Qwen3-0.6B Q4_K_M (larger models need more)"
echo "  disk:   ~450MB for the default tiny model"
echo ""
echo "run:  MILTON_EMBEDDED=1 bun src/server.ts"
echo "      (or just bun src/server.ts — the sidecar auto-starts when no MILTON_LLM_URL is set)"
