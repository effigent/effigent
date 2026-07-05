#!/usr/bin/env node
/**
 * ccopt — The Agent Waste Report CLI.
 *
 *   ccopt analyze   local-only mode: engine + report on your own transcripts
 *   ccopt sync      upload session transcripts to the hosted service
 *   ccopt run       headless wrapper tagging a Claude Code run with an agentId
 */

import { Command } from 'commander';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { analyzeRuns, renderReportHtml } from '@ccopt/core';
import {
  CCOPT_HOME,
  CCOPT_STORE,
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
program.name('ccopt').description('ccopt — graph-based agent waste detection').version('0.1.0');

program
  .command('analyze')
  .description('Analyze local Claude Code transcripts and render the Waste Report')
  .option('--source <dir...>', 'transcript directories', defaultSources())
  .option('--days <n>', 'analysis window in days', '30')
  .option('--agent <substr>', 'only include agents whose id contains this substring')
  .option('--min-steps <n>', 'ignore trivial sessions with fewer steps', '3')
  .option('--out <file>', 'HTML report output path', 'ccopt-report.html')
  .option('--json <file>', 'JSON report output path', 'ccopt-report.json')
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
  .description('Persist the ccopt server + API key (used as defaults by sync/run/doctor)')
  .requiredOption('--server <url>', 'ccopt server base URL')
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
      console.error('Run `ccopt login` first — invite packages your server + key.');
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
      `  curl -fsSL https://raw.githubusercontent.com/SpectorHacked/ccopt/main/install.sh | sh -s -- --join ${encoded}\n`,
    );
    console.log('It installs ccopt, joins this workspace, schedules a 15-minute sync, and uploads their history.');
  });

program
  .command('join')
  .description('Join a workspace from an invite token: config + schedule + first sync, in one shot')
  .argument('<token>', 'setup token from `ccopt invite`')
  .action(async (rawToken: string) => {
    let token: SetupToken;
    try {
      token = JSON.parse(Buffer.from(rawToken, 'base64url').toString('utf8')) as SetupToken;
      if (token.v !== 1 || !token.server || !token.apiKey) throw new Error('missing fields');
    } catch {
      console.error('Invalid setup token. Ask for a fresh one via `ccopt invite`.');
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

    // Schedule the recurring sync with THIS node + THIS ccopt (absolute paths:
    // launchd/cron have no nvm/homebrew PATH).
    const nodeBin = process.execPath;
    const ccoptBin = resolve(process.argv[1]);
    const syncArgs = ['sync', ...(token.syncAgent ? ['--agent', token.syncAgent] : []), '--days', '7'];

    if (process.platform === 'darwin') {
      const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.ccopt.sync.plist');
      const args = [nodeBin, ccoptBin, ...syncArgs];
      const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.ccopt.sync</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${a}</string>`).join('\n')}
  </array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${join(CCOPT_HOME, 'sync.log')}</string>
  <key>StandardErrorPath</key><string>${join(CCOPT_HOME, 'sync.log')}</string>
</dict>
</plist>
`;
      mkdirSync(dirname(plistPath), { recursive: true });
      mkdirSync(CCOPT_HOME, { recursive: true });
      writeFileSync(plistPath, plist);
      const uid = process.getuid?.() ?? 501;
      spawnSync('launchctl', ['bootout', `gui/${uid}/com.ccopt.sync`], { stdio: 'ignore' });
      const boot = spawnSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { encoding: 'utf8' });
      console.log(
        boot.status === 0
          ? '✓ scheduled: launchd job com.ccopt.sync (every 15 min)'
          : `! could not load launchd job (${boot.stderr?.trim()}) — plist written to ${plistPath}`,
      );
    } else {
      const cronLine = `*/15 * * * * ${nodeBin} ${ccoptBin} ${syncArgs.join(' ')} >> ${join(CCOPT_HOME, 'sync.log')} 2>&1`;
      const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' });
      const existing = current.status === 0 ? current.stdout : '';
      if (existing.includes('ccopt') && existing.includes('sync')) {
        console.log('✓ scheduled: crontab already has a ccopt sync entry');
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
    const first = spawnSync(nodeBin, [ccoptBin, ...syncArgs, '--days', '30'], { stdio: 'inherit' });
    console.log(
      first.status === 0
        ? '\nDone. This machine now reports to the workspace continuously.'
        : '\nSetup saved; first sync failed (see above) — the schedule will retry every 15 minutes.',
    );
  });

program
  .command('sync')
  .description('Upload local session transcripts to the ccopt service')
  .option('--server <url>', 'ccopt server base URL (default: ccopt login config)')
  .option('--key <apiKey>', 'tenant API key (default: ccopt login config)')
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
    const server: string | undefined = opts.server ?? process.env.CCOPT_SERVER ?? config.server;
    const apiKey: string | undefined = opts.key ?? process.env.CCOPT_API_KEY ?? config.apiKey;
    if (!server || !apiKey) {
      console.error('No server/key: pass --server/--key, set CCOPT_SERVER/CCOPT_API_KEY, or run `ccopt login`.');
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
        'Nothing to sync. (Only attributed sessions upload — add an agentRule, use `ccopt tag`/`ccopt run`, or pass --all.)',
      );
      return;
    }
    // State is per server+key: the same session must upload once per tenant,
    // not once globally (switching tenants must not silently skip history).
    const target = createHash('sha256').update(`${server}|${apiKey}`).digest('hex').slice(0, 12);
    const statePath = `${CCOPT_HOME}/sync-state-${target}.json`;
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
    mkdirSync(CCOPT_HOME, { recursive: true });
    writeFileSync(statePath, JSON.stringify(state, null, 2));
    console.log(`Synced ${uploaded} session(s), ${skipped} already up to date.`);
  });

