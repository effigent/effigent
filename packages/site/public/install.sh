#!/bin/sh
# Effigent endpoint installer (Linux and macOS). Installs effigentd as a
# service, enrolls this machine with your organization, and starts enforcing.
# Linux: also installs Tetragon (kernel enforcement); without systemd (containers,
# sandboxes) both run as background processes until the next reboot. macOS: installs the
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
    # agents pointed at the model gateway would lose their model without the daemon
    # (grep first: an older effigentd would take the unknown subcommand for a daemon start)
    { grep -a -q install-gateway /usr/local/bin/effigentd || grep -q install-gateway /usr/local/bin/effigentd; } 2>/dev/null && { /usr/local/bin/effigentd install-gateway --remove --agents claude,codex 2>/dev/null || true; }
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
# Containers and sandboxes (e.g. Grok Bot's computer) often have no systemd, or
# systemctl without systemd running. There both daemons run as background processes.
SYSTEMD=0
if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then SYSTEMD=1; fi

if [ "$UNINSTALL" = 1 ]; then
  say "Removing effigentd"
  if [ "$SYSTEMD" = 1 ]; then
    systemctl disable --now effigentd 2>/dev/null || true
    rm -f /etc/systemd/system/effigentd.service
    systemctl daemon-reload 2>/dev/null || true
  fi
  pkill -x effigentd 2>/dev/null || true # a daemon started by hand
  # agents pointed at the model gateway would lose their model without the daemon
  { grep -a -q install-gateway /usr/local/bin/effigentd || grep -q install-gateway /usr/local/bin/effigentd; } 2>/dev/null && { /usr/local/bin/effigentd install-gateway --remove --agents claude,codex 2>/dev/null || true; }
  rm -f /usr/local/bin/effigentd
  if [ "$SYSTEMD" = 0 ] && pkill -x tetragon 2>/dev/null; then # nothing else manages it here
    sleep 1; umount /run/tetragon/cgroup2 2>/dev/null || true
    echo "Tetragon stopped (its files stay in /usr/local)."
  fi
  echo "effigentd removed. Enrollment state kept in /var/lib/effigent (delete it to unenroll this machine)."
  exit 0
fi

[ "$SYSTEMD" = 1 ] || warn "systemd is not running: Tetragon and effigentd will run as background processes and stop at the next reboot (rerun this installer then)."

# Without systemd: start a daemon in its own session so it outlives this shell.
# The subshell exits at once, so the daemon is orphaned right away and leaves
# the process tree of whoever ran the installer (often an AI agent itself)
# before effigentd starts tracking agents.
start_bg() { # start_bg LOGFILE CMD...
  log="$1"; shift
  ( setsid nohup "$@" >>"$log" 2>&1 </dev/null & )
}

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

# ---- effigentd ------------------------------------------------------------
# Enroll before Tetragon starts: it logs command lines and their ancestors, and this
# installer's own (with --token) is an ancestor of everything below. A one-time token
# is spent by then.
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

TETRAGON_ADDR="unix:///var/run/tetragon/tetragon.sock"

tetragon_running() {
  if [ "$SYSTEMD" = 1 ]; then systemctl is-active --quiet tetragon; else pgrep -x tetragon >/dev/null 2>&1; fi
}

if [ "$SKIP_TETRAGON" = 0 ] && ! tetragon_running; then
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
  if [ "$SYSTEMD" = 1 ]; then
    "$TMP/tetragon-$TETRAGON_VERSION-$ARCH/install.sh" >/dev/null
  else
    # What Tetragon's install.sh does, minus the systemd unit.
    cp -Rf "$TMP/tetragon-$TETRAGON_VERSION-$ARCH/usr/local/"* /usr/local/
    install -d /etc/tetragon/tetragon.tp.d /var/log/tetragon /var/run/tetragon
    cp -n -r /usr/local/lib/tetragon/tetragon.conf.d /etc/tetragon/ 2>/dev/null || true
    start_bg /var/log/tetragon/tetragon.out env PATH="/usr/local/lib/tetragon:$PATH" /usr/local/bin/tetragon
  fi
