#!/bin/bash
# Builds a Release app and installs it on a connected, unlocked iPhone.
#   apps/ios/scripts/install-device.sh            # first paired physical iPhone
#   apps/ios/scripts/install-device.sh <UDID>
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
IOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$IOS_DIR"

DEVICE="${1:-$(xcrun devicectl list devices 2>/dev/null | awk '/iPhone/ && $0 !~ /simulated/ {for (i = 1; i <= NF; i++) if ($i ~ /^[0-9A-F]{8}-[0-9A-F]{16}$/) {print $i; exit}}')}"
if [[ -z "$DEVICE" ]]; then
  echo "没有找到已配对的 iPhone：先用数据线连接并在手机上信任这台电脑。" >&2
  exit 1
fi

./scripts/generate-project.sh
xcodebuild -project Shard.xcodeproj -scheme Shard -configuration Release \
  -destination 'generic/platform=iOS' -derivedDataPath build/DerivedData \
  -allowProvisioningUpdates -quiet build
xcrun devicectl device install app --device "$DEVICE" build/DerivedData/Build/Products/Release-iphoneos/Shard.app
xcrun devicectl device process launch --device "$DEVICE" dev.shard.mobile
