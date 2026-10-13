#!/usr/bin/env bash
# Builds dist/releases/effigentd/<version>/Effigent-<version>.pkg: a universal
# (Apple Silicon + Intel) effigentd, its launchd service and the enroll/hook
# post-install. Sign it for MDM with:  SIGN_ID="Developer ID Installer: …" deploy/macos/build-pkg.sh <version>
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${1:-$(git describe --tags --always --dirty)}"
OUT="dist/releases/effigentd/$VERSION"; mkdir -p "$OUT"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/usr/local/bin" "$ROOT/Library/LaunchDaemons"
for arch in arm64 amd64; do
  GOOS=darwin GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$ROOT/effigentd-$arch" ./cmd/effigentd
done
lipo -create -output "$ROOT/usr/local/bin/effigentd" "$ROOT/effigentd-arm64" "$ROOT/effigentd-amd64"
rm "$ROOT"/effigentd-arm64 "$ROOT"/effigentd-amd64
cp "$ROOT/usr/local/bin/effigentd" "$OUT/effigentd-darwin-universal"
cp deploy/macos/ai.effigent.effigentd.plist "$ROOT/Library/LaunchDaemons/"
chmod 644 "$ROOT/Library/LaunchDaemons/ai.effigent.effigentd.plist"
# macOS keeps a protected com.apple.provenance attribute on new files; pkgutil
# lists it as ._ entries and the installer restores it as an attribute.
xattr -cr "$ROOT" 2>/dev/null || true
export COPYFILE_DISABLE=1
PKG="$OUT/Effigent-$VERSION.pkg"
pkgbuild --root "$ROOT" --scripts deploy/macos/scripts --identifier ai.effigent.effigentd \
  --version "${VERSION#v}" --install-location / ${SIGN_ID:+--sign "$SIGN_ID"} "$PKG" >/dev/null
(cd "$OUT" && shasum -a 256 "Effigent-$VERSION.pkg" > "Effigent-$VERSION.pkg.sha256" && shasum -a 256 effigentd-darwin-universal > effigentd-darwin-universal.sha256)
echo "built $PKG $([ -n "${SIGN_ID:-}" ] && echo signed || echo UNSIGNED)"
