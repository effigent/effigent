#!/usr/bin/env node
/**
 * Bundle invariant: the runtime runs INSIDE a customer's production agent, so it
 * ships the recorder + pricing only. The analyzer (alignment, lattice, synthesis,
 * replay, embeddings, drift) is server-side — if any of these symbols appear in
 * the bundle, someone broke tree-shaking and the publish should fail loudly.
 * The emitted .d.ts must not reference @effigent/core either: it is a dev-only
 * dependency, inlined by the bundle, and not installed for consumers.
 */
import { readFileSync } from 'node:fs';

const FORBIDDEN = [
  'embedRunGraph',
  'detectDrift',
  'analyzeDeterminism',
  'synthesizeTools',
  'replayToolSpec',
  'clusterBySimilarity',
  'parseTranscript',
];
const MAX_KB = 64;

let failed = false;
for (const file of ['index.js', 'index.cjs']) {
  const bundle = readFileSync(new URL(`./dist/${file}`, import.meta.url), 'utf8');
  const leaked = FORBIDDEN.filter((sym) => bundle.includes(sym));
  const kb = Math.round(bundle.length / 1024);
  if (leaked.length) {
    console.error(`✗ dist/${file} contains server-side engine symbols: ${leaked.join(', ')}`);
    failed = true;
  } else if (kb > MAX_KB) {
    console.error(`✗ dist/${file} is ${kb} kB (budget ${MAX_KB} kB)`);
    failed = true;
  } else {
    console.log(`✓ dist/${file} clean (${kb} kB)`);
  }
}
// Walk the declarations reachable from index.d.ts (internal modules may use core types).
const seen = new Set();
const walk = (f) => {
  if (seen.has(f)) return;
  seen.add(f);
  const src = readFileSync(new URL(`./dist/${f}`, import.meta.url), 'utf8');
  if (/(from \s*|import\()['"]@effigent\/core['"]/.test(src)) {
    console.error(`✗ dist/${f} references @effigent/core — keep core types off the public surface`);
    failed = true;
  }
  for (const m of src.matchAll(/from '\.\/([\w-]+)\.js'/g)) walk(`${m[1]}.d.ts`);
};
walk('index.d.ts');
if (failed) process.exit(1);
