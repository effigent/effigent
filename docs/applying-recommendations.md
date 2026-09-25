# Applying Effigent recommendations — instructions for the coding agent

The short way, in Claude Code: run **`/effigent-apply`** in the project (installed by
`effigent install claude`). It loads `effigent recommendations` — this project's open changes,
their files and these rules — and the agent applies them and records each one with
`effigent applied <id>`. Without Claude Code, hand this file plus the output of
`effigent recommendations` to the agent. It is written for the agent, not for a person.

Effigent's Insights view lists, per agent, **recommendations** — each with an id, a basis
(measured / simulated / structural / needs A/B) and usually **files** to write. Every change
is a hypothesis: after it is applied, Effigent compares sessions before and after the date
it was marked applied. So the job is to make the change *exactly*, make it *attributable*,
and record *when*.

## Rules

1. **Look before writing.** `git status` first. If the tree has uncommitted work, do not
   commit, stash or reformat anything that is not yours — only add files and append lines.
   Read every file you are about to change; never overwrite an existing one.
2. **Merge, never replace.** A settings file is JSON: merge the `env` keys into the existing
   object and keep every other key. A CLAUDE.md line is *added* where it will be read (near
   the top, next to the other working rules), in the file's own voice.
3. **Make the generic template project-true.** A generated file is a template. Where it has
   a placeholder (`<your deploy command>`), fill it from the project's own docs and from the
   commands the agent really ran (the shell history in past sessions) — and where the real
   answer depends on what changed (per-surface deploys), write the routing, not one command.
   Never put a command in a skill that the project's docs say must not be automated.
4. **Personal vs shared settings.** In a repo other people work in, put behaviour changes that
   only the measured user asked for (compaction window, model choices) in
   `.claude/settings.local.json`, which is not committed. Agents (`.claude/agents/`) and skills
   (`.claude/skills/`) are safe to share, but leave committing to the user.
5. **One lever per change, where you can.** Items marked *needs A/B* (e.g. shrinking
   CLAUDE.md) change what every session starts with — apply them on their own, not in the
   same week as another change, or the before/after cannot tell which one moved.
   Restructuring a large curated CLAUDE.md is a proposal to the user, not something to do
   unasked.
6. **Items with no file** (advisor spend, "compact before breaks") are behaviour or account
   settings — report them to the user; do not invent a file for them.
7. **Never run what the skill would run.** Setting up a ship/deploy skill is not a reason to
   deploy. Write files only.

## The levers and what "applied" means

| Recommendation id | Write | Effigent sees it as applied when |
|---|---|---|
| `spill-exploration` | `.claude/agents/scout.md` + one CLAUDE.md line telling the agent to delegate 3+-lookup investigations to `scout` | sessions call the `scout` subagent |
| `compact-earlier` | `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` = the threshold in tokens (100k–1M; capped at the model's window, so it is safe on smaller models). Avoid `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` — a percentage means a different threshold on each model | sessions compact near the threshold, repeatedly (one manual `/compact` does not count) |
| `ship-skill` | `.claude/skills/ship/SKILL.md` (`disable-model-invocation: true`, repo state injected with `` !`git …` ``), with the project's real push and deploy steps | the user runs `/ship` |
| `command-*` | a skill that runs the recorded command | the skill is used |
| `verify-hook` | a PostToolUse hook that type-checks after edits | check-only requests drop |
| `shrink-instructions` | an index CLAUDE.md with sections moved to docs it points at (needs A/B — ask first) | the tokens every session starts with drop ≥25% |

## After applying

Tell the user, in a few lines: which recommendation ids were applied, the files written,
what was deliberately left out and why. Then **record each applied id**:
`effigent applied <id> [<id>…]` (the agent is resolved from the directory; `--at YYYY-MM-DD`
for a change made earlier, `--undo` to clear), or in the dashboard (Insights → the agent →
*Suggestions & results* → *Mark as applied*), so the before/after starts at the right moment. The measurement needs at least 3 sessions on each side
and reports "collecting" until then.
