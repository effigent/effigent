# Effigent × Windmill

Run your Effigent approvals and alerts through [Windmill](https://www.windmill.dev/):
approve paused agent actions from **Slack or Microsoft Teams** buttons, add your own
routing (two approvers, on-call, tickets), and script Effigent from flows.

> **Approvals need a person.** Effigent accepts an approval only from someone it can identify:
> the console, the approval email's signed buttons, or the workspace's Effigent Slack app. An
> API key (and so this flow) can **deny** a request but its **approve** is refused
> (`403 not_a_person`): the name the flow reports for a button press is the flow's own claim,
> and the person who pressed it could be the requester. Use the flow to route and to relay
> denials; approve from the link it posts to the console.

```
agent pauses ──► Effigent ──webhook──► Windmill flow ──► Slack / Teams: Approve · Deny
                    ▲                                              │
                    └──────────── API key: decision ◄──────────────┘
```

## What's here

| File | What it does |
|---|---|
| `resource_type.effigent.json` | The `effigent` resource type: control plane URL + API key |
| `scripts/get_approval.ts` | Read one approval request |
| `scripts/decide_approval.ts` | Deny a request (with the approver's name and a note); approvals are refused for API keys |
| `scripts/list_pending_approvals.ts` | Requests waiting for a decision |
| `scripts/recent_blocked.ts` | Latest blocked agent actions (reports) |
| `scripts/revoke_endpoint.ts` | Revoke a machine |
| `scripts/verify_webhook.ts` | Verify `X-Effigent-Signature` (script, or HTTP-route preprocessor) |
| `flows/approval_via_slack.flow.json` | The approval flow: webhook → re-check → Slack/Teams → decision |

## Set up (about 10 minutes)

1. **Effigent API key** — console → Settings → Integrations → *Create key*, name
   `windmill`, scope **Deny approval requests**. Copy the `efk_…` key (shown once).
2. **Windmill resource** — create a folder `effigent`, add the resource type from
   `resource_type.effigent.json` (Resources → Add resource type), then a resource
   `f/effigent/workspace` with `base_url` `https://api.effigent.ai` and the key.
3. **Scripts** — create each file in `scripts/` as a Bun script at
   `f/effigent/<name>` (e.g. `f/effigent/decide_approval`).
4. **Flow** — Flows → New → Import JSON → `flows/approval_via_slack.flow.json`, save as
   `f/effigent/approval_via_slack`. In the **ask** step set either
   `slack_resource_path` (your Slack resource, e.g. `f/effigent/slack`) + `slack_channel`
   (channel ID), or `teams_team` + `teams_channel`. Windmill's Slack/Teams workspace
   connection must be set up (Workspace settings → Slack / Teams).
5. **Effigent webhook** — copy the flow's webhook URL (flow → Triggers → Webhooks, with a token
   created for this webhook). In Effigent: Settings → Integrations → *Add webhook*,
   paste the URL, events **Approval requested**. Press *Send test*.

Now a policy rule such as `command_approve: ["git push --force*"]` pauses the agent and
the request appears in your Slack channel. Pressing **Deny** denies it at once (the agent, the
console and the audit trail show `<approver> (via Windmill)`, the approver Windmill reports for
the button press). **Approve** is refused by Effigent (see above): open the request in the
console to approve it.

## How it stays safe

- The flow **re-reads the request from Effigent** before asking anyone and only acts
  on `pending` requests. A forged or replayed webhook can't approve anything: the
  decision is a separate API call, and Effigent only accepts it for a request that is
  really pending.
- The API key only needs the `approvals` scope; keys can never create keys or webhooks.
- One approval lets **one** action run once; a different command is a new request.
- Timeouts do nothing: the request expires in Effigent and the action stays blocked.
- Windmill's resume links are secrets — keep the approval channel private, and turn
  on *Require approvers to be logged in* in the ask step's suspend settings if your
  approvers have Windmill accounts.

## Webhook format

```http
POST <your URL>
Content-Type: application/json
X-Effigent-Event: approval.requested
X-Effigent-Delivery: evt_…
X-Effigent-Signature: t=1760600000,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>

{"id":"evt_…","type":"approval.requested","created_at":"…","tenant":"org:…",
 "data":{"approval":{"id":"apr_…","summary":"Bash: git push --force origin main",
   "reason":"…","agent":"claude-code","hostname":"…","os_user":"…","state":"pending",…},
   "review_url":"https://app.effigent.ai/approvals?id=apr_…"}}
```

Events: `approval.requested`, `approval.decided`, `action.blocked` (max 60/min per
webhook, the rest counted as dropped), `endpoint.enrolled`, `endpoint.revoked`,
`policy.published`, and `test`. Non-2xx answers are retried (10s, 1m, 5m, 30m, 2h, 6h);
4xx other than 408/429 are final. The secret (`whsec_…`) is shown once when you add the
webhook. To verify signatures in Windmill, use an **HTTP route** with *raw body* on and
`scripts/verify_webhook.ts` as its preprocessor, with the secret in the Windmill secret
variable `f/effigent/webhook_secret` (Windmill's plain flow webhooks don't expose the
raw body — the flow above doesn't need it, because it re-checks with Effigent).

## Tested

Against a local Windmill CE v1.837 and a local Effigent control plane: the flow imports,
an Effigent webhook starts it, it re-reads the request and waits, and an approval or a
denial (with a note) reaches the waiting agent as `approved` / `denied` by
`<approver> (via Windmill)`. The signature check was tested against Effigent's signer.
**Not tested:** the Slack and Teams buttons themselves (no Slack/Teams workspace was
connected) and the HTTP-route preprocessor inside Windmill.
