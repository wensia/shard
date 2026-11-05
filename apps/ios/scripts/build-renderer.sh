#!/bin/bash
# Builds the shared Web app and the legacy GitHub Markdown renderer.
# Xcode runs this before compiling; it skips the build when nothing changed.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$IOS_DIR/../.." && pwd)"
OUTPUT="$IOS_DIR/Shard/Resources/Renderer/index.html"
WEB_OUTPUT="$IOS_DIR/Shard/Resources/WebApp/index.html"

if [[ "${1:-}" != "--force" && -f "$OUTPUT" && -f "$WEB_OUTPUT" ]]; then
  newer=$(find "$IOS_DIR/renderer/src" "$IOS_DIR/renderer/index.html" "$IOS_DIR/renderer/vite.config.ts" \
    "$REPO_ROOT/packages/markdown/src" "$REPO_ROOT/packages/markdown/styles.css" \
    "$REPO_ROOT/src" "$REPO_ROOT/public" "$REPO_ROOT/vendor/kiln/tokens" \
    "$REPO_ROOT/index.html" "$REPO_ROOT/vite.config.ts" "$REPO_ROOT/vite.ios.config.ts" \
    "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml" \
    -newer "$OUTPUT" -type f -print -quit)
  web_newer=$(find "$REPO_ROOT/src" "$REPO_ROOT/public" "$REPO_ROOT/vendor/kiln/tokens" \
    "$REPO_ROOT/packages/markdown/src" "$REPO_ROOT/crates/shard-lockbox-wasm/src" \
    "$REPO_ROOT/index.html" "$REPO_ROOT/vite.config.ts" "$REPO_ROOT/vite.ios.config.ts" \
    "$REPO_ROOT/package.json" "$REPO_ROOT/pnpm-lock.yaml" \
    -newer "$WEB_OUTPUT" -type f -print -quit)
  if [[ -z "$newer" && -z "$web_newer" ]]; then
    echo "iOS web resources: up to date"
    exit 0
  fi
fi

cd "$REPO_ROOT"
pnpm build:markdown
pnpm --filter @shard/ios-renderer build
pnpm build:ios-web