program
  .command('doctor')
  .description('Check that ccopt can capture, attribute, and (optionally) upload on this machine')
  .option('--server <url>', 'ccopt server to check (env CCOPT_SERVER)')
  .option('--key <apiKey>', 'tenant API key to verify (env CCOPT_API_KEY)')
  .action(async (opts) => {
    let failures = 0;
    const ok = (msg: string) => console.log(`  ✓ ${msg}`);
    const warn = (msg: string) => console.log(`  ! ${msg}`);
    const bad = (msg: string) => {
      console.log(`  ✗ ${msg}`);
      failures++;
    };

    console.log('ccopt doctor\n');

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
      ? ok(`${tags} session(s) explicitly attributed via ccopt run/tag`)
      : warn('no explicit attributions yet — untagged runs fall back to their directory name');

    if (process.env.ANTHROPIC_API_KEY) ok('env auth: ANTHROPIC_API_KEY set (--isolated will work)');
    else if (process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX)
      ok('env auth: Bedrock/Vertex configured (--isolated will work)');
    else
      warn(
        'no env-based auth detected — `ccopt run --isolated` needs ANTHROPIC_API_KEY (or Bedrock/Vertex); ' +
          'non-isolated capture works regardless',
      );

    const config = loadConfig();
    const server: string | undefined = opts.server ?? process.env.CCOPT_SERVER ?? config.server;
    const apiKey: string | undefined = opts.key ?? process.env.CCOPT_API_KEY ?? config.apiKey;
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
          warn('no API key provided — skipping auth check (set CCOPT_API_KEY)');
        }
      } catch (err) {
        bad(`cannot reach ${server}: ${err instanceof Error ? err.message : err}`);
      }
    } else {
      warn('no server configured — local-only mode (set CCOPT_SERVER to check upload path)');
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
  .option('--server <url>', 'ccopt server to upload captured sessions to (env CCOPT_SERVER)')
  .option('--key <apiKey>', 'tenant API key for --server (env CCOPT_API_KEY)')
  .allowUnknownOption(true)
  .argument('<cmd...>', 'command to execute, e.g. -- claude -p "…" or -- node my-agent.js')
  .action(async (cmd: string[], opts) => {
    const argv = [...cmd];
    const config = loadConfig();
    const server: string | undefined = opts.server ?? process.env.CCOPT_SERVER ?? config.server;
    const apiKey: string | undefined = opts.key ?? process.env.CCOPT_API_KEY ?? config.apiKey;
    if (server && !apiKey) {
      console.error('[ccopt] --server requires --key (or CCOPT_API_KEY)');
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
      isoDir = mkdtempSync(join(tmpdir(), 'ccopt-run-'));
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
    console.error(`[ccopt] agent=${opts.agent}${opts.isolated ? ' isolated' : ''} watching=${watchDir}`);
    const res = spawnSync(argv[0], argv.slice(1), { stdio: 'inherit', env });

    const produced = discoverSessions(watchDir).filter((s) => {
      const prev = before.get(s.path);
      return prev === undefined || s.mtimeMs > prev;
    });
    const sessionIds = [...new Set([...preTagged, ...produced.map((s) => s.sessionId)])];

    // Local attribution for `ccopt analyze`/`ccopt sync` on this machine.
    // Per-session tag files — safe under concurrent wrappers.
    if (sessionIds.length > 0) tagSessions(sessionIds, opts.agent);

    // Cloud path: push transcripts off the (possibly ephemeral) machine now.
    if (server && apiKey) {
      let ok = 0;
      for (const s of produced) {
        const r = await uploadSessionFile({ server, apiKey }, s.path, s.sessionId, opts.agent);
        if (r.ok) ok++;
        else console.error(`[ccopt] upload failed for ${s.sessionId}: HTTP ${r.status} ${r.detail ?? ''}`);
      }
      console.error(`[ccopt] uploaded ${ok}/${produced.length} session(s) as ${opts.agent}`);
    }

    // Isolated transcripts would vanish with the temp dir — preserve them locally
    // so `ccopt analyze` still sees them (defaultSources includes CCOPT_STORE).
    if (isoDir) {
      for (const s of produced) {
        const rel = s.path.slice(watchDir.length + 1);
        const dest = join(CCOPT_STORE, rel);
        mkdirSync(dirname(dest), { recursive: true });
        copyFileSync(s.path, dest);
      }
      rmSync(isoDir, { recursive: true, force: true });
    }

    console.error(
      sessionIds.length > 0
        ? `[ccopt] attributed ${sessionIds.length} session(s) to ${opts.agent}`
        : '[ccopt] no sessions observed during the run',
    );
    process.exitCode = res.status ?? 1;
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
