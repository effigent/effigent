# Data Processing Agreement: template

> **DRAFT. Requires legal review. Not for signature.** This was put together by engineering
> from the code and deploy setup at commit f9a7774 (2026-10-21). It is meant to give counsel
> accurate facts, not finished contract wording.
>
> Before use:
> - Counsel must review every clause, especially §§4, 8, 9, 11, 12 and the annexes.
> - Fill in the ⟨placeholders⟩.
> - Resolve the **open items** in Annex 4.
>
> Legal sources were read on 2026-10-21 and are listed in Annex 5.

Structure: GDPR Art. 28(3)(a)–(h). The Israeli Privacy Protection (Data Security) Regulations
5777-2017, Reg. 15 (outsourcing), are mapped in Annex 3. Covers vendor checklist item 26.

---

## Parties

- **Customer** (controller; under Israeli law, the "database controller"): ⟨legal name,
  address, registration no.⟩.
- **Effigent** (processor; under Israeli law, the "external service provider" / "processor"):
  ⟨Effigent legal entity, address, Israel⟩.

This DPA forms part of the ⟨Terms of Service / Master Agreement⟩ (the "Agreement"). If the two
conflict, this DPA prevails on the processing of personal data.

## 1. Definitions

Terms such as *personal data*, *processing*, *controller*, *processor*, *data subject* and
*personal data breach* have the meanings in the GDPR (Regulation (EU) 2016/679) and the UK
GDPR. For Israel, they have the meanings in the Protection of Privacy Law 5741-1981 as amended
by Amendment 13 ("PPL"), and in its regulations. "Service" means Effigent's agent control
plane: the endpoint software `effigentd`, the hosted control plane and the web console.

## 2. Subject matter, duration, nature and purpose (Art. 28(3) opening paragraph)

- **Subject matter:** providing the Service. It detects AI coding agents on the Customer's
  machines, applies the Customer's policies on those machines, routes approval requests, and
  stores the resulting events and audit records. Optionally it analyses AI-tool spend
  ("Pricing Leaks").
