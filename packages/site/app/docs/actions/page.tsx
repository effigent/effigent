import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Actions — Effigent docs',
  description:
    'How Effigent reads what a coding agent’s tool call does — a push to a protected branch, a DROP TABLE, a Terraform destroy in prod, an unlisted or malicious package — and lets a policy deny it or ask for approval, per environment.',
};

const KINDS: Array<[string, string, string]> = [
  ['Git', 'protected_push · force_push · branch_delete · history_rewrite · hook_bypass', 'A push to main or release*, --force and +refspec, deleted branches, reset --hard and filter-repo, --no-verify.'],
  ['Databases', 'destructive_sql · sql_write', 'DROP, TRUNCATE, DELETE or UPDATE without WHERE, migrations. Read from psql, mysql and the other clients, heredocs, piped input, .sql files and MCP database tools.'],
  ['Cloud & clusters', 'cloud_change · cloud_destroy · access', 'aws, gcloud, az, kubectl, helm, terraform and pulumi commands, with the profile, account, context, project, subscription, workspace or stack they act on.'],
  ['Packages', 'package_install · _unlisted · _registry · _scripts · _malicious · _vulnerable', 'npm, pnpm, yarn, bun, pip, uv, poetry, cargo, go, gem, brew and npx. Malicious and vulnerable versions come from the OSV feed.'],
  ['Credentials', 'credential_read', 'Reading credential files and caches, printing tokens or dumping the environment.'],
  ['Guardrails', 'guardrail_edit', 'Writing CI config, CODEOWNERS, git hooks, agent settings, shell startup files, cron, launchd or systemd units.'],
  ['Shell', 'remote_script · fs_destroy', 'curl … | sh, and recursive deletes outside build output and temp directories.'],
  ['MCP', 'mcp_unlisted · mcp_changed', 'A call to an MCP server outside mcp_allow, or to a pinned server whose definition changed.'],
  ['Models', 'model_endpoint · model_api_key', 'An agent pointed at a model host outside model_hosts_allow, or running on a personal API key.'],
  ['Session', 'exfil_sequence · untrusted_then_risky', 'Rules on the order of calls in one session. See below.'],
];

const LISTS: Array<[string, string]> = [
  ['actions_deny / actions_approve', 'Action kinds, or kind@environment. sql_write covers destructive_sql, cloud_change covers cloud_destroy.'],
  ['command_deny / command_approve', 'Commands by pattern, * anywhere: "git push*", "terraform * -auto-approve".'],
  ['file_write_deny / file_write_approve', 'Writes only: Write and Edit, redirects, tee, cp, mv, sed -i, curl -o. An entry ending in / is a directory tree.'],
  ['protected_branches', 'What protected_push means. Default: main, master, trunk, prod, production, release*.'],
  ['package_deny / package_approve / package_allow', 'npm:name[@version], pypi:, cargo:, go:, gem:, brew:, with * wildcards.'],
  ['package_registries', 'Registry URL prefixes an install may use.'],
  ['mcp_allow', 'The MCP servers an agent may call.'],
  ['model_hosts_allow', 'The model API hosts an agent may be configured for.'],
];

