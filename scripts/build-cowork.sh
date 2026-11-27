#!/usr/bin/env bash
set -euo pipefail

# Build standalone Linux x64 and Windows x64 executables + release archives for mx-Cowork

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CW_DIR="$ROOT_DIR/cowork"
OUT_DIR="$ROOT_DIR/dist"

mkdir -p "$OUT_DIR"
cd "$CW_DIR"

echo "=== Installing mx-Cowork packaging dependencies ==="
npm install --no-audit --no-fund

echo "=== Building standalone Linux x64 & Windows x64 executables ==="
npm run build:all

cp -f "$CW_DIR/dist/mx-cowork-linux-x64" "$OUT_DIR/mx-cowork-linux-x64"
cp -f "$CW_DIR/dist/mx-cowork-win-x64.exe" "$OUT_DIR/mx-cowork-win-x64.exe"

echo "=== Packaging release archives ==="
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

mkdir -p "$STAGE/mx-cowork-linux-x64" "$STAGE/mx-cowork-windows-x64"
cp "$OUT_DIR/mx-cowork-linux-x64" "$CW_DIR/README.md" "$STAGE/mx-cowork-linux-x64/"
cp "$OUT_DIR/mx-cowork-win-x64.exe" "$CW_DIR/README.md" "$STAGE/mx-cowork-windows-x64/"

tar -C "$STAGE" -czf "$OUT_DIR/mx-cowork-linux-x64.tar.gz" mx-cowork-linux-x64
(cd "$STAGE" && python3 -c "
import os, zipfile
with zipfile.ZipFile('$OUT_DIR/mx-cowork-windows-x64.zip', 'w', zipfile.ZIP_DEFLATED) as zf:
    for root, _, files in os.walk('mx-cowork-windows-x64'):
        for f in files:
            p = os.path.join(root, f)
            zf.write(p, p)
")

(cd "$OUT_DIR" && sha256sum mx-cowork-linux-x64.tar.gz mx-cowork-windows-x64.zip mx-cowork-win-x64.exe > SHA256SUMS.txt)
ls -lh "$OUT_DIR"
cat "$OUT_DIR/SHA256SUMS.txt"
