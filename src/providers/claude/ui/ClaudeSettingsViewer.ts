import * as fs from 'fs';
import { Setting } from 'obsidian';

import {
  getProviderEnvironmentVariables,
  getSharedEnvironmentVariables,
  getVaultEnvironmentVariables,
} from '../../../core/providers/providerEnvironment';
import type ClaudianPlugin from '../../../main';
import { getVaultPath } from '../../../utils/path';

/** Reads a JSON settings file synchronously, returning null if missing or invalid. */
function readSettingsFile(filePath: string): Record<string, unknown> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractEnv(raw: Record<string, unknown> | null): Record<string, string> {
  if (!raw) return {};
  return (raw.env as Record<string, string>) ?? {};
}

/** Parses Claudian env text into a key-value map. */
function parseEnvMap(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7) : trimmed;
    const eqIndex = normalized.indexOf('=');
    if (eqIndex > 0) {
      const key = normalized.substring(0, eqIndex).trim();
      let value = normalized.substring(eqIndex + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (key) result[key] = value;
    }
  }
  return result;
}

/**
 * Displays Claude settings with emphasis on env configuration.
 * Shows user-level (~/.claude/settings.json) vs vault-level (.claude/settings.json)
 * for .claude/settings.json owned fields, AND the Claudian-managed environment
 * variables that are actually sent to the SDK.
 */
export class ClaudeSettingsViewer {
  private container: HTMLElement;
  private plugin: ClaudianPlugin;
  private tableEl: HTMLElement | null = null;

  constructor(container: HTMLElement, plugin: ClaudianPlugin) {
    this.container = container;
    this.plugin = plugin;
  }

  render(): void {
    try {
      this.container.empty();

      const section = new Setting(this.container)
        .setName('Claude Settings (.claude/settings.json)')
        .setDesc('Shows user-level (~/.claude/), vault-level (.claude/), and final values. The env section shows the actual variables sent to the SDK.')
        .setHeading();

      const refreshBtn = section.controlEl.createEl('button', {
        text: 'Refresh',
        cls: 'claudian-resolved-env-refresh',
      });
      refreshBtn.addEventListener('click', () => this.render());

      this.tableEl = this.container.createDiv({ cls: 'claudian-resolved-env-table' });
      this.populateTable();
    } catch {
      // Silently fail in test/mock environments
    }
  }

  private populateTable(): void {
    if (!this.tableEl) return;
    this.tableEl.empty();

    const vaultPath = getVaultPath(this.plugin.app);
    if (!vaultPath) {
      this.tableEl.createDiv({
        cls: 'claudian-resolved-env-empty',
        text: 'Unable to determine vault path.',
      });
      return;
    }

    const userSettingsPath = `${process.env.HOME}/.claude/settings.json`;
    const vaultSettingsPath = `${vaultPath}/.claude/settings.json`;

    const userRaw = readSettingsFile(userSettingsPath);
    const vaultRaw = readSettingsFile(vaultSettingsPath);

    const userEnv = extractEnv(userRaw);
    const vaultEnv = extractEnv(vaultRaw);

    // Claudian-managed env: shared + provider(claude) + vault — this is what SDK receives
    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const sharedEnv = parseEnvMap(getSharedEnvironmentVariables(settings));
    const providerEnv = parseEnvMap(getProviderEnvironmentVariables(settings, 'claude'));
    const claudianVaultEnv = parseEnvMap(getVaultEnvironmentVariables(settings));

    // === Section 1: Claudian-managed environment (what SDK receives) ===
    this.tableEl.createDiv({
      cls: 'claudian-env-section-header',
      text: 'Claudian Environment Variables (sent to SDK)',
    });

    // Merge: shared <- provider <- vault
    const mergedEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(sharedEnv)) mergedEnv[k] = v;
    for (const [k, v] of Object.entries(providerEnv)) mergedEnv[k] = v;
    for (const [k, v] of Object.entries(claudianVaultEnv)) mergedEnv[k] = v;

    const envKeys = Object.keys(mergedEnv).sort();

