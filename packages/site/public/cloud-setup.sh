#!/bin/sh
# Effigent for cloud agent sessions: installs effigentd and saves the cloud
# environment's credentials and policy, so the repository's hooks can check
# every tool call. Run it in the environment's setup step with the token from
# the console (Machines -> Add cloud environment) in EFFIGENT_CLOUD_TOKEN:
#
#   curl -fsSL https://effigent.ai/cloud-setup.sh | sh
#
# Linux (x86_64, arm64). Env: EFFIGENT_VERSION (default latest),
# EFFIGENT_BIN_DIR (default /usr/local/bin), EFFIGENT_STATE_DIR (default
# /var/tmp/effigent-cloud), EFFIGENT_ALLOW_OFFLINE=1 (don't fail the setup
# when the control plane can't be reached; the hooks then deny until it can).
set -eu
RELEASES="${EFFIGENT_RELEASES:-https://effigent.ai/releases/effigentd}"
VERSION="${EFFIGENT_VERSION:-latest}"
BIN_DIR="${EFFIGENT_BIN_DIR:-/usr/local/bin}"
die() { echo "effigent cloud-setup: $*" >&2; exit 1; }

[ -n "${EFFIGENT_CLOUD_TOKEN:-}" ] || die "EFFIGENT_CLOUD_TOKEN is not set (the token from Machines -> Add cloud environment)"
[ "$(uname -s)" = Linux ] || die "cloud environments run Linux; on a laptop use https://effigent.ai/install.sh"
case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU $(uname -m)" ;;
esac
SUDO=
if [ "$(id -u)" != 0 ] && command -v sudo >/dev/null 2>&1; then SUDO="sudo"; fi

if [ "$VERSION" = latest ]; then VERSION="$(curl -fsSL "$RELEASES/latest")"; fi
BIN="effigentd-linux-$ARCH"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fsSL -o "$TMP/$BIN" "$RELEASES/$VERSION/$BIN"
curl -fsSL -o "$TMP/$BIN.sha256" "$RELEASES/$VERSION/$BIN.sha256"
(cd "$TMP" && sha256sum -c "$BIN.sha256" >/dev/null) || die "effigentd download failed its checksum"
$SUDO mkdir -p "$BIN_DIR"
$SUDO install -m 0755 "$TMP/$BIN" "$BIN_DIR/effigentd"

# The agent may run as another user than this step (Copilot: the runner user
# here, root in the session): the state is readable by all (--shared).
set -- --token "$EFFIGENT_CLOUD_TOKEN" --shared
[ -n "${EFFIGENT_STATE_DIR:-}" ] && set -- "$@" --state-dir "$EFFIGENT_STATE_DIR"
[ "${EFFIGENT_ALLOW_OFFLINE:-}" = 1 ] && set -- "$@" --allow-offline
$SUDO "$BIN_DIR/effigentd" cloud-setup "$@"
