import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

function findBinaries(): { node: string; ccusage: string } | null {
  if (resolvedNode && resolvedCcusage) {
    return { node: resolvedNode, ccusage: resolvedCcusage };
  }

  const home = os.homedir();

  try {
    const node = execSync('which node 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
    const cc = execSync('which ccusage 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (node && cc && fs.existsSync(node) && fs.existsSync(cc)) {
      resolvedNode = node; resolvedCcusage = cc;
      return { node, ccusage: cc };
    }
  } catch { /* ignore */ }

  const nvmDir = process.env.NVM_DIR || path.join(home, '.nvm');
  if (fs.existsSync(nvmDir)) {
    try {
      const versionsDir = path.join(nvmDir, 'versions', 'node');
      const versions = fs.readdirSync(versionsDir).reverse();
      for (const ver of versions) {
        const binDir = path.join(versionsDir, ver, 'bin');
        const nodePath = path.join(binDir, 'node');
        const ccPath = path.join(binDir, 'ccusage');
        if (fs.existsSync(nodePath) && fs.existsSync(ccPath)) {
          resolvedNode = nodePath; resolvedCcusage = ccPath;
          return { node: nodePath, ccusage: ccPath };
        }
      }
    } catch { /* ignore */ }
  }

  const nodeCandidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(home, '.local', 'bin', 'node'),
  ];
  const ccusageCandidates = [
    path.join(home, '.nvm', 'versions', 'node'),
    path.join(home, '.npm-global', 'bin', 'ccusage'),
    '/opt/homebrew/bin/ccusage',
    '/usr/local/bin/ccusage',
    path.join(home, '.local', 'bin', 'ccusage'),
  ];

  for (const p of nodeCandidates) {
    if (fs.existsSync(p)) {
      const nodeDir = path.dirname(p);
      const nearbyCc = path.join(nodeDir, 'ccusage');
      if (fs.existsSync(nearbyCc)) {
        resolvedNode = p; resolvedCcusage = nearbyCc;
        return { node: p, ccusage: nearbyCc };
      }
    }
  }

  let foundNode: string | null = null;
  for (const p of nodeCandidates) {
    if (fs.existsSync(p)) { foundNode = p; break; }
  }

  for (const p of ccusageCandidates) {
    if (p.endsWith('/node')) continue;
    const checkPath = p.endsWith('/ccusage') ? p : (() => {
      try {
        const versions = fs.readdirSync(p).reverse();
        for (const ver of versions) {
          const cc = path.join(p, ver, 'bin', 'ccusage');
          if (fs.existsSync(cc)) return cc;
        }
      } catch { /* ignore */ }
      return null;
    })();
    if (checkPath && fs.existsSync(checkPath) && foundNode) {
      resolvedNode = foundNode; resolvedCcusage = checkPath;
      return { node: foundNode, ccusage: checkPath };
    }
  }

  return null;
}

export function fetchCurrentUsage(sessionId: string): CurrentUsage | null {
  const binaries = findBinaries();
  if (!binaries) return null;

  try {
    const output = execSync(`"${binaries.node}" "${binaries.ccusage}" blocks --json`, {
      encoding: 'utf-8',
      timeout: 10_000,
    });
    const data = JSON.parse(output) as Record<string, unknown>;
    const blocks = (data.blocks ?? []) as Record<string, unknown>[];

    // Find active block (or the one matching our session)
    const activeBlock = blocks.find((b) => b.isActive === true && !b.isGap)
      ?? blocks.filter((b) => !b.isGap).pop();

    if (!activeBlock) return null;

    const tc = (activeBlock.tokenCounts ?? {}) as Record<string, unknown>;

    return {
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
  } catch {
    return null;
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

function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function fmtDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
    d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * Renders a single-session usage card.
 * Called every 5 seconds for live updates.
 */
export function renderUsageCard(container: HTMLElement, usage: CurrentUsage) {
  container.empty();

  // Header
  const header = container.createDiv({ cls: 'claudian-usage-card-header' });
  header.createDiv({
    cls: 'claudian-usage-card-title',
    text: 'Current Session',
  });
  header.createDiv({
    cls: 'claudian-usage-card-status',
    text: usage.isActive ? '● Active' : '○ Ended',
  });

  // Stats grid
  const grid = container.createDiv({ cls: 'claudian-usage-card-grid' });

  // Cost
  const costCard = grid.createDiv({ cls: 'claudian-usage-stat-card claudian-usage-stat-accent' });
  costCard.createDiv({ cls: 'claudian-usage-stat-label', text: 'Cost' });
  costCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtCost(usage.cost) });

  // Total tokens
  const tokCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  tokCard.createDiv({ cls: 'claudian-usage-stat-label', text: 'Total Tokens' });
  tokCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.totalTokens) });

  // Input tokens
  const inCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  inCard.createDiv({ cls: 'claudian-usage-stat-label', text: '↑ Input' });
  inCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.inputTokens) });

  // Output tokens
  const outCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  outCard.createDiv({ cls: 'claudian-usage-stat-label', text: '↓ Output' });
  outCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.outputTokens) });

  // Cache read
  const cacheReadCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  cacheReadCard.createDiv({ cls: 'claudian-usage-stat-label', text: '📖 Cache Read' });
  cacheReadCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.cacheReadTokens) });

  // Cache creation
  const cacheCreateCard = grid.createDiv({ cls: 'claudian-usage-stat-card' });
  cacheCreateCard.createDiv({ cls: 'claudian-usage-stat-label', text: '💾 Cache Write' });
  cacheCreateCard.createDiv({ cls: 'claudian-usage-stat-value', text: fmtTokens(usage.cacheCreationTokens) });

  // Footer: time + models
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

  // Store getter for live refresh
  (container as any)._getUsage = () => usage;
}

export function renderUsageCardError(container: HTMLElement, message: string) {
  container.empty();
  container.createDiv({
    cls: 'claudian-usage-card-error',
    text: message,
  });
}
