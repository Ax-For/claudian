#!/usr/bin/env node
/**
 * Build and deploy Claudian to all Obsidian vaults that have it installed.
 *
 * Usage:
 *   node scripts/deploy-vault.mjs              # Build + deploy + reload (only vaults with Claudian)
 *   node scripts/deploy-vault.mjs --skip-build # Skip build, just copy
 *   node scripts/deploy-vault.mjs --no-reload  # Don't reload vaults
 *   node scripts/deploy-vault.mjs --force      # Install Claudian to ALL vaults (creates dirs if needed)
 */

import { execSync } from 'child_process';
import { cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BUILD_FILES = ['main.js', 'styles.css', 'manifest.json'];

function log(msg) {
  console.log(`  ${msg}`);
}

function parseArgs(argv) {
  return {
    skipBuild: argv.includes('--skip-build'),
    noReload: argv.includes('--no-reload'),
    force: argv.includes('--force'),
  };
}

function getVaults() {
  const output = execSync('obsidian vaults verbose', { encoding: 'utf-8' }).trim();
  const vaults = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const match = line.match(/^(.+?)\t(.+)$/);
    if (match) {
      vaults.push({ name: match[1].trim(), path: match[2].trim() });
    }
  }
  return vaults;
}

function hasClaudian(vaultPath) {
  const pluginDir = join(vaultPath, '.obsidian', 'plugins', 'claudian');
  return existsSync(join(pluginDir, 'manifest.json'));
}

function getClaudianVersion(vaultPath) {
  const manifestPath = join(vaultPath, '.obsidian', 'plugins', 'claudian', 'manifest.json');
  try {
    const manifest = JSON.parse(execSync(`cat "${manifestPath}"`, { encoding: 'utf-8' }));
    return manifest.version || 'unknown';
  } catch {
    return 'not installed';
  }
}

function build() {
  log('Building plugin...');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
  log('Build complete.');
}

function deployToVault(vault, force) {
  const pluginDir = join(vault.path, '.obsidian', 'plugins', 'claudian');

  const oldVersion = getClaudianVersion(vault.path);
  const isNew = oldVersion === 'not installed';

  if (!existsSync(pluginDir)) {
    if (!force) {
      log(`Skipping ${vault.name}: claudian not installed`);
      return false;
    }
    log(`Installing to ${vault.name} (new) (${vault.path})`);
    mkdirSync(pluginDir, { recursive: true });
  } else {
    log(`Deploying to ${vault.name} (${vault.path})`);
  }

  for (const file of BUILD_FILES) {
    const src = join(ROOT, file);
    if (!existsSync(src)) {
      log(`  ERROR: ${file} not found in build output`);
      return false;
    }
    cpSync(src, join(pluginDir, file));
  }

  const newVersion = getClaudianVersion(vault.path);
  log(`  ${isNew ? 'Installed' : 'Updated'}: ${newVersion}`);
  return true;
}

function reloadVault(vault) {
  try {
    log(`Reloading vault ${vault.name}...`);
    execSync(`obsidian vault reload`, { encoding: 'utf-8', stdio: 'pipe' });
    log('  Reloaded.');
  } catch (err) {
    log(`  Warning: vault reload failed (${err.message})`);
  }
}

function main() {
  const { skipBuild, noReload, force } = parseArgs(process.argv.slice(2));

  console.log('Claudian Deploy Script');
  console.log('=====================');
  if (force) console.log('  Mode: FORCE (install to all vaults)');

  // Step 1: Build
  if (!skipBuild) {
    build();
  } else {
    log('Skipping build (--skip-build)');
    // Verify build files exist
    for (const file of BUILD_FILES) {
      if (!existsSync(join(ROOT, file))) {
        console.error(`ERROR: ${file} not found. Run without --skip-build first.`);
        process.exit(1);
      }
    }
  }

  // Step 2: Find vaults
  console.log('\nFinding vaults...');
  const vaults = getVaults();
  log(`Found ${vaults.length} vault(s)`);

  let targetVaults;
  if (force) {
    targetVaults = vaults;
    console.log(`\nForce mode: deploying to all ${targetVaults.length} vault(s):\n`);
  } else {
    targetVaults = vaults.filter(v => hasClaudian(v.path));
    if (targetVaults.length === 0) {
      log('No vaults with Claudian found.');
      return;
    }
    console.log(`\nDeploying to ${targetVaults.length} vault(s):\n`);
  }

  let deployed = 0;
  for (const vault of targetVaults) {
    if (deployToVault(vault, force)) {
      deployed++;
      if (!noReload) {
        reloadVault(vault);
      }
    }
    console.log();
  }

  console.log(`Done. Deployed to ${deployed}/${targetVaults.length} vault(s).`);
}

main();
