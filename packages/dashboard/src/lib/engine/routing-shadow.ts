// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
import { addUsage, emptyUsage, usageCostUsd } from './cost.ts';
import type { Policy } from './policy.ts';
import type { TokenUsage } from './types.ts';

/**
 * The first runtime policy for Claude Code: route SUBAGENT conversations off the
 * premium tier (Opus / Fable) to Sonnet — in SHADOW. The gateway forwards every
 * request unchanged; this module only records what the policy WOULD have done
 * and what that would have cost.
 *
 * Unit of decision = one subagent conversation (`x-claude-code-agent-id`,
 * verified on real Claude Code traffic: the main thread sends none, each
 * subagent sends its own id on every request). Deciding per REQUEST would switch
 * models mid-conversation and throw away the prompt cache — a policy that could
 * never be enforced as priced. The decision is taken from the conversation's
 * first request and held.
 *
 * Counterfactual = the SAME usage priced at the target model (`usageCostUsd`,
 * so cache multipliers and the 1h write split apply). A subagent counts as
 * "would route" only when that is materially cheaper (≥5%): cache reads cost about the
 * same across tiers (Opus 5.5 0.05×$4 = Sonnet 5 0.1×$2 = $0.20/M), so a
 * read-heavy subagent can save nothing. What the estimate cannot see: the
 * cheaper model's tokenizer, how many more turns it would take, and whether the
 * answer would be as good — none of that is measurable until a sample is
 * actually routed. Every number here is labelled an estimate for that reason.
 */

export const SUBAGENT_ROUTING_POLICY_ID = 'claude-code.subagent-model-routing';
export const SUBAGENT_ROUTING_VERSION = 1;
export const SUBAGENT_ROUTING_TARGET = 'claude-sonnet-5-5';
/** Tiers the policy routes FROM: priced above the target on every token class. */
const PREMIUM = /opus|fable|mythos/i;
/** A saving under 5% is noise (float ties on cache-read-only traffic), not a reason to route. */
const MATERIAL = 0.95;

export function subagentRoutingPolicy(agent: string): Policy {
  return {
    policyId: SUBAGENT_ROUTING_POLICY_ID,
    version: SUBAGENT_ROUTING_VERSION,
    agent,
    fingerprint: 'claude-code:subagent:first-request',
    type: 'rules',
    status: 'shadow',
    params: { scope: 'claude-code-subagent', from: PREMIUM.source, to: SUBAGENT_ROUTING_TARGET },
    demoteIf: { agreementBelow: 0, successDeltaBelow: -0.05, window: 50 },
  };
}

/** One observed /v1/messages exchange (metadata only — no content). */
export interface ShadowRequest {
  sessionId?: string;
  /** x-claude-code-agent-id; absent on the main thread. */
  agentId?: string;
  model: string;
  usage: TokenUsage;
  at?: string;
}

export interface ShadowSubagent {
  agentId: string;
  /** Model of the conversation's first request (the decision input). */
  model: string;
  requests: number;
  usage: TokenUsage;
  costUsd: number;
  /** Set when the policy would have routed this conversation. */
  wouldRouteTo?: string;
  /** Same usage at the target's price (premium-tier subagents only). */
  counterfactualUsd?: number;
}

export interface ShadowSession {
  sessionId: string;
  agent: string;
  policyId: string;
  policyVersion: number;
  startedAt?: string;
  endedAt?: string;
  requests: number;
  costUsd: number;
  /** Main thread + harness side calls (no agent id). */
  mainCostUsd: number;
  subagents: ShadowSubagent[];
  /** Subagents the policy would have routed (premium tier AND cheaper at the target). */
  wouldRoute: number;
  /** Σ (actual − counterfactual) over routed subagents. An estimate — see the header. */
  estimatedSavingsUsd: number;
}

interface Acc {
  model: string;
  requests: number;
  byModel: Map<string, TokenUsage>;
}

const priced = (byModel: Map<string, TokenUsage>) => [...byModel].reduce((s, [m, u]) => s + usageCostUsd(m, u), 0);
const merged = (byModel: Map<string, TokenUsage>) => [...byModel.values()].reduce(addUsage, emptyUsage());

