import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface UsageSession {
  name: string;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  lastActive: string;
}

let cache: { data: UsageSession[]; ts: number } | null = null;
const CACHE_MS = 30_000;
let ccusagePath: string | null = null;

/**
 * Finds the ccusage binary by searching common paths.
 * Needed because Obsidian's Electron process doesn't inherit shell PATH (nvm, etc).
 */
function findCcusage(): string | null {
  if (ccusagePath !== null) return ccusagePath;

  const candidates: string[] = [];

  // 1. Try 'which ccusage' (works if PATH is inherited)
  try {
    const resolved = execSync('which ccusage 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (resolved) { ccusagePath = resolved; return resolved; }
  } catch { /* ignore */ }

  // 2. Check nvm paths
  const home = os.homedir();
  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  if (fs.existsSync(nvmDir)) {
    try {
      const versions = fs.readdirSync(path.join(nvmDir, 'versions', 'node'));
      for (const ver of versions.reverse()) {
        const candidate = path.join(nvmDir, 'versions', 'node', ver, 'bin', 'ccusage');
        if (fs.existsSync(candidate)) { ccusagePath = candidate; return candidate; }
      }
    } catch { /* ignore */ }
  }

  // 3. Check common global npm paths
  const npmGlobalPaths = [
    path.join(home, '.npm-global', 'bin', 'ccusage'),
    '/usr/local/bin/ccusage',
    '/opt/homebrew/bin/ccusage',
    path.join(home, '.local', 'bin', 'ccusage'),
  ];
  for (const p of npmGlobalPaths) {
    if (fs.existsSync(p)) { ccusagePath = p; return p; }
  }

  ccusagePath = null;
  return null;
}

/**
 * Fetches usage data from ccusage blocks CLI.
 */
export async function fetchUsage(): Promise<UsageSession[]> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_MS) {
    return cache.data;
  }

  const binary = findCcusage();
  if (!binary) {
    return cache?.data ?? [];
  }

  try {
    const output = execSync(`"${binary}" blocks --json`, {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const data = JSON.parse(output) as Record<string, unknown>;
    const blocks = (data.blocks ?? []) as Record<string, unknown>[];

    const sessions: UsageSession[] = blocks
      .filter((b) => !b.isGap)
      .map((b) => {
        const tc = (b.tokenCounts ?? {}) as Record<string, unknown>;
        return {
          name: (b.id as string) ?? 'unknown',
          models: Array.isArray(b.models) ? (b.models as string[]) : [],
          inputTokens: Number(tc.inputTokens ?? 0),
          outputTokens: Number(tc.outputTokens ?? 0),
          totalTokens: Number(b.totalTokens ?? 0),
          cost: Number(b.costUSD ?? 0),
          lastActive: (b.actualEndTime ?? b.startTime ?? '') as string,
        };
      });

    cache = { data: sessions, ts: now };
    return sessions;
  } catch {
    return cache?.data ?? [];
  }
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n}`;
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

export function renderUsagePanel(container: HTMLElement, sessions: UsageSession[]) {
  container.empty();

  if (sessions.length === 0) {
    const ccusage = findCcusage();
    container.createDiv({
      cls: 'claudian-usage-empty',
      text: ccusage
        ? 'No usage data available.'
        : 'ccusage not found. Install it with: npm i -g ccusage',
    });
    return;
  }

  // Summary
  const totalCost = sessions.reduce((s, x) => s + x.cost, 0);
  const totalTokens = sessions.reduce((s, x) => s + x.totalTokens, 0);

  const summaryEl = container.createDiv({ cls: 'claudian-usage-summary' });
  summaryEl.createDiv({ cls: 'claudian-usage-summary-item', text: `Total cost: ${fmtCost(totalCost)}` });
  summaryEl.createDiv({ cls: 'claudian-usage-summary-item', text: `Total tokens: ${fmtTokens(totalTokens)}` });
  summaryEl.createDiv({ cls: 'claudian-usage-summary-item', text: `Sessions: ${sessions.length}` });

  // Session list
  const listEl = container.createDiv({ cls: 'claudian-usage-list' });
  for (const sess of sessions) {
    const item = listEl.createDiv({ cls: 'claudian-usage-item' });

    const header = item.createDiv({ cls: 'claudian-usage-item-header' });
    header.createDiv({ cls: 'claudian-usage-item-name', text: sess.name });
    header.createDiv({ cls: 'claudian-usage-item-cost', text: fmtCost(sess.cost) });

    const meta = item.createDiv({ cls: 'claudian-usage-item-meta' });
    meta.createDiv({
      cls: 'claudian-usage-item-tokens',
      text: `↑ ${fmtTokens(sess.inputTokens)} · ↓ ${fmtTokens(sess.outputTokens)} · Σ ${fmtTokens(sess.totalTokens)}`,
    });
    if (sess.models.length > 0) {
      meta.createDiv({ cls: 'claudian-usage-item-models', text: sess.models.join(', ') });
    }
    meta.createDiv({ cls: 'claudian-usage-item-time', text: fmtDate(sess.lastActive) });
  }
}
