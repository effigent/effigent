#!/usr/bin/env node
/**
 * effigent — the Optimizer CLI.
 *
 *   effigent analyze   local-only mode: engine + report on your own transcripts
 *   effigent sync      upload session transcripts to the hosted service
 *   effigent run       headless wrapper tagging a Claude Code run with an agentId
 */

import { Command } from 'commander';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { analyzeRuns, renderReportHtml } from '@effigent/core';
import {
  EFFIGENT_HOME,
  EFFIGENT_STORE,
  defaultSource,
  defaultSources,
  discoverSessions,
  loadAgentMap,
  loadConfig,
  loadRuns,
  resolveAgentId,
  saveConfig,
  tagSessions,
  CONFIG_PATH,
} from './store.js';
import { uploadSessionFile } from './upload.js';

const program = new Command();
program.name('effigent').description('Effigent — the Optimizer CLI: capture agent runs, compile away the waste').version('0.5.0');

/** Hosted collector — a dedicated subdomain so the ingestion backend can move to
 *  its own infra later by repointing DNS, with zero client reconfiguration. The
 *  default so nobody has to type (or typo) --server; still overridable with
 *  --server / EFFIGENT_SERVER for self-hosting or local dev. */
const DEFAULT_SERVER = 'https://collector.effigent.ai';

program
  .command('analyze')
  .description('Analyze local Claude Code transcripts and render the Waste Report')
  .option('--source <dir...>', 'transcript directories', defaultSources())
  .option('--days <n>', 'analysis window in days', '30')
  .option('--agent <substr>', 'only include agents whose id contains this substring')
  .option('--min-steps <n>', 'ignore trivial sessions with fewer steps', '3')
  .option('--out <file>', 'HTML report output path', 'effigent-report.html')
  .option('--json <file>', 'JSON report output path', 'effigent-report.json')
  .action((opts) => {
    const sources: string[] = Array.isArray(opts.source) ? opts.source : [opts.source];
    const runs = loadRuns(sources.map((s: string) => resolve(s)), {
      sinceDays: Number(opts.days),
      agentFilter: opts.agent,
      minSteps: Number(opts.minSteps),
    });
    if (runs.length === 0) {
      console.error(`No runs found under ${opts.source} in the last ${opts.days} day(s).`);
      process.exitCode = 1;
      return;
    }
    const { report } = analyzeRuns(runs);
    writeFileSync(resolve(opts.out), renderReportHtml(report));
    writeFileSync(resolve(opts.json), JSON.stringify(report, null, 2));
    const total = report.totals;
    console.log(`Analyzed ${total.runs} runs across ${report.agentIds.length} agent(s).`);
    console.log(
      `Observed spend $${total.costUsd} (~$${total.estMonthlyCostUsd}/mo) · ` +
        `${Math.round(total.clusteredRunRatio * 100)}% of runs repeat a known shape · ` +
        `cache-read ratio ${Math.round(total.cacheReadRatio * 100)}%`,
    );
    for (const [i, f] of report.findings.entries()) {
      console.log(`  #${i + 1} [${f.kind}] $${f.estMonthlySavingUsd}/mo — ${f.title}`);
    }
    console.log(`Report: ${resolve(opts.out)}`);
  });

program
  .command('login')
  .description('Persist the effigent server + API key (used as defaults by sync/run/doctor)')
  .option('--server <url>', 'effigent server base URL (default: the hosted collector)', DEFAULT_SERVER)
  .requiredOption('--key <apiKey>', 'tenant API key')
  .action(async (opts) => {
    const config = loadConfig();
    config.server = opts.server;
    config.apiKey = opts.key;
    saveConfig(config);
    try {
      const res = await fetch(`${opts.server.replace(/\/$/, '')}/api/v1/reports`, {
        headers: { authorization: `Bearer ${opts.key}` },
      });
      console.log(
        res.ok
          ? `Saved to ${CONFIG_PATH} — key verified against ${opts.server}.`
          : `Saved to ${CONFIG_PATH}, but the key was rejected (HTTP ${res.status}) — check it.`,
      );
    } catch {
      console.log(`Saved to ${CONFIG_PATH} — server unreachable right now, will be used anyway.`);
    }
  });

interface SetupToken {
  v: 1;
  server: string;
  apiKey: string;
  agentRules?: { pattern: string; agent: string }[];
  /** Substring filter for the scheduled sync (keeps unrelated local sessions private). */
  syncAgent?: string;
}

program
  .command('invite')
  .description('Print a one-line setup command for another developer (uses your login + rules)')
  .option('--agent <substr>', 'restrict their scheduled sync to this agent substring')
  .action((opts) => {
    const config = loadConfig();
    if (!config.server || !config.apiKey) {
      console.error('Run `effigent login` first — invite packages your server + key.');
      process.exitCode = 2;
      return;
    }
    const token: SetupToken = {
      v: 1,
      server: config.server,
      apiKey: config.apiKey,
      agentRules: config.agentRules,
      syncAgent: opts.agent,
    };
    const encoded = Buffer.from(JSON.stringify(token)).toString('base64url');
    console.log('Send this ONE command to the developer (contains the workspace API key — share privately):\n');
    console.log(
      `  curl -fsSL https://effigent.ai/install.sh | sh -s -- --join ${encoded}\n`,
    );
    console.log('It installs effigent, joins this workspace, schedules a 15-minute sync, and uploads their history.');
  });

