import type { Metadata } from 'next';
import Link from 'next/link';
import { Nav, Footer, PageHero, DocSection, CodeBlock, DocsPager, H2 } from '../../ui';

export const metadata: Metadata = {
  title: 'Model gateway — Effigent docs',
  description: 'A local model gateway in effigentd: choose which models Claude Code and Codex may call, cap output tokens, record every model call with its token counts, and require that sessions go through it.',
};

const PROVIDERS: Array<[string, string, string]> = [
  ['anthropic', 'api.anthropic.com', 'Claude Code'],
  ['codex', 'chatgpt.com/backend-api/codex (ChatGPT sign-in) or api.openai.com/v1 (API key)', 'Codex'],
  ['openai', 'api.openai.com', 'OpenAI-compatible clients'],
  ['gemini', 'generativelanguage.googleapis.com', 'Gemini API clients'],
];

const FIELDS: Array<[string, string]> = [
  ['provider · requested_model', 'Which provider, and the model the agent asked for.'],
  ['input_tokens · output_tokens', 'Input excludes cache reads and writes; output includes reasoning.'],
  ['cache_read_tokens · cache_write_tokens · reasoning_tokens', 'As the provider reports them.'],
  ['status · stream · stop_reason · error', 'How the call ended.'],
  ['latency_ms · first_byte_ms', 'Total time, and time to the first byte of the answer.'],
  ['session_id · os_user · git_email', 'The agent session and the person behind it, joined from the agent hooks.'],
  ['rewritten', 'Set when the gateway lowered the request’s output limit.'],
];

export default function ModelGateway() {
  return (
    <div style={{ width: '100%', overflowX: 'hidden' }}>
      <Nav />
      <PageHero
        eyebrow="Docs · Model gateway"
        title="Which models your agents call, and what they cost."
        sub="effigentd runs a small gateway on each machine. Claude Code and Codex send their model calls through it, so your policy decides which models they may use and every call is recorded with its tokens."
      />

      <DocSection>
        <H2>How it works</H2>
        <p className="doc-p">
          The gateway listens on <code>127.0.0.1:7779</code>, on the machine itself. It is not a proxy that intercepts TLS: an agent uses it because its base URL points there. For each model call it:
        </p>
        <ul className="doc-list">
          <li><b>Reads the model and the output limit</b> from the request, and checks them against the policy&apos;s <code>models:</code> section.</li>
          <li><b>Forwards the request</b> to the provider and streams the answer back as it arrives, unbuffered, so the agent feels no difference.</li>
          <li><b>Records a <code>model_call</code> event</b> with the usage the provider returned.</li>
        </ul>
        <p className="doc-p">
          Prompts, completions, query strings and credentials never go into events or logs. The agent&apos;s own authentication passes through as it was sent: API keys and claude.ai or ChatGPT sign-ins both work.
        </p>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Path</th><th>Upstream</th><th>Used by</th></tr></thead>
            <tbody>{PROVIDERS.map(([p, u, a]) => <tr key={p}><td><code>/{p}/…</code></td><td>{u}</td><td>{a}</td></tr>)}</tbody>
          </table>
        </div>
      </DocSection>

      <DocSection>
        <H2>Point the agents at it</H2>
        <CodeBlock title="sh">{`sudo effigentd install-gateway --agents claude,codex

# Claude Code: env.ANTHROPIC_BASE_URL in managed-settings.json
# Codex:       openai_base_url in /etc/codex/managed_config.toml

sudo effigentd install-gateway --remove     # point them back at their providers`}</CodeBlock>
        <p className="doc-p" style={{ marginTop: 14 }}>
          An admin runs it once per machine. It changes where model traffic goes, so the installers leave it to you. It never replaces a base URL someone else set, and it keeps Codex&apos;s original file as a backup. Each machine reports to the control plane whether its agents point at the gateway.
        </p>
      </DocSection>

      <DocSection>
        <H2>The models policy</H2>
        <CodeBlock title="policy · models">{`models:
  allow: ["claude-sonnet-*", "claude-haiku-*", "gpt-5*"]
  deny: ["*opus*"]
  max_tokens: 64000
  require_gateway: true
  agents:
    codex:
      allow: ["gpt-5-codex*"]
      max_tokens: 32000`}</CodeBlock>
        <ul className="doc-list" style={{ marginTop: 14 }}>
          <li><b>allow / deny.</b> Case-insensitive patterns with <code>*</code>. A deny always wins. An agent&apos;s own list replaces the default one.</li>
          <li><b>Refused models.</b> In denylist and allowlist mode the agent gets a 400 in its provider&apos;s error format, and shows it: <code>API Error: 400 Blocked by Effigent: model … is not allowed</code>. The call is recorded as <code>blocked</code>. In monitor and learn mode it is recorded as <code>would_block</code> and forwarded.</li>
          <li><b>max_tokens.</b> Lowers a larger output limit in the request, thinking budgets included. That cap, and asking streamed chat completions to include usage, are the only changes the gateway makes to a request. Everything else is forwarded byte for byte.</li>
          <li><b>require_gateway.</b> The agent hooks treat a Claude Code or Codex session that didn&apos;t go through the gateway as a <code>model_endpoint</code> action and deny it. Going around the gateway stops the agent instead of going unseen.</li>
        </ul>
      </DocSection>

      <DocSection>
        <H2>What each call records</H2>
        <div className="tbl-wrap">
          <table className="doc-tbl">
            <thead><tr><th>Field</th><th>Meaning</th></tr></thead>
            <tbody>{FIELDS.map(([f, d]) => <tr key={f}><td><code>{f}</code></td><td>{d}</td></tr>)}</tbody>
          </table>
        </div>
        <p className="doc-p" style={{ marginTop: 14 }}>
          Model calls are agent events like any other, stored with the session&apos;s tool calls in Audit → Agent events. They also tell <Link href="/docs/pricing-leaks">Pricing Leaks</Link> which model each person uses.
        </p>
      </DocSection>

      <DocSection>
        <H2>When effigentd is stopped</H2>
        <p className="doc-p">
          An agent pointed at the gateway can&apos;t reach its model while effigentd is down. That is the same posture as the hooks: a stopped daemon never means a free pass. <code>install-gateway --remove</code> points the agents back at their providers, and the uninstallers run it for you.
        </p>
      </DocSection>

      <DocsPager current="/docs/model-gateway" />
      <Footer />
    </div>
  );
}
