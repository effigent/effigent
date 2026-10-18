#!/bin/sh
# Effigent endpoint installer (Linux and macOS). Installs effigentd as a
# service, enrolls this machine with your organization, and starts enforcing.
# Linux: also installs Tetragon (kernel enforcement). macOS: installs the
# release .pkg (checksum-verified), which adds the Claude Code, Codex and Gemini CLI
# hooks to their machine-wide settings.
#
#   curl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --token eft_...
#
# Options:
#   --token TOKEN        enrollment token from the console (Enforcement -> Enroll an endpoint)
#   --server URL         control plane (default https://api.effigent.ai)
#   --version VERSION    effigentd version (default: latest)
#   --skip-tetragon      Tetragon is already installed and running (Linux)
#   --uninstall          stop and remove effigentd (leaves Tetragon)
set -eu

SERVER="https://api.effigent.ai"
RELEASES="${EFFIGENT_RELEASES:-https://effigent.ai/releases/effigentd}"
TETRAGON_VERSION="v1.7.1"
VERSION="latest"
TOKEN=""
SKIP_TETRAGON=0
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --token) TOKEN="$2"; shift 2 ;;
    --server) SERVER="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --skip-tetragon) SKIP_TETRAGON=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

say()  { printf '\033[1m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33mwarning:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[31merror:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root: curl -fsSL https://effigent.ai/install.sh | sudo sh -s -- --token ..."
command -v curl >/dev/null 2>&1 || die "curl is required"

# ---- macOS: the .pkg does the work (enroll, agent hooks, launchd) -----
if [ "$(uname -s)" = Darwin ]; then
  STATE="${EFFIGENT_STATE_DIR:-/Library/Application Support/Effigent}"
  if [ "$UNINSTALL" = 1 ]; then
    say "Removing effigentd"
    /usr/local/bin/effigentd install-hooks --remove 2>/dev/null || true
    launchctl bootout system/ai.effigent.effigentd 2>/dev/null || true
    rm -f /Library/LaunchDaemons/ai.effigent.effigentd.plist /usr/local/bin/effigentd
    pkgutil --forget ai.effigent.effigentd >/dev/null 2>&1 || true
    echo "effigentd removed. Enrollment state kept in $STATE (delete it to unenroll this machine)."
    exit 0
  fi
  if [ "$VERSION" = latest ]; then VERSION="$(curl -fsSL "$RELEASES/latest")"; fi
  PKG="Effigent-$VERSION.pkg"
  say "Downloading effigentd $VERSION"
  TMPB="$(mktemp -d)"; trap 'rm -rf "$TMPB"' EXIT
  curl -fsSL -o "$TMPB/$PKG" "$RELEASES/$VERSION/$PKG"
  curl -fsSL -o "$TMPB/$PKG.sha256" "$RELEASES/$VERSION/$PKG.sha256"
  (cd "$TMPB" && shasum -a 256 -c "$PKG.sha256" >/dev/null) || die "effigentd download failed its checksum"
  install -d -m 0700 "$STATE"
  if [ -s "$STATE/endpoint.json" ]; then
    say "Already enrolled; keeping the existing enrollment"
  else
    [ -n "$TOKEN" ] || die "--token is required for the first install (console: Enforcement -> Enroll an endpoint)"
    # the package's post-install enrolls with it and then deletes it
    (umask 077; printf '%s\n' "$TOKEN" > "$STATE/enroll.token"; printf '%s\n' "$SERVER" > "$STATE/enroll.server")
  fi
  say "Installing (enrolls, adds the agent hooks, starts the service)"
  ${EFFIGENT_INSTALLER:-installer} -pkg "$TMPB/$PKG" -target / >/dev/null || die "the installer failed: see /Library/Logs/Effigent/install.log"
  i=0
  until /usr/local/bin/effigentd status >/dev/null 2>&1 || [ $i -ge 15 ]; do sleep 1; i=$((i+1)); done
  /usr/local/bin/effigentd status || die "effigentd did not come up: see /Library/Logs/Effigent/install.log"
  [ -s "$STATE/endpoint.json" ] || die "enrollment failed (token expired, used up or mistyped?): see /Library/Logs/Effigent/install.log, then rerun with a new token"
  echo
  echo "Done. This machine now appears in the console under Enforcement."
  echo "macOS has no kernel enforcement: Claude Code, Codex and Gemini CLI tool calls are checked through their hooks."
  exit 0
fi

[ "$(uname -s)" = Linux ] || die "this installer is for Linux and macOS; on Windows use https://effigent.ai/install.ps1"
command -v systemctl >/dev/null 2>&1 || die "systemd is required"

if [ "$UNINSTALL" = 1 ]; then
  say "Removing effigentd"
  systemctl disable --now effigentd 2>/dev/null || true
  rm -f /etc/systemd/system/effigentd.service /usr/local/bin/effigentd
  systemctl daemon-reload
  echo "effigentd removed. Enrollment state kept in /var/lib/effigent (delete it to unenroll this machine)."
  exit 0
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

# ---- kernel checks -------------------------------------------------------
say "Checking the kernel"
KREL="$(uname -r)"
[ -e /sys/kernel/btf/vmlinux ] || die "kernel $KREL has no BTF (/sys/kernel/btf/vmlinux). Use a distro kernel 5.8+ (Ubuntu 22.04+, Debian 12+, RHEL 9+, Amazon Linux 2023)."
# Some minimal images don't mount securityfs; it's where the active LSMs are listed.
[ -e /sys/kernel/security/lsm ] || mount -t securityfs securityfs /sys/kernel/security 2>/dev/null || true
LSM_OK=0
if grep -qw bpf /sys/kernel/security/lsm 2>/dev/null; then LSM_OK=1; fi
if [ "$LSM_OK" = 0 ]; then
  warn "BPF LSM is not enabled, so effigentd can watch agents but cannot block them yet."
  warn "Enable it: add 'lsm=$(cat /sys/kernel/security/lsm 2>/dev/null),bpf' to GRUB_CMDLINE_LINUX in /etc/default/grub, run update-grub (or grub2-mkconfig), reboot."
fi

# ---- Tetragon ------------------------------------------------------------

# Outside Kubernetes nothing ever fills in pod details, but in a container- or
# pod-style cgroup Tetragon holds each event waiting for them: 15 retries x 2s
# by default, so events (and the `effigentd run` start confirmation) arrive
# ~30s late. Keep the wait to ~2s there.
tetragon_event_cache() {
  [ -n "${KUBERNETES_SERVICE_HOST:-}" ] && return 0
  echo 2 > /etc/tetragon/tetragon.conf.d/event-cache-retries
  echo 1 > /etc/tetragon/tetragon.conf.d/event-cache-retry-delay
}

if [ "$SKIP_TETRAGON" = 0 ] && ! systemctl is-active --quiet tetragon; then
  say "Installing Tetragon $TETRAGON_VERSION"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  TGZ="tetragon-$TETRAGON_VERSION-$ARCH.tar.gz"
  curl -fsSL -o "$TMP/$TGZ" "https://github.com/cilium/tetragon/releases/download/$TETRAGON_VERSION/$TGZ"
  curl -fsSL -o "$TMP/$TGZ.sha256sum" "https://github.com/cilium/tetragon/releases/download/$TETRAGON_VERSION/$TGZ.sha256sum"
  (cd "$TMP" && sha256sum -c "$TGZ.sha256sum" >/dev/null) || die "Tetragon download failed its checksum"
  tar -xzf "$TMP/$TGZ" -C "$TMP"
  install -d /etc/tetragon/tetragon.conf.d
  # effigentd attributes every event to its agent through the ancestor chain.
  echo "base,kprobe,lsm" > /etc/tetragon/tetragon.conf.d/enable-ancestors
  tetragon_event_cache
  "$TMP/tetragon-$TETRAGON_VERSION-$ARCH/install.sh" >/dev/null
else
  say "Tetragon is already running"
  if [ ! -s /etc/tetragon/tetragon.conf.d/enable-ancestors ] || { [ -z "${KUBERNETES_SERVICE_HOST:-}" ] && [ ! -s /etc/tetragon/tetragon.conf.d/event-cache-retries ]; }; then
    echo "base,kprobe,lsm" > /etc/tetragon/tetragon.conf.d/enable-ancestors
    tetragon_event_cache
    systemctl restart tetragon
  fi
fi

# ---- effigentd ------------------------------------------------------------
say "Installing effigentd ($VERSION)"
if [ "$VERSION" = latest ]; then VERSION="$(curl -fsSL "$RELEASES/latest")"; fi
BIN="effigentd-linux-$ARCH"
TMPB="$(mktemp -d)"
curl -fsSL -o "$TMPB/$BIN" "$RELEASES/$VERSION/$BIN"
curl -fsSL -o "$TMPB/$BIN.sha256" "$RELEASES/$VERSION/$BIN.sha256"
(cd "$TMPB" && sha256sum -c "$BIN.sha256" >/dev/null) || die "effigentd download failed its checksum"
install -m 0755 "$TMPB/$BIN" /usr/local/bin/effigentd
rm -rf "$TMPB"

install -d -m 0700 /var/lib/effigent
install -d -m 0750 /var/log/effigent
if [ -s /var/lib/effigent/endpoint.json ]; then
  say "Already enrolled; keeping the existing enrollment"
else
  [ -n "$TOKEN" ] || die "--token is required for the first install (console: Enforcement -> Enroll an endpoint)"
  say "Enrolling this machine with $SERVER"
  /usr/local/bin/effigentd enroll --server "$SERVER" --token "$TOKEN" --state-dir /var/lib/effigent
fi

cat > /etc/systemd/system/effigentd.service <<'UNIT'
[Unit]
Description=Effigent endpoint agent (AI agent monitoring and enforcement)
Documentation=https://effigent.ai/docs/quickstart
After=network-online.target tetragon.service
Wants=network-online.target
Requires=tetragon.service

[Service]
ExecStart=/usr/local/bin/effigentd --tetragon unix:///var/run/tetragon/tetragon.sock --state-dir /var/lib/effigent --output none --log-file /var/log/effigent/events.jsonl --keep-policies-on-exit
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now effigentd >/dev/null 2>&1
systemctl restart effigentd

say "Waiting for effigentd"
i=0
until /usr/local/bin/effigentd status >/dev/null 2>&1 || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done
/usr/local/bin/effigentd status || die "effigentd did not come up: journalctl -u effigentd"
echo
echo "Done. This machine now appears in the console under Machines."
[ "$LSM_OK" = 1 ] || echo "Blocking turns on after you enable BPF LSM and reboot (see the warning above)."