/** Accumulates one `effigent claude` process's traffic into per-session shadow records. */
export class SubagentRoutingShadow {
  private readonly sessions = new Map<string, { started?: string; ended?: string; requests: number; main: Map<string, TokenUsage>; subs: Map<string, Acc> }>();

  constructor(private readonly agent: string) {}

  add(r: ShadowRequest): void {
    const id = r.sessionId ?? 'unknown';
    let s = this.sessions.get(id);
    if (!s) this.sessions.set(id, (s = { requests: 0, main: new Map(), subs: new Map() }));
    s.started ??= r.at;
    s.ended = r.at ?? s.ended;
    s.requests++;
    const into = (m: Map<string, TokenUsage>) => m.set(r.model, addUsage(m.get(r.model) ?? emptyUsage(), r.usage));
    if (!r.agentId) {
      into(s.main);
      return;
    }
    let sub = s.subs.get(r.agentId);
    if (!sub) s.subs.set(r.agentId, (sub = { model: r.model, requests: 0, byModel: new Map() }));
    sub.requests++;
    into(sub.byModel);
  }

  get empty(): boolean {
    return this.sessions.size === 0;
  }

  result(): ShadowSession[] {
    return [...this.sessions].map(([sessionId, s]) => {
      const subagents: ShadowSubagent[] = [...s.subs].map(([agentId, a]) => {
        const costUsd = priced(a.byModel);
        const usage = merged(a.byModel);
        const sub: ShadowSubagent = { agentId, model: a.model, requests: a.requests, usage, costUsd };
        if (PREMIUM.test(a.model)) {
          const counterfactualUsd = usageCostUsd(SUBAGENT_ROUTING_TARGET, usage);
          sub.counterfactualUsd = counterfactualUsd;
          if (counterfactualUsd <= costUsd * MATERIAL) sub.wouldRouteTo = SUBAGENT_ROUTING_TARGET;
        }
        return sub;
      });
      const mainCostUsd = priced(s.main);
      const routed = subagents.filter((x) => x.wouldRouteTo);
      return {
        sessionId,
        agent: this.agent,
        policyId: SUBAGENT_ROUTING_POLICY_ID,
        policyVersion: SUBAGENT_ROUTING_VERSION,
        startedAt: s.started,
        endedAt: s.ended,
        requests: s.requests,
        costUsd: mainCostUsd + subagents.reduce((t, x) => t + x.costUsd, 0),
        mainCostUsd,
        subagents,
        wouldRoute: routed.length,
        estimatedSavingsUsd: routed.reduce((t, x) => t + (x.costUsd - (x.counterfactualUsd ?? x.costUsd)), 0),
      };
    });
  }
}

export interface ShadowSummary {
  policyId: string;
  sessions: number;
  costUsd: number;
  subagents: number;
  subagentCostUsd: number;
  premiumSubagents: number;
  wouldRoute: number;
  estimatedSavingsUsd: number;
  /** Savings as a share of all observed spend. */
  estimatedSavingsShare: number;
  firstAt?: string;
  lastAt?: string;
}

export function summarizeShadow(sessions: ShadowSession[]): ShadowSummary {
  const subs = sessions.flatMap((s) => s.subagents);
  const costUsd = sessions.reduce((t, s) => t + s.costUsd, 0);
  const estimatedSavingsUsd = sessions.reduce((t, s) => t + s.estimatedSavingsUsd, 0);
  const times = sessions.flatMap((s) => [s.startedAt, s.endedAt]).filter((x): x is string => !!x).sort();
  return {
    policyId: SUBAGENT_ROUTING_POLICY_ID,
    sessions: sessions.length,
    costUsd,
    subagents: subs.length,
    subagentCostUsd: subs.reduce((t, x) => t + x.costUsd, 0),
    premiumSubagents: subs.filter((x) => x.counterfactualUsd != null).length,
    wouldRoute: subs.filter((x) => x.wouldRouteTo).length,
    estimatedSavingsUsd,
    estimatedSavingsShare: costUsd > 0 ? estimatedSavingsUsd / costUsd : 0,
    firstAt: times[0],
    lastAt: times[times.length - 1],
  };
}
