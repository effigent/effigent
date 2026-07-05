/**
 * The batch pipeline — spec §4: ingest → parse → canonicalize → graph build →
 * fingerprint → cluster → findings. Runs on-upload (debounced by the caller)
 * and nightly; never real-time.
 */

import { analyzeRuns, renderReportHtml, type Run } from '@ccopt/core';
import type { Db } from './db.js';
import type { BlobStore } from './blobs.js';
import { sanitizeForJsonb } from './jsonb.js';

export interface PipelineResult {
  reportId: string;
  findings: number;
  clusters: number;
  runs: number;
}

export async function runPipeline(
  db: Db,
  blobs: BlobStore,
  tenantId: string,
  agentFilter?: string,
): Promise<PipelineResult | null> {
  const { rows } = await db.query<{ id: string; parsed: Run }>(
    agentFilter
      ? `select id, parsed from runs where tenant_id = $1 and agent_id ilike '%' || $2 || '%' order by started_at asc nulls last`
      : `select id, parsed from runs where tenant_id = $1 order by started_at asc nulls last`,
    agentFilter ? [tenantId, agentFilter] : [tenantId],
  );
  if (rows.length === 0) return null;

  const runIdToDbId = new Map<string, string>();
  const runs: Run[] = rows.map((r) => {
    runIdToDbId.set(r.parsed.runId, r.id);
    return r.parsed;
  });

  const { report: rawReport, clusters: rawClusters } = analyzeRuns(runs);
  const report = sanitizeForJsonb(rawReport);
  const clusters = sanitizeForJsonb(rawClusters);
  const html = renderReportHtml(report);

  const client = await db.connect();
  try {
    await client.query('begin');
    const reportRes = await client.query<{ id: string }>(
      `insert into reports (tenant_id, window_days, totals, report_json, html_blob_path)
       values ($1, $2, $3, $4, '') returning id`,
      [tenantId, report.windowDays, JSON.stringify(report.totals), JSON.stringify(report)],
    );
    const reportId = reportRes.rows[0].id;
    const htmlPath = `${tenantId}/reports/${reportId}.html`;
    await blobs.put(htmlPath, html);
    await client.query(`update reports set html_blob_path = $2 where id = $1`, [reportId, htmlPath]);

    for (const c of clusters) {
      const clusterRes = await client.query<{ id: string }>(
        `insert into clusters (tenant_id, report_id, cluster_key, agent_id, l1, family_id,
                               n_runs, total_cost_usd, determinism, metrics, label_sequence)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [
          tenantId,
          reportId,
          c.clusterId,
          c.agentId,
          c.l1,
          c.familyId,
          c.metrics.nRuns,
          c.metrics.totalCostUsd,
          c.metrics.determinismScore,
          JSON.stringify(c.metrics),
          JSON.stringify(c.labelSequence),
        ],
      );
      const clusterDbId = clusterRes.rows[0].id;
      for (const runId of c.runIds) {
        const dbId = runIdToDbId.get(runId);
        if (dbId) {
          await client.query(
            `insert into cluster_runs (cluster_id, run_id) values ($1, $2) on conflict do nothing`,
            [clusterDbId, dbId],
          );
        }
      }
    }

    for (const f of report.findings) {
      await client.query(
        `insert into findings (tenant_id, report_id, kind, title, agent_id,
                               est_monthly_saving_usd, confidence, effort, score, payload)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          tenantId,
          reportId,
          f.kind,
          f.title,
          f.agentId,
          f.estMonthlySavingUsd,
          f.confidence,
          f.effort,
          f.score,
          JSON.stringify(f),
        ],
      );
    }
    await client.query('commit');
    return {
      reportId,
      findings: report.findings.length,
      clusters: clusters.length,
      runs: runs.length,
    };
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
}
