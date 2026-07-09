# effigent — the Effigent CLI

Capture your AI agents' runs — Claude Code, OpenAI Codex, LangGraph/CrewAI/AutoGen, or any
OTel-capable agent — and send them to your [Effigent](https://github.com/effigent/effigent)
workspace, where every run becomes an execution graph with cost, models, and
optimization insights (replace / memoize / template / route).

## Install

```sh
npm i -g effigent
```

## Two-minute setup

```sh
# 1. Log in with your workspace key (generate it on the dashboard's Install page)
effigent login --server https://<your-dashboard-url> --key eff_…

# 2. Register the agent — mints a scoped capture key
effigent agent add my-agent

# 3. Wire capture for your harness
effigent install claude --agent my-agent    # Claude Code: SessionEnd hook, zero-touch
effigent install codex  --agent my-agent    # Codex: prints the OTel env, key filled in
effigent install python --agent my-agent    # LangGraph / CrewAI / AutoGen via OpenLLMetry
effigent install node   --agent my-agent    # Node/TS agents via OpenLLMetry
effigent install otel   --agent my-agent    # any OTel exporter
```

Or wrap any command directly (CI, cron, one-offs):

```sh
effigent run --agent nightly-etl -- node etl.js
```

## Security

- One **scoped key per agent** — write-only, bound to that agent, stored hashed server-side.
- Keys live in `~/.effigent/config.json`, never in your agent's code or settings.
- Captured payloads are **redacted** (API keys, credentials, PII) before storage or analysis.

## Commands

| Command | What it does |
| --- | --- |
| `effigent login` | Save + verify the server URL and workspace key |
| `effigent agent add <name>` | Register an agent, mint its scoped capture key |
| `effigent agent list` | List agents registered from this machine |
| `effigent install <harness>` | Wire capture: `claude`, `codex`, `python`, `node`, `otel` |
| `effigent run --agent <name> -- <cmd…>` | Run any agent command with capture + attribution |
| `effigent sync` | Upload local Claude Code sessions in batch |
| `effigent doctor` | Check your local setup |
