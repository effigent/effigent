# Partner outreach emails (drafts)

Short first emails, one per provider. Attach or link `agent-platforms.md`. Fill in the
brackets; check each provider's current product names before sending. The xAI email mentions
the 2026-10-18 test on a Grok bot's Linux sandbox; drop that sentence if it shouldn't be shared.

---

## xAI

**Subject:** Enterprise controls for Grok agents running in your sandboxes

Hi [name],

I run Effigent. We govern AI coding agents on the machines they run on: what they may execute,
read and connect to, enforced in the Linux kernel, with human approval for risky steps and an
audit trail the customer's security team owns. It works whatever model drives the agent; this
week we ran it on a Linux sandbox where a Grok-driven bot executes commands.

Where your agents run in your own cloud, your enterprise customers lose those controls at your
boundary. We'd like to change that with you: effigentd ships in your sandbox image, and each
customer turns it on with a token from their own Effigent workspace. Their policy, their
approvers, their audit, without access to your infrastructure.

Would 30 minutes with whoever owns your agent sandbox make sense in the next two weeks? One-page
overview attached.

[name]
[title], Effigent · [email]

---

## OpenAI (Codex cloud)

**Subject:** Customer-owned policy and approvals inside Codex cloud tasks

Hi [name],

I run Effigent. We govern Codex, Claude Code and Gemini CLI on a company's own machines:
policy enforced in the kernel and in Codex's PreToolUse hook, human approval for steps like
`git push`, and an audit trail the security team owns.

The next question from a security team is what happens when the same work runs as a Codex
cloud task. We'd like to answer it with you: effigentd in your task container, enabled per
organization with the customer's own enrollment token, so their existing policy, approvers and
audit apply inside your sandbox, and nothing about your infrastructure is exposed to them.

Could we take 30 minutes with the team behind the Codex cloud environment? One-page overview
attached.

[name]
[title], Effigent · [email]

---

## Cursor (background agents)

**Subject:** Letting security teams approve Cursor background agents

Hi [name],

I run Effigent, an agent control plane: a daemon on each machine that attributes every
process, file and network action to the agent that caused it, enforces the company's policy
(in the Linux kernel where available), and routes risky actions to a human approver.

Background agents run on your infrastructure, so a customer's security team can't put those
controls on them today, and that slows enterprise rollout. We'd like to fix that together:
effigentd in the background-agent VM image, turned on per team with a token from the customer's
Effigent workspace. Same policy as their laptops, their approvers, their audit trail.

Open to a 30-minute technical call? One-page overview attached.

[name]
[title], Effigent · [email]

---

## Anthropic (Claude Code on the web)

**Subject:** Customer-owned controls for Claude Code cloud sessions

Hi [name],

I run Effigent. We enforce a company's policy on Claude Code through its PreToolUse hook and,
on Linux, in the kernel, with approvals and an audit trail the security team owns.

When a session runs in your cloud environment instead of on their machine, those controls don't
follow it. We'd like to explore shipping effigentd in that environment, enabled per
organization with the customer's own token, so their policy, approvers and audit apply there
too.

Would a 30-minute call with the team behind the cloud environment be possible? One-page
overview attached.

[name]
[title], Effigent · [email]

---

## Google (Jules) · Cognition (Devin) · similar platforms

**Subject:** Enterprise policy, approvals and audit inside [product]'s sandboxes

Hi [name],

I run Effigent. We govern AI coding agents on the machines they run on: programs, files and
network enforced in the kernel, human approval for risky steps, and an audit trail the
customer's security team owns, whatever model drives the agent.

[Product] runs in your sandboxes, where enterprise customers can't apply those controls today.
We'd like to change that with you: effigentd in your sandbox image, turned on per organization
with the customer's own Effigent token.

Worth 30 minutes with your sandbox team? One-page overview attached.

[name]
[title], Effigent · [email]