program
  .command('join')
  .description('Join a workspace from an invite token: config + schedule + first sync, in one shot')
  .argument('<token>', 'setup token from `effigent invite`')
  .action(async (rawToken: string) => {
    let token: SetupToken;
    try {
      token = JSON.parse(Buffer.from(rawToken, 'base64url').toString('utf8')) as SetupToken;
      if (token.v !== 1 || !token.server || !token.apiKey) throw new Error('missing fields');
    } catch {
      console.error('Invalid setup token. Ask for a fresh one via `effigent invite`.');
      process.exitCode = 2;
      return;
    }

    const config = loadConfig();
    config.server = token.server;
    config.apiKey = token.apiKey;
    if (token.agentRules) config.agentRules = token.agentRules;
    saveConfig(config);
    console.log(`✓ workspace config saved (${token.server})`);

    try {
      const res = await fetch(`${token.server.replace(/\/$/, '')}/api/v1/reports`, {
        headers: { authorization: `Bearer ${token.apiKey}` },
      });
      console.log(res.ok ? '✓ server reachable, API key accepted' : `✗ server rejected the key (HTTP ${res.status})`);
      if (!res.ok) process.exitCode = 1;
    } catch (err) {
      console.log(`! server not reachable right now (${err instanceof Error ? err.message : err}) — sync will retry on schedule`);
    }

    // Schedule the recurring sync with THIS node + THIS effigent (absolute paths:
    // launchd/cron have no nvm/homebrew PATH).
    const nodeBin = process.execPath;
    const cliBin = resolve(process.argv[1]);
    const syncArgs = ['sync', ...(token.syncAgent ? ['--agent', token.syncAgent] : []), '--days', '7'];

    if (process.platform === 'darwin') {
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.effigent.sync.plist');
      const args = [nodeBin, cliBin, ...syncArgs];
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.effigent.sync</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(EFFIGENT_HOME, 'sync.log')}</string>
  <key>StandardErrorPath</key><string>${join(EFFIGENT_HOME, 'sync.log')}</string>
</dict>
</plist>
`;
      mkdirSync(dirname(plistPath), { recursive: true });
      mkdirSync(EFFIGENT_HOME, { recursive: true });
      writeFileSync(plistPath, plist);
      const uid = process.getuid?.() ?? 501;
      spawnSync('launchctl', ['bootout', `gui/${uid}/com.effigent.sync`], { stdio: 'ignore' });
      const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
      console.log(
        boot.status === 0
          ? '✓ scheduled: launchd job com.effigent.sync (every 15 min)'
          : `! could not load launchd job (${boot.stderr?.trim()}) — plist written to ${plistPath}`,
      );
    } else {
      const cronLine = `*/15 * * * * ${nodeBin} ${cliBin} ${syncArgs.join(' ')} >> ${join(EFFIGENT_HOME, 'sync.log')} 2>&1`;
      const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
      const existing = current.status === 0 ? current.stdout : '';
      if (existing.includes('effigent') && existing.includes('sync')) {
        console.log('✓ scheduled: crontab already has a effigent sync entry');
      } else {
        const set = spawnSync('crontab', ['-'], { input: `${existing.trimEnd()}\n${cronLine}\n`, encoding: 'utf8' });
        console.log(
          set.status === 0
            ? '✓ scheduled: cron entry added (every 15 min)'
            : `! could not edit crontab — add this line yourself:\n    ${cronLine}`,
        );
      }
    }

    console.log('Uploading existing history…');
    const first = spawnSync(nodeBin, [cliBin, ...syncArgs, '--days', '30'], { stdio: 'inherit' });
    console.log(
      first.status === 0
        ? '\nDone. This machine now reports to the workspace continuously.'
        : '\nSetup saved; first sync failed (see above) — the schedule will retry every 15 minutes.',
    );
  });

program
  .command('sync')
  .description('Upload local session transcripts to the effigent service')
  .option('--server <url>', 'effigent server base URL (default: effigent login config)')
  .option('--key <apiKey>', 'tenant API key (default: effigent login config)')
  .option('--source <dir...>', 'transcript directories', defaultSources())
  .option('--days <n>', 'only sync sessions modified in the last N days', '30')
  .option('--agent <substr>', 'only sync sessions whose resolved agentId contains this substring')
  .option(
    '--all',
    'DANGER: also upload unattributed sessions (everything on this machine). ' +
      'Default is attributed-only: a session uploads only when a tag or agentRule claims it.',
  )
  .action(async (opts) => {
    const config = loadConfig();
    const server: string | undefined = opts.server ?? process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
    const apiKey: string | undefined = opts.key ?? process.env.EFFIGENT_API_KEY ?? config.apiKey;
    if (!server || !apiKey) {
      console.error('No server/key: pass --server/--key, set EFFIGENT_SERVER/EFFIGENT_API_KEY, or run `effigent login`.');
      process.exitCode = 2;
      return;
    }
    const cutoff = Date.now() - Number(opts.days) * 86_400_000;
    const sourceDirs: string[] = Array.isArray(opts.source) ? opts.source : [opts.source];
    const seen = new Set<string>();
    const sessions = sourceDirs
      .flatMap((d: string) => discoverSessions(resolve(d)))
      .filter((s) => s.mtimeMs >= cutoff)
      .filter((s) => (seen.has(s.sessionId) ? false : (seen.add(s.sessionId), true)))
      .map((s) => ({ ...s, agentId: resolveAgentId(s.sessionId, s.path) }))
      // Privacy default: only sessions explicitly claimed by a tag or rule leave
      // this machine. `--all` is the deliberate opt-out.
      .filter((s) => (opts.all ? true : s.agentId !== undefined))
      .filter((s) => !opts.agent || (s.agentId ?? '').includes(opts.agent));
    if (sessions.length === 0) {
      console.error(
        'Nothing to sync. (Only attributed sessions upload — add an agentRule, use `effigent tag`/`effigent run`, or pass --all.)',
      );
      return;
    }
    // State is per server+key: the same session must upload once per tenant,
    // not once globally (switching tenants must not silently skip history).
    const target = createHash('sha256').update(`${server}|${apiKey}`).digest('hex').slice(0, 12);
    const statePath = `${EFFIGENT_HOME}/sync-state-${target}.json`;
    let state: Record<string, number> = {};
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'));
    } catch {
      /* first sync */
    }
    let uploaded = 0;
    let skipped = 0;
    for (const s of sessions) {
      if (state[s.sessionId] && state[s.sessionId] >= s.mtimeMs) {
        skipped++;
        continue;
      }
      const r = await uploadSessionFile(
        { server, apiKey },
        s.path,
        s.sessionId,
        s.agentId,
      );
      if (!r.ok) {
        console.error(`  ✗ ${s.sessionId}: HTTP ${r.status} ${r.detail ?? ''}`);
        continue;
      }
      state[s.sessionId] = s.mtimeMs;
      uploaded++;
    }
    mkdirSync(EFFIGENT_HOME, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`Synced ${uploaded} session(s), ${skipped} already up to date.`);
  });

program
  .command('doctor')
  .description('Check that effigent can capture, attribute, and (optionally) upload on this machine')
  .option('--server <url>', 'effigent server to check (env EFFIGENT_SERVER)')
  .option('--key <apiKey>', 'tenant API key to verify (env EFFIGENT_API_KEY)')
  .action(async (opts) => {
    let failures = 0;
    const ok = (msg: string) => console.log(`  ✓ ${msg}`);
    const warn = (msg: string) => console.log(`  ! ${msg}`);
    const bad = (msg: string) => {
      console.log(`  ✗ ${msg}`);
      failures++;
    };

    console.log('effigent doctor\n');

    const major = Number(process.versions.node.split('.')[0]);
    major >= 20 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} — need ≥ 20`);

    const claudeBin = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    claudeBin.status === 0
      ? ok(`claude CLI ${claudeBin.stdout.trim()}`)
      : warn('claude CLI not on PATH (fine if your agent bundles the Agent SDK)');

    for (const src of defaultSources()) {
      if (!existsSync(src)) {
        warn(`no transcript store at ${src} yet (created on first agent run)`);
        continue;
      }
      const sessions = discoverSessions(src);
      const recent = sessions.filter((s) => Date.now() - s.mtimeMs < 30 * 86_400_000);
      ok(`${src}: ${sessions.length} session(s), ${recent.length} in the last 30 days`);
    }

    const runs = loadRuns(defaultSources(), { sinceDays: 30, minSteps: 1 });
    runs.length > 0
      ? ok(`${runs.length} run(s) parse cleanly (${[...new Set(runs.map((r) => r.agentId))].length} agent id(s))`)
      : warn('no parseable runs in the last 30 days — run any Claude Code/Agent SDK agent first');

    const tags = Object.keys(loadAgentMap()).length;
    tags > 0
      ? ok(`${tags} session(s) explicitly attributed via effigent run/tag`)
      : warn('no explicit attributions yet — untagged runs fall back to their directory name');

    if (process.env.ANTHROPIC_API_KEY) ok('env auth: ANTHROPIC_API_KEY set (--isolated will work)');
    else if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX)
      ok('env auth: Bedrock/Vertex configured (--isolated will work)');
    else
      warn(
        'no env-based auth detected — `effigent run --isolated` needs ANTHROPIC_API_KEY (or Bedrock/Vertex); ' +
          'non-isolated capture works regardless',
      );

    const config = loadConfig();
    const server: string | undefined = opts.server ?? process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
    const apiKey: string | undefined = opts.key ?? process.env.EFFIGENT_API_KEY ?? config.apiKey;
    if (server) {
      try {
        const health = await fetch(`${server.replace(/\/$/, '')}/healthz`);
        health.ok ? ok(`server reachable: ${server}`) : bad(`server unhealthy: HTTP ${health.status}`);
        if (apiKey) {
          const auth = await fetch(`${server.replace(/\/$/, '')}/api/v1/reports`, {
            headers: { authorization: `Bearer ${apiKey}` },
          });
          auth.ok ? ok('API key accepted') : bad(`API key rejected: HTTP ${auth.status}`);
        } else {
          warn('no API key provided — skipping auth check (set EFFIGENT_API_KEY)');
        }
      } catch (err) {
        bad(`cannot reach ${server}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      warn('no server configured — local-only mode (set EFFIGENT_SERVER to check upload path)');
    }

    console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
    process.exitCode = failures === 0 ? 0 : 1;
  });

program
  .command('tag')
  .description('Attribute existing session(s) to a logical agentId (for external harnesses)')
  .requiredOption('--agent <id>', 'logical agent id')
  .argument('<sessionId...>', 'Claude Code session id(s) to tag')
  .action((sessionIds: string[], opts) => {
    tagSessions(sessionIds, opts.agent);
    console.log(`Tagged ${sessionIds.length} session(s) as ${opts.agent}`);
  });

program
  .command('run')
  .description(
    'Run ANY agent command tagged with an agentId (for CI/cron). Standalone: no changes ' +
      'to the wrapped agent — sessions written during the run are attributed and, with ' +
      '--server, uploaded straight from the runner (ephemeral-machine safe).',
  )
  .requiredOption('--agent <id>', 'logical agent id for this run')
  .option('--source <dir>', 'transcript directory to watch (non-isolated mode)', defaultSource())
  .option(
    '--isolated',
    'run with a private CLAUDE_CONFIG_DIR: exact attribution, safe for concurrent agents. ' +
      'Requires env-based auth (ANTHROPIC_API_KEY / Bedrock / Vertex) or file-based credentials; ' +
      'macOS keychain logins do not carry over.',
  )
  .option('--server <url>', 'effigent server to upload captured sessions to (env EFFIGENT_SERVER)')
  .option('--key <apiKey>', 'tenant API key for --server (env EFFIGENT_API_KEY)')
  .allowUnknownOption(true)
  .argument('<cmd...>', 'command to execute, e.g. -- claude -p "…" or -- node my-agent.js')
  .action(async (cmd: string[], opts) => {
    const argv = [...cmd];
    const config = loadConfig();
    const server: string | undefined = opts.server ?? process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
    const apiKey: string | undefined = opts.key ?? process.env.EFFIGENT_API_KEY ?? config.apiKey;
    if (server && !apiKey) {
      console.error('[effigent] --server requires --key (or EFFIGENT_API_KEY)');
      process.exitCode = 2;
      return;
    }

    // Precise path: direct `claude` invocations get a known --session-id up front.
    const preTagged: string[] = [];
    if (argv[0] === 'claude' && !argv.includes('--session-id')) {
      const sessionId = randomUUID();
      argv.splice(1, 0, '--session-id', sessionId);
      preTagged.push(sessionId);
    }

    const env = { ...process.env };
    let watchDir: string;
    let isoDir: string | undefined;
    if (opts.isolated) {
      // Private transcript store per run — exact attribution, concurrency-safe.
      isoDir = mkdtempSync(join(tmpdir(), 'effigent-run-'));
      env.CLAUDE_CONFIG_DIR = isoDir;
      // Carry over file-based credentials/state when present (Linux/CI).
      for (const f of ['.credentials.json']) {
        const src = join(homedir(), '.claude', f);
        if (existsSync(src)) copyFileSync(src, join(isoDir, f));
      }
      const stateFile = join(homedir(), '.claude.json');
      if (existsSync(stateFile)) copyFileSync(stateFile, join(isoDir, '.claude.json'));
      watchDir = join(isoDir, 'projects');
    } else {
      watchDir = resolve(opts.source);
    }

    // Snapshot → run → diff. In isolated mode the diff is exact; in shared mode,
    // concurrent sessions on this machine during the window are attributed too.
    const before = new Map(discoverSessions(watchDir).map((s) => [s.path, s.mtimeMs]));
    console.error(`[effigent] agent=${opts.agent}${opts.isolated ? ' isolated' : ''} watching=${watchDir}`);
    const res = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', env });

    const produced = discoverSessions(watchDir).filter((s) => {
      const prev = before.get(s.path);
      return prev === undefined || s.mtimeMs > prev;
    });
    const sessionIds = [...new Set([...preTagged, ...produced.map((s) => s.sessionId)])];

    // Local attribution for `effigent analyze`/`effigent sync` on this machine.
    // Per-session tag files — safe under concurrent wrappers.
    if (sessionIds.length > 0) tagSessions(sessionIds, opts.agent);

    // Cloud path: push transcripts off the (possibly ephemeral) machine now.
    if (server && apiKey) {
      let ok = 0;
      for (const s of produced) {
        const r = await uploadSessionFile({ server, apiKey }, s.path, s.sessionId, opts.agent);
        if (r.ok) ok++;
        else console.error(`[effigent] upload failed for ${s.sessionId}: HTTP ${r.status} ${r.detail ?? ''}`);
      }
      console.error(`[effigent] uploaded ${ok}/${produced.length} session(s) as ${opts.agent}`);
    }

    // Isolated transcripts would vanish with the temp dir — preserve them locally
    // so `effigent analyze` still sees them (defaultSources includes EFFIGENT_STORE).
    if (isoDir) {
      for (const s of produced) {
        const rel = s.path.slice(watchDir.length + 1);
        const dest = join(EFFIGENT_STORE, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(s.path, dest);
      }
      rmSync(isoDir, { recursive: true, force: true });
    }

    console.error(
      sessionIds.length > 0
        ? `[effigent] attributed ${sessionIds.length} session(s) to ${opts.agent}`
        : '[effigent] no sessions observed during the run',
    );
    process.exitCode = res.status ?? 1;
  });

const agentCmd = program.command('agent').description('Register agents and mint scoped capture keys');
agentCmd
  .command('add <name>')
  .description('Register an agent in your workspace and save its scoped capture key')
  .option('--harness <name>', 'harness label (e.g. claude-code, codex, hermes, langgraph)')
  .option('--server <url>', 'effigent server base URL (default: effigent login config)')
  .option('--key <apiKey>', 'tenant OWNER key (default: effigent login config)')
  .action(async (name: string, opts) => {
    const config = loadConfig();
    const server: string | undefined = opts.server ?? process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
    const apiKey: string | undefined = opts.key ?? process.env.EFFIGENT_API_KEY ?? config.apiKey;
    if (!server || !apiKey) {
      console.error('No server/key: run `effigent login` first (owner key), or pass --server/--key.');
      process.exitCode = 2;
      return;
    }
    let res: Response;
    try {
      res = await fetch(`${server.replace(/\/$/, '')}/api/v1/agents`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ name, harness: opts.harness }),
      });
    } catch (err) {
      console.error(`Cannot reach ${server}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      console.error(`Agent registration failed (HTTP ${res.status}): ${await res.text()}`);
      if (res.status === 403) console.error('Use your tenant key (from `effigent login`), not an agent-scoped capture key.');
      process.exitCode = 1;
      return;
    }
    const out = (await res.json()) as { agentId: string; apiKey: string };
    config.agents = { ...(config.agents ?? {}), [name]: { agentId: out.agentId, key: out.apiKey, harness: opts.harness } };
    saveConfig(config);
    const base = server.replace(/\/$/, '');
    console.log(`✓ registered agent '${name}' — scoped key saved to ${CONFIG_PATH}\n`);
    console.log('Capture options for this agent:');
    console.log(`  • Claude Code (this machine):  effigent install claude --agent ${name}`);
    console.log(`  • OpenAI Codex (this machine): effigent install codex --agent ${name}`);
    console.log('  • SDK / OpenLLMetry agent — export before running it:');
    console.log(`      export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${base}/v1/traces`);
    console.log('      export OTEL_EXPORTER_OTLP_PROTOCOL=http/json');
    console.log('      export OTEL_EXPORTER_OTLP_COMPRESSION=none');
    console.log(`      export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${out.apiKey}"`);
  });

