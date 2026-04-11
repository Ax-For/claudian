import { execSync } from 'child_process';

export interface UsageSession {
  name: string;
  models: string[];
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
  lastActive: string;
}

export interface UsageSummary {
  sessions: UsageSession[];
  totalCost: number;
  totalTokens: number;
}

let cache: { data: UsageSession[]; ts: number } | null = null;
const CACHE_MS = 30_000;

/**
 * Fetches session usage data from ccusage CLI.
 * Results are cached for 30 seconds.
 */
export async function fetchUsage(): Promise<UsageSession[]> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_MS) {
    return cache.data;
  }

  try {
    const output = execSync('ccusage session --json 2>/dev/null', {
      encoding: 'utf-8',
      timeout: 15_000,
    });
    const sessions: unknown[] = JSON.parse(output);

    const data: UsageSession[] = (sessions as Record<string, unknown>[]).map((s) => ({
      name: (s.name as string) ?? 'unknown',
      models: Array.isArray(s.models)
        ? (s.models as string[])
        : [],
      inputTokens: Number(s.inputTokens ?? s.input_tokens ?? 0),
      outputTokens: Number(s.outputTokens ?? s.output_tokens ?? 0),
      totalTokens: Number(s.totalTokens ?? s.total_tokens ?? 0),
      cost: Number(s.costUSD ?? s.cost_usd ?? 0),
      lastActive: (s.lastActive ?? s.last_active ?? '') as string,
    }));

    cache = { data, ts: now };
    return data;
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

/**
 * Renders a usage stats panel into the given container.
 */
export function renderUsagePanel(container: HTMLElement, sessions: UsageSession[]) {
  container.empty();

  if (sessions.length === 0) {
    container.createDiv({
      cls: 'claudian-usage-empty',
      text: 'No usage data available. Make sure ccusage is installed.',
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
