#!/bin/bash
# Regenerates Shard.xcodeproj from project.yml (the project file is not committed).
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$IOS_DIR/scripts/build-renderer.sh"
xcodegen generate --spec "$IOS_DIR/project.yml" --project "$IOS_DIR"
