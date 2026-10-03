import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startGateway, type GatewayRecord } from './gateway.js';
import { EFFIGENT_HOME } from './store.js';

/**
 * `effigent claude [args…]` — run Claude Code through the local Effigent gateway.
 * Starts the gateway on 127.0.0.1, launches `claude` with ANTHROPIC_BASE_URL
 * pointing at it, and lives exactly as long as Claude Code does. The terminal
 * belongs to Claude Code's TUI while it runs: one line before, the summary after,
 * nothing in between (diagnostics go to ~/.effigent/gateway.log with --debug).
 */

export const GATEWAY_LOG = join(EFFIGENT_HOME, 'gateway.log');

export interface LaunchOptions {
  args: string[];
  /** Write per-request header names + identity to GATEWAY_LOG. */
  debug: boolean;
  onRecord?: (r: GatewayRecord) => void;
  /** Runs after Claude Code exits, before the gateway closes. */
  onExit?: () => Promise<void> | void;
  /** One line printed before launch. */
  banner?: string;
  claudeBin?: string;
}

/** Claude Code applies settings.json `env` over the process env, so a base URL set
 *  there would bypass the gateway without any error. */
export function settingsBaseUrl(): string | undefined {
  for (const p of [join(homedir(), '.claude', 'settings.json'), join(process.cwd(), '.claude', 'settings.json'), join(process.cwd(), '.claude', 'settings.local.json')]) {
    try {
      const env = (JSON.parse(readFileSync(p, 'utf8')) as { env?: Record<string, string> }).env;
      if (env?.ANTHROPIC_BASE_URL) return `${env.ANTHROPIC_BASE_URL} (${p})`;
    } catch {
      /* absent or unreadable */
    }
  }
  return undefined;
}

export async function launchClaude(opts: LaunchOptions): Promise<number> {
  const upstream = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
  const log = opts.debug
    ? (line: string) => {
        try {
          mkdirSync(EFFIGENT_HOME, { recursive: true });
          appendFileSync(GATEWAY_LOG, `${new Date().toISOString()} ${line}\n`);
        } catch {
          /* logging is best-effort */
        }
      }
    : undefined;

  const gw = await startGateway({
    upstream,
    log,
    onRecord: (r) => {
      try {
        opts.onRecord?.(r);
      } catch (err) {
        log?.(`record error: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
  // The gateway must outlive anything Claude Code does to the process group.
  const keepServing = (err: unknown) => log?.(`uncaught: ${err instanceof Error ? err.stack : String(err)}`);
  process.on('uncaughtException', keepServing);

  const shadowed = settingsBaseUrl();
  if (shadowed) {
    console.error(`[effigent] ⚠ ANTHROPIC_BASE_URL is set in Claude Code settings: ${shadowed}`);
    console.error('[effigent]   Claude Code will use it instead of the gateway; remove it to route through Effigent.');
  }
  if (opts.banner) console.error(opts.banner);

  const child = spawn(opts.claudeBin ?? 'claude', opts.args, {
    stdio: 'inherit',
    env: { ...process.env, ANTHROPIC_BASE_URL: gw.url },
  });
  // Ctrl-C reaches the whole process group: Claude Code handles it; we must not die.
  const ignore = () => {};
  const forward = (sig: NodeJS.Signals) => () => child.kill(sig);
  const onTerm = forward('SIGTERM');
  const onHup = forward('SIGHUP');
  process.on('SIGINT', ignore);
  process.on('SIGTERM', onTerm);
  process.on('SIGHUP', onHup);

  const code = await new Promise<number>((resolve) => {
    child.on('error', (err) => {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      console.error(missing ? '[effigent] `claude` not found on PATH — install Claude Code first.' : `[effigent] could not start claude: ${err.message}`);
      resolve(127);
    });
    child.on('exit', (c, signal) => resolve(c ?? (signal ? 128 + (signal === 'SIGINT' ? 2 : 15) : 0)));
  });

  process.off('SIGINT', ignore);
  process.off('SIGTERM', onTerm);
  process.off('SIGHUP', onHup);
  try {
    await opts.onExit?.();
  } finally {
    await gw.close();
    process.off('uncaughtException', keepServing);
  }
  return code;
}
