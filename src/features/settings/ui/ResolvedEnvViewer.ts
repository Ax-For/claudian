import { Setting } from 'obsidian';

import {
  getResolvedEnvironmentVariables,
  type ResolvedEnvVar,
} from '../../../core/providers/providerEnvironment';
import type { ProviderId } from '../../../core/types/provider';
import type ClaudianPlugin from '../../../main';

interface ResolvedEnvViewerOptions {
  container: HTMLElement;
  plugin: ClaudianPlugin;
  providerId: ProviderId;
}

/**
 * Displays resolved environment variables with user-level, vault-level, and final values.
 * Shows a table: Key | User Value | Vault Value | Final Value.
 */
export class ResolvedEnvViewer {
  private container: HTMLElement;
  private plugin: ClaudianPlugin;
  private providerId: ProviderId;
  private tableEl: HTMLElement | null = null;

  constructor(container: HTMLElement, options: ResolvedEnvViewerOptions) {
    this.container = container;
    this.plugin = options.plugin;
    this.providerId = options.providerId;
  }

  /**
   * Renders or re-renders the resolved environment table.
   * Clears previous content to avoid duplicates on refresh.
   */
  render(): void {
    try {
      this.container.empty();

      const section = new Setting(this.container)
        .setName('Resolved Environment')
        .setDesc('Final environment variables sent to the runtime. Vault-level values override user-level.')
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

    const settings = this.plugin.settings as unknown as Record<string, unknown>;
    const resolved = getResolvedEnvironmentVariables(settings, this.providerId);

    if (resolved.length === 0) {
      this.tableEl.createDiv({
        cls: 'claudian-resolved-env-empty',
        text: 'No environment variables configured.',
      });
      return;
    }

    // Header row
    const headerEl = this.tableEl.createDiv({ cls: 'claudian-resolved-env-header' });
    headerEl.createDiv({ cls: 'claudian-resolved-env-col-key', text: 'Key' });
    headerEl.createDiv({ cls: 'claudian-resolved-env-col-user', text: 'User Value' });
    headerEl.createDiv({ cls: 'claudian-resolved-env-col-vault', text: 'Vault Value' });
    headerEl.createDiv({ cls: 'claudian-resolved-env-col-final', text: 'Final Value' });

    // Data rows
    for (const entry of resolved) {
      this.renderRow(entry);
    }
  }

  private renderRow(entry: ResolvedEnvVar): void {
    const rowEl = this.tableEl!.createDiv({ cls: 'claudian-resolved-env-row' });

    // Key column
    rowEl.createDiv({
      cls: 'claudian-resolved-env-col-key claudian-resolved-env-key',
      text: entry.key,
    });

    // User value column
    const userEl = rowEl.createDiv({
      cls: 'claudian-resolved-env-col-user claudian-resolved-env-value',
    });
    if (entry.userValue) {
      userEl.setText(entry.userValue);
      userEl.setAttribute('title', entry.userValue);
    } else {
      userEl.createSpan({ cls: 'claudian-resolved-env-none', text: '—' });
    }

    // Vault value column
    const vaultEl = rowEl.createDiv({
      cls: 'claudian-resolved-env-col-vault claudian-resolved-env-value',
    });
    if (entry.vaultValue) {
      vaultEl.setText(entry.vaultValue);
      vaultEl.setAttribute('title', entry.vaultValue);
    } else {
      vaultEl.createSpan({ cls: 'claudian-resolved-env-none', text: '—' });
    }

    // Final value column (masked for sensitive values)
    const finalEl = rowEl.createDiv({
      cls: 'claudian-resolved-env-col-final claudian-resolved-env-value',
    });
    const isSensitive = this.isSensitiveKey(entry.key);
    if (isSensitive && entry.value.length > 4) {
      finalEl.createSpan({
        cls: 'claudian-env-masked',
        text: `${entry.value.slice(0, 4)}${'•'.repeat(Math.min(entry.value.length - 4, 12))}`,
      });
      finalEl.setAttribute('title', entry.value);
    } else if (entry.value) {
      finalEl.setText(entry.value);
    } else {
      finalEl.createSpan({ cls: 'claudian-resolved-env-none', text: '—' });
    }
  }

  private isSensitiveKey(key: string): boolean {
    const sensitivePatterns = /(?:API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH)/i;
    return sensitivePatterns.test(key);
  }
}
