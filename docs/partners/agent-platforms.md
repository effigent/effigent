# Effigent for hosted agent platforms

**For:** providers that run coding agents in their own cloud sandboxes: xAI, OpenAI (Codex
cloud), Cursor (background agents), Anthropic (Claude Code on the web), Google (Jules),
Cognition (Devin) and similar. October 2026. Contact: [name], [email]

## The problem your enterprise customers bring you

A security team that has approved an AI coding agent on its laptops and CI runners has done so
with controls in place: a policy on what agents may run, read and connect to, a human approval
for risky steps, and an audit trail. When the same agent runs in your cloud sandbox, those
controls stop at your boundary. The usual answer is "not in our cloud yet", or a long security
review of your sandbox.

## The offer

Your business customers get their own Effigent policy, approvals and audit **inside your
sandboxes**, the same ones that already govern their laptops, servers and Kubernetes nodes. You
ship it once; each customer turns it on with a token from their own Effigent workspace.

| The customer gets | How |
|---|---|
| Their policy enforced in your sandbox | Programs, files and network addresses the agent may not touch, blocked in the sandbox's kernel (BPF LSM), not just asked of the agent |
| Approvals from their own reviewers | Risky actions (`git push`, a deploy command, an MCP tool) pause until someone on their team approves, by email or in the console |
| One audit trail | Every agent action in your sandbox lands next to their laptop and CI events, attributed to the agent that caused it, hash-chained per machine |
| Same rules everywhere | One policy covers Claude Code, Codex, Gemini CLI and custom agents, whatever model drives them |

## How it works

1. Your sandbox image contains `effigentd` (a static Go binary, amd64/arm64) and, for kernel
   enforcement, Tetragon. The container image `ghcr.io/effigent/effigentd` is ready today.
2. When a customer's organization has Effigent turned on, you pass their enrollment token to the
   sandbox as `EFFIGENT_ENROLL_TOKEN` (plus `EFFIGENT_HOSTNAME`, e.g. a sandbox or task id).
3. On start, effigentd enrolls with the customer's workspace, fetches their policy (signed with
   Ed25519, verified on the sandbox) and enforces it before the agent's first action
   (`effigentd run` starts the agent only once enforcement is confirmed).
4. Events and approval requests go to the customer's workspace. Your infrastructure never holds
   their policy keys, and the customer never needs access to your infrastructure.

**What leaves the sandbox:** action metadata (process, file path, destination address, the
rule that matched) and a redacted one-line summary for approvals. Not collected: file contents,
source code, model prompts or completions.

## What you do, what we do

| You | Effigent |
|---|---|
| Add effigentd (and Tetragon) to the sandbox image | Integration engineering with your team |
| A guest kernel with BTF and BPF LSM, or agent hooks only if you can't change the kernel | Sandbox-friendly machine identity (see below) |
| A per-organization setting where the customer pastes their token | Docs for your customers and, if you want, a joint announcement |

## Ready today, and what we'd build together

**Ready:** kernel enforcement on Linux (Tetragon, BPF LSM) for programs, files and network
addresses; hook enforcement and approvals for Claude Code, Codex and Gemini CLI; signed policy
that keeps working offline; enrollment from an environment variable; container image for amd64 and
arm64; Helm chart and Docker deployment for customer-run hosts.

**To build with you:** today each sandbox enrolls as one machine, which suits long-lived
sandboxes. For short-lived ones we would add pooled identities (one enrollment per customer and
pool, each sandbox a session under it) and automatic retirement when a sandbox ends. Agents
inside microVMs or gVisor need effigentd inside the guest, not on the host; we'd fit it to your
isolation model.

## Next step

A 30-minute technical call with the team that owns your sandbox image: we walk through the
integration on your isolation model and agree on a pilot with one of your enterprise customers.
