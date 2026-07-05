/**
 * End-to-end analysis: runs → graphs → clusters → findings → WasteReport.
 * Same engine for local mode (`ccopt analyze`) and the hosted pipeline.
 */

import type { Cluster, ClusterSummary, Run, RunGraph, WasteReport } from './types.js';
import { buildRunGraph } from './graph.js';
import { clusterRuns } from './cluster.js';
import { mapFindings } from './findings.js';
import { cacheReadRatio } from './cost.js';
import { mineSegments } from './segments.js';
import { mapSegmentFindings } from './findings.js';

export interface AnalyzeResult {
  report: WasteReport;
  clusters: Cluster[];
  graphs: RunGraph[];
}

function windowDaysOf(graphs: RunGraph[]): number {
  const dates = graphs
    .map((g) => g.startedAt)
    .filter((d): d is string => !!d)
    .map((d) => Date.parse(d))
    .filter((t) => !Number.isNaN(t));
  if (dates.length < 2) return 1;
  const span = (Math.max(...dates) - Math.min(...dates)) / 86_400_000;
  return Math.max(1, span);
}

export function analyzeRuns(runs: Run[], now?: string): AnalyzeResult {
  const graphs = runs.map(buildRunGraph);
  const clusters = clusterRuns(graphs);
  const windowDays = windowDaysOf(graphs);
  const segments = mineSegments(graphs);
  const findings = [...mapFindings(clusters, { windowDays, maxFindings: 99 }), ...mapSegmentFindings(segments, windowDays)]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const totalCost = graphs.reduce((s, g) => s + g.costUsd, 0);
  const clusteredRuns = clusters
    .filter((c) => c.metrics.nRuns >= 2)
    .reduce((s, c) => s + c.metrics.nRuns, 0);

  const clusterSummaries: ClusterSummary[] = clusters.map((c) => ({
    clusterId: c.clusterId,
    agentId: c.agentId,
    familyId: c.familyId,
    nRuns: c.metrics.nRuns,
    totalCostUsd: Math.round(c.metrics.totalCostUsd * 100) / 100,
    determinismScore: Math.round(c.metrics.determinismScore * 100) / 100,
    failureRate: Math.round(c.metrics.failureRate * 100) / 100,
    labelSequence: c.labelSequence,
    runIds: c.runIds,
    modelMix: c.metrics.modelMix,
  }));

  const report: WasteReport = {
    generatedAt: now ?? new Date().toISOString(),
    agentIds: [...new Set(graphs.map((g) => g.agentId))].sort(),
    windowDays: Math.round(windowDays * 10) / 10,
    totals: {
      runs: graphs.length,
      costUsd: Math.round(totalCost * 100) / 100,
      estMonthlyCostUsd: Math.round(totalCost * (30 / windowDays) * 100) / 100,
      clusteredRunRatio:
        graphs.length === 0 ? 0 : Math.round((clusteredRuns / graphs.length) * 100) / 100,
      cacheReadRatio:
        Math.round(
          cacheReadRatio(graphs.flatMap((g) => Object.values(g.usageByModel))) * 100,
        ) / 100,
    },
    findings,
    clusters: clusterSummaries,
    segments,
  };

  return { report, clusters, graphs };
}
