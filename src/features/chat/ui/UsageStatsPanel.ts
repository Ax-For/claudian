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
let resolvedNode: string | null = null;
let resolvedCcusage: string | null = null;

/**
 * Finds node and ccusage binaries.
 * Obsidian's Electron process doesn't inherit shell PATH (nvm, etc),
 * so we must resolve full paths ourselves.
 * Returns { node, ccusage } or null if either is missing.
 */
function findBinaries(): { node: string; ccusage: string } | null {
  if (resolvedNode && resolvedCcusage) {
    return { node: resolvedNode, ccusage: resolvedCcusage };
  }

  const home = os.homedir();

  // 1. Try 'which' (works if PATH is inherited)
  try {
    const node = execSync('which node 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
    const cc = execSync('which ccusage 2>/dev/null', { encoding: 'utf-8', timeout: 3000 }).trim();
    if (node && cc && fs.existsSync(node) && fs.existsSync(cc)) {
      resolvedNode = node; resolvedCcusage = cc;
      return { node, ccusage: cc };
    }
  } catch { /* ignore */ }

  // 2. nvm — find node version dir that has both node and ccusage
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

  // 3. Check for node in common paths, then find ccusage relative to it
  const nodeCandidates = [
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    path.join(home, '.local', 'bin', 'node'),
  ];
  const ccusageCandidates = [
    path.join(home, '.nvm', 'versions', 'node'), // search subdirs
    path.join(home, '.npm-global', 'bin', 'ccusage'),
    '/opt/homebrew/bin/ccusage',
    '/usr/local/bin/ccusage',
    path.join(home, '.local', 'bin', 'ccusage'),
  ];

  for (const p of nodeCandidates) {
    if (fs.existsSync(p)) {
      // Try to find ccusage near this node or globally
      const nodeDir = path.dirname(p);
      const nearbyCc = path.join(nodeDir, 'ccusage');
      if (fs.existsSync(nearbyCc)) {
        resolvedNode = p; resolvedCcusage = nearbyCc;
        return { node: p, ccusage: nearbyCc };
      }
    }
  }

  // Find any node, then find ccusage relative to it
  let foundNode: string | null = null;
  for (const p of nodeCandidates) {
    if (fs.existsSync(p)) { foundNode = p; break; }
  }

  for (const p of ccusageCandidates) {
    if (p.endsWith('/node')) continue; // skip the node base dir
    const checkPath = p.endsWith('/ccusage') ? p : (() => {
      // It's a base dir (nvm versions dir), search for ccusage
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

/**
 * Fetches usage data from ccusage blocks CLI.
 */
export async function fetchUsage(): Promise<UsageSession[]> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_MS) {
    return cache.data;
  }

  const binaries = findBinaries();
  if (!binaries) {
    return cache?.data ?? [];
  }

  try {
    const output = execSync(`"${binaries.node}" "${binaries.ccusage}" blocks --json`, {
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
    const binaries = findBinaries();
    container.createDiv({
      cls: 'claudian-usage-empty',
      text: binaries
        ? 'No usage data available.'
        : 'ccusage or node not found. Install with: npm i -g ccusage',
    });
    return;
  }

  const totalCost = sessions.reduce((s, x) => s + x.cost, 0);
  const totalTokens = sessions.reduce((s, x) => s + x.totalTokens, 0);

  const summaryEl = container.createDiv({ cls: 'claudian-usage-summary' });
  summaryEl.createDiv({ cls: 'claudian-usage-summary-item', text: `Total cost: ${fmtCost(totalCost)}` });
  summaryEl.createDiv({ cls: 'claudian-usage-summary-item', text: `Total tokens: ${fmtTokens(totalTokens)}` });
  summaryEl.createDiv({ cls: 'claudian-usage-summary-item', text: `Sessions: ${sessions.length}` });

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
