// Trace-driven context simulator. Replays a session's OBSERVED deposits (Δ_k) on a simulated
// context under a compaction policy. Behavioral assumption (tested in E6): the agent's deposits
// are unchanged by an earlier compaction, except for a measured re-acquisition burst.
import { pricingFor } from '../../packages/core/dist/index.js';
export function simulate(s, { T = Infinity, keep = 0.1, summaryOut = 12000, reacqTok = 15000, reacqReqs = 8, observedResets = true } = {}) {
  const R = s.reqs; let cost = 0, ctx = R[0].ctx, compactions = 0; const base = R[0].ctx;
  let pendingReacq = 0;
  for (let k = 0; k < R.length; k++) {
    const r = R[k], p = pricingFor(r.model), rp = p.inputPerM * (p.cacheReadMult ?? 0.1) / 1e6, w = p.inputPerM * (r.cw1h > 0 ? 2 : 1.25) / 1e6, op = p.outputPerM / 1e6;
    if (k > 0) {
      const prev = R[k - 1], d = r.ctx - prev.ctx;
      if (d < -0.4 * prev.ctx) { // an observed reset (real compaction / clear)
        if (observedResets) ctx = Math.min(ctx, r.ctx); else ctx += 0;
      } else ctx += Math.max(0, d) + (d < 0 ? d : 0);
      ctx = Math.max(ctx, base * 0.5);
    }
    // policy: compact when the simulated context crosses T
    if (ctx > T) { compactions++;
      cost += ctx * rp + summaryOut * op;                       // the compaction call reads everything once, writes a summary
      ctx = base + summaryOut + (ctx - base) * keep * 0;        // new context = base + summary
      cost += (base + summaryOut) * w;                          // re-write the new prefix
      pendingReacq = reacqReqs;                                 // then pay a re-exploration burst
    }
    if (pendingReacq > 0) { const t = reacqTok / reacqReqs; cost += ctx * rp + t * w + 300 * op; ctx += t; pendingReacq--; }
    // this request: read what was already there, write what is new, pay output
    const cold = k > 0 && r.cw > 0.5 * R[k - 1].ctx && R[k - 1].ctx > 20000; // cache expired (idle gap): whole prefix re-written
    const newTok = k === 0 ? r.ctx : Math.max(0, r.ctx - R[k - 1].ctx);
    if (cold) cost += ctx * w; else cost += Math.max(0, ctx - newTok) * rp + newTok * w;
    cost += r.out * op;
    cost += r.cost - (r.in * p.inputPerM / 1e6 + (r.cw - r.cw1h) * p.inputPerM * 1.25 / 1e6 + r.cw1h * p.inputPerM * 2 / 1e6 + r.cr * rp + r.out * op); // advisor residual, unchanged by policy
  }
  return { cost, compactions };
}
