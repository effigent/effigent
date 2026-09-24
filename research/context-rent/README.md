# Context-rent research harness

Reproduces every number in `docs/context-rent.md` from local Claude Code
transcripts (`~/.claude/projects`). Build core first (`npm run -w @effigent/core build`).

```
node research/context-rent/build.mjs research/context-rent/ds.json   # dataset (gitignored — it is session content)
node research/context-rent/e1.mjs  research/context-rent/ds.json     # E1 spend anatomy
node research/context-rent/e2b.mjs research/context-rent/ds.json     # E2 rent identity + attribution
node research/context-rent/e3.mjs  research/context-rent/ds.json     # E3 boundary dependency, fresh-start cost
node research/context-rent/e4.mjs  research/context-rent/ds.json     # E4 the real compactions
node research/context-rent/e5.mjs  research/context-rent/ds.json     # E5 compaction-policy simulation
node research/context-rent/e6.mjs  research/context-rent/ds.json family|action|exact   # E6 held-out predictability
node research/context-rent/e7.mjs  research/context-rent/ds.json     # E7 ask → program
node research/context-rent/e7b.mjs research/context-rent/ds.json     # E7b ship episodes
node research/context-rent/e8.mjs  research/context-rent/ds.json     # E8 simulator assumption, TTL, advisor
node research/context-rent/e9.mjs  research/context-rent/ds.json 0.7 # E9 near-duplicate generated programs (held-out)
node research/context-rent/e10.mjs                                     # E10 harness injections
node research/context-rent/e11.mjs                                     # E11 dead-output elimination
node research/context-rent/e12.mjs|e12b.mjs|e12c.mjs research/context-rent/ds.json <CLAUDE.md> <project>  # E12 CLAUDE.md
node research/context-rent/e13.mjs research/context-rent/ds.json      # E13 exploration spill (+ e13b live-out)
node research/context-rent/e14.mjs|e15.mjs|e16.mjs|e17.mjs research/context-rent/ds.json  # reasons, routine determinism, drivers, EOQ
node research/context-rent/verify-rent.mjs                            # the ENGINE (core/rent.ts) end to end
node research/context-rent/insights-local.mjs                         # the NEW Insights output per agent (terminal)
node research/context-rent/audit-insights.mjs                         # what the OLD Insights said (for comparison)
```
