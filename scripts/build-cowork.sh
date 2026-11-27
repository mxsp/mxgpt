#!/usr/bin/env bash
set -euo pipefail

# Build native Electron desktop apps for mx-Cowork (Linux AppImage + .deb, Windows GUI .zip)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CW_DIR="$ROOT_DIR/cowork"
OUT_DIR="$ROOT_DIR/dist"

mkdir -p "$OUT_DIR"
cd "$CW_DIR"

echo "=== Installing mx-Cowork Electron dependencies ==="
npm install --no-audit --no-fund

echo "=== Building native Linux (AppImage, .deb) and Windows GUI (.zip) apps ==="
npm run build:all

cp -f "$CW_DIR"/dist/*.AppImage "$OUT_DIR/"
cp -f "$CW_DIR"/dist/*.deb "$OUT_DIR/"
cp -f "$CW_DIR"/dist/*-win.zip "$OUT_DIR/mx-Cowork-1.1.0-win-x64.zip"

(cd "$OUT_DIR" && sha256sum *.AppImage *.deb *.zip > SHA256SUMS.txt)
ls -lh "$OUT_DIR"
cat "$OUT_DIR/SHA256SUMS.txt"