agentCmd
  .command('list')
  .description('List agents registered from this machine (names, harness, key presence)')
  .action(() => {
    const config = loadConfig();
    const agents = Object.entries(config.agents ?? {});
    if (agents.length === 0) {
      console.log('No agents registered here yet — run `effigent agent add <name>`.');
      return;
    }
    for (const [name, a] of agents) {
      console.log(`  ${name.padEnd(28)} ${(a.harness ?? '—').padEnd(14)} key:${a.key ? '✓' : '✗'}  ${a.agentId}`);
    }
  });

const installCmd = program.command('install').description('Wire up capture on this machine for a registered agent');

/** OTLP env block for any OTel-capable harness, filled with the agent's real scoped key. */
function otelEnv(base: string, key: string): string {
  return [
    `export OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=${base}/v1/traces`,
    'export OTEL_EXPORTER_OTLP_PROTOCOL=http/json',
    'export OTEL_EXPORTER_OTLP_COMPRESSION=none',
    `export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer ${key}"`,
  ].join('\n');
}

/** Per-harness capture recipes. Adding a harness = adding one entry here. */
const OTEL_HARNESSES: Record<string, { title: string; render: (base: string, key: string) => string }> = {
  python: {
    title: 'Python agents — LangGraph / CrewAI / AutoGen / OpenAI Agents (OpenLLMetry)',
    // baseUrl/api_endpoint is the BASE — the SDK appends /v1/traces itself
    // (passing the full path double-appends → 404).
    render: (base, key) =>
      `pip install traceloop-sdk\n\n# once at startup — auto-instruments openai/anthropic + the frameworks:\nfrom traceloop.sdk import Traceloop\nTraceloop.init(\n    api_endpoint="${base}",\n    headers={"Authorization": "Bearer ${key}"},\n)`,
  },
  node: {
    title: 'Node / TS agents (OpenLLMetry)',
    // baseUrl is the BASE — @traceloop/node-server-sdk appends /v1/traces.
    render: (base, key) =>
      `npm i @traceloop/node-server-sdk\n\n// before your agent runs — auto-instruments the openai/anthropic clients:\nimport * as traceloop from "@traceloop/node-server-sdk";\ntraceloop.initialize({\n  baseUrl: "${base}",\n  headers: { Authorization: "Bearer ${key}" },\n  disableBatch: true,\n});`,
  },
  proxy: {
    title: 'Proxy fallback — any OpenAI-compatible agent you cannot instrument',
    render: (base, key) =>
      `# Start the local capturing gateway (forwards to OpenAI, mirrors each call to Effigent):\neffigent proxy --agent <name>\n\n# Point your agent's OpenAI client at it — no SDK, no code changes:\nexport OPENAI_BASE_URL=http://localhost:4319/v1\n# (your existing OPENAI_API_KEY still authenticates upstream; the proxy never stores it)\n\n# Reports to: ${base}/v1/traces  ·  Bearer ${key}`,
  },
  generic: {
    title: 'Any OTel-capable agent',
    render: (base, key) => otelEnv(base, key),
  },
};

