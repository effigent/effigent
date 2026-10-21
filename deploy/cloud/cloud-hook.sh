#!/bin/sh
# Effigent: checks every tool call of a cloud agent session (Claude Code on
# the web, GitHub Copilot's cloud agent, Cursor cloud agents) against your
# workspace's policy. Commit it as .effigent/cloud-hook.sh; the repository's
# hook config runs it as `sh .effigent/cloud-hook.sh <claude|copilot|cursor>`.
# See docs/cloud-agents.md.
#
# Outside a cloud session it does nothing: a laptop's own effigentd has its
# own hook. In a cloud session without effigentd (the setup step didn't run)
# it blocks (exit 2).
agent="$1"
cloud=
case "$agent" in
  claude) [ "${CLAUDE_CODE_REMOTE:-}" = true ] && cloud=1 ;;  # Claude Code on the web
  copilot) [ "${GITHUB_ACTIONS:-}" = true ] && cloud=1 ;;     # Copilot cloud agent (GitHub Actions)
esac
[ -n "${EFFIGENT_CLOUD_TOKEN:-}" ] && cloud=1                 # Cursor: the Runtime Secret
[ -n "$cloud" ] || exit 0
if command -v effigentd >/dev/null 2>&1; then
  exec effigentd hook "$agent" --remote
fi
echo "Blocked by Effigent: effigentd is not installed in this cloud environment (add the Effigent setup step)." >&2
exit 2