export default function Actions() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Actions"
        title="What a tool call does, not just what it runs."
        sub="A hook sees git push origin main. Effigent reads it as a push to a protected branch, terraform destroy as a cloud destroy in the prod workspace, and DROP TABLE as destructive SQL. Policies are written in those terms."
      />

      <DocSection>
        <H2>Actions</H2>
        <p className="doc-p">
          Before every tool call of Claude Code, Codex, Gemini CLI and Cursor, effigentd classifies it into actions. Each action has a kind and a target: the branch, the database host, the AWS account, the package. Every hook event carries its actions, whether a rule matched or not, so the audit trail says what each call did.
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Area</th><th>Kinds</th><th>What it catches</th></tr></thead>
            <tbody>{KINDS.map(([a, k, d]) => <tr key={a}><td style={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{a}</td><td><code>{k}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Effigent reads the command line and the scripts it runs: <code>bash deploy.sh</code>, <code>./x.sh</code>, <code>source</code>, package.json scripts with their pre and post hooks, two levels deep. A destructive command inside a script is caught the same as one typed directly, and script commands go through the same deny and approval lists.
        </p>
      </DocSection>

      <DocSection>
        <H2>Environments</H2>
        <p className="doc-p">
          Name your environments once, then scope any action to one with <code>kind@env</code>. <code>cloud_destroy@prod</code> matches only destroys whose target is in prod; the same command against staging runs.
        </p>
        <CodeBlock title="policy.yaml · actions">{`environments:
  prod:
    aws_accounts: ["123456789012"]
    aws_profiles: [prod, prod-admin]
    kube_contexts: [prod-eu, prod-us]
    terraform_workspaces: [prod]
    hosts: [db.prod.internal]
    mcp_servers: [supabase-prod]
    match_unknown: true   # no profile, context or host worked out: counts as prod

defaults:
  mode: denylist
  actions_deny:
    - force_push
    - cloud_destroy@prod
    - destructive_sql@prod
    - remote_script
    - package_malicious
  actions_approve:
    - protected_push
    - sql_write@prod
    - cloud_change@prod
    - package_unlisted
  command_approve: ["terraform apply*"]
  file_write_approve: [.github/workflows/, CODEOWNERS]
  package_allow: ["npm:@acme/*", "npm:react", "pypi:requests"]
  package_registries: [https://registry.npmjs.org/]
  mcp_allow: [github, linear, supabase-prod]
  model_hosts_allow: [api.anthropic.com, api.openai.com]

mcp_pins:
  github: 9f2c4e…d81a`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Targets are worked out the way the tool itself would: <code>--profile</code> and <code>AWS_PROFILE</code> through <code>~/.aws/config</code> to the account, <code>--context</code> and the kubeconfig&apos;s current context, the gcloud project and active configuration, the Azure default subscription, the Terraform workspace and Pulumi stack, the database host from flags, URLs and <code>PGHOST</code>, and the branch from the refspec or <code>.git/HEAD</code>. The agent&apos;s own environment variables count, so a session started with <code>AWS_PROFILE=prod</code> is in prod.
        </p>
      </DocSection>

      <DocSection>
        <H2>The lists</H2>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>List</th><th>Matches</th></tr></thead>
            <tbody>{LISTS.map(([l, d]) => <tr key={l}><td style={{ whiteSpace: 'nowrap' }}><code>{l}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          A deny always wins over an approval. In monitor and learn mode every match is reported as <code>would_block</code>, so you can see what a list would do before you enforce it. Approvals for actions are routed like any other; see <Link href="/docs/approvals">Approvals</Link>.
        </p>
      </DocSection>

      <DocSection>
        <H2>Packages and the OSV feed</H2>
        <ul className="doc-list">
          <li><b>Unlisted.</b> With <code>package_allow</code> set, anything else is <code>package_unlisted</code>. PyPI names are normalised, so <code>Requests</code> and <code>requests</code> are one package.</li>
          <li><b>Registry.</b> An install from a URL, a git spec, an extra PyPI index or a registry outside <code>package_registries</code> is <code>package_registry</code>.</li>
          <li><b>Install scripts.</b> npm, pnpm, yarn and bun installs that run lifecycle scripts are <code>package_scripts</code>, and so are Python installs that may build a source distribution (no <code>--only-binary=:all:</code>).</li>
          <li><b>Malicious and vulnerable.</b> When a list names them, effigentd looks the packages up in OSV, including the OpenSSF malicious-packages data, with one batched query per call and an hour&apos;s cache. <code>npm ci</code> is checked against the lockfile&apos;s versions.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>Session rules</H2>
        <p className="doc-p">
          Two rules look at the order of calls in one agent session (the last 50 calls or 30 minutes):
        </p>
        <ul className="doc-list">
          <li><code>exfil_sequence</code>: a network call to a host the session hasn&apos;t used yet, after it read a credential, an <code>.env</code> file or a <code>file_alert</code> path.</li>
          <li><code>untrusted_then_risky</code>: the first risky action (a recursive delete, destructive SQL, a cloud destroy, a force-push, a guardrail edit, a remote script or a credential read) after outside content entered the session through WebFetch, WebSearch, curl or an MCP server outside <code>mcp_allow</code>.</li>
        </ul>
        <p className="doc-p">Put either in <code>actions_deny</code> or <code>actions_approve</code> like any other kind.</p>
      </DocSection>

      <DocSection>
        <H2>MCP server pinning</H2>
        <p className="doc-p">
          Each agent session&apos;s start event lists its MCP servers with a fingerprint: a SHA-256 of the transport, command, arguments, working directory, URL and the names (never the values) of its environment variables and headers. Copy the ones you trust into <code>mcp_pins</code>. A call to a pinned server whose definition changed, for example a new package version or another URL, is <code>mcp_changed</code>. Effigent reads each agent&apos;s MCP config in that agent&apos;s own order of precedence: Claude Code&apos;s managed, project and user files, Codex&apos;s <code>config.toml</code>, Gemini CLI&apos;s settings and Cursor&apos;s <code>mcp.json</code>.
        </p>
      </DocSection>

      <DocSection>
        <H2>Outcomes</H2>
        <p className="doc-p">
          A post-tool hook reports how each call ended: ok, error, interrupted, timed out or denied, with the exit code and duration the agent gives and the first line of the error. The tool&apos;s output never leaves the machine. In the console, the outcome appears under the call in Audit → Agent events.
        </p>
      </DocSection>

      <DocSection>
        <H2>Redaction</H2>
        <p className="doc-p">Before anything leaves the machine, effigentd removes secrets from commands, targets, approval summaries and errors:</p>
        <ul className="doc-list">
          <li>The gitleaks rule set.</li>
          <li>Secrets on command lines: <code>NAME_TOKEN=</code> and <code>DB_PASSWORD=</code> assignments, <code>--password</code> and <code>--token</code> flags, <code>mysql -p…</code>, <code>user:pass@</code> in URLs, bearer tokens and private-key blocks.</li>
          <li>Your own masks: <code>redact: {'{'}pii: true, patterns: [{'{'}name, pattern{'}'}]{'}'}</code>. <code>pii</code> masks emails, phone numbers, card numbers and IBANs.</li>
        </ul>
      </DocSection>

      <DocsPager current="/docs/actions" />
      <Footer />
    </div>
  );
}
