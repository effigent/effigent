# Rolling Effigent out to employees: privacy and works-council guidance

> **Not legal advice. Requires review by qualified counsel in each jurisdiction before it is
> given to a customer.** This is a starting point for the customer's own DPO, HR and legal
> team. The legal sections cite their sources. Items marked *[secondary]* rest on law-firm or
> IAPP summaries, not the primary text. Sources were read on 2026-10-21.

Covers vendor checklist item 26.

**Who does what.** The customer decides to deploy Effigent on its employees' machines and
decides what for, so the customer is the controller (Israel: the database controller).
Effigent processes the data on the customer's behalf as processor. See `dpa-template.md`.

## 1. What Effigent collects (from the code at f9a7774)

Effigent records what **AI coding agents** do on a machine: Claude Code, Codex, Gemini CLI,
Cursor and others. It records nothing about what a person does outside an agent. Two layers do
the collecting.

### 1.1 Sent to Effigent's control plane

| Data | When | Detail |
|---|---|---|
| **Tool calls an agent makes** (hooks: Claude Code, Codex, Gemini CLI, Cursor) | Every call | Tool name plus **one** telling field: the shell command, file path, URL, search pattern or web-search query, cut to 300 characters (`hooks.Summary`). For Read/Write/Edit it is the **path only**, never the file's content. Cursor's hook payload carries the file being read; effigentd drops it before processing (`hooks.CursorSlim`) |
| **Actions read from a call** | When a command does something classified (§2e of the engineering guide) | Kind plus target, cut to 200 characters: pushed branch, package name, cloud operation and profile/account, database host, and **SQL statements** found in the command or in a `.sql`/script file it runs |
| **Programs run inside an agent's process tree** (Linux, kernel layer) | Every exec in the tree | Binary path, full command line (redacted), working directory, uid |
| **Sensitive files opened by an agent** | Only the paths on the policy's alert/deny lists, e.g. `.env`, SSH keys, cloud credentials | Path only |
| **Outbound connections by an agent** (Linux) | Each TCP connect | Destination IP and port |
| **Blocks, would-blocks, approval requests** | When a rule matches | Rule name, reason. For approvals, a one-line summary. For MCP tools without a single telling field, up to **800 characters of the tool's arguments as JSON**, so an issue or PR body can appear |
| **Who and where** | On each event | `node` (hostname), `os_user`, `git_email` (read from the repo's or user's git config files), agent `session_id`, `model` if the agent reports it, `transcript_path` (**the path of the agent's transcript file only; its content is never read**: `hooks/meta.go`, `event.go`) |
| **Agent environment** | First event of a hook session | Cloud profile and project names, DB host names, model and registry URLs (credentials stripped), git-hook switches. API keys appear only as `"set"`, never their values (`hooks/env.go`) |
| **Machine record** | Enrollment and heartbeat | Hostname, OS, architecture, effigentd version, policy version, hook installation state per agent. For Gemini CLI this includes the **OS user names that turned the hook off** in their own settings |
| **Daemon stop** | When effigentd stops | How it was stopped. For a stop from a terminal, the OS user who ran it |
| **Cowork VMs** (macOS) | When one starts or stops | That a Claude desktop VM is running (agent `claude-cowork`, "not under policy") |

### 1.2 Kept in the control plane from other sources

- **Console users:** name, email, organisation role. These are held by Clerk; approver-group
  members' Clerk ids and emails are copied into Effigent's database.
- **Audit trail:** every console change and refused attempt, with actor, role, IP and details.
- **Approval decisions:** who decided, with a note. Via Slack, if a workspace has it on:
  `slack:<team>:<user>`, the Slack name and email.
- **Pricing Leaks**, only if an admin connects a vendor or uploads a CSV:
  - per-person seats: email or GitHub login, name, plan, assigned and last-active dates;
  - per-person daily cost, requests and tokens, from Cursor, Anthropic, GitHub Copilot or OpenAI;
  - a People directory mapping OS users, git emails and hostnames to a work email.

  The result shows, for example, "unused seat" or "runaway cost" **per named person**. That is
  an evaluation of individuals (see §4).

### 1.3 Not collected

- Keystrokes or keyboard/mouse activity.
- Screen contents or screenshots, camera, microphone.
- Browsing history outside what an agent fetches.
- Email.
- Location.
- **File contents and source code.** The exceptions are SQL statements in scripts the agent runs
  (≤200 characters each) and whatever text is written inline in a shell command, such as a
  heredoc.
- **Model prompts and responses**, and transcript contents.
- Activity of processes that aren't part of an agent's tree.

Commands are recorded as the agent ran them, after redaction, so anything an agent puts on a
command line is recorded.

### 1.4 Stays on the machine (not sent to Effigent)

- **effigentd's local event log** (`/var/log/effigent/events.jsonl`, macOS
  `/Library/Logs/Effigent/events.jsonl`). The same events as above. Readable by root.
