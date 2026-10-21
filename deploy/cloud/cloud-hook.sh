#!/bin/sh
# Effigent: checks every tool call of a cloud agent session (Claude Code on
# the web, GitHub Copilot's cloud agent, Cursor cloud agents) against your
# workspace's policy. Commit it as .effigent/cloud-hook.sh; the repository's
# hook config runs it as `sh .effigent/cloud-hook.sh <claude|copilot|cursor>`.
# See docs/cloud-agents.md.
#
# Outside a cloud session (no vendor marker, no token, no state from the
# setup step) it does nothing: a laptop's own effigentd has its own hook.
# In a cloud session without effigentd it blocks (exit 2).
agent="$1"
cloud=
case "$agent" in
  claude) [ "${CLAUDE_CODE_REMOTE:-}" = true ] && cloud=1 ;;  # Claude Code on the web
  copilot) [ -n "${GITHUB_COPILOT_API_TOKEN:-}" ] || [ "${GITHUB_ACTIONS:-}" = true ] && cloud=1 ;;  # Copilot cloud agent
esac
[ -n "${EFFIGENT_CLOUD_TOKEN:-}" ] && cloud=1                 # the token (Cursor: the Runtime Secret)
# The setup step ran here (effigentd cloud-setup), if the state is root's or this user's:
f="${EFFIGENT_STATE_DIR:-/var/tmp/effigent-cloud}/endpoint.json"
if [ -r "$f" ] && { [ -O "$f" ] || [ -n "$(find "$f" -prune -user 0 2>/dev/null)" ]; }; then cloud=1; fi
[ -n "$cloud" ] || exit 0
if command -v effigentd >/dev/null 2>&1; then
  exec effigentd hook "$agent" --remote
fi
echo "Blocked by Effigent: effigentd is not installed in this cloud environment (add the Effigent setup step)." >&2
exit 2
