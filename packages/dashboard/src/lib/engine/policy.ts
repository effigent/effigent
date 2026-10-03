// VENDORED from packages/core|server (dashboard can't take workspace deps on Vercel).
/**
 * The policy contract between the analyzer and the runtime (`@effigent/runtime`).
 *
 * A policy is the ONLY thing the runtime may execute, and it carries the evidence
 * that justified it. Lifecycle: candidate → shadow → approved → enforced, with
 * automatic demotion back to shadow when live metrics cross `demoteIf`. Approval is
 * always human; demotion is always automatic. The runtime never makes a novel
 * decision — a `decider` policy chooses only among the options it was approved with.
 *
 * The analyzer produces no policies yet: that needs a prefix matcher (recognise
 * a pattern from the START of a live run — the analyzer today only reads finished
 * runs). The one policy served today is hand-written and harness-level:
 * `routing-shadow.ts` (Claude Code subagent model routing), in shadow only.
 */

/** What a policy replaces. `script` = a repeated procedural sequence of turns,
 *  `rules` = a decision fully determined by state, `cache` = a repeat input
 *  fingerprint, `decider` = a bounded choice among a small option set. */
export type PolicyType = 'script' | 'rules' | 'cache' | 'decider';

export type PolicyStatus = 'candidate' | 'shadow' | 'approved' | 'enforced';

export interface PolicyEvidence {
  /** Runs (or decision points) the evidence was measured on. */
  samples: number;
  /** Share of samples where the policy's answer matched the agent's. */
  agreement: number;
  /** Run success rate with the policy minus baseline; must stay ≥ 0 to approve. */
  successDelta: number;
}

export interface PolicyDemotion {
  agreementBelow: number;
  successDeltaBelow: number;
  /** Rolling window (samples) the two thresholds are evaluated over. */
  window: number;
}

export interface Policy {
  policyId: string;
  version: number;
  /** Agent name (matches `runs.agent_id`). */
  agent: string;
  /** Fingerprint of the run state the policy fires on. */
  fingerprint: string;
  type: PolicyType;
  status: PolicyStatus;
  /** Absent while a candidate/shadow policy is still collecting evidence. */
  evidence?: PolicyEvidence;
  /** Type-specific settings (e.g. a routing policy's scope and target model). */
  params?: Record<string, string | number | boolean>;
  demoteIf: PolicyDemotion;
  /** Who approved it (absent until `approved`). */
  approvedBy?: string;
}

/** What the runtime fetches per agent. `version` changes whenever any policy does,
 *  so the runtime can keep a cached bundle and skip unchanged ones. */
export interface PolicyBundle {
  agent: string;
  version: string;
  policies: Policy[];
}
