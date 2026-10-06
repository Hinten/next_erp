import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { deepStrictEqual, equal, match, throws } from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  discoverWorktrees,
  hash,
  parseArgs,
  planConfigRepair,
  repairWorktrees,
  RepairError,
  restoreManifest,
  writeChecked,
} from './repair-worktree-config.mjs';

const CONFIG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'config.toml'), 'utf8');
const LEGACY = CONFIG.replace(/^":(?:minimal|tmpdir|slash_tmp)" = .*\r?\n/gm, '')
  .replace(/^"(?:\.|\.git|\.codex|\.agents|\.aws)" = .*\r?\n/gm, '')
  .replace(/\[permissions\.next-erp\.network\]\r?\nenabled = false\r?\n/, '')
  .replace('[permissions.next-erp]\n', '[permissions.next-erp]\nextends = ":workspace"\n')
  .replace('[permissions.next-erp]\r\n', '[permissions.next-erp]\r\nextends = ":workspace"\r\n');
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'next-erp-config-test-'));
  roots.push(directory);
  const repoRoot = join(directory, 'repo');
  mkdirSync(join(repoRoot, '.codex'), { recursive: true });
  const config = join(repoRoot, '.codex', 'config.toml');
  writeFileSync(config, LEGACY);
  const git = (args) => execFileSync('git', ['-C', repoRoot, ...args], { stdio: 'pipe' });
  git(['init', '-q', '-b', 'fixture']);
  git(['add', '.codex/config.toml']);
  git([
    '-c',
    'user.name=Config test',
    '-c',
    'user.email=config-test@example.invalid',
    'commit',
    '-qm',
    'Fixture',
  ]);
  return { directory, repoRoot, config, git };
}

// Non-Windows CI exercises the orchestration with a checked writer. The actual
// FileShare.None implementation has a separate native Windows integration test.
function checkedWriter(path, expectedHash, replacement) {
  if (hash(readFileSync(path)) !== expectedHash) throw new RepairError('concurrent edit');
  writeFileSync(path, replacement);
}

describe('conservative configuration repair', () => {
  it('recognizes the original and fixed profiles and is idempotent', () => {
    const plan = planConfigRepair(LEGACY);
    equal(plan.status, 'repairable');
    equal(planConfigRepair(plan.replacement).status, 'already-fixed');
    equal(planConfigRepair(CONFIG).status, 'already-fixed');
  });

  it('preserves everything outside the permissions, including multiline strings', () => {
    const prefix = 'developer_instructions = """\n[permissions.next-erp]\nC: = "deny"\n"""\n';
    const suffix = '\n[unrelated]\nvalue = "keep me"\n';
    const source = prefix + LEGACY.slice(LEGACY.indexOf('[permissions.next-erp]')) + suffix;
    const plan = planConfigRepair(source);
    equal(plan.status, 'repairable');
    equal(plan.replacement.slice(0, prefix.length), prefix);
    equal(plan.replacement.slice(-suffix.length), suffix);
    const mcp = source.slice(source.indexOf('[mcp_servers.playwright]'));
    equal(plan.replacement.slice(plan.replacement.indexOf('[mcp_servers.playwright]')), mcp);
  });

  it('preserves CRLF and description text', () => {
    const source = LEGACY.replace(/\r?\n/g, '\r\n').replace(
      /description = "[^"]+"/,
      'description = "Custom description"',
    );
    const plan = planConfigRepair(source);
    equal(plan.status, 'repairable');
    match(plan.replacement, /description = "Custom description"/);
    equal(plan.replacement.includes('\r\r\n'), false);
    equal(
      plan.replacement.split('\n').find((line) => line.startsWith('description')),
      source.split('\n').find((line) => line.startsWith('description')),
    );
    equal(/(?<!\r)\n/.test(plan.replacement), false);
  });

  for (const [name, change] of [
    [
      'extra filesystem access',
      (s) => s.replace('glob_scan_max_depth = 8', 'glob_scan_max_depth = 8\n"C:/" = "read"'),
    ],
    ['changed denial', (s) => s.replace('".env.local" = "deny"', '".env.local" = "read"')],
    ['custom inherited profile', (s) => s.replace('extends = ":workspace"', 'extends = "other"')],
    [
      'extra profile table',
      (s) => s + '\n[permissions.next-erp.workspace_roots]\n"C:/extra" = true\n',
    ],
    ['duplicate table', (s) => s + '\n[permissions.next-erp]\nextends = ":workspace"\n'],
    ['changed fixed network policy', () => CONFIG.replace('enabled = false', 'enabled = true')],
  ]) {
    it(`refuses ${name}`, () => {
      deepStrictEqual(planConfigRepair(change(LEGACY)), { status: 'custom-profile' });
    });
  }

  it('reports a missing profile and leaves unrelated configuration alone', () => {
    deepStrictEqual(planConfigRepair('[other]\nvalue = true\n'), { status: 'missing-profile' });
  });
});

