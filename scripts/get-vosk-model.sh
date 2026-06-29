#!/usr/bin/env bash
# get-vosk-model.sh — download the small English Vosk model and package it as the
# .tar.gz that vosk-browser expects, into ./models/.
#
# The app loads this file as its (only) speech engine. Hosting it in the repo
# (same-origin) avoids CORS issues and lets the PWA cache it for offline use.
#
# Note: it's ~40 MB. GitHub Pages serves it fine, but if you'd rather not commit a
# 40 MB binary, you can host it elsewhere (CORS-enabled) and change VOSK_MODEL_URL
# in js/vosk-engine.js instead.
#
# Usage:  ./scripts/get-vosk-model.sh

set -euo pipefail
cd "$(dirname "$0")/.."

MODEL="vosk-model-small-en-us-0.15"
ZIP_URL="https://alphacephei.com/vosk/models/${MODEL}.zip"
OUT="models/${MODEL}.tar.gz"

for tool in curl unzip tar; do
  command -v "$tool" >/dev/null 2>&1 || { echo "❌ Need '$tool' installed."; exit 1; }
done

mkdir -p models
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "⬇️  Downloading ${MODEL} (~40 MB)…"
curl -fL --progress-bar "$ZIP_URL" -o "$tmp/model.zip"

echo "📦 Unpacking…"
unzip -q "$tmp/model.zip" -d "$tmp"

echo "🗜️  Repackaging as ${OUT} …"
# Preserve the top-level model folder (matches the official distribution layout
# vosk-browser expects). gzip the tar so the browser can stream-extract it.
tar -C "$tmp" -czf "$OUT" "$MODEL"

SIZE="$(du -h "$OUT" | cut -f1)"
echo "✅ Done: $OUT ($SIZE)"
echo "   Commit models/ and (re)load the app — it preloads this at startup."
