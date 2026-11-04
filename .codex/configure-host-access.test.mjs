import { deepStrictEqual, match, strictEqual, throws } from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, it } from 'node:test';

import {
  configureHostAccess,
  discoverHostGrants,
  hostPathDiagnostics,
  parseHostArgs,
  planHostAccess,
  restoreHostAccess,
} from './configure-host-access.mjs';
import { hash, RepairError } from './repair-worktree-config.mjs';

const SELECTOR = 'default_permissions = ":workspace"\n';
const TEST_HOME = resolve('host-config-test-user');
const GRANTS = [
  { path: join(TEST_HOME, '.cache', 'codex-runtimes', 'dependencies'), access: 'read' },
  { path: join(TEST_HOME, '.gitconfig'), access: 'read' },
  { path: resolve('host-config-test-repository', '.git'), access: 'write' },
];

function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'codex-host-access-'));
  const home = join(root, 'user');
  const repoRoot = join(root, 'worktree');
  const common = join(root, 'checkout', '.git');
  const admin = join(common, 'worktrees', 'test');
  const runtime = join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies');
  const configPath = join(home, '.codex', 'config.toml');
  for (const directory of [
    runtime,
    repoRoot,
    admin,
    join(common, 'objects'),
    dirname(configPath),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFileSync(configPath, SELECTOR + 'model = "test-model"\n');
  writeFileSync(join(common, 'HEAD'), 'ref: refs/heads/main\n');
  writeFileSync(join(repoRoot, '.git'), 'gitdir: ' + admin + '\n');
  writeFileSync(join(admin, 'commondir'), '../..\n');
  writeFileSync(join(home, '.gitconfig'), '[user]\nname = Example\n');
  const writer = (path, expected, bytes) => {
    if (hash(readFileSync(path)) !== expected) throw new RepairError('Concurrent edit.');
    writeFileSync(path, bytes);
  };
  try {
    return run({ root, home, repoRoot, common, runtime, configPath, writer });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('host overlay planning with an explicit existing default', () => {
  it('preserves existing bytes, line endings and unrelated settings', () => {
    const source =
      'default_permissions = ":workspace"\r\nmodel = "keep-me"\r\n\r\n[features]\r\ncustom = true\r\n';
    const plan = planHostAccess(source, { home: TEST_HOME, grants: GRANTS });
    strictEqual(plan.status, 'repairable');
    strictEqual(plan.replacement.startsWith(source), true);
    match(plan.replacement, /\[permissions\.next-erp\.filesystem\]\r\n/);
    strictEqual(
      planHostAccess(plan.replacement, { home: TEST_HOME, grants: GRANTS }).status,
      'already-configured',
    );
  });

  it('merges into an existing quoted table without altering unrelated entries', () => {
    const source =
      SELECTOR +
      '[permissions."next-erp".filesystem]\n":minimal" = "read"\n\n[other]\nvalue = "kept"\n';
    const plan = planHostAccess(source, { home: TEST_HOME, grants: GRANTS });
    strictEqual(
      plan.replacement.includes('\n":minimal" = "read"\n\n[other]\nvalue = "kept"\n'),
      true,
    );
    strictEqual((plan.replacement.match(/\[permissions/g) ?? []).length, 1);
  });

  it('recognizes equivalent home-relative grants without rewriting matching settings', () => {
    const source = SELECTOR + '[permissions.next-erp.filesystem]\n"~/.gitconfig" = "read"\n';
    const plan = planHostAccess(source, { home: TEST_HOME, grants: [GRANTS[1]] });
    strictEqual(plan.status, 'already-configured');
    strictEqual(plan.replacement, source);
  });

  it('ignores header-looking strings while preserving their bytes', () => {
    const source =
      SELECTOR +
      'developer_instructions = """\n[permissions.next-erp.filesystem]\n"fake" = "deny"\n"""\n[features]\ncustom = true\n';
    const plan = planHostAccess(source, { home: TEST_HOME, grants: GRANTS });
    strictEqual(plan.replacement.startsWith(source), true);
  });

  it('refuses conflicting permissions and duplicate semantic paths', () => {
    const absolute = JSON.stringify(GRANTS[1].path.replaceAll('\\', '/'));
    throws(
      () =>
        planHostAccess(
          SELECTOR + '[permissions.next-erp.filesystem]\n' + absolute + ' = "deny"\n',
          { home: TEST_HOME, grants: GRANTS },
        ),
      /conflicting permission/,
    );
    throws(
      () =>
        planHostAccess(
          SELECTOR +
            '[permissions.next-erp.filesystem]\n"~/.gitconfig" = "read"\n' +
            absolute +
            ' = "read"\n',
          { home: TEST_HOME, grants: GRANTS },
        ),
      /Duplicate host path/,
    );
  });

  it('keeps a similarly named credential file distinct from the required Git config path', () => {
    const source = SELECTOR + '[permissions.next-erp.filesystem]\n"~/.gitconfig.backup" = "deny"\n';
    const plan = planHostAccess(source, { home: TEST_HOME, grants: [GRANTS[1]] });
    strictEqual(plan.status, 'repairable');
    match(plan.replacement, /"~\/\.gitconfig\.backup" = "deny"/);
    strictEqual(
      planHostAccess(plan.replacement, { home: TEST_HOME, grants: [GRANTS[1]] }).status,
      'already-configured',
    );
  });

  it('refuses duplicate tables, inline structures and scoped target tables', () => {
    throws(
      () =>
        planHostAccess(
          SELECTOR + '[permissions.next-erp.filesystem]\n[permissions."next-erp".filesystem]\n',
          { home: TEST_HOME, grants: GRANTS },
        ),
      /Duplicate host filesystem/,
    );
    throws(
      () =>
        planHostAccess(
          SELECTOR + '[permissions.next-erp]\nfilesystem = { ":minimal" = "read" }\n',
          { home: TEST_HOME, grants: GRANTS },
        ),
      /manual review/,
    );
    const path = JSON.stringify(GRANTS[1].path.replaceAll('\\', '/'));
    throws(
      () =>
        planHostAccess(
          SELECTOR + '[permissions.next-erp.filesystem.' + path + ']\n"." = "read"\n',
          { home: TEST_HOME, grants: GRANTS },
        ),
      /scoped host table/,
    );
  });

  it('rejects drive-wide or special-root grant requests', () => {
    for (const path of [resolve('/'), ':root', ':workspace_roots']) {
      throws(
        () => planHostAccess(SELECTOR, { home: TEST_HOME, grants: [{ path, access: 'read' }] }),
        /not roots/,
      );
    }
  });
});

describe('global default selection regression', () => {
  it('blocks the original permissions-without-default failure before proposing any writes', () => {
    for (const source of [
      'model = "keep-me"\n',
      '[permissions.next-erp.filesystem]\n"~/.gitconfig" = "read"\n',
    ]) {
      const plan = planHostAccess(source, { home: TEST_HOME, grants: GRANTS });
      strictEqual(plan.status, 'blocked-missing-default');
      strictEqual('replacement' in plan, false);
    }
  });

  it('blocks before runtime discovery, backups or writer calls when the default is absent', () =>
    fixture(({ home, repoRoot, configPath, runtime }) => {
      const original = 'model = "missing-default"\n';
      writeFileSync(configPath, original);
      rmSync(runtime, { recursive: true });
      const report = configureHostAccess({
        apply: true,
        home,
        repoRoot,
        writer: () => {
          throw new RepairError('Unexpected write.');
        },
      });
      strictEqual(report.status, 'blocked-missing-default');
      deepStrictEqual(report.grants, []);
      strictEqual(readFileSync(configPath, 'utf8'), original);
      strictEqual(existsSync(join(home, '.codex', 'backups')), false);
    }));

  it('does not accept a fake selector in multiline prose, comments or nested tables', () => {
    for (const source of [
      'developer_instructions = """\ndefault_permissions = ":workspace"\n"""\n',
      '# default_permissions = ":workspace"\n',
      '[examples]\ndefault_permissions = ":workspace"\n',
      '[[examples]]\ndefault_permissions = ":workspace"\n',
    ]) {
      strictEqual(
        planHostAccess(source, { home: TEST_HOME, grants: GRANTS }).status,
        'blocked-missing-default',
      );
    }
  });

  it('refuses duplicate or malformed root selectors even with explicit opt-in', () => {
    for (const source of [
      SELECTOR + 'default_permissions = ":workspace"\n',
      SELECTOR + '"default_permissions" = ":workspace"\n',
      'default_permissions = 42\n',
      'default_permissions = [":workspace"]\n',
      'default_permissions = ""\n',
      'default_permissions = "arbitrary prose value"\n',
      'default_permissions = ":unknown-builtin"\n',
      'default_permissions = "undefined-custom-profile"\n',
    ]) {
      for (const defaultPermissions of [undefined, ':workspace']) {
        const plan = planHostAccess(source, {
          home: TEST_HOME,
          grants: GRANTS,
          defaultPermissions,
        });
        strictEqual(plan.status, 'blocked-invalid-default');
        strictEqual('replacement' in plan, false);
      }
    }
  });

  it('preserves an existing different default and rejects an explicit attempt to change it', () => {
    const source = 'default_permissions = ":read-only"\n';
    const unchanged = planHostAccess(source, { home: TEST_HOME, grants: GRANTS });
    strictEqual(unchanged.status, 'repairable');
    strictEqual(unchanged.replacement.startsWith(source), true);
    const conflict = planHostAccess(source, {
      home: TEST_HOME,
      grants: GRANTS,
      defaultPermissions: ':workspace',
    });
    strictEqual(conflict.status, 'blocked-conflicting-default');
    strictEqual('replacement' in conflict, false);
  });

  it('allows only explicit :workspace opt-in and keeps CRLF/BOM and original bytes otherwise', () => {
    const source = '\uFEFFmodel = "keep-me"\r\n';
    const plan = planHostAccess(source, {
      home: TEST_HOME,
      grants: GRANTS,
      defaultPermissions: ':workspace',
    });
    strictEqual(plan.status, 'repairable');
    strictEqual(
      plan.replacement.startsWith('\uFEFFdefault_permissions = ":workspace"\r\n' + source.slice(1)),
      true,
    );
    strictEqual((plan.replacement.match(/default_permissions/g) ?? []).length, 1);
    throws(
      () =>
        planHostAccess(source, {
          home: TEST_HOME,
          grants: GRANTS,
          defaultPermissions: ':read-only',
        }),
      /Only an explicit/,
    );
  });

  it('treats adding a selector to already-present grants as a repair, then becomes idempotent', () => {
    const existing = planHostAccess(SELECTOR, { home: TEST_HOME, grants: GRANTS }).replacement;
    const missing = existing.slice(SELECTOR.length);
    strictEqual(
      planHostAccess(missing, { home: TEST_HOME, grants: GRANTS }).status,
      'blocked-missing-default',
    );
    const opted = planHostAccess(missing, {
      home: TEST_HOME,
      grants: GRANTS,
      defaultPermissions: ':workspace',
    });
    strictEqual(opted.status, 'repairable');
    strictEqual(
      planHostAccess(opted.replacement, {
        home: TEST_HOME,
        grants: GRANTS,
        defaultPermissions: ':workspace',
      }).status,
      'already-configured',
    );
  });

  it('allows an existing named default only when its profile is actually defined', () => {
    const source =
      'default_permissions = "existing-profile"\n[permissions.existing-profile]\nextends = ":workspace"\n';
    strictEqual(planHostAccess(source, { home: TEST_HOME, grants: GRANTS }).status, 'repairable');
  });
});

describe('legacy compatibility and sanitized diagnostics', () => {
  it('keeps blocking real legacy sandbox configuration even with an opted-in default', () => {
    for (const source of [
      'sandbox_mode = "workspace-write"\n',
      '[sandbox_workspace_write]\nnetwork_access = false\n',
    ]) {
      for (const defaultPermissions of [undefined, ':workspace']) {
        strictEqual(
          planHostAccess(source, { home: TEST_HOME, grants: GRANTS, defaultPermissions }).status,
          'blocked-legacy-settings',
        );
      }
    }
  });

  it('ignores legacy examples inside multiline instructions', () => {
    const source =
      SELECTOR +
      'developer_instructions = """\nsandbox_mode = "workspace-write"\n[sandbox_workspace_write]\n"""\n';
    strictEqual(planHostAccess(source, { home: TEST_HOME, grants: GRANTS }).status, 'repairable');
    deepStrictEqual(hostPathDiagnostics(source), [
      { kind: 'default-permission-profile', line: 1, profile: ':workspace' },
    ]);
  });

  it('reports only diagnostic categories, line numbers and safe default identifiers', () => {
    const source =
      'default_permissions = ":workspace"\n[permissions.example]\nextends = ":workspace"\n[permissions.example.filesystem]\n":root" = "read"\n"X:/actual" = "read"\n[sandbox_workspace_write]\nwritable_roots = ["private-path"]\n';
    deepStrictEqual(hostPathDiagnostics(source), [
      { kind: 'default-permission-profile', line: 1, profile: ':workspace' },
      { kind: 'workspace-inheritance', line: 3 },
      { kind: 'broad-root-grant', line: 5 },
      { kind: 'x-drive-filesystem-grant', line: 6 },
      { kind: 'legacy-workspace-settings', line: 7 },
      { kind: 'additional-writable-roots', line: 8 },
    ]);
    deepStrictEqual(hostPathDiagnostics('default_permissions = "arbitrary prose value"\n'), [
      { kind: 'default-permission-profile', line: 1 },
    ]);
  });

  it('does not mistake X paths or legacy settings in multiline prose for active settings', () => {
    const source =
      '[permissions.example]\ndescription = """\nextends = ":workspace"\n[permissions.fake.filesystem]\n"X:/fake" = "read"\n"""\n[permissions.example.filesystem."X:/scoped"]\n"." = "read"\n';
    deepStrictEqual(hostPathDiagnostics(source), [{ kind: 'x-drive-filesystem-grant', line: 7 }]);
  });
});

describe('host application and recovery', () => {
  it('discovers only existing tool and shared Git paths', () =>
    fixture(({ home, repoRoot, common, runtime }) => {
      deepStrictEqual(discoverHostGrants({ home, repoRoot }), [
        { path: runtime, access: 'read' },
        { path: common, access: 'write' },
        { path: join(home, '.gitconfig'), access: 'read' },
      ]);
      rmSync(join(home, '.gitconfig'));
      strictEqual(discoverHostGrants({ home, repoRoot }).length, 2);
    }));

  it('keeps dry runs read-only with or without explicit selector opt-in', () =>
    fixture(({ home, repoRoot, configPath }) => {
      const original = 'model = "dry-run"\n';
      writeFileSync(configPath, original);
      const options = {
        home,
        repoRoot,
        writer: () => {
          throw new RepairError('Unexpected write.');
        },
      };
      strictEqual(configureHostAccess(options).status, 'blocked-missing-default');
      const report = configureHostAccess({ ...options, defaultPermissions: ':workspace' });
      strictEqual(report.status, 'repairable');
      strictEqual(report.addsDefaultPermissions, true);
      strictEqual(readFileSync(configPath, 'utf8'), original);
      strictEqual(existsSync(join(home, '.codex', 'backups')), false);
    }));

  it('backs up outside the repository and restores an existing selected configuration', () =>
    fixture(({ home, repoRoot, configPath, writer }) => {
      const original = readFileSync(configPath, 'utf8');
      const report = configureHostAccess({ apply: true, home, repoRoot, writer });
      strictEqual(report.status, 'configured');
      strictEqual(report.addsDefaultPermissions, false);
      strictEqual(
        report.manifest.startsWith(join(home, '.codex', 'backups', 'host-access') + sep),
        true,
      );
      strictEqual(relative(repoRoot, report.manifest).startsWith('..'), true);
      strictEqual(readFileSync(join(dirname(report.manifest), 'original.toml'), 'utf8'), original);
      strictEqual(
        configureHostAccess({ apply: true, home, repoRoot, writer }).status,
        'already-configured',
      );
      strictEqual(restoreHostAccess(report.manifest, { home, writer }).status, 'restored');
      strictEqual(readFileSync(configPath, 'utf8'), original);
      strictEqual(restoreHostAccess(report.manifest, { home, writer }).status, 'already-restored');
    }));

  it('applies opted-in default and grants atomically, and rollback removes both without leaking config', () =>
    fixture(({ home, repoRoot, configPath, writer }) => {
      const original =
        'model = "keep-me"\n[mcp_servers.example.env]\nAPI_KEY = "fixture-private-value"\n';
      writeFileSync(configPath, original);
      let writes = 0;
      const report = configureHostAccess({
        apply: true,
        defaultPermissions: ':workspace',
        home,
        repoRoot,
        writer: (path, expected, bytes) => {
          writes++;
          strictEqual(String(bytes).startsWith(SELECTOR + original), true);
          match(String(bytes), /\[permissions\.next-erp\.filesystem\]/);
          writer(path, expected, bytes);
        },
      });
      strictEqual(writes, 1);
      strictEqual(report.addsDefaultPermissions, true);
      strictEqual(JSON.stringify(report).includes('fixture-private-value'), false);
      strictEqual(restoreHostAccess(report.manifest, { home, writer }).status, 'restored');
      strictEqual(readFileSync(configPath, 'utf8'), original);
    }));

  it('preserves concurrent apply edits and refuses to overwrite newer restore edits', () =>
    fixture(({ home, repoRoot, configPath, writer }) => {
      throws(
        () =>
          configureHostAccess({
            apply: true,
            home,
            repoRoot,
            writer: (path, expected, bytes) => {
              writeFileSync(path, SELECTOR + 'model = "concurrent"\n');
              writer(path, expected, bytes);
            },
          }),
        /Concurrent edit/,
      );
      strictEqual(readFileSync(configPath, 'utf8'), SELECTOR + 'model = "concurrent"\n');
      const report = configureHostAccess({ apply: true, home, repoRoot, writer });
      writeFileSync(configPath, readFileSync(configPath, 'utf8') + '\n# newer edit\n');
      throws(() => restoreHostAccess(report.manifest, { home, writer }), /changed after repair/);
    }));

  it('rejects tampered backups, another user and repository-local manifests', () =>
    fixture(({ home, repoRoot, writer }) => {
      const report = configureHostAccess({ apply: true, home, repoRoot, writer });
      writeFileSync(
        join(dirname(report.manifest), 'original.toml'),
        SELECTOR + 'model = "tampered"\n',
      );
      throws(() => restoreHostAccess(report.manifest, { home, writer }), /verification failed/);
      throws(
        () => restoreHostAccess(report.manifest, { home: join(home, 'other'), writer }),
        /this user backup directory/,
      );
      throws(
        () =>
          restoreHostAccess(report.manifest, { home, repoRoot: dirname(report.manifest), writer }),
        /outside the repository/,
      );
    }));

  it('restores an old manifest even when its original had no default selector', () =>
    fixture(({ home, configPath, writer }) => {
      const original = 'model = "old-original-without-default"\n';
      const historical =
        original + '\n[permissions.next-erp.filesystem]\n"~/.gitconfig" = "read"\n';
      const directory = join(home, '.codex', 'backups', 'host-access', 'historical');
      mkdirSync(directory, { recursive: true });
      const manifestPath = join(directory, 'manifest.json');
      writeFileSync(join(directory, 'original.toml'), original);
      writeFileSync(
        manifestPath,
        JSON.stringify({
          version: 1,
          kind: 'host-access',
          configPath,
          originalHash: hash(original),
          replacementHash: hash(historical),
        }),
      );
      writeFileSync(configPath, historical);
      strictEqual(restoreHostAccess(manifestPath, { home, writer }).status, 'restored');
      strictEqual(readFileSync(configPath, 'utf8'), original);
    }));
});

describe('explicit command-line choices', () => {
  it('keeps default selection opt-in and permits preview or apply explicitly', () => {
    deepStrictEqual(parseHostArgs([]), { apply: false });
    deepStrictEqual(parseHostArgs(['--apply']), { apply: true });
    deepStrictEqual(parseHostArgs(['--default-permissions', ':workspace']), {
      apply: false,
      defaultPermissions: ':workspace',
    });
    deepStrictEqual(parseHostArgs(['--apply', '--default-permissions', ':workspace']), {
      apply: true,
      defaultPermissions: ':workspace',
    });
    deepStrictEqual(parseHostArgs(['--restore', 'manifest.json']), {
      restore: resolve('manifest.json'),
    });
  });

  it('rejects other defaults, duplicate flags and opt-in combined with restore', () => {
    for (const args of [
      ['--default-permissions'],
      ['--default-permissions', ':read-only'],
      ['--default-permissions', 'next-erp'],
      ['--default-permissions', ':workspace', '--restore', 'manifest.json'],
      ['--apply', '--restore', 'manifest.json'],
      ['--apply', '--apply'],
      ['--config', 'other.toml'],
      ['--restore'],
      ['--restore', '--apply'],
    ])
      throws(() => parseHostArgs(args), RepairError);
  });
});