- **Tetragon's own event log** on Linux (`/var/log/tetragon/`). With Tetragon's default
  export settings this covers process starts across the **whole host**, not only agents.
  Effigent doesn't read or ship that file, but it exists on the employee's machine. The
  customer should set its rotation and retention, or turn the export off. *(Check Tetragon's
  export configuration on your build; we haven't audited its defaults for this document.)*

### 1.5 Who can see it

Every member of the customer's Effigent workspace can read all events and download archived
days, **including the read-only role**. There is no per-team or per-person view restriction
today. Approvers see the approval summaries routed to them. Keep workspace membership to the
people who need it.

## 2. Masking and minimisation that exist today

- **Secret redaction, always on, on the machine before anything leaves it:**
  - the gitleaks rule set;
  - `NAME_TOKEN=…` style assignments;
  - `--password` / `--token` flags;
  - `mysql -p…`;
  - `user:pass@` in URLs;
  - bearer tokens;
  - private-key blocks.
- **Workspace masks in the policy (`redact:`):**
  - `patterns:` takes up to 50 RE2 expressions, e.g. customer ids or internal hostnames.
  - `pii: true` masks email addresses, phone numbers, card numbers and IBANs.

  They apply to commands, paths, messages, action targets, approval summaries and reasons.
- **What masking does not cover:** the identity fields themselves (`os_user`, `git_email`,
  hostname, working directory, agent environment names). Those are what attribution needs.
  Leaving them out would take a code change; no option exists today.
- **Scope by agent:**
  - The policy lists which agents are tracked (`agents:`).
  - Orphan MCP server tracking can be turned off (`track_orphan_mcp`).
  - Hooks are installed per agent (`install-hooks --agents …`).
- **Retention:**
  - Online retention per workspace runs from 90 to 3650 days. **90 days is the minimum.**
  - After that, events are archived to S3 for a year under Object Lock, then deleted.
  - A legal hold stops deletion. Set the shortest period that meets the purpose.
- **Pricing Leaks is off unless connected.** Don't connect vendor keys or import CSVs if
  per-person spend analysis isn't part of the purpose.
- **What can't be turned down today:**
  - Every event is sent to the control plane. effigentd's `-backend-min-severity` filter
    applies only to an extra backend, not to the control plane.
  - Not sending `git_email` is not an option.

  These are product gaps. Raise them if they matter for your DPIA.

## 3. Transparency notice for employees (template)

Adapt it, translate it where needed, and have counsel review it. Placeholders are in
⟨angle brackets⟩.

> **Monitoring of AI coding agents on company devices**
>
> ⟨Company⟩ uses Effigent to supervise the AI coding assistants (such as Claude Code, Codex,
> Gemini CLI and Cursor) that run on ⟨company-managed developer machines / these devices⟩.
>
> **Why.** To stop AI agents from taking harmful actions: leaking credentials, deleting data,
> pushing to protected branches, installing malicious packages, or reaching systems they
> shouldn't. Also to give approvers the chance to allow risky actions, and to keep an audit
> record of what agents did. ⟨If used: to find unused or duplicate AI-tool licences.⟩
> **It is not used to measure your performance** ⟨or state the actual purposes⟩.
>
> **What is recorded.** When an AI agent runs a command, opens or edits a file, fetches a URL
> or calls a tool, Effigent records:
> - the action: the command text, the file path (not its contents), the address;
> - which rule applied, and whether it was allowed, blocked or sent for approval;
> - the device name, your operating-system user name and the git email configured on the
>   device.
>
> Secrets on command lines are masked before anything leaves the device ⟨and email addresses,
> phone and card numbers are masked too⟩.
>
> **What is not recorded.** Your keystrokes, screen, camera, microphone, email, browsing
> outside the agent, location, the contents of your files, and your conversations with the
> AI assistant.
>
> **Who can see it.** ⟨The security team and named engineering managers⟩ in ⟨Company⟩'s
> Effigent workspace. Approvers see only the requests sent to them. Effigent (our supplier)
> hosts the data in the United States (AWS us-east-1) under a data processing agreement.
>
> **How long.** ⟨N⟩ days online, then an archive for one year, then deletion, unless a legal
> hold applies.
>
> **Your rights.** You can ask for access to, or correction of, data about you, and object
> where the law allows, at ⟨contact / DPO⟩. ⟨EU: you can complain to ⟨supervisory
> authority⟩. Israel: to the Privacy Protection Authority.⟩
>
> **Working hours and personal use.** Monitoring applies only to AI agents on ⟨company
> devices⟩. ⟨State the rule on personal projects on these devices, and on use outside working
> hours.⟩

## 4. EU: legal basis, DPIA, works councils

**Legal basis.**
- Consent is generally unsuitable at work. WP29 Opinion 2/2017 on data processing at work
  ([WP249](https://ec.europa.eu/newsroom/article29/redirection/document/45631), 8 June 2017,
  p. 3) says consent is "highly unlikely to be a legal basis for data processing at work,
  unless employees can refuse without adverse consequence".
- The usual basis is **legitimate interest**, Art. 6(1)(f) GDPR
  ([GDPR](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)): the employer's interest in the
  security of its systems and code, balanced against employees' rights.
- WP249 requires that the processing be "strictly necessary for a legitimate purpose", and
  that a proportionality test be done "prior to the deployment of any monitoring tool"
  (§6.2). It says "prevention should be given much more weight than detection".
- Effigent's design fits that. It blocks actions on the machine and logs agent actions, not
  people's activity in general. Record the balancing test in writing anyway.
- WP249 predates the GDPR and is **not** on the EDPB's list of endorsed WP29 guidelines. It is
  still the usual reference.

**National rules, Art. 88 GDPR.**
- Member States may set more specific rules for employee data, including on "monitoring
  systems at the work place" (Art. 88(2)).
- In C-34/21 (30 March 2023) the CJEU held that national rules not meeting Art. 88(2) must be
  disregarded. In Germany this is read as weakening § 26 BDSG, which leaves Art. 6(1)(f) and
  works agreements *[secondary]*.

**DPIA (Art. 35).**
- The EDPB-endorsed DPIA guidelines
  ([WP248 rev.01](https://ec.europa.eu/newsroom/just/document.cfm?doc_id=47711)) list
  "systematic monitoring" and "vulnerable data subjects", employees included, as criteria. Two
  criteria usually mean a DPIA is needed.
- Their own example is "a company systematically monitoring its employees' activities,
  including the monitoring of the employees' work station, internet activity". **Plan on a
  DPIA.**
- Art. 35(9) asks the controller to seek the views of data subjects or their representatives
  where appropriate.
- Pricing Leaks' per-person cost findings add an evaluation element. Include them in the DPIA
  if used.

**Works councils.**
- **Germany:** § 87(1) no. 6 BetrVG
  ([text](https://www.gesetze-im-internet.de/betrvg/__87.html)) gives the works council
  co-determination over technical devices "dazu bestimmt … das Verhalten oder die Leistung der
  Arbeitnehmer zu überwachen". The BAG holds that being **objectively suitable** is enough;
  the employer's intent doesn't matter (BAG 13.12.2016, 1 ABR 7/15) *[secondary reproduction]*.
- A tool that records commands attributed to an OS user and git email is objectively suitable.
  **Expect co-determination. Conclude a works agreement (Betriebsvereinbarung) before rollout**,
  covering:
  - purposes;
  - what is recorded;
  - who has access;
  - retention;
  - a ban on performance evaluation;
  - how evidence may be used.
- **France:** the CSE must be informed and consulted before tools that allow monitoring of
  employees' activity are introduced (Code du travail
  [L2312-38](https://code.travail.gouv.fr/code-du-travail/l2312-38)). No personal data may be
  collected by a device employees weren't told about beforehand
  ([L1222-4](https://code.travail.gouv.fr/code-du-travail/l1222-4)).
- **Netherlands:** the works council's **consent** is required for arrangements "gericht op of
  geschikt voor" observing or checking employees' presence, behaviour or performance (WOR art.
  27(1)(l), [text](https://wetten.overheid.nl/BWBR0002747/)).
- **Elsewhere:** check local co-determination and notice rules before rollout.

## 5. Israel

- **Law.** Protection of Privacy Law 5741-1981, as amended by **Amendment 13** (in force 14
  August 2025)
  ([PPA English translation, unofficial](https://www.gov.il/BlobFolder/legalinfo/legislation/en/Protection-of-Privacy-Law57411981unofficialtranslatioup.pdf)).
  Amendment 13 broadened the definitions, gave the Privacy Protection Authority (PPA) monetary
  sanctions (s. 23KF), and added a **DPO duty** (s. 17B1(a)(3)). That duty covers a controller
  **or processor** whose core activities involve "regular and systematic monitoring of
  individuals … on a significant scale".
  - The PPA's opinion on DPO appointment (14 July 2026,
    [link](https://www.gov.il/BlobFolder/legalinfo/amendment-13-26-07-26/he/media_06-07-26.pdf))
    reads this as covering activities that actually involve such monitoring, even when that
    isn't their purpose.
  - Customers should assess whether they need a DPO. Effigent must assess the same for itself
    as processor (open item).
- **Workplace monitoring case law.** Labor Appeal (National) 90/08, *Isakov Inbar v. State of
  Israel – Commissioner for Women's Work Law* (8 Feb 2011). The principles as the PPA restates
  them are good faith, disclosure, transparency, legitimacy, proportionality and purpose
  limitation. The court also required:
  - a clear written policy, given to employees and part of the employment terms;
  - the least invasive means;
  - no secondary use;
  - informed consent;
  - specific consent before private content is inspected.

  It distinguished professional, mixed and private mailboxes *[secondary: Meitar, IAPP
  summaries]*.
- **PPA guidance on monitoring remote workers**, updated after Amendment 13 (11 Jan 2026,
  Hebrew, [link](https://www.gov.il/BlobFolder/policy/remotework/he/remoteWorking_new.pdf)):
  - Monitoring must be reasonable and proportionate, have a legitimate purpose tied to the
    workplace, and come with notice.
  - The PPA singles out browsing and email-content monitoring, webcam and microphone control,
    keyloggers, screenshots and continuous monitoring of device activity as especially
    intrusive. These are allowed only exceptionally, with specific written notice and explicit
    consent.
  - Consent can't cure disproportionate monitoring.
  - No monitoring outside working hours.
  - Retention reviewed at least yearly.
  - **For Effigent:** describe it accurately as **supervision of AI agents' actions, not of the
    employee**. Effigent collects none of the listed high-harm categories. Still, logging every
    agent command on a developer's machine is close enough to "continuous device activity"
    monitoring that a written policy, specific notice and documented proportionality are the
    safe course.
- **Data security.** The Privacy Protection (Data Security) Regulations 5777-2017
  ([translation](https://www.gov.il/BlobFolder/legalinfo/data_security_regulation/en/5777%E2%80%932017.pdf))
  require, among other things:
  - a security level for the database;
  - documenting incidents and notifying the PPA immediately of a **severe** incident
    (Reg. 11);
  - contract terms with an outsourced processor (Reg. 15).

  The DPA template covers Reg. 15.

## 6. Rollout checklist for the customer

1. **Purposes.** Write them down: agent safety, approvals, audit; spend only if Pricing Leaks
   is used. Decide that Effigent data won't be used for performance evaluation, or say plainly
   if it will.
2. **Legal basis.** Legitimate-interest assessment (EU), or the Israeli proportionality
   analysis.
3. **DPIA** (EU), and the DPO question (Israel).
4. **Works council or employee representatives.** Consultation, consent or a works agreement
   where required. Do this **before** installing on employee machines.
5. **Notice.** The §3 notice, delivered in writing and kept accessible. In Israel, attach it to
   or reference it in the employment policy.
6. **Configuration:**
   - `redact.pii: true` if emails or phone numbers may appear on command lines;
   - `redact.patterns` for customer identifiers;
   - the shortest retention that meets the purposes;
   - workspace membership limited to the people who need it (§1.5);
   - Pricing Leaks off unless needed.
7. **Local logs.** Decide retention for the local effigentd and Tetragon logs on Linux
   machines.
8. **DPA signed with Effigent; sub-processor list reviewed.**
9. **Yearly review** of retention, access and purposes.