elif [ "$SYSTEMD" = 0 ]; then
  # Possibly started by hand with its own flags: leave it running and connect
  # effigentd to wherever it listens (flag, then config, then Tetragon's default).
  say "Tetragon is already running"
  TARGS="$(tr '\0' ' ' < "/proc/$(pgrep -xo tetragon)/cmdline" 2>/dev/null || true)"
  ADDR="$(printf '%s\n' "$TARGS" | sed -n 's/.*--server-address[= ]\([^ ]*\).*/\1/p')"
  for f in /etc/tetragon/tetragon.conf.d/server-address /usr/local/lib/tetragon/tetragon.conf.d/server-address; do
    [ -n "$ADDR" ] || ADDR="$(cat "$f" 2>/dev/null || true)"
  done
  ADDR="${ADDR:-localhost:54321}"
  case "$ADDR" in
    unix://*) TETRAGON_ADDR="$ADDR" ;;
    0.0.0.0:*|:*) TETRAGON_ADDR="127.0.0.1:${ADDR##*:}" ;;
    *) TETRAGON_ADDR="$ADDR" ;;
  esac
  case "$TARGS" in
    *enable-ancestors*) ;;
    *) grep -qs kprobe /etc/tetragon/tetragon.conf.d/enable-ancestors ||
         warn "Tetragon was started without --enable-ancestors base,kprobe,lsm, so effigentd cannot tell which agent caused an event. Restart it with that flag, or stop it (pkill -x tetragon) and rerun this installer." ;;
  esac
else
  say "Tetragon is already running"
  if [ ! -s /etc/tetragon/tetragon.conf.d/enable-ancestors ] || { [ -z "${KUBERNETES_SERVICE_HOST:-}" ] && [ ! -s /etc/tetragon/tetragon.conf.d/event-cache-retries ]; }; then
    install -d /etc/tetragon/tetragon.conf.d
    echo "base,kprobe,lsm" > /etc/tetragon/tetragon.conf.d/enable-ancestors
    tetragon_event_cache
    systemctl restart tetragon
  fi
fi

# ---- start effigentd ------------------------------------------------------
EFFIGENTD_ARGS="--tetragon $TETRAGON_ADDR --state-dir /var/lib/effigent --output none --log-file /var/log/effigent/events.jsonl --keep-policies-on-exit"
if [ "$SYSTEMD" = 1 ]; then
cat > /etc/systemd/system/effigentd.service <<UNIT
[Unit]
Description=Effigent endpoint agent (AI agent monitoring and enforcement)
Documentation=https://effigent.ai/docs/quickstart
After=network-online.target tetragon.service
Wants=network-online.target
Requires=tetragon.service

[Service]
ExecStart=/usr/local/bin/effigentd $EFFIGENTD_ARGS
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now effigentd >/dev/null 2>&1
systemctl restart effigentd
LOGHINT="journalctl -u effigentd"
else
  SOCK="${TETRAGON_ADDR#unix://}"
  if [ "$SOCK" != "$TETRAGON_ADDR" ]; then
    i=0 # effigentd retries Tetragon on its own, but don't race its first start
    until [ -S "$SOCK" ] || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done
    [ -S "$SOCK" ] || warn "Tetragon has not opened $SOCK yet: see /var/log/tetragon/tetragon.out"
  fi
  # Replace a daemon started by hand or by an earlier run only now, so a failure above leaves it running.
  if pkill -x effigentd 2>/dev/null; then sleep 1; fi
  # shellcheck disable=SC2086
  start_bg /var/log/effigent/effigentd.log /usr/local/bin/effigentd $EFFIGENTD_ARGS
  LOGHINT="/var/log/effigent/effigentd.log"
fi

say "Waiting for effigentd"
i=0
until /usr/local/bin/effigentd status >/dev/null 2>&1 || [ $i -ge 30 ]; do sleep 1; i=$((i+1)); done
/usr/local/bin/effigentd status || die "effigentd did not come up: $LOGHINT"
echo
echo "Done. This machine now appears in the console under Machines."
[ "$SYSTEMD" = 1 ] || echo "No systemd: Tetragon and effigentd stop at the next reboot; rerun this installer to start them again."
[ "$LSM_OK" = 1 ] || echo "Blocking turns on after you enable BPF LSM and reboot (see the warning above)."