function printOtelInstall(harness: string, agentName: string): void {
  const config = loadConfig();
  const entry = config.agents?.[agentName];
  const server: string | undefined = process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
  if (!entry || !server) {
    console.error(`Agent '${agentName}' not registered here — run \`effigent agent add ${agentName}\` first.`);
    process.exitCode = 2;
    return;
  }
  const recipe = OTEL_HARNESSES[harness] ?? OTEL_HARNESSES.generic;
  const base = server.replace(/\/$/, '');
  console.log(`# ${recipe.title} — capture as agent '${agentName}'\n`);
  console.log(recipe.render(base, entry.key));
  console.log('\n# Runs appear in the dashboard under this agent after the exporter flushes.');
}

installCmd
  .command('otel')
  .description('Print a ready-to-paste OTel capture setup (key filled in) for any harness')
  .requiredOption('--agent <name>', 'registered agent name (from `effigent agent add`)')
  .option('--harness <name>', `one of: ${Object.keys(OTEL_HARNESSES).join(', ')}`, 'generic')
  .action((opts) => printOtelInstall(opts.harness, opts.agent));

for (const harness of ['python', 'node', 'proxy'] as const) {
  installCmd
    .command(harness)
    .description(`Print the ${OTEL_HARNESSES[harness].title} setup for a registered agent`)
    .requiredOption('--agent <name>', 'registered agent name (from `effigent agent add`)')
    .action((opts) => printOtelInstall(harness, opts.agent));
}

// Codex configures OpenTelemetry ONLY through ~/.codex/config.toml — it ignores
// the standard OTEL_EXPORTER_OTLP_* env vars. So we write a scoped, clearly
// delimited [otel] block there. Never a shell profile / global env: a global
// OTEL_* block is inherited by every OTel-aware process (incl. Codex Desktop)
// and breaks their telemetry init at startup.
const CODEX_BEGIN = '# >>> effigent (managed) — delete this block to disable Effigent capture >>>';
const CODEX_END = '# <<< effigent (managed) <<<';

/** The managed `[otel]` block. Traces carry the DAG; logs carry token counts. */
function codexOtelBlock(base: string, key: string): string {
  const http = (path: string) =>
    `{ otlp-http = { endpoint = "${base}${path}", protocol = "json", headers = { Authorization = "Bearer ${key}" } } }`;
  return [
    CODEX_BEGIN,
    '[otel]',
    `trace_exporter = ${http('/v1/traces')}`,
    `exporter = ${http('/v1/logs')}`,
    'metrics_exporter = "none"',
    CODEX_END,
  ].join('\n');
}

installCmd
  .command('codex')
  .description('Wire up Codex capture: write a scoped [otel] block into ~/.codex/config.toml (no global env)')
  .requiredOption('--agent <name>', 'registered agent name (from `effigent agent add`)')
  .action((opts) => {
    const config = loadConfig();
    const entry = config.agents?.[opts.agent];
    const server: string | undefined = process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
    if (!entry || !server) {
      console.error(`Agent '${opts.agent}' not registered here — run \`effigent agent add ${opts.agent}\` first.`);
      process.exitCode = 2;
      return;
    }
    const base = server.replace(/\/$/, '');
    const block = codexOtelBlock(base, entry.key);
    const cfgPath = join(homedir(), '.codex', 'config.toml');
    const existing = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : '';

    if (existing.includes(CODEX_BEGIN)) {
      // Idempotent: replace the previously-written managed block in place.
      const start = existing.indexOf(CODEX_BEGIN);
      const end = existing.indexOf(CODEX_END, start) + CODEX_END.length;
      const next = existing.slice(0, start) + block + existing.slice(end);
      copyFileSync(cfgPath, `${cfgPath}.bak`);
      writeFileSync(cfgPath, next);
      console.log(`✓ updated the Effigent [otel] block in ${cfgPath} (backup: ${cfgPath}.bak)`);
    } else if (/^\s*\[otel[\].]/m.test(existing)) {
      // A hand-written [otel] table already exists — don't risk corrupting it
      // (TOML forbids a duplicate [otel] table). Print for manual merge.
      console.log(`Your ${cfgPath} already has an [otel] section. Merge these keys into it by hand:\n`);
      console.log(block);
      console.log('\n(Then fully restart Codex — OpenTelemetry initializes at launch.)');
      return;
    } else {
      mkdirSync(dirname(cfgPath), { recursive: true });
      if (existing) copyFileSync(cfgPath, `${cfgPath}.bak`);
      const next = existing.trim() ? `${existing.trimEnd()}\n\n${block}\n` : `${block}\n`;
      writeFileSync(cfgPath, next);
      console.log(`✓ wrote the Effigent [otel] block to ${cfgPath}${existing ? ` (backup: ${cfgPath}.bak)` : ''}`);
    }
    console.log('  Scoped to Codex only — no shell profile or global env is touched, so other apps (incl. Codex Desktop) are unaffected.');
    console.log('  Fully restart Codex, then run a task. Runs appear in the dashboard under this agent after the session ends.');
  });

installCmd
  .command('claude')
  .description('Install a Claude Code SessionEnd hook that uploads each finished session (event-driven; no polling)')
  .requiredOption('--agent <name>', 'registered agent name (from `effigent agent add`)')
  .action((opts) => {
    const config = loadConfig();
    if (!config.agents?.[opts.agent]) {
      console.error(`Agent '${opts.agent}' not found in config — run \`effigent agent add ${opts.agent}\` first.`);
      process.exitCode = 2;
      return;
    }
    const settingsPath = join(homedir(), '.claude', 'settings.json');
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsPath)) {
      try {
        settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
      } catch {
        console.error(`Could not parse ${settingsPath} — fix or remove it, then retry.`);
        process.exitCode = 1;
        return;
      }
    }
    // Absolute node + cli paths: hooks run without nvm/homebrew PATH. The scoped
    // key is NOT written here — the hook commands read it from ~/.effigent/config.json.
    const bin = `${process.execPath} ${resolve(process.argv[1])}`;
    const hooks = (settings.hooks ??= {}) as Record<string, unknown>;
    type HookGroup = { hooks?: Array<{ type?: string; command?: string }> };
    const addHook = (event: string, command: string, marker: string): boolean => {
      const groups = (Array.isArray(hooks[event]) ? hooks[event] : []) as HookGroup[];
      const already = groups.some((g) => (g.hooks ?? []).some((h) => typeof h.command === 'string' && h.command.includes(marker)));
      if (!already) {
        groups.push({ hooks: [{ type: 'command', command }] });
        hooks[event] = groups;
      }
      return !already;
    };
    const addedEnd = addHook('SessionEnd', `${bin} claude-hook --agent ${opts.agent}`, `claude-hook --agent ${opts.agent}`);
    // Auto-injection: every session start refreshes the optimization bundle +
    // skill (throttled + fail-open inside claude-refresh — never blocks work).
    const addedStart = addHook('SessionStart', `${bin} claude-refresh --agent ${opts.agent}`, `claude-refresh --agent ${opts.agent}`);
    if (!addedEnd && !addedStart) {
      console.log(`✓ hooks for '${opts.agent}' already present in ${settingsPath}`);
      return;
    }
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
    console.log(`✓ installed hooks for '${opts.agent}' in ${settingsPath}`);
    console.log('  SessionEnd → uploads each finished session · SessionStart → keeps the optimization bundle fresh (auto-injection).');
  });

