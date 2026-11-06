#!/bin/bash
# Builds the WKWebView Markdown renderer into Shard/Resources/Renderer.
# Xcode runs this before compiling; it skips the build when nothing changed.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$IOS_DIR/../.." && pwd)"
OUTPUT="$IOS_DIR/Shard/Resources/Renderer/index.html"

if [[ "${1:-}" != "--force" && -f "$OUTPUT" ]]; then
  newer=$(find "$IOS_DIR/renderer/src" "$IOS_DIR/renderer/index.html" "$IOS_DIR/renderer/vite.config.ts" \
    "$REPO_ROOT/packages/markdown/src" "$REPO_ROOT/packages/markdown/styles.css" \
    -newer "$OUTPUT" -type f -print -quit)
  if [[ -z "$newer" ]]; then
    echo "renderer: up to date"
    exit 0
  fi
fi

cd "$REPO_ROOT"
pnpm build:markdown
pnpm --filter @shard/ios-renderer build
