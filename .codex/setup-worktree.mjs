// Shared Codex Local Environment setup command. Configure the desktop app to
// run `node .codex/setup-worktree.mjs` for new worktrees. The package-manager
// version comes from package.json so this file cannot drift from CI.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');

export function parsePinnedPnpm(packageManager) {
  const match = String(packageManager).match(/^pnpm@(\d+\.\d+\.\d+)$/);
  if (!match) throw new Error('package.json packageManager must pin an exact pnpm version.');
  return match[1];
}

export function setupCommand(
  packageJson,
  { repoRoot = REPO_ROOT, platform = process.platform, environment = process.env } = {},
) {
  const version = parsePinnedPnpm(packageJson.packageManager);
  const cacheRoot = resolve(repoRoot, 'out', 'codex-sandbox-cache');
  const cacheSettings = {
    npm_config_cache: resolve(cacheRoot, 'npm'),
    pnpm_config_store_dir: resolve(cacheRoot, 'pnpm-store'),
    pnpm_config_cache_dir: resolve(cacheRoot, 'pnpm-cache'),
    pnpm_config_state_dir: resolve(cacheRoot, 'state'),
  };
  // Windows environment names are case-insensitive. Replace every inherited
  // spelling so npm and pnpm receive one absolute value for each cache.
  const env = {
    ...Object.fromEntries(
      Object.entries(environment).filter(
        ([key]) => !Object.hasOwn(cacheSettings, key.toLowerCase()),
      ),
    ),
    ...cacheSettings,
  };
  const pnpmArgs = ['--yes', `pnpm@${version}`, 'install', '--frozen-lockfile'];
  if (platform === 'win32') {
    return {
      executable: environment.ComSpec ?? environment.COMSPEC ?? 'cmd.exe',
      args: ['/d', '/s', '/c', 'npx.cmd', ...pnpmArgs],
      env,
    };
  }
  return {
    executable: 'npx',
    args: pnpmArgs,
    env,
  };
}

export function runSetup() {
  const packageJson = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8'));
  const { executable, args, env } = setupCommand(packageJson);
  const result = spawnSync(executable, args, { cwd: REPO_ROOT, env, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) runSetup();