program
  .command('claude-refresh')
  .description('(internal) Claude Code SessionStart hook — refreshes the optimization bundle + skill; throttled and fail-open')
  .requiredOption('--agent <name>', 'registered agent name')
  .action(async (opts) => {
    try {
      const bundleDir = join(EFFIGENT_HOME, 'bundles', slugify(opts.agent));
      const bundlePath = join(bundleDir, 'bundle.json');
      // Throttle: at most one refresh per 15 minutes.
      if (existsSync(bundlePath) && Date.now() - statSync(bundlePath).mtimeMs < 15 * 60_000) return;
      const config = loadConfig();
      const server: string | undefined = process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
      const apiKey: string | undefined = config.agents?.[opts.agent]?.key ?? config.apiKey;
      if (!server || !apiKey) return;
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 5000);
      const res = await fetch(
        `${server.replace(/\/$/, '')}/api/v1/optimize?agent=${encodeURIComponent(opts.agent)}&mark=1`,
        { headers: { authorization: `Bearer ${apiKey}` }, signal: ctl.signal },
      );
      clearTimeout(timer);
      if (!res.ok) return;
      const bundle = (await res.json()) as Bundle;
      mkdirSync(bundleDir, { recursive: true });
      writeFileSync(bundlePath, JSON.stringify(bundle, null, 2));
      const ready = bundle.tools.filter((t) => t.replay?.status === 'ready');
      writeFileSync(
        join(bundleDir, 'context.md'),
        renderSkill(bundle, new Set(ready.filter(isExecutable).map((t) => t.id)), 'context'),
      );
      if (ready.length > 0 || (bundle.knowledge?.worthIt ?? false)) {
        const executables = new Set(ready.filter(isExecutable).map((t) => t.id));
        const skillDir = join(homedir(), '.claude', 'skills', `effigent-${slugify(opts.agent)}`);
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(join(skillDir, 'SKILL.md'), renderSkill(bundle, executables));
        const kgFiles = writeOkfBundle(skillDir, bundle.okf);
        console.error(
          `[effigent] bundle refreshed: ${ready.length} tool(s), ${bundle.knowledge?.entries.length ?? 0} fact(s)` +
            (kgFiles ? `, ${kgFiles} OKF concept file(s)` : ''),
        );
      }
    } catch {
      /* fail-open — a refresh problem must never block a session */
    }
  });

program
  .command('claude-hook')
  .description('(internal) Claude Code SessionEnd hook — uploads the finished session for a scoped agent')
  .requiredOption('--agent <name>', 'registered agent name')
  .action(async (opts) => {
    const config = loadConfig();
    const entry = config.agents?.[opts.agent];
    const server: string | undefined = process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
    if (!entry || !server) {
      console.error(`[effigent] claude-hook: agent '${opts.agent}' or server not configured`);
      process.exitCode = 2;
      return;
    }
    let payload: { session_id?: string; transcript_path?: string };
    try {
      payload = JSON.parse(readFileSync(0, 'utf8')) as { session_id?: string; transcript_path?: string };
    } catch {
      console.error('[effigent] claude-hook: could not read hook JSON from stdin');
      process.exitCode = 1;
      return;
    }
    const { session_id: sessionId, transcript_path: transcriptPath } = payload;
    if (!sessionId || !transcriptPath || !existsSync(transcriptPath)) {
      console.error('[effigent] claude-hook: missing/unreadable session_id or transcript_path');
      process.exitCode = 1;
      return;
    }
    const r = await uploadSessionFile({ server, apiKey: entry.key }, transcriptPath, sessionId, opts.agent);
    console.error(
      r.ok
        ? `[effigent] uploaded session ${sessionId} as ${opts.agent}`
        : `[effigent] upload failed (HTTP ${r.status}) ${r.detail ?? ''}`,
    );
    process.exitCode = r.ok ? 0 : 1;
  });

/* ----------------------------------------------------------------------------
 * effigent optimize — the injection vehicle. Downloads the activation bundle
 * (replay-validated ToolSpecs + the knowledge graph) and installs it into the
 * running agent. For Claude Code that is a generated SKILL the agent loads:
 * known facts replace re-exploration (fewer greps), compiled procedures
 * replace recurring step chains. Standalone principle intact: nothing in the
 * agent's code changes — the skill is configuration.
 * The bundle is consumed as plain JSON on purpose: the engine stays
 * server-side and never enters the npm bundle (see check-bundle.mjs).
 * -------------------------------------------------------------------------- */

interface BundleKnowledgeEntry {
  kind: string; tool: string; key: string; value: string;
  support: number; confidence: number; estUsdPerRun: number;
}
interface BundleKnowledge {
  entries: BundleKnowledgeEntry[]; coverage: number; estUsdPerRun: number; worthIt: boolean;
}
interface BundleSubstitution {
  slot: number; kind: 'param' | 'derive'; param?: string; sourceColumn?: number; method?: string;
}
interface BundleToolStep {
  column: number; resultColumn?: number;
  tool: string; argTemplate: string; expectedOutputTemplate?: string;
  class: string; guarded: boolean; substitutions: BundleSubstitution[];
}
interface BundleTool {
  id: string; name: string; params: Array<{ name: string; type: string; source: string; examples: string[] }>;
  body: BundleToolStep[]; postcondition?: string;
  evidence: { runs: number; support: number };
  savings: { perRunUsd: number; windowUsd: number };
  replay?: { runsChecked: number; passRate: number; status: string };
}
interface Bundle {
  agentId: string; window: number; runCount: number; generatedAt?: string;
  tools: BundleTool[]; readyTools?: number; knowledge: BundleKnowledge | null;
  /** OKF (Open Knowledge Format) concept files, rendered server-side. */
  okf?: { path: string; content: string }[];
  /** The slim, budgeted knowledge actually injected in-context. */
  slimContext?: { markdown: string; factsIncluded: number; estTokens: number; estUsdPerRun: number } | null;
  drift?: { changed: boolean; changedAt?: string } | null; activatable?: boolean; note?: string;
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Write the server-rendered OKF bundle under a skill dir. Paths arrive as
 * `knowledge/…/x.md`; each segment is validated (no absolute paths, no `..`,
 * word chars only) so a malicious bundle can't escape the target directory.
 */
function writeOkfBundle(baseDir: string, okf?: { path: string; content: string }[]): number {
  if (!okf?.length) return 0;
  let n = 0;
  for (const f of okf) {
    const segs = f.path.split('/').filter((p) => p && p !== '..' && /^[\w.-]+$/.test(p));
    if (segs.length === 0 || typeof f.content !== 'string') continue;
    const full = join(baseDir, ...segs);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, f.content);
    n++;
  }
  return n;
}

/* --- deterministic executability ------------------------------------------
 * A tool is EXECUTABLE when code can run every step without an LLM: read-only
 * step classes, tools the executor implements, and only constructive
 * derivations (json:/line: reconstruct values; `substr` can merely verify).
 * Executable tools appear in the skill as ONE command — the LLM's entire job
 * is deciding to run it and reading the final answer.
 * -------------------------------------------------------------------------- */
