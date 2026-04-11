import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';

const execAsync = promisify(exec);

export interface CurrentUsage {
  sessionId: string;
  models: string[];
  isActive: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  cost: number;
  startTime: string;
  endTime: string;
}

let resolvedNode: string | null = null;
let resolvedCcusage: string | null = null;
let lastResult: CurrentUsage | null = null;
let lastFetch = 0;
const CACHE_MS = 10_000;

function findBinaries(): { node: string; ccusage: string } | null {
  if (resolvedNode && resolvedCcusage) return { node: resolvedNode, ccusage: resolvedCcusage };

  const home = os.homedir();
  try {
    const node = execSync('which node 2>/dev/null', { encoding: 'utf-8', timeout: 2000 }).trim();
    const cc = execSync('which ccusage 2>/dev/null', { encoding: 'utf-8', timeout: 2000 }).trim();
    if (node && cc && fs.existsSync(node) && fs.existsSync(cc)) {
      resolvedNode = node; resolvedCcusage = cc;
      return { node, ccusage: cc };
    }
  } catch { /* ignore */ }

  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  if (fs.existsSync(nvmDir)) {
    try {
      const vDir = path.join(nvmDir, 'versions', 'node');
      const versions = fs.readdirSync(vDir).reverse();
      for (const ver of versions) {
        const b = path.join(vDir, ver, 'bin');
        const np = path.join(b, 'node');
        const cp = path.join(b, 'ccusage');
        if (fs.existsSync(np) && fs.existsSync(cp)) {
          resolvedNode = np; resolvedCcusage = cp;
          return { node: np, ccusage: cp };
        }
      }
    } catch { /* ignore */ }
  }

  const candidates = [
    { n: '/opt/homebrew/bin/node', c: '/opt/homebrew/bin/ccusage' },
    { n: '/usr/local/bin/node', c: '/usr/local/bin/ccusage' },
  ];
  for (const { n, c } of candidates) {
    if (fs.existsSync(n) && fs.existsSync(c)) {
      resolvedNode = n; resolvedCcusage = c;
      return { node: n, ccusage: c };
    }
  }
  return null;
}

/**
 * Fetches current session usage asynchronously.
 * Returns cached result if called within 10s.
 */
export async function fetchCurrentUsage(sessionId: string): Promise<CurrentUsage | null> {
  const now = Date.now();
  if (lastResult && now - lastFetch < CACHE_MS) {
    return lastResult;
  }

  const binaries = findBinaries();
  if (!binaries) return lastResult;

  try {
    const { stdout } = await execAsync(
      `"${binaries.node}" "${binaries.ccusage}" blocks --json`,
      { encoding: 'utf-8', timeout: 8000 }
    );
    const data = JSON.parse(stdout) as Record<string, unknown>;
    const blocks = (data.blocks ?? []) as Record<string, unknown>[];

    const activeBlock = blocks.find((b) => b.isActive === true && !b.isGap)
      ?? blocks.filter((b) => !b.isGap).pop();

    if (!activeBlock) return lastResult;

    const tc = (activeBlock.tokenCounts ?? {}) as Record<string, unknown>;
    const result: CurrentUsage = {
      sessionId,
      isActive: (activeBlock.isActive ?? false) as boolean,
      models: Array.isArray(activeBlock.models) ? (activeBlock.models as string[]) : [],
      inputTokens: Number(tc.inputTokens ?? 0),
      outputTokens: Number(tc.outputTokens ?? 0),
      cacheCreationTokens: Number(tc.cacheCreationInputTokens ?? 0),
      cacheReadTokens: Number(tc.cacheReadInputTokens ?? 0),
      totalTokens: Number(activeBlock.totalTokens ?? 0),
      cost: Number(activeBlock.costUSD ?? 0),
      startTime: (activeBlock.startTime ?? '') as string,
      endTime: (activeBlock.actualEndTime ?? activeBlock.endTime ?? '') as string,
    };

    lastResult = result;
    lastFetch = now;
    return result;
  } catch {
    return lastResult;
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

export function renderUsageCard(container: HTMLElement, usage: CurrentUsage) {
  container.empty();

  const header = container.createDiv({ cls: 'claudian-usage-card-header' });
  header.createDiv({ cls: 'claudian-usage-card-title', text: 'Current Session' });
  header.createDiv({
    cls: 'claudian-usage-card-status',
    text: usage.isActive ? '● Active' : '○ Ended',
  });

  const grid = container.createDiv({ cls: 'claudian-usage-card-grid' });

  const costCard = grid.createDiv({ cls: 'claudian-usage-stat-card claudian-usage-stat-accent' });
  costCard.createDiv({ cls: 'claudian-usage-stat-label', text: 'Cost' });
  costCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtCost(usage.cost) });

  const tokCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  tokCard.createDiv({ cls: 'claudian-usage-stat-label', text: 'Total Tokens' });
  tokCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.totalTokens) });

  const inCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  inCard.createDiv({ cls: 'claudian-usage-stat-label', text: '↑ Input' });
  inCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.inputTokens) });

  const outCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  outCard.createDiv({ cls: 'claudian-usage-stat-label', text: '↓ Output' });
  outCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.outputTokens) });

  const cacheReadCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  cacheReadCard.createDiv({ cls: 'claudian-usage-stat-label', text: '📖 Cache Read' });
  cacheReadCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.cacheReadTokens) });

  const cacheCreateCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  cacheCreateCard.createDiv({ cls: 'claudian-usage-stat-label', text: '💾 Cache Write' });
  cacheCreateCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.cacheCreationTokens) });

  const footer = container.createDiv({ cls: 'claudian-usage-card-footer' });
  if (usage.startTime) {
    footer.createDiv({ cls: 'claudian-usage-card-meta', text: `Started: ${fmtDate(usage.startTime)}` });
  }
  if (usage.endTime) {
    footer.createDiv({ cls: 'claudian-usage-card-meta', text: `Last active: ${fmtDate(usage.endTime)}` });
  }
  if (usage.models.length > 0) {
    footer.createDiv({ cls: 'claudian-usage-card-meta', text: `Models: ${usage.models.join(', ')}` });
  }
}

export function renderUsageCardLoading(container: HTMLElement) {
  container.empty();
  container.createDiv({ cls: 'claudian-usage-card-loading', text: 'Loading usage...' });
}

export function renderUsageCardError(container: HTMLElement, message: string) {
  container.empty();
  container.createDiv({ cls: 'claudian-usage-card-error', text: message });
}
