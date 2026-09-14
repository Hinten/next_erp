import { deepStrictEqual, strictEqual, throws } from 'node:assert/strict';
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

  it('installs with the pinned runtime and frozen lockfile', () => {
    const command = setupCommand({ packageManager: 'pnpm@11.2.2' });
    const pnpmArgs = ['--yes', 'pnpm@11.2.2', 'install', '--frozen-lockfile'];
    if (process.platform === 'win32') {
      strictEqual(command.executable, process.env.ComSpec ?? 'cmd.exe');
      deepStrictEqual(command.args, ['/d', '/s', '/c', 'npx.cmd', ...pnpmArgs]);
    } else {
      strictEqual(command.executable, 'npx');
      deepStrictEqual(command.args, pnpmArgs);
    }
  });
});