const EXEC_TOOLS = new Set(['bash', 'read', 'glob', 'grep', 'ls', 'webfetch', 'web_fetch']);

function isExecutable(t: BundleTool): boolean {
  return (
    t.body.length > 0 &&
    t.body.every(
      (s) =>
        !s.guarded &&
        (s.class === 'mechanical' || s.class === 'cacheable') &&
        EXEC_TOOLS.has(s.tool.toLowerCase()) &&
        s.substitutions.every(
          (sub) =>
            sub.kind === 'param' ||
            (sub.kind === 'derive' && !!sub.method && (sub.method.startsWith('json:') || sub.method.startsWith('line:'))),
        ),
    )
  );
}

function paramUsage(t: BundleTool): string {
  return t.params.map((p) => `<${p.name}:${p.type}>`).join(' ');
}

function renderSkill(bundle: Bundle, executables: Set<string>, format: 'skill' | 'context' = 'skill'): string {
  const lines: string[] = [];
  if (format === 'skill') {
    lines.push('---');
    lines.push(`name: effigent-${slugify(bundle.agentId)}`);
    lines.push(
      `description: Auto-generated by Effigent for agent "${bundle.agentId}" — known facts and compiled tools from its last ${bundle.runCount} runs. Consult BEFORE exploring the repo; run compiled tools INSTEAD of performing their steps.`,
    );
    lines.push('---', '');
  }
  lines.push(`# Effigent — ${bundle.agentId}`);
  lines.push('');
  lines.push(
    `Generated ${bundle.generatedAt ?? 'now'} from the last ${bundle.runCount} runs. ` +
      'Do not edit — regenerate with `effigent optimize`.',
  );

  const ready = bundle.tools.filter((t) => t.replay?.status === 'ready');
  const exec = ready.filter((t) => executables.has(t.id));
  const recipes = ready.filter((t) => !executables.has(t.id));

  if (exec.length > 0) {
    lines.push('', '## Compiled tools — run these INSTEAD of performing the steps', '');
    lines.push(
      'Each command executes the whole recorded procedure deterministically in code — ' +
        'no reasoning, no intermediate results in context. It prints only the final answer.',
    );
    for (const t of exec) {
      lines.push('', `### ${t.name}`);
      lines.push('```', `effigent tool ${bundle.agentId} ${t.name}${t.params.length ? ` ${paramUsage(t)}` : ''}`.trim(), '```');
      for (const p of t.params) {
        lines.push(`- \`${p.name}\` (${p.type}, from ${p.source}) — e.g. \`${p.examples[0] ?? ''}\``);
      }
      if (t.postcondition) lines.push(`Returns: \`${t.postcondition.slice(0, 120).replace(/`/g, "'")}\``);
      lines.push(
        `_(${t.body.length} steps · validated ${t.replay!.runsChecked} replays at ${Math.round((t.replay!.passRate) * 100)}% · saves ~$${t.savings.perRunUsd}/run)_`,
      );
    }
  }

  if (recipes.length > 0) {
    lines.push('', '## Validated recipes (not yet executable as code)', '');
    lines.push('Follow exactly — the arguments are known in advance, so do not re-derive them.');
    for (const t of recipes) {
      lines.push('', `### ${t.name} — ${t.body.length} steps, saves ~$${t.savings.perRunUsd}/run`);
      t.body.forEach((s, i) => {
        lines.push(`${i + 1}. **${s.tool}**${s.guarded ? ' ⚠ side-effect — verify first' : ''} — \`${s.argTemplate.slice(0, 160).replace(/`/g, "'")}\``);
      });
    }
  }

  const slim = bundle.slimContext?.markdown?.trim();
  const facts = bundle.knowledge?.entries ?? [];
  if (slim) {
    // The smallest set of facts that stops re-exploration — pushed in-context.
    // The full graph (every fact + connections) stays on disk as OKF, read
    // on demand only for something not listed here.
    lines.push('', slim, '');
    if (bundle.okf?.length) {
      lines.push(
        'Full knowledge graph under `knowledge/` — open [`knowledge/index.md`](knowledge/index.md) ' +
          'ONLY if you need a fact not listed above.',
        '',
      );
    }
  } else if (facts.length > 0) {
    // Fallback for bundles without a slim context.
    lines.push('', '## Known facts — read these, do NOT re-run the lookups', '');
    for (const f of facts) {
      const key = f.key.replace(/`/g, "'").slice(0, 160);
      if (f.value.length <= 80 && !f.value.includes('\n')) {
        lines.push(`- ${f.kind} \`${key}\` → \`${f.value.replace(/`/g, "'")}\` _(${f.support}×)_`);
      } else {
        lines.push('', `### ${f.kind} · \`${key}\` _(${f.support}× stable)_`);
        lines.push('```', f.value, '```');
      }
    }
  }

  const shadow = bundle.tools.length - ready.length;
  if (shadow > 0) lines.push('', `_${shadow} candidate procedure(s) still in shadow validation — not installed._`);
  lines.push('');
  return lines.join('\n');
}

program
  .command('optimize')
  .description('Download the activation bundle (validated tools + knowledge graph) and install it into the running agent (Claude Code: a generated skill)')
  .argument('<agent>', 'registered agent name')
  .option('--server <url>', 'effigent server base URL (default: effigent login config)')
  .option('--key <apiKey>', 'capture key (default: the agent’s scoped key, then the tenant key)')
  .option('--out <dir>', 'bundle output directory (default ~/.effigent/bundles/<agent>)')
  .option('--no-install', 'write the bundle only — skip the Claude Code skill')
  .option('--codex [dir]', 'also inject into Codex: maintain a managed Effigent section in <dir>/AGENTS.md (default: cwd)')
  .option('--no-mark', 'do not stamp the agent as optimized')
  .action(async (agentName: string, opts) => {
    const config = loadConfig();
    const server: string | undefined = opts.server ?? process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
    const apiKey: string | undefined =
      opts.key ?? config.agents?.[agentName]?.key ?? process.env.EFFIGENT_API_KEY ?? config.apiKey;
    if (!server || !apiKey) {
      console.error('No server/key: run `effigent login` (or `effigent agent add`) first, or pass --server/--key.');
      process.exitCode = 2;
      return;
    }

    let res: Response;
    try {
      res = await fetch(
        `${server.replace(/\/$/, '')}/api/v1/optimize?agent=${encodeURIComponent(agentName)}${opts.mark === false ? '' : '&mark=1'}`,
        { headers: { authorization: `Bearer ${apiKey}` } },
      );
    } catch (err) {
      console.error(`Cannot reach ${server}: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
      return;
    }
    if (!res.ok) {
      console.error(`Optimize failed (HTTP ${res.status}): ${await res.text()}`);
      process.exitCode = 1;
      return;
    }
    const bundle = (await res.json()) as Bundle;
    if (bundle.note) console.log(`! ${bundle.note}`);

    const outDir = resolve(opts.out ?? join(EFFIGENT_HOME, 'bundles', slugify(agentName)));
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'bundle.json'), JSON.stringify(bundle, null, 2));
    // Harness-neutral injection surface: any agent (Python SDK, Docker, custom)
    // can load this straight into its system context.
    const allExec = new Set(
      bundle.tools.filter((t) => t.replay?.status === 'ready' && isExecutable(t)).map((t) => t.id),
    );
    writeFileSync(join(outDir, 'context.md'), renderSkill(bundle, allExec, 'context'));
    console.log(`✓ bundle written: ${join(outDir, 'bundle.json')} (+ context.md for SDK/Docker agents)`);

    if (opts.codex !== undefined) {
      // Codex reads AGENTS.md natively — maintain a managed section in place.
      const dir = resolve(typeof opts.codex === 'string' && opts.codex.length > 0 ? opts.codex : '.');
      const agentsPath = join(dir, 'AGENTS.md');
      const START = '<!-- effigent:start -->';
      const END = '<!-- effigent:end -->';
      const section = `${START}\n${renderSkill(bundle, allExec, 'context')}\n${END}`;
      let doc = existsSync(agentsPath) ? readFileSync(agentsPath, 'utf8') : '';
      if (doc.includes(START) && doc.includes(END)) {
        doc = doc.slice(0, doc.indexOf(START)) + section + doc.slice(doc.indexOf(END) + END.length);
      } else {
        doc = doc.trimEnd() + (doc ? '\n\n' : '') + section + '\n';
      }
      writeFileSync(agentsPath, doc);
      console.log(`✓ Codex injection: managed Effigent section in ${agentsPath}`);
    }

    const ready = bundle.tools.filter((t) => t.replay?.status === 'ready').length;
    const facts = bundle.knowledge?.entries.length ?? 0;
    console.log(
      `  ${ready} validated tool(s) · ${facts} knowledge fact(s)` +
        (bundle.knowledge ? ` covering ${Math.round((bundle.knowledge.coverage ?? 0) * 100)}% of exploration` : ''),
    );
    if (bundle.drift?.changed) {
      console.log(`  ⚠ recent behavior drift detected (${bundle.drift.changedAt ?? 'recently'}) — bundle reflects the newest window`);
    }

    if (opts.install !== false) {
      if (ready === 0 && !(bundle.knowledge?.worthIt ?? false)) {
        console.log('  nothing activatable yet — skill not installed (bundle.json kept for inspection)');
        return;
      }
      const executables = new Set(
        bundle.tools.filter((t) => t.replay?.status === 'ready' && isExecutable(t)).map((t) => t.id),
      );
      const skillDir = join(homedir(), '.claude', 'skills', `effigent-${slugify(agentName)}`);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(join(skillDir, 'SKILL.md'), renderSkill(bundle, executables));
      const kgFiles = writeOkfBundle(skillDir, bundle.okf);
      console.log(`✓ Claude Code skill installed: ${skillDir}`);
      if (kgFiles) console.log(`  ${kgFiles} OKF knowledge concept file(s) under knowledge/ — the agent navigates them from knowledge/index.md`);
      console.log(
        `  ${executables.size} tool(s) run as CODE via \`effigent tool\` — zero LLM tokens inside; ` +
          `${ready - executables.size} stay as recipes; facts replace re-exploration.`,
      );
      console.log('  SDK/OTel agents: load bundle.json programmatically (facts → system context, tools → functions).');
    }
  });

