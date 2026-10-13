#!/usr/bin/env bash
# Builds effigentd for Linux amd64/arm64 into dist/releases/effigentd/<version>/
# (binary + .sha256), and writes dist/releases/effigentd/latest.
# Publish: aws s3 sync dist/releases/ s3://<site-bucket>/releases/  (served as https://effigent.ai/releases/…)
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${1:-$(git describe --tags --always --dirty)}"
OUT="dist/releases/effigentd/$VERSION"
mkdir -p "$OUT"   # the macOS job adds its pkg to the same folder
for target in linux/amd64 linux/arm64 windows/amd64 windows/arm64; do
  os=${target%/*}; arch=${target#*/}; ext=""; [ "$os" = windows ] && ext=".exe"
  bin="effigentd-$os-$arch$ext"
  GOOS=$os GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$OUT/$bin" ./cmd/effigentd
  (cd "$OUT" && shasum -a 256 "$bin" > "$bin.sha256")
done
echo "$VERSION" > dist/releases/effigentd/latest
echo "built $VERSION:"; ls -l "$OUT"