- **Duration:** the term of the Agreement, plus the retention and deletion periods in §9.
- **Nature:** collection (by `effigentd` on the Customer's machines), transmission, storage,
  indexing and search, display, archiving, deletion, and sending approval notifications.
- **Purpose:** for the Customer to secure and govern the use of AI agents and to keep an audit
  record. If the Customer turns it on, also to find unused, duplicate or excessive AI-tool
  spend. Effigent does not process Customer personal data for its own purposes, and does not
  use it to train models.
- **Data categories and data subjects:** Annex 1.

## 3. Instructions (Art. 28(3)(a))

Effigent processes Customer personal data only on the Customer's documented instructions. That
includes transfers to third countries (§11). The instructions are:
- this DPA and the Agreement;
- the Customer's configuration of the Service: policies, retention, legal hold, integrations;
- written instructions agreed later.

If the law requires otherwise, Effigent will tell the Customer first, unless that law forbids
it. Effigent will tell the Customer immediately if, in its opinion, an instruction infringes
data protection law.

## 4. Confidentiality (Art. 28(3)(b); Reg. 15(f))

Effigent ensures that everyone authorised to process Customer personal data has committed to
confidentiality or is under a statutory duty of it. Production access is limited to named
personnel (Annex 4, open item O7).

## 5. Security (Art. 28(3)(c), Art. 32)

Effigent implements the measures in Annex 2 and in
`docs/security/architecture-and-data-flow.md` §4. It may update them, but not in a way that
lowers the overall level of protection.

## 6. Sub-processors (Art. 28(2), (3)(d), (4))

- **Authorisation.** The Customer gives general authorisation for the sub-processors in
  Annex 3.
- **Changes.** Effigent will give at least ⟨30⟩ days' notice of a new or replacement
  sub-processor ⟨by email to the Customer's notification address / on a published page⟩. The
  Customer may object on reasonable data-protection grounds. If the parties can't resolve the
  objection, the Customer may terminate the affected Service.
- **Flow-down.** Effigent puts data-protection obligations on each sub-processor that are no
  less protective than this DPA. Effigent remains liable for its sub-processors.

## 7. Data subject requests (Art. 28(3)(e))

Effigent helps the Customer answer data subjects' requests to the extent the Service allows.
What exists today:
- **Access and portability.** The console and API search events by any recorded field,
  including OS user, git email and hostname (`GET /api/v1/events?q=…`), and export them as
  JSON. Archived days can be downloaded as JSON lines.
- **Erasure and rectification.** Agent events are stored **append-only and hash-chained**, so
  the audit record can be verified. The Service has **no function to delete or edit one
  person's events** before the retention period ends.
  - What is possible: shorter retention for the workspace (minimum 90 days), and masking at the
    source through the policy's `redact:` patterns, which applies to new events only.
  - Erasure beyond that is a manual operation by Effigent and would break the integrity chain
    for that period. *(Counsel: decide whether to rely on Art. 17(3)(b)/(e), or on the
    Customer's own legal-hold and audit obligations, and how to word this.)*
- **Requests sent to Effigent.** Effigent forwards to the Customer, without undue delay, any
  request it receives from a data subject about Customer data. It does not answer the request
  itself unless the Customer instructs it to.

## 8. Assistance with Arts. 32–36 (Art. 28(3)(f))

Effigent gives the Customer the information it reasonably needs for its own security, breach
notification, DPIA and prior consultation obligations. That includes this DPA's annexes,
`architecture-and-data-flow.md` and `employee-monitoring.md`.

## 9. Return and deletion (Art. 28(3)(g); Reg. 15(d))

- **Retention during the term:**
  - Agent events stay online for the workspace's retention period: 90 days minimum, up to 3650,
    or the control-plane default if none is set.
  - They are then written to an archive in Amazon S3 and deleted from the database in the same
    step, after the upload has been checked.
  - Archives are under **S3 Object Lock, governance mode, for 365 days**, and a lifecycle rule
    deletes them after one year.
  - A **legal hold** set by the Customer suspends deletion in the database and places an Object
    Lock legal hold on the archive objects until the Customer releases it. *(Legal hold has unit
    and database tests only; it hasn't yet run against the production bucket.)*
- **Kept for the life of the workspace:** approval records, the console audit trail, policies
  and machine records.
- **At the end of the Agreement**, at the Customer's choice, Effigent will return the Customer
  personal data (JSON export of events, audit trail, approvals and configuration), or delete it
  within ⟨30⟩ days. Two exceptions:
  - archive objects still under Object Lock are deleted when their lock expires (at most 365
    days), unless Effigent overrides governance mode;
  - data under a legal hold the Customer hasn't released.
- **The Customer's machines.** effigentd's local state and logs stay on them until the Customer
  uninstalls the software: `/var/lib/effigent`, `/var/log/effigent`, Tetragon's own log on
  Linux, and `/Library/…/Effigent` on macOS.
- **Built so far:** workspace-level deletion is a manual procedure. No self-service "delete
  workspace" exists yet (Annex 4, O4).

## 10. Audits and information (Art. 28(3)(h); Reg. 15(h))

- **Information.** Effigent makes available the information needed to show compliance with
  this DPA. It answers security questionnaires (SIG Lite, CAIQ or the Customer's own) and
  reports on its compliance with this DPA at least once a year.
- **SOC 2.** Effigent has **no SOC 2 report yet** (see `soc2-plan.md`). Until it has one, the
  Customer may audit, or have an independent auditor bound by confidentiality do so, once a
  year with ⟨30⟩ days' notice, at the Customer's cost. Extra audits are allowed after a
  personal data breach or when a regulator requires one.

## 11. International transfers

- **Where the data is.** Customer personal data is hosted in the **United States**:
  - AWS us-east-1;
  - the database provider in the US (Annex 4, O1);
  - Clerk and Vercel, whose regions are to be confirmed.

  Effigent personnel access it from **Israel**.
- **EU/EEA customers:**
  - *EU → Effigent (Israel).* Israel has an EU adequacy decision (Decision 2011/61/EU). The
    Commission's first review (COM(2024) 7, 15 January 2024) concluded that Israel continues to
    provide an adequate level of protection.
  - *Onward to the US.* Each US sub-processor is relied on under the **EU-U.S. Data Privacy
    Framework** where it is certified. Implementing Decision (EU) 2023/1795 covers only
    organisations on the DPF List; AWS states it is certified. Otherwise the 2021 Standard
    Contractual Clauses apply (Decision (EU) 2021/914): **Module 3** (processor to processor)
    between Effigent and the sub-processor, with a transfer impact assessment (Clause 14).
  - *If the Customer requires it,* the parties sign the 2021 SCCs, **Module 2** (controller to
    processor), incorporated by reference. Options:
    - Clause 7 (docking): ⟨included⟩.
    - Clause 9: Option 2, general authorisation, ⟨30⟩ days' notice.
    - Clause 11: ⟨optional redress clause not used⟩.
    - Clause 17: ⟨law of Ireland / the Customer's Member State⟩.
    - Clause 18: ⟨courts of the same⟩.
    - Annexes I–III: Annexes 1–3 of this DPA.

    *(Counsel: the SCCs are meant for importers not subject to the GDPR (Art. 1(1) and recital 7
    of 2021/914). Confirm that Module 2 fits an Israeli processor working under an adequacy
    decision, or rely on adequacy plus Art. 28 terms alone.)*
  - **DPF risk (2026).** The General Court upheld the DPF in *Latombe* (T-553/23, 3 September
    2025). An appeal is pending (C-703/25 P). After the US Supreme Court's *Trump v. Slaughter*
    (29 June 2026), the EDPB asked the Commission (letter of 31 July 2026) to assess whether the
    DPF still works. Keep SCCs as a fallback with every US sub-processor.
- **UK customers:** the UK IDTA or the UK Addendum to the EU SCCs ⟨counsel⟩.
- **Israeli customers:**
  - Transfers abroad must meet the Privacy Protection (Transfer of Data to Databases Abroad)
    Regulations 5761-2001. That includes Reg. 2(4) (a contract binding the recipient to
    Israeli-equivalent conditions) and Reg. 3 (a written undertaking by the recipient).
  - Effigent's sub-processor terms are to include that undertaking. Onward transfers need the
    Customer's consent, which §6 provides.
- **Data received from the EEA** is also handled under the Privacy Protection Regulations
  (Instructions for Data Transferred to Israel from the EEA) 5783-2023: deletion on request,
  a retention mechanism, accuracy, and the duty to inform.

## 12. Personal data breach

- **When Effigent notifies.** Effigent notifies the Customer of a personal data breach
  affecting Customer data **without undue delay, and in any case within ⟨48⟩ hours** of
  becoming aware of it. *(Business decision. Art. 33(2) GDPR says only "without undue delay";
  the controller then has 72 hours.)*
- **What the notice contains**, as far as known (Art. 33(3)):
  - the nature of the breach;
  - the categories and approximate number of data subjects and records;
  - likely consequences;
  - measures taken or proposed;
  - a contact point.

  Effigent then updates the Customer as it learns more.
- **Israel.** Effigent also reports security incidents to the Customer so it can meet Reg. 11
  of the Data Security Regulations: documenting incidents, and immediately notifying the PPA of
  a severe incident. Effigent keeps its own incident records (Reg. 11(a)).
- **Fault.** A notice is not an admission of fault.
- **Status:** an incident-response runbook is being written (`soc2-plan.md`, I1).

## 13. Liability, governing law

⟨As in the Agreement. Governing law and courts: ⟨Israel / Customer's jurisdiction⟩.⟩
*(Counsel.)*

---

## Annex 1: Categories of data and data subjects

**Data subjects:**
- the Customer's employees and contractors whose machines run effigentd;
- the Customer's console users and approvers;
- the Customer's AI-tool seat holders, if Pricing Leaks is connected;
- third parties whose data appears incidentally in commands an agent runs, such as an email
  address in a command line.

**Categories.** All are sent by effigentd over TLS or entered in the console. Detail:
`employee-monitoring.md` §1.

| Category | Fields | Source |
|---|---|---|
| Agent events | Time, event type, agent, mode, rule, outcome. Tool call summary (command / path / URL / pattern / query, ≤300 chars). Actions (kind and target ≤200 chars, e.g. branch, package, cloud profile/account, DB host, SQL statement). On Linux: binary, command line, working directory, uid, opened sensitive-file paths, destination IP:port. Message | effigentd |
| Identity attached to events | Hostname (`node`), OS user, git `user.email`, agent session id, model name, transcript **file path** | effigentd |
| Agent environment | Names of cloud profiles/projects/subscriptions, DB hosts, model API base URLs, package registries (credentials stripped); whether certain API keys are set (never their value) | effigentd (hook process) |
| Approval requests | Redacted summary (MCP tools: up to 800 chars of arguments), reason, working directory, OS user, fingerprint; decision, approver id and name, note | effigentd, approvers |
| Machine records | Hostname, OS, arch, version, owner, teams, policy version, hook state per agent (incl. OS users who disabled a hook), last seen | effigentd, admins |
| Console users | Clerk user id, name, email, organisation role. Approver-group members' ids and emails. Audit-trail actor, role, IP address | Clerk, console |
| Slack approvals (only if enabled) | Slack team/user id, name, email | Slack |
| Pricing Leaks (only if connected) | Seat holder email or GitHub login, name, plan, assigned and last-activity dates; per-person daily cost, requests, tokens. People directory (work email ↔ OS user, git email, hostname, GitHub login) | The Customer's vendor accounts via the Customer's admin keys, CSV uploads, admins |

**Redaction before data leaves the machine:** gitleaks rules, command-line secret rules and
the Customer's `redact:` masks (optional PII masks for email, phone, card, IBAN).

**Not collected:** file contents, source code (except SQL statements and inline command text as
above), model prompts or responses, transcript contents, keystrokes, screen contents.

**Special categories (Art. 9 GDPR / "data of special sensitivity" under the PPL):** none
intended. They may appear incidentally in command text. Pricing Leaks' per-person findings
should be assessed under PPL s. 3 category (8), "ability to function at work", if used to
evaluate people *(counsel)*.

## Annex 2: Technical and organisational measures (summary)

- **Encryption.**
  - In transit: TLS on every connection.
  - At rest: the database is encrypted by its provider; the S3 archive uses SSE-S3.
  - Integration secrets (e.g. Slack tokens, vendor admin keys) are sealed with AES-256-GCM,
    bound to the workspace, and never returned by the API.
- **Integrity.**
  - Ed25519-signed policies, verified on each machine.
  - Append-only, hash-chained events (per machine) and audit trail (per workspace), verifiable
    from the console.
  - S3 Object Lock and versioning.
- **Access control.**
  - Console sign-in through Clerk (SSO available, see `sso-scim.md`).
  - Roles admin / security_admin / read-only.
  - Scoped API keys stored as hashes; enrollment tokens and machine secrets stored as hashes.
  - Every refused attempt is audited.
- **Tenant isolation.** Every record and query is scoped to the workspace. Machine credentials
  and policies are bound to one workspace and one machine.
- **Minimisation.** Redaction on the machine. Retention configurable from 90 days. Data
  collected only for AI-agent process trees.
- **Secrets management.** AWS Secrets Manager, readable only by the control plane's role.
- **Availability.** Endpoints keep enforcing the last signed policy offline and spool events
  locally (≤256 MB). Database backups are by the provider (see O1).
- **Webhooks.** HTTPS only, HMAC-signed, private and internal addresses refused when connecting.
- **Rate limits** per IP, machine and user.
- **Gaps being closed:** `soc2-plan.md` §2 (branch protection, CI gates, MFA evidence, logging,
  IR plan).

## Annex 3: Sub-processors and other recipients

**Sub-processors** (process Customer personal data on Effigent's behalf):

| Sub-processor | Service | Data | Location | Basis for transfer |
|---|---|---|---|---|
| Amazon Web Services, Inc. | App Runner (control plane), ECR, Secrets Manager, S3 (event archive), SES (approval emails), Route 53, CloudWatch (service logs) | All categories in Annex 1 (S3: events older than the retention period; SES: approver emails and redacted summaries) | US (us-east-1) | DPF (AWS states it is certified) / SCCs |
| ⟨Database provider: Neon, per the architecture doc; **confirm**⟩ | Managed PostgreSQL | All categories in Annex 1 | US | ⟨confirm⟩ |
| Clerk, Inc. | Console sign-in, organisation membership, roles; Directory Sync if the Customer uses SSO/SCIM | Console users' names, emails, roles, sign-in data | ⟨US; confirm⟩ | ⟨confirm DPF / SCCs⟩ |
| Vercel Inc. | Hosts the web console | Console traffic in transit. See O2 on whether any data is stored | ⟨US / global edge; confirm⟩ | ⟨confirm⟩ |
| Anthropic, PBC | Optional "Ask AI" policy assistant, used only when an admin invokes it | The policy text and the admin's request (≤4000 chars). Policies may name users, teams, hosts | US | ⟨confirm⟩ |

**Other recipients that are not Effigent's sub-processors:**
- **Slack** (approval messages, only if `EFFIGENT_SLACK=1`; **off in production**). The
  Customer's own Slack app and workspace are used, so Slack is the Customer's vendor.
- **The Customer's webhook endpoints** and AI-tool vendors (Cursor, Anthropic Admin API, GitHub
  Copilot, OpenAI) used by Pricing Leaks under the Customer's own admin keys. These are the
  Customer's recipients and sources.
- **Called directly from the Customer's machines by effigentd**, not via Effigent:
  - **OSV.dev** (Google), with package names and versions, only when a policy uses
    `package_malicious` / `package_vulnerable`;
  - **public DNS resolvers** (1.1.1.1, 8.8.8.8, 9.9.9.9) with the hostnames listed in the
    policy's `domain_deny`, turned off with `-dns-servers ""`.
- **GitHub** (Actions, ghcr.io) builds and distributes the software. It receives no Customer
  data.

**Israeli Reg. 15 mapping.** The outsourcing contract terms are covered as follows:
- (a) data and purposes: §2, Annex 1;
- (b) systems accessed: Annex 3;
- (c) processing types: §2;
- (d) duration, return and destruction: §9;
- (e) security: §5, Annex 2;
- (f) confidentiality undertakings: §4;
- (g) flow-down: §6;
- (h) yearly report and incident notice: §§10, 12.

## Annex 4: Open items before this template can be used

| # | Item | Owner |
|---|---|---|
| O1 | Confirm the production database provider, region and backup/PITR settings (the architecture doc says Neon, US; the deploy script only references a secret `effigent/cp/database-url`). Sign its DPA | Engineering |
| O2 | `packages/dashboard` has server routes from the earlier product: `api/v1/storage` (uses a Postgres pool, `lib/db.ts`) and `api/v1/webhooks/clerk` (on `organization.created`, creates a tenant and provisions a per-org S3 bucket). If `DATABASE_URL` / AWS variables are set in Vercel, the console stores data and the architecture doc ("stores nothing") is wrong. Verify, then remove the routes or list Vercel and that store here | Engineering |
| O3 | Confirm Clerk's and Vercel's data locations and DPF status, and collect their DPAs | Founder |
| O4 | No self-service deletion of a workspace or of one person's events; define the manual procedure and its timeline (§§7, 9) | Engineering + counsel |
| O5 | Breach-notice period (⟨48⟩ h proposed) and an incident runbook (`soc2-plan.md` I1) | Founder |
| O6 | Whether Effigent needs a DPO under PPL s. 17B1(a)(3) as a processor whose core activity involves systematic monitoring; database registration / notice duties after Amendment 13 | Counsel |
| O7 | Named list of personnel with production access, confidentiality undertakings | Founder |
| O8 | Effigent's own DPF certification (none known), or whether it is needed given Israel's adequacy | Counsel |
| O9 | Whether to offer SCC Module 2 at all, given Art. 1(1) of 2021/914 (§11) | Counsel |
| O10 | Archive deletion at termination versus 365-day governance-mode Object Lock (§9) | Engineering + counsel |

## Annex 5: Sources (read 2026-10-21)

- **GDPR**, Arts. 6, 28, 32, 33, 35, 44–46, 88: https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng
- **2021 SCCs**, Implementing Decision (EU) 2021/914:
  https://eur-lex.europa.eu/eli/dec_impl/2021/914/oj/eng
- **EU-U.S. Data Privacy Framework**, Implementing Decision (EU) 2023/1795:
  https://eur-lex.europa.eu/eli/dec_impl/2023/1795/oj/eng
  - General Court T-553/23 *Latombe*, press release 106/25:
    https://curia.europa.eu/jcms/upload/docs/application/pdf/2025-09/cp250106en.pdf
  - Appeal C-703/25 P: https://eur-lex.europa.eu/eli/C/2025/6610/oj
  - EDPB letter of 31 July 2026:
    https://www.edpb.europa.eu/system/files/2026-08/edpb_letter_20260731_us_supremecourt_judgment_trump_v_slaughter_en.pdf
  - *Trump v. Slaughter*, No. 25-332: https://www.supremecourt.gov/opinions/25pdf/25-332_qn12.pdf
  - AWS DPF statement: https://aws.amazon.com/compliance/eu-us-privacy-shield-faq/
- **Israel adequacy review**, COM(2024) 7 final, 15 January 2024 (Commission report on the
  first review of the adequacy decisions; CELEX 52024DC0007).
- **Israel, Protection of Privacy Law** after Amendment 13 (PPA unofficial translation):
  https://www.gov.il/BlobFolder/legalinfo/legislation/en/Protection-of-Privacy-Law57411981unofficialtranslatioup.pdf
- **Israel, PPA opinion on DPO appointment** (14 July 2026):
  https://www.gov.il/BlobFolder/legalinfo/amendment-13-26-07-26/he/media_06-07-26.pdf
- **Israel, Data Security Regulations 5777-2017** (Regs. 1, 10, 11, 15):
  https://www.gov.il/BlobFolder/legalinfo/data_security_regulation/en/5777%E2%80%932017.pdf
- **Israel, Transfer of Data to Databases Abroad Regulations 5761-2001**:
  https://www.gov.il/BlobFolder/legalinfo/legislation/en/Privacy-ProtectionTransferofDataabroadRegulationsun.pdf
  - PPA opinion on Reg. 3: https://www.gov.il/BlobFolder/legalinfo/takana3/en/en-regulation3.pdf
- **Israel, Regulations on Data Transferred to Israel from the EEA 5783-2023**:
  https://www.gov.il/BlobFolder/legalinfo/datatransferredisrael2023/en/Privacy%20Protection%20Regulations%20(Instructions%20for%20Data%20that%20was%20transferred%20to%20Israel%20from%20the%20European%20Economic%20Area).pdf