    if (envKeys.length > 0) {
      const headerEl = this.tableEl.createDiv({ cls: 'claudian-resolved-env-header' });
      headerEl.createDiv({ cls: 'claudian-resolved-env-col-key', text: 'Key' });
      headerEl.createDiv({ cls: 'claudian-resolved-env-col-shared', text: 'Shared' });
      headerEl.createDiv({ cls: 'claudian-resolved-env-col-provider', text: 'Provider' });
      headerEl.createDiv({ cls: 'claudian-resolved-env-col-vault', text: 'Vault' });
      headerEl.createDiv({ cls: 'claudian-resolved-env-col-final', text: 'Final (SDK)' });

      for (const key of envKeys) {
        const rowEl = this.tableEl.createDiv({ cls: 'claudian-resolved-env-row claudian-env-row-5col' });
        rowEl.createDiv({
          cls: 'claudian-resolved-env-col-key claudian-resolved-env-key',
          text: key,
        });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-shared claudian-resolved-env-value', text: sharedEnv[key] ?? '—' });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-provider claudian-resolved-env-value', text: providerEnv[key] ?? '—' });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-vault claudian-resolved-env-value', text: claudianVaultEnv[key] ?? '—' });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-final claudian-resolved-env-value claudian-resolved-env-final', text: mergedEnv[key] ?? '—' });
      }
    } else {
      this.tableEl.createDiv({
        cls: 'claudian-resolved-env-empty',
        text: 'No custom environment variables configured in Claudian. See .claude/settings.json below.',
      });
    }

    // === Section 2: .claude/settings.json env ===
    if (Object.keys(userEnv).length > 0 || Object.keys(vaultEnv).length > 0) {
      this.tableEl.createDiv({
        cls: 'claudian-env-section-header',
        text: '.claude/settings.json env (also sent to SDK)',
      });

      const ccHeaderEl = this.tableEl.createDiv({ cls: 'claudian-resolved-env-header' });
      ccHeaderEl.createDiv({ cls: 'claudian-resolved-env-col-key', text: 'Key' });
      ccHeaderEl.createDiv({ cls: 'claudian-resolved-env-col-user', text: 'User (~/.claude/)' });
      ccHeaderEl.createDiv({ cls: 'claudian-resolved-env-col-vault', text: 'Vault (.claude/)' });
      ccHeaderEl.createDiv({ cls: 'claudian-resolved-env-col-final', text: 'Final' });

      const ccKeys = [...new Set([...Object.keys(userEnv), ...Object.keys(vaultEnv)])].sort();
      for (const key of ccKeys) {
        const uVal = userEnv[key] ?? '';
        const vVal = vaultEnv[key] ?? '';
        const final = vVal || uVal;

        const rowEl = this.tableEl.createDiv({ cls: 'claudian-resolved-env-row' });
        rowEl.createDiv({
          cls: 'claudian-resolved-env-col-key claudian-resolved-env-key',
          text: key,
        });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-user claudian-resolved-env-value', text: uVal || '—' });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-vault claudian-resolved-env-value', text: vVal || '—' });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-final claudian-resolved-env-value claudian-resolved-env-final', text: final || '—' });
      }
    }

    // === Section 3: Other settings ===
    const otherRows: Array<[string, string, string]> = [];

    if (userRaw?.model || vaultRaw?.model) {
      otherRows.push(['model', (userRaw?.model as string) ?? '—', (vaultRaw?.model as string) ?? '—']);
    }

    if (userRaw?.permissions || vaultRaw?.permissions) {
      const uPerm = (userRaw?.permissions as Record<string, unknown>) ?? {};
      const vPerm = (vaultRaw?.permissions as Record<string, unknown>) ?? {};
      if (uPerm.defaultMode || vPerm.defaultMode) {
        otherRows.push(['permissions.defaultMode',
          (uPerm.defaultMode as string) ?? '—',
          (vPerm.defaultMode as string) ?? '—',
        ]);
      }
      if (uPerm.allow || vPerm.allow) {
        const uAllow = (uPerm.allow as string[] ?? []).join(', ') || '—';
        const vAllow = (vPerm.allow as string[] ?? []).join(', ') || '—';
        otherRows.push(['permissions.allow', uAllow, vAllow]);
      }
      if (uPerm.deny || vPerm.deny) {
        const uDeny = (uPerm.deny as string[] ?? []).join(', ') || '—';
        const vDeny = (vPerm.deny as string[] ?? []).join(', ') || '—';
        otherRows.push(['permissions.deny', uDeny, vDeny]);
      }
      if (uPerm.ask || vPerm.ask) {
        const uAsk = (uPerm.ask as string[] ?? []).join(', ') || '—';
        const vAsk = (vPerm.ask as string[] ?? []).join(', ') || '—';
        otherRows.push(['permissions.ask', uAsk, vAsk]);
      }
    }

    if (userRaw?.enabledPlugins || vaultRaw?.enabledPlugins) {
      const uPlugins = Object.entries(userRaw?.enabledPlugins as Record<string, boolean> ?? {})
        .map(([k, v]) => `${k}: ${v}`).join(', ') || '—';
      const vPlugins = Object.entries(vaultRaw?.enabledPlugins as Record<string, boolean> ?? {})
        .map(([k, v]) => `${k}: ${v}`).join(', ') || '—';
      otherRows.push(['enabledPlugins', uPlugins, vPlugins]);
    }

    if (userRaw?.mcpServers || vaultRaw?.mcpServers) {
      const uMcp = Object.keys(userRaw?.mcpServers as Record<string, unknown> ?? {}).join(', ') || '—';
      const vMcp = Object.keys(vaultRaw?.mcpServers as Record<string, unknown> ?? {}).join(', ') || '—';
      otherRows.push(['mcpServers', uMcp, vMcp]);
    }

    if (otherRows.length > 0) {
      this.tableEl.createDiv({
        cls: 'claudian-env-section-header',
        text: 'Other .claude/settings.json Fields',
      });

      const otherHeaderEl = this.tableEl.createDiv({ cls: 'claudian-resolved-env-header' });
      otherHeaderEl.createDiv({ cls: 'claudian-resolved-env-col-key', text: 'Setting' });
      otherHeaderEl.createDiv({ cls: 'claudian-resolved-env-col-user', text: 'User (~/.claude/)' });
      otherHeaderEl.createDiv({ cls: 'claudian-resolved-env-col-vault', text: 'Vault (.claude/)' });

      for (const [key, userVal, vaultVal] of otherRows) {
        const rowEl = this.tableEl.createDiv({ cls: 'claudian-resolved-env-row' });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-key claudian-resolved-env-key', text: key });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-user claudian-resolved-env-value', text: userVal });
        rowEl.createDiv({ cls: 'claudian-resolved-env-col-vault claudian-resolved-env-value', text: vaultVal });
      }
    }
  }
}