/* ----------------------------------------------------------------------------
 * effigent tool — the deterministic executor. Runs a compiled ToolSpec's body
 * entirely in code: read-only bash, file reads, globs, greps, fetches, with
 * derive() extractions computed from intermediate outputs that NEVER enter the
 * LLM's context. The agent's whole job: one decision + one final answer.
 * -------------------------------------------------------------------------- */

function extractDerived(raw: string, method: string): string {
  if (method.startsWith('json:')) {
    const path = method.slice(5);
    let v: unknown = JSON.parse(raw);
    if (path !== '') {
      for (const part of path.split('.')) {
        if (v === null || typeof v !== 'object') throw new Error(`json path ${path} not found`);
        v = (v as Record<string, unknown>)[part];
      }
    }
    if (v === null || v === undefined || typeof v === 'object') throw new Error(`json path ${path} not a scalar`);
    return String(v);
  }
  if (method.startsWith('line:')) {
    const k = Number(method.slice(5));
    const line = raw.split('\n')[k];
    if (line === undefined) throw new Error(`line ${k} out of range`);
    return line.trim();
  }
  throw new Error(`non-constructive derivation '${method}'`);
}

const jsonEscape = (v: string) => JSON.stringify(v).slice(1, -1);

function globToRegex(pattern: string): RegExp {
  const esc = pattern.replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '§§SLASH§§').replace(/\*\*/g, '§§ALL§§')
    .replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')
    .replace(/§§SLASH§§/g, '(?:.*/)?').replace(/§§ALL§§/g, '.*');
  return new RegExp(`^${esc}$`);
}

function* walkFiles(dir: string, depth = 0): Generator<string> {
  if (depth > 12) return;
  const entries = (() => { try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; } })();
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.next') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(p, depth + 1);
    else if (e.isFile()) yield p;
  }
}

