import type { ReactNode } from 'react';

/** The ⓘ explanations, in one place so the wording stays consistent. */
export const HELP: Record<string, ReactNode> = {
  // pages
  overview: <>The state of your workspace at a glance: machines reporting, what agents did recently, what was blocked and what is waiting for an approver.</>,
  graph: <>Who did what: machines → the agents on them → what each agent touched, grouped (commands, files, network, MCP servers…). Red means policy stopped it. Built from every problem in the period plus the newest activity.</>,
  audit: <><b>Agent events</b>: everything agents ran, opened and reached, with what policy did. <b>Console audit trail</b>: every change people made here. Both are tamper-evident and exportable.</>,
  policies: <>One policy per workspace says what agents may run, open and reach, and what needs an approver. Publishing creates a new signed version that every machine applies within seconds.</>,
  approvals: <>Actions your policy marks “needs approval” pause on the machine and wait here. Approving lets that exact action run <b>once</b>; anything different asks again.</>,
  machines: <>Every laptop and server running effigentd. A machine is <b>online</b> when it checked in during the last minute; <b>policy</b> shows which version it enforces.</>,
  team: <>Members come from your sign-in organization. Approver groups and routing rules decide <b>who</b> approves <b>which</b> requests; admins can always step in.</>,
  pricingLeaks: <>Seats and usage from your AI vendors’ admin APIs (Cursor, Anthropic, GitHub Copilot, OpenAI) or their CSV exports, joined per person with the agents effigentd sees on each machine. Savings are per month, from the vendor’s prices where it reports them and the price table otherwise.</>,
  leaks: <><b>Unused seat</b>: paid, no use in 30 days (14-day grace for new seats). <b>Duplicate tool</b>: one tool used daily, a paid other barely. <b>Shadow spend</b>: an agent on a machine whose person isn’t on that vendor’s company plan. <b>Runaway cost</b>: over 3× the team median, or a day 5× the week before.</>,
  connectors: <>Keys are sealed with AES-256-GCM under the control plane’s secrets key and only used to read seats, usage and cost. Syncs pull the last 30 days, once a day and on demand. A CSV import fills in where a vendor has no API or you’d rather not share a key; API data wins where both exist.</>,
  spendPeople: <>Vendors know people by email (Copilot by GitHub login); effigentd knows machines. A machine maps to its owner, else a hostname alias, else its only OS user alias. Unmatched accounts stay as <code>github:login</code> or <code>host:name</code> and are listed so you can add an alias.</>,
  spendPrices: <>Seat prices apply when the vendor doesn’t report a price (Cursor and Copilot don’t in their APIs). <code>copilot/business</code> and <code>copilot/enterprise</code> override Copilot by plan. Personal plan prices estimate what shadow spend costs someone off the company plan.</>,
  settings: <>Where approval requests are sent, API keys and webhooks for your other tools, and workspace options.</>,

  // overview
  recentActivity: <>The latest agent actions across all machines. Open Activity &amp; Audit to search everything.</>,
  liveEvents: <>Events as effigentd reports them, about every two seconds.</>,
  waiting: <>Requests paused on a machine until an approver decides. They expire after the policy’s <code>ttl_minutes</code>.</>,
  endpointPolicy: <>The live policy version and its default mode: <b>monitor</b> only reports, <b>denylist</b> blocks what is listed, <b>allowlist</b> blocks everything not listed.</>,

  // activity & audit
  agentEvents: <>Read from the server a page at a time for the chosen period (up to 90 days). <b>Result</b> is what policy did; <b>What happened</b> is what the agent touched. Older events are in the archive below.</>,
  routine: <>Read-only housekeeping (ls, cat, grep, git status…) is hidden by default so the risky actions stand out. Anything policy stopped is never hidden.</>,
  evidence: <>Each batch of events a machine sends is chained to the one before it. <b>Verify events</b> recomputes the chains and names any event that was edited, removed or inserted. After 90 days events move to a locked S3 archive, one file per day, kept for a year.</>,
  consoleTrail: <>Every change made in this console — and every refused attempt — with who, when and from where. Each entry commits to the one before it, so <b>Verify chain</b> detects edits or deletions.</>,

  // policies
  askAi: <>Describe a change in plain words; the assistant proposes a full policy, checked with effigentd’s own parser. Nothing is published until you review it and press Publish.</>,
  editor: <>While you are only viewing, the editor shows the live policy. As soon as you change something, the live version appears on the left and your edit on the right, like a code review.</>,
  exceptions: <>Allow something the company policy blocks, for specific machines and optionally one agent, for a while or for good. Each change publishes a new policy version.</>,
  versions: <>Every published version is kept. Compare any two, see what a version changed, or restore an old one as your edit (then publish it).</>,

  // approvals
  approveOnce: <>The approval binds to a fingerprint of this exact action (command, files, session, user). It runs once; a retry of anything else asks again.</>,
  decidedBy: <>Routing rules in Team &amp; Approvers decide which group gets each request. Only that group is emailed and can decide; admins can step in, recorded as an override.</>,

  // machines
  enroll: <>Create a token, then run one command on the machine. The token is single-use (or limited) and expires; the machine gets its own secret and only ever accepts policies signed for it.</>,
  coverage: <>How strongly each machine can stop an agent: on Linux the <b>kernel</b> blocks (Tetragon); on macOS and Windows the agents’ <b>hooks</b> block before a tool runs.</>,
  endpoints: <>Each machine checks in every few seconds. If the control plane is unreachable, it keeps enforcing its last policy and keeps events on disk until it is back.</>,

  // team
  members: <>People in your organization. Invite and change roles in the organization settings. Admins and security admins change policy; members are read-only unless an approver group includes them.</>,
  groups: <>A set of members who decide one kind of request — e.g. Security (the CISO) or DevOps. Members get the email and can approve from it or from the console.</>,
  rules: <>Checked top to bottom; the first match wins. Match on the kind of request, text in the action (case-insensitive, <code>*</code> as a wildcard), machines or agent. Anything unmatched goes to the default.</>,
  tryIt: <>Uses the control plane’s own matcher on the rules above, including unsaved edits.</>,

  // settings
  notifications: <>Who is told when an agent pauses for approval. Each email carries Approve / Deny buttons signed for that person and that request.</>,
  integrations: <><b>API keys</b> let your scripts and automations read and act (each key has scopes). <b>Webhooks</b> push events to your systems, signed so the receiver can check they came from Effigent.</>,
};
