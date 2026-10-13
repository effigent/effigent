#!/usr/bin/env bash
# Builds effigentd for Linux amd64/arm64 into dist/releases/effigentd/<version>/
# (binary + .sha256), and writes dist/releases/effigentd/latest.
# Publish: aws s3 sync dist/releases/ s3://<site-bucket>/releases/  (served as https://effigent.ai/releases/…)
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${1:-$(git describe --tags --always --dirty)}"
OUT="dist/releases/effigentd/$VERSION"
rm -rf "$OUT" && mkdir -p "$OUT"
for arch in amd64 arm64; do
  bin="effigentd-linux-$arch"
  GOOS=linux GOARCH=$arch CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=$VERSION" -o "$OUT/$bin" ./cmd/effigentd
  (cd "$OUT" && shasum -a 256 "$bin" > "$bin.sha256")
done
echo "$VERSION" > dist/releases/effigentd/latest
echo "built $VERSION:"; ls -l "$OUT"