async function execStep(tool: string, args: Record<string, unknown>): Promise<string> {
  const t = tool.toLowerCase();
  if (t === 'bash') {
    const cmd = String(args.command ?? '');
    const r = spawnSync('/bin/sh', ['-c', cmd], { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`command failed (${r.status}): ${(r.stderr || r.stdout || '').slice(0, 300)}`);
    return (r.stdout ?? '').slice(0, 100_000);
  }
  if (t === 'read') {
    return readFileSync(String(args.file_path ?? args.path ?? ''), 'utf8').slice(0, 100_000);
  }
  if (t === 'glob') {
    const pattern = String(args.pattern ?? '');
    const re = globToRegex(pattern);
    const out: string[] = [];
    for (const f of walkFiles(process.cwd())) {
      const rel = f.slice(process.cwd().length + 1);
      if (re.test(rel)) { out.push(rel); if (out.length >= 2000) break; }
    }
    return out.sort().join('\n');
  }
  if (t === 'grep' || t === 'ls') {
    if (t === 'ls') {
      const dir = String(args.path ?? '.');
      return readdirSync(resolve(dir)).sort().join('\n');
    }
    const pattern = String(args.pattern ?? '');
    let re: RegExp;
    try { re = new RegExp(pattern); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
    const root = resolve(String(args.path ?? '.'));
    const matches: string[] = [];
    for (const f of walkFiles(root)) {
      let text: string;
      try { text = readFileSync(f, 'utf8'); } catch { continue; }
      if (text.length > 1_000_000 || text.includes('\u0000')) continue;
      const rel = f.slice(process.cwd().length + 1) || f;
      text.split('\n').forEach((line, i) => {
        if (matches.length < 200 && re.test(line)) matches.push(`${rel}:${i + 1}:${line.slice(0, 200)}`);
      });
      if (matches.length >= 200) break;
    }
    return matches.join('\n');
  }
  if (t === 'webfetch' || t === 'web_fetch') {
    const res = await fetch(String(args.url ?? ''));
    if (!res.ok) throw new Error(`fetch failed: HTTP ${res.status}`);
    return (await res.text()).slice(0, 100_000);
  }
  throw new Error(`executor does not implement tool '${tool}'`);
}

program
  .command('tool')
  .description('Execute a compiled ToolSpec deterministically — code instead of LLM (prints only the final answer)')
  .argument('<agent>', 'agent name (bundle from `effigent optimize`)')
  .argument('<name>', 'tool name from the bundle')
  .argument('[params...]', 'parameter values, in the order listed by the skill')
  .option('-v, --verbose', 'print per-step trace to stderr')
  .action(async (agentName: string, toolName: string, params: string[], opts) => {
    const bundlePath = join(EFFIGENT_HOME, 'bundles', slugify(agentName), 'bundle.json');
    if (!existsSync(bundlePath)) {
      console.error(`No bundle for '${agentName}' — run \`effigent optimize ${agentName}\` first.`);
      process.exitCode = 2;
      return;
    }
    const bundle = JSON.parse(readFileSync(bundlePath, 'utf8')) as Bundle;
    const tool = bundle.tools.find((t) => t.name === toolName || t.id === toolName);
    if (!tool) {
      console.error(`Tool '${toolName}' not in the bundle. Available: ${bundle.tools.map((t) => t.name).join(', ') || '(none)'}`);
      process.exitCode = 2;
      return;
    }
    if (!isExecutable(tool)) {
      console.error(`'${toolName}' is not executable as code (side-effect or non-constructive derivation) — follow its recipe in the skill instead.`);
      process.exitCode = 2;
      return;
    }
    if (params.length < tool.params.length) {
      console.error(`Missing parameters. Usage: effigent tool ${agentName} ${tool.name} ${paramUsage(tool)}`);
      process.exitCode = 2;
      return;
    }
    const paramValues = new Map(tool.params.map((p, i) => [p.name, params[i]]));

    const outputs = new Map<number, string>();
    let final = '';
    for (const step of tool.body) {
      // Resolve ${pN} and ${derive(cN.method)} markers, JSON-escaped (the
      // template is a canonicalized JSON payload).
      const argJson = step.argTemplate.replace(/\$\{([^}]+)\}/g, (_m, token: string) => {
        const d = token.match(/^derive\(c(\d+)\.(.+)\)$/);
        if (d) {
          const src = outputs.get(Number(d[1]));
          if (src === undefined) throw new Error(`step ${step.column}: derivation source c${d[1]} not yet executed`);
          return jsonEscape(extractDerived(src, d[2]));
        }
        const v = paramValues.get(token);
        if (v === undefined) throw new Error(`step ${step.column}: unbound parameter ${token}`);
        return jsonEscape(v);
      });
      let args: Record<string, unknown>;
      try {
        args = JSON.parse(argJson) as Record<string, unknown>;
      } catch {
        throw new Error(`step ${step.column}: resolved arguments are not valid JSON: ${argJson.slice(0, 200)}`);
      }
      if (opts.verbose) console.error(`→ ${step.tool} ${JSON.stringify(args).slice(0, 200)}`);
      const out = await execStep(step.tool, args);
      outputs.set(step.resultColumn ?? step.column + 1, out);
      final = out;
      if (step.expectedOutputTemplate && !step.expectedOutputTemplate.includes('⟨·⟩')) {
        const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
        if (norm(out) !== norm(step.expectedOutputTemplate)) {
          console.error(`⚠ step ${step.column}: output differs from the validated expectation — repo/world state may have changed; consider re-running \`effigent optimize\`.`);
        }
      }
    }
    process.stdout.write(final.endsWith('\n') ? final : `${final}\n`);
  });

/* ----------------------------------------------------------------------------
 * effigent proxy — the capture FALLBACK for agents you cannot instrument.
 * A local OpenAI-compatible gateway: point the agent's OPENAI_BASE_URL at it,
 * it forwards every call to the real upstream (the client's own key travels
 * through untouched — never stored) and mirrors each chat completion to the
 * collector as an OTLP GenAI span. No SDK, no code changes.
 * Limitation: only what flows through the LLM endpoint is seen — tool
 * executions happen in the agent, not the proxy (same as OTel without tool
 * instrumentation). Streaming calls are forwarded transparently; usage is
 * captured only when the stream includes it.
 * -------------------------------------------------------------------------- */
function hex(bytes: number): string {
  return createHash('sha256').update(`${randomUUID()}:${bytes}`).digest('hex').slice(0, bytes * 2);
}

program
  .command('proxy')
  .description('Run a local OpenAI-compatible capturing gateway (capture fallback for un-instrumentable agents)')
  .requiredOption('--agent <name>', 'registered agent name (attribution)')
  .option('--port <n>', 'local port to listen on', '4319')
  .option('--upstream <url>', 'upstream OpenAI-compatible base', 'https://api.openai.com')
  .option('--server <url>', 'effigent collector (default: login config)')
  .option('--key <apiKey>', 'capture key (default: the agent’s scoped key, then tenant key)')
  .action(async (opts) => {
    const { createServer } = await import('node:http');
    const { Readable } = await import('node:stream');
    const config = loadConfig();
    const server: string | undefined = opts.server ?? process.env.EFFIGENT_SERVER ?? config.server ?? DEFAULT_SERVER;
    const apiKey: string | undefined = opts.key ?? config.agents?.[opts.agent]?.key ?? config.apiKey;
    if (!server || !apiKey) {
      console.error('No server/key: run `effigent login` / `effigent agent add` first, or pass --server/--key.');
      process.exitCode = 2;
      return;
    }
    const collector = `${server.replace(/\/$/, '')}/v1/traces`;
    const upstream = opts.upstream.replace(/\/$/, '');
    const port = Number(opts.port);
    const sessionId = `proxy-${randomUUID()}`; // one run per proxy lifetime
    const traceId = hex(16);

    // Fire-and-forget OTLP emission — capture must never slow the agent.
    const emit = (model: string, startMs: number, endMs: number, promptText: string, completion: string, usage?: { input: number; output: number; cached?: number }, isError?: boolean) => {
      const attributes: Array<{ key: string; value: Record<string, unknown> }> = [
        { key: 'gen_ai.conversation.id', value: { stringValue: sessionId } },
        { key: 'gen_ai.operation.name', value: { stringValue: 'chat' } },
        { key: 'gen_ai.provider.name', value: { stringValue: 'openai' } },
        { key: 'gen_ai.request.model', value: { stringValue: model } },
        { key: 'gen_ai.response.model', value: { stringValue: model } },
        { key: 'gen_ai.prompt', value: { stringValue: promptText.slice(0, 8000) } },
        { key: 'gen_ai.completion', value: { stringValue: completion.slice(0, 8000) } },
      ];
      if (usage) {
        attributes.push({ key: 'gen_ai.usage.input_tokens', value: { intValue: usage.input } });
        attributes.push({ key: 'gen_ai.usage.output_tokens', value: { intValue: usage.output } });
        if (usage.cached) attributes.push({ key: 'gen_ai.usage.cached_tokens', value: { intValue: usage.cached } });
      }
      const body = { resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: opts.agent } }] }, scopeSpans: [{ spans: [{
        traceId, spanId: hex(8), name: `chat ${model}`,
        startTimeUnixNano: `${startMs}000000`, endTimeUnixNano: `${endMs}000000`,
        status: isError ? { code: 2 } : undefined,
        attributes,
      }] }] }] };
      fetch(collector, { method: 'POST', headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .catch(() => {/* fail-open */});
    };

    const promptOf = (reqJson: { messages?: Array<{ role?: string; content?: unknown }> }) => {
      const msgs = reqJson.messages ?? [];
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
      return typeof lastUser?.content === 'string' ? lastUser.content : JSON.stringify(lastUser?.content ?? '');
    };

    const srv = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', async () => {
        const bodyBuf = Buffer.concat(chunks);
        const isChat = (req.url ?? '').includes('/chat/completions') && req.method === 'POST';
        const startMs = Date.now();
        const headers: Record<string, string> = {};
        if (req.headers['authorization']) headers['authorization'] = req.headers['authorization'] as string;
        if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'] as string;
        let up: Response;
        try {
          up = await fetch(`${upstream}${req.url}`, { method: req.method, headers, body: bodyBuf.length ? bodyBuf : undefined });
        } catch (err) {
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: `proxy upstream unreachable: ${err instanceof Error ? err.message : err}` }));
          return;
        }
        res.writeHead(up.status, { 'content-type': up.headers.get('content-type') ?? 'application/json' });

        let reqJson: Record<string, unknown> = {};
        try { reqJson = JSON.parse(bodyBuf.toString('utf8')); } catch { /* non-JSON passthrough */ }
        const streaming = reqJson.stream === true;

        if (isChat && !streaming) {
          const text = await up.text();
          res.end(text);
          try {
            const j = JSON.parse(text) as {
              model?: string;
              choices?: Array<{ message?: { content?: string; tool_calls?: unknown } }>;
              usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
            };
            const model = j.model ?? String(reqJson.model ?? 'unknown');
            const content = j.choices?.[0]?.message?.content ?? (j.choices?.[0]?.message?.tool_calls ? '[tool_calls]' : '');
            const u = j.usage
              ? { input: j.usage.prompt_tokens ?? 0, output: j.usage.completion_tokens ?? 0, cached: j.usage.prompt_tokens_details?.cached_tokens }
              : undefined;
            emit(model, startMs, Date.now(), promptOf(reqJson), content, u, up.status >= 400);
          } catch { /* couldn't parse — still forwarded to the client */ }
        } else if (up.body) {
          // Streaming or non-chat: forward transparently.
          Readable.fromWeb(up.body as WebReadableStream).pipe(res);
          if (isChat) emit(String(reqJson.model ?? 'unknown'), startMs, Date.now(), promptOf(reqJson), '[streamed]', undefined, up.status >= 400);
        } else {
          res.end();
        }
      });
    });
    srv.listen(port, () => {
      console.error(`[effigent] proxy listening on http://localhost:${port}  →  ${upstream}`);
      console.error(`[effigent] point your agent at it:  export OPENAI_BASE_URL=http://localhost:${port}/v1`);
      console.error(`[effigent] capturing as agent '${opts.agent}' (session ${sessionId.slice(0, 20)}…). Ctrl-C to stop.`);
    });
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
