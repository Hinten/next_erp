import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import { parsePinnedPnpm, setupCommand } from './setup-worktree.mjs';

describe('Codex worktree setup', () => {
  it('reads an exact pnpm version', () => {
    strictEqual(parsePinnedPnpm('pnpm@11.2.2'), '11.2.2');
  });

  for (const value of ['pnpm@^11.2.2', 'pnpm@latest', 'npm@11.2.2', '', undefined]) {
    it(`rejects an unpinned package manager: ${String(value)}`, () => {
      throws(() => parsePinnedPnpm(value), /must pin an exact pnpm version/);
    });
  }

  it('uses the manifest pin and project-local caches through Windows cmd', () => {
    const repoRoot = resolve('worktree with spaces');
    const command = setupCommand(
      { packageManager: 'pnpm@11.3.4' },
      { repoRoot, platform: 'win32', environment: { ComSpec: 'custom-cmd.exe' } },
    );
    const cacheRoot = resolve(repoRoot, 'out', 'codex-sandbox-cache');
    strictEqual(command.executable, 'custom-cmd.exe');
    deepStrictEqual(command.args, [
      '/d',
      '/s',
      '/c',
      'npx.cmd',
      '--yes',
      'pnpm@11.3.4',
      'install',
      '--frozen-lockfile',
    ]);
    deepStrictEqual(command.env, {
      ComSpec: 'custom-cmd.exe',
      npm_config_cache: resolve(cacheRoot, 'npm'),
      pnpm_config_store_dir: resolve(cacheRoot, 'pnpm-store'),
      pnpm_config_cache_dir: resolve(cacheRoot, 'pnpm-cache'),
      pnpm_config_state_dir: resolve(cacheRoot, 'state'),
    });
  });

  it('uses npx directly outside Windows and keeps every cache under the selected worktree', () => {
    const repoRoot = resolve('another worktree');
    const command = setupCommand(
      { packageManager: 'pnpm@11.2.2' },
      { repoRoot, platform: 'linux', environment: {} },
    );
    strictEqual(command.executable, 'npx');
    deepStrictEqual(command.args, ['--yes', 'pnpm@11.2.2', 'install', '--frozen-lockfile']);
    const cacheRoot = resolve(repoRoot, 'out', 'codex-sandbox-cache');
    deepStrictEqual(command.env, {
      npm_config_cache: resolve(cacheRoot, 'npm'),
      pnpm_config_store_dir: resolve(cacheRoot, 'pnpm-store'),
      pnpm_config_cache_dir: resolve(cacheRoot, 'pnpm-cache'),
      pnpm_config_state_dir: resolve(cacheRoot, 'state'),
    });
  });

  for (const platform of ['win32', 'linux']) {
    it(`replaces every cache key spelling on ${platform} while preserving unrelated settings and the input`, () => {
      const inherited = {
        PATH: 'existing-tool-path',
        CUSTOM_SETTING: 'preserve me',
        NPM_CONFIG_CACHE: 'outside-npm-upper',
        npm_config_cache: 'outside-npm-lower',
        Npm_Config_Cache: 'outside-npm-mixed',
        PNPM_CONFIG_STORE_DIR: 'outside-store-upper',
        pnpm_config_store_dir: 'outside-store-lower',
        Pnpm_Config_Store_Dir: 'outside-store-mixed',
        PNPM_CONFIG_CACHE_DIR: 'outside-cache-upper',
        pnpm_config_cache_dir: 'outside-cache-lower',
        Pnpm_Config_Cache_Dir: 'outside-cache-mixed',
        PNPM_CONFIG_STATE_DIR: 'outside-state-upper',
        pnpm_config_state_dir: 'outside-state-lower',
        Pnpm_Config_State_Dir: 'outside-state-mixed',
        npm_config_cache_buster: 'different npm setting',
        pnpm_config_cache_dir_buster: 'different pnpm setting',
        pnpm_config_store_directory: 'different store setting',
        COMSPEC: 'uppercase-cmd.exe',
      };
      const environment = Object.freeze({ ...inherited });
      const repoRoot = resolve('isolated-worktree');
      const cacheRoot = resolve(repoRoot, 'out', 'codex-sandbox-cache');
      const command = setupCommand(
        { packageManager: 'pnpm@11.2.2' },
        { repoRoot, platform, environment },
      );
      deepStrictEqual(command.env, {
        PATH: 'existing-tool-path',
        CUSTOM_SETTING: 'preserve me',
        npm_config_cache_buster: 'different npm setting',
        pnpm_config_cache_dir_buster: 'different pnpm setting',
        pnpm_config_store_directory: 'different store setting',
        COMSPEC: 'uppercase-cmd.exe',
        npm_config_cache: resolve(cacheRoot, 'npm'),
        pnpm_config_store_dir: resolve(cacheRoot, 'pnpm-store'),
        pnpm_config_cache_dir: resolve(cacheRoot, 'pnpm-cache'),
        pnpm_config_state_dir: resolve(cacheRoot, 'state'),
      });
      strictEqual(command.executable, platform === 'win32' ? 'uppercase-cmd.exe' : 'npx');
      deepStrictEqual(environment, inherited);
    });
  }

  it('falls back to cmd.exe without an ambient command processor', () => {
    const command = setupCommand(
      { packageManager: 'pnpm@11.2.2' },
      { platform: 'win32', environment: {} },
    );
    strictEqual(command.executable, 'cmd.exe');
  });
});