describe('worktree discovery and recovery', () => {
  it('dry-runs without creating backups or modifying a dirty worktree', () => {
    const f = fixture();
    writeFileSync(join(f.repoRoot, 'uncommitted.txt'), 'operator work');
    const before = f.git(['status', '--porcelain']).toString();
    const report = repairWorktrees({ repoRoot: f.repoRoot });
    equal(report.records[0].status, 'repairable');
    equal(report.manifest, undefined);
    equal(readFileSync(f.config, 'utf8'), LEGACY);
    equal(f.git(['status', '--porcelain']).toString(), before);
  });

  it('discovers related worktrees but refuses another repository', () => {
    const f = fixture();
    const worktree = join(f.directory, 'worktree with spaces');
    f.git(['worktree', 'add', '--detach', worktree]);
    equal(discoverWorktrees(f.repoRoot).length, 2);
    const other = fixture();
    throws(
      () =>
        repairWorktrees({
          repoRoot: f.repoRoot,
          worktrees: [other.repoRoot],
          apply: true,
          writer: checkedWriter,
        }),
      RepairError,
    );
    equal(readFileSync(other.config, 'utf8'), LEGACY);
  });

  it('backs up original bytes, preserves branch and dirty files, and restores once', () => {
    const f = fixture();
    writeFileSync(join(f.repoRoot, 'uncommitted.txt'), 'operator work');
    const branch = f.git(['branch', '--show-current']).toString();
    const report = repairWorktrees({
      repoRoot: f.repoRoot,
      worktrees: [f.repoRoot],
      apply: true,
      writer: checkedWriter,
    });
    equal(report.records[0].status, 'repaired');
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'));
    equal(readFileSync(manifest.records[0].backupPath, 'utf8'), LEGACY);
    equal(hash(readFileSync(f.config)), manifest.records[0].replacementHash);
    equal(f.git(['branch', '--show-current']).toString(), branch);
    equal(readFileSync(join(f.repoRoot, 'uncommitted.txt'), 'utf8'), 'operator work');
    equal(
      repairWorktrees({
        repoRoot: f.repoRoot,
        worktrees: [f.repoRoot],
        apply: true,
        writer: checkedWriter,
      }).records[0].status,
      'already-fixed',
    );
    equal(
      restoreManifest(report.manifest, { repoRoot: f.repoRoot, writer: checkedWriter }).records[0]
        .status,
      'restored',
    );
    equal(readFileSync(f.config, 'utf8'), LEGACY);
    equal(
      restoreManifest(report.manifest, { repoRoot: f.repoRoot, writer: checkedWriter }).records[0]
        .status,
      'already-restored',
    );
  });

  it('publishes a backup before a write and refuses a concurrent edit', () => {
    const f = fixture();
    const operatorEdit = LEGACY + '\n# another operator\n';
    const report = repairWorktrees({
      repoRoot: f.repoRoot,
      worktrees: [f.repoRoot],
      apply: true,
      writer(path, expected, replacement) {
        writeFileSync(path, operatorEdit);
        checkedWriter(path, expected, replacement);
      },
    });
    equal(report.records[0].status, 'blocked');
    equal(readFileSync(f.config, 'utf8'), operatorEdit);
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'));
    equal(readFileSync(manifest.records[0].backupPath, 'utf8'), LEGACY);
  });

  it('refuses to restore over an edit made after repair', () => {
    const f = fixture();
    const report = repairWorktrees({
      repoRoot: f.repoRoot,
      worktrees: [f.repoRoot],
      apply: true,
      writer: checkedWriter,
    });
    const edit = readFileSync(f.config, 'utf8') + '\n# new configuration\n';
    writeFileSync(f.config, edit);
    equal(
      restoreManifest(report.manifest, { repoRoot: f.repoRoot, writer: checkedWriter }).records[0]
        .status,
      'blocked',
    );
    equal(readFileSync(f.config, 'utf8'), edit);
  });

  it('restores a recorded replacement without depending on the current planner layout', () => {
    const f = fixture();
    const report = repairWorktrees({
      repoRoot: f.repoRoot,
      worktrees: [f.repoRoot],
      apply: true,
      writer: checkedWriter,
    });
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'));
    const historicalReplacement = readFileSync(f.config, 'utf8') + '\n# earlier repair version\n';
    writeFileSync(f.config, historicalReplacement);
    manifest.records[0].replacementHash = hash(historicalReplacement);
    writeFileSync(report.manifest, JSON.stringify(manifest));
    equal(
      restoreManifest(report.manifest, { repoRoot: f.repoRoot, writer: checkedWriter }).records[0]
        .status,
      'restored',
    );
    equal(readFileSync(f.config, 'utf8'), LEGACY);
  });

  it('refuses a tampered backup and a manifest from another repository', () => {
    const f = fixture();
    const report = repairWorktrees({
      repoRoot: f.repoRoot,
      worktrees: [f.repoRoot],
      apply: true,
      writer: checkedWriter,
    });
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'));
    writeFileSync(manifest.records[0].backupPath, LEGACY + '# tampered');
    equal(
      restoreManifest(report.manifest, { repoRoot: f.repoRoot, writer: checkedWriter }).records[0]
        .status,
      'blocked',
    );
    const other = fixture();
    throws(
      () => restoreManifest(report.manifest, { repoRoot: other.repoRoot, writer: checkedWriter }),
      RepairError,
    );
  });

  it('refuses a backup redirected outside the recovery directory', () => {
    const f = fixture();
    const report = repairWorktrees({
      repoRoot: f.repoRoot,
      worktrees: [f.repoRoot],
      apply: true,
      writer: checkedWriter,
    });
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'));
    manifest.records[0].backupPath = join(f.directory, 'outside.toml');
    writeFileSync(report.manifest, JSON.stringify(manifest));
    equal(
      restoreManifest(report.manifest, { repoRoot: f.repoRoot, writer: checkedWriter }).records[0]
        .status,
      'blocked',
    );
  });

  it('reports missing config and custom profiles without changing them', () => {
    const f = fixture();
    rmSync(f.config);
    equal(repairWorktrees({ repoRoot: f.repoRoot }).records[0].status, 'missing-config');
    writeFileSync(f.config, LEGACY.replace('extends = ":workspace"', 'extends = "custom"'));
    const before = readFileSync(f.config);
    equal(
      repairWorktrees({
        repoRoot: f.repoRoot,
        worktrees: [f.repoRoot],
        apply: true,
        writer: checkedWriter,
      }).records[0].status,
      'custom-profile',
    );
    deepStrictEqual(readFileSync(f.config), before);
  });

  it('reports a stale worktree without touching other worktrees', () => {
    const f = fixture();
    const stale = join(f.directory, 'stale');
    f.git(['worktree', 'add', '--detach', stale]);
    rmSync(stale, { recursive: true });
    const report = repairWorktrees({ repoRoot: f.repoRoot });
    equal(report.records.find((r) => resolve(r.worktree) === stale).status, 'blocked');
    equal(readFileSync(f.config, 'utf8'), LEGACY);
  });

  it('refuses a configuration directory junction', () => {
    const f = fixture();
    const elsewhere = join(f.directory, 'redirected');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, 'config.toml'), LEGACY);
    rmSync(dirname(f.config), { recursive: true });
    symlinkSync(elsewhere, dirname(f.config), process.platform === 'win32' ? 'junction' : 'dir');
    equal(
      repairWorktrees({
        repoRoot: f.repoRoot,
        worktrees: [f.repoRoot],
        apply: true,
        writer: checkedWriter,
      }).records[0].status,
      'blocked',
    );
    equal(readFileSync(join(elsewhere, 'config.toml'), 'utf8'), LEGACY);
  });

  it(
    'uses the native Windows checked writer without changing file access',
    { skip: process.platform !== 'win32' },
    () => {
      const f = fixture();
      const acl = () =>
        execFileSync(
          'powershell.exe',
          [
            '-NoLogo',
            '-NoProfile',
            '-Command',
            '[Console]::Out.Write([IO.File]::GetAccessControl([Console]::In.ReadToEnd()).GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::All))',
          ],
          { encoding: 'utf8', input: f.config, windowsHide: true },
        );
      const beforeAcl = acl();
      const replacement = planConfigRepair(LEGACY).replacement;
      throws(() => writeChecked(f.config, hash('wrong bytes'), replacement), RepairError);
      equal(readFileSync(f.config, 'utf8'), LEGACY);
      writeChecked(f.config, hash(LEGACY), replacement);
      equal(readFileSync(f.config, 'utf8'), replacement);
      writeChecked(f.config, hash(replacement), LEGACY);
      equal(readFileSync(f.config, 'utf8'), LEGACY);
      equal(acl(), beforeAcl);
    },
  );
  it(
    'refuses a native Windows file held by another writer',
    { skip: process.platform !== 'win32' },
    async () => {
      const f = fixture();
      const holder = spawn(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-Command',
          '$stream = [IO.File]::Open($env:CODEX_REPAIR_TEST_PATH, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None); try { [Console]::Out.Write("ready"); [Console]::Out.Flush(); [Threading.Thread]::Sleep(1500) } finally { $stream.Dispose() }',
        ],
        { env: { ...process.env, CODEX_REPAIR_TEST_PATH: f.config }, windowsHide: true },
      );
      const done = once(holder, 'close');
      try {
        const [ready] = await Promise.race([
          once(holder.stdout, 'data'),
          done.then(() => {
            throw new RepairError('Lock holder exited before acquiring the file.');
          }),
        ]);
        equal(ready.toString(), 'ready');
        throws(
          () => writeChecked(f.config, hash(LEGACY), planConfigRepair(LEGACY).replacement),
          RepairError,
        );
      } finally {
        await done;
      }
      equal(readFileSync(f.config, 'utf8'), LEGACY);
    },
  );
});

describe('repair command arguments', () => {
  it('defaults to inspection and requires explicit targets for apply', () => {
    deepStrictEqual(parseArgs([]), { apply: false, worktrees: [] });
    throws(() => parseArgs(['--apply']), RepairError);
    deepStrictEqual(parseArgs(['--apply', '--worktree', 'C:/repo']), {
      apply: true,
      worktrees: ['C:/repo'],
    });
  });
  it('rejects ambiguous or incomplete commands', () => {
    for (const args of [
      ['--unknown'],
      ['--worktree'],
      ['--restore'],
      ['--restore', 'backup', '--apply'],
    ]) {
      throws(() => parseArgs(args), RepairError);
    }
  });
});
