#!/usr/bin/env bash
set -euo pipefail

# mx-GPT + mx-Cowork One-Time Setup Script (Linux / macOS)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "============================================================"
echo "  mx-GPT & mx-Cowork — One-Time Setup (Linux / macOS)"
echo "============================================================"

if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js 20+ is required. Install from https://nodejs.org/"
  exit 1
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "ERROR: Node.js 20+ is required (found $(node -v))."
  exit 1
fi
echo "[ok] Node.js $(node -v)"

# 1. Create .env if missing
if [ ! -f "$ROOT_DIR/.env" ]; then
  cp "$ROOT_DIR/.env.example" "$ROOT_DIR/.env"
  # Detect physical CPU core count for optimal Ollama threading
  PHYS_CORES=$(lscpu -p=CORE,SOCKET 2>/dev/null | grep -v '^#' | sort -u | wc -l || nproc 2>/dev/null || echo 8)
  if [ "${PHYS_CORES:-0}" -gt 0 ]; then
    sed -i.bak "s/^MXGPT_NUM_THREAD=.*/MXGPT_NUM_THREAD=${PHYS_CORES}/" "$ROOT_DIR/.env" && rm -f "$ROOT_DIR/.env.bak"
  fi
  echo "[ok] Created .env (MXGPT_NUM_THREAD=${PHYS_CORES})"
else
  echo "[ok] Keeping existing .env"
fi

mkdir -p "$ROOT_DIR/data" "$ROOT_DIR/workspace"

# 2. Optional npm install for mx-GPT (zero mandatory runtime dependencies)
if [ -f "$ROOT_DIR/package.json" ]; then
  npm install --no-audit --no-fund >/dev/null 2>&1 || true
fi

# 3. Check Ollama availability
if command -v ollama >/dev/null 2>&1; then
  echo "[ok] Ollama found: $(ollama --version 2>&1 | head -n 1)"
  if curl -fsS --max-time 2 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
    echo "[ok] Ollama daemon is running on http://127.0.0.1:11434"
  else
    echo "[!] Ollama is installed but not running. Start it with: ollama serve"
  fi
else
  echo "[!] Ollama not found locally (optional if connecting to a remote Ollama / mx-GPT endpoint)."
  echo "    Install Ollama: https://ollama.com/download"
fi

# 4. Syntax verification
node --check "$ROOT_DIR/server/server.js"
node --check "$ROOT_DIR/deploy/ollama-queue.cjs"
node --check "$ROOT_DIR/cowork/src/main.js"
echo "[ok] Verified mx-GPT server, queue scheduler, and mx-Cowork"

echo ""
echo "Setup complete! Start services with:"
echo "  1) Queue scheduler:  node deploy/ollama-queue.cjs"
echo "  2) mx-GPT web app:   node server/server.js          -> http://127.0.0.1:8088"
echo "  3) mx-Cowork app:    node cowork/src/main.js        -> http://127.0.0.1:4318"
echo ""
echo "To build standalone Linux & Windows executables for mx-Cowork:"
echo "  ./scripts/build-cowork.sh"
echo ""
