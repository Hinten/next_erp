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
const ENV_SECRET = ['.env', 'secrets'].join('.');
// Historical fixtures are intentionally independent of the live project configuration.
const LEGACY = `default_permissions = "next-erp"

[permissions.next-erp]
description = "Historical next-erp profile"
extends = ":workspace"

[permissions.next-erp.filesystem]
glob_scan_max_depth = 8

[permissions.next-erp.filesystem.":workspace_roots"]
".env" = "deny"
".env.local" = "deny"
"${ENV_SECRET}" = "deny"
"${ENV_SECRET}.example" = "deny"
"secrets" = "deny"
"secrets/**" = "deny"
".ignore" = "deny"
".ignore/**" = "deny"
"**/.env" = "deny"
"**/.env.local" = "deny"
"**/${ENV_SECRET}" = "deny"
"**/${ENV_SECRET}.example" = "deny"
"**/secrets" = "deny"
"**/secrets/**" = "deny"
"**/.ignore" = "deny"
"**/.ignore/**" = "deny"

[mcp_servers.playwright]
command = "node"
args = ["node_modules/@playwright/mcp/cli.js"]
`;
const MINIMAL_OFFLINE = `default_permissions = "next-erp"

[permissions.next-erp]
description = "Historical next-erp profile"

[permissions.next-erp.filesystem]
":minimal" = "read"
":tmpdir" = "write"
":slash_tmp" = "write"
glob_scan_max_depth = 8

[permissions.next-erp.filesystem.":workspace_roots"]
"." = "write"
".git" = "read"
".codex" = "read"
".agents" = "read"
".aws" = "read"
".env" = "deny"
".env.local" = "deny"
"${ENV_SECRET}" = "deny"
"${ENV_SECRET}.example" = "deny"
"secrets" = "deny"
"secrets/**" = "deny"
".ignore" = "deny"
".ignore/**" = "deny"
"**/.env" = "deny"
"**/.env.local" = "deny"
"**/${ENV_SECRET}" = "deny"
"**/${ENV_SECRET}.example" = "deny"
"**/secrets" = "deny"
"**/secrets/**" = "deny"
"**/.ignore" = "deny"
"**/.ignore/**" = "deny"

[permissions.next-erp.network]
enabled = false

[mcp_servers.playwright]
command = "node"
args = ["node_modules/@playwright/mcp/cli.js"]
`;
const MINIMAL_REGISTRY = MINIMAL_OFFLINE.replace(
  '[permissions.next-erp]',
  `[features]
network_proxy = true

[shell_environment_policy.set]
npm_config_cache = "out/codex-sandbox-cache/npm"
pnpm_config_store_dir = "out/codex-sandbox-cache/pnpm-store"
pnpm_config_cache_dir = "out/codex-sandbox-cache/pnpm-cache"
pnpm_config_state_dir = "out/codex-sandbox-cache/state"

[permissions.next-erp]`,
).replace(
  'enabled = false',
  `enabled = true
allow_local_binding = true

[permissions.next-erp.network.domains]
"registry.npmjs.org" = "allow"`,
);
const MINIMAL_DEPENDENCIES = MINIMAL_REGISTRY.replace(
  '".codex" = "read"',
  '".codex" = "read"\n".codex/node_modules" = "write"',
);
const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(configSource = LEGACY) {
  const directory = mkdtempSync(join(tmpdir(), 'next-erp-config-test-'));
  roots.push(directory);
  const repoRoot = join(directory, 'repo');
  mkdirSync(join(repoRoot, '.codex'), { recursive: true });
  const config = join(repoRoot, '.codex', 'config.toml');
  writeFileSync(config, configSource);
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
  it('recognizes historical profiles and the current profile idempotently', () => {
    for (const historical of [LEGACY, MINIMAL_OFFLINE, MINIMAL_REGISTRY, MINIMAL_DEPENDENCIES]) {
      const plan = planConfigRepair(historical);
      equal(plan.status, 'repairable');
      equal(planConfigRepair(plan.replacement).status, 'already-fixed');
      match(plan.replacement, /network_proxy\s*=\s*true/);
      match(plan.replacement, /allow_local_binding\s*=\s*true/);
      match(plan.replacement, /"registry\.npmjs\.org"\s*=\s*"allow"/);
      match(plan.replacement, /TURBO_TELEMETRY_DISABLED\s*=\s*"1"/);
      for (const [key, directory] of [
        ['npm_config_cache', 'npm'],
        ['pnpm_config_store_dir', 'pnpm-store'],
        ['pnpm_config_cache_dir', 'pnpm-cache'],
        ['pnpm_config_state_dir', 'state'],
      ]) {
        match(
          plan.replacement,
          new RegExp(key + '\\s*=\\s*"out/codex-sandbox-cache/' + directory + '"'),
        );
      }
    }
    equal(planConfigRepair(CONFIG).status, 'already-fixed');
  });

  it('upgrades the registry profile with generated-directory writes and preserves every other setting', () => {
    const source = MINIMAL_REGISTRY.replace(
      'network_proxy = true',
      'network_proxy = true\nfast_mode = false',
    ).replace(
      'npm_config_cache = "out/codex-sandbox-cache/npm"',
      'CUSTOM_FLAG = "keep me"\nnpm_config_cache = "out/codex-sandbox-cache/npm"',
    );
    const plan = planConfigRepair(source);
    equal(plan.status, 'repairable');
    equal(
      plan.replacement,
      source
        .replace(
          '[permissions.next-erp.filesystem.":workspace_roots"]\n',
          '[permissions.next-erp.filesystem.":workspace_roots"]\n".codex/node_modules" = "write"\n".codex/.turbo" = "write"\n',
        )
        .replace(
          '[shell_environment_policy.set]\n',
          '[shell_environment_policy.set]\nTURBO_TELEMETRY_DISABLED = "1"\n',
        ),
    );
    equal(planConfigRepair(plan.replacement).status, 'already-fixed');
  });

  it('adds only task-log writes and telemetry opt-out to the dependency-enabled profile', () => {
    const plan = planConfigRepair(MINIMAL_DEPENDENCIES);
    equal(plan.status, 'repairable');
    equal(
      plan.replacement,
      MINIMAL_DEPENDENCIES.replace(
        '[permissions.next-erp.filesystem.":workspace_roots"]\n',
        '[permissions.next-erp.filesystem.":workspace_roots"]\n".codex/.turbo" = "write"\n',
      ).replace(
        '[shell_environment_policy.set]\n',
        '[shell_environment_policy.set]\nTURBO_TELEMETRY_DISABLED = "1"\n',
      ),
    );
    equal(planConfigRepair(plan.replacement).status, 'already-fixed');
  });

  it('refuses custom dependency or metadata grants in the previous registry profile', () => {
    for (const extra of [
      '".codex/node_modules" = "read"',
      '".codex/rules" = "write"',
      '".codex/**" = "write"',
      '".codex/.turbo" = "read"',
      '".codex/.turbo/**" = "write"',
    ]) {
      const source = MINIMAL_REGISTRY.replace('".codex" = "read"', '".codex" = "read"\n' + extra);
      deepStrictEqual(planConfigRepair(source), { status: 'custom-profile' });
    }
    deepStrictEqual(
      planConfigRepair(MINIMAL_REGISTRY.replace('".codex" = "read"', '".codex" = "write"')),
      { status: 'custom-profile' },
    );
  });

  it('refuses a conflicting telemetry choice instead of silently replacing it', () => {
    const source = MINIMAL_DEPENDENCIES.replace(
      '[shell_environment_policy.set]\n',
      '[shell_environment_policy.set]\nTURBO_TELEMETRY_DISABLED = "0"\n',
    );
    deepStrictEqual(planConfigRepair(source), { status: 'custom-profile' });
  });

  it('preserves quoted telemetry keys and refuses conflicting or duplicate aliases', () => {
    for (const key of ['"TURBO_TELEMETRY_DISABLED"', "'TURBO_TELEMETRY_DISABLED'"]) {
      const source = MINIMAL_DEPENDENCIES.replace(
        '[shell_environment_policy.set]\n',
        '[shell_environment_policy.set]\n' + key + ' = "1"\n',
      );
      const plan = planConfigRepair(source);
      equal(plan.status, 'repairable');
      equal(
        plan.replacement,
        source.replace(
          '[permissions.next-erp.filesystem.":workspace_roots"]\n',
          '[permissions.next-erp.filesystem.":workspace_roots"]\n".codex/.turbo" = "write"\n',
        ),
      );
      equal(planConfigRepair(plan.replacement).status, 'already-fixed');
      deepStrictEqual(planConfigRepair(source.replace(key + ' = "1"', key + ' = "0"')), {
        status: 'custom-profile',
      });
      deepStrictEqual(
        planConfigRepair(
          source.replace(key + ' = "1"', key + ' = "1"\nTURBO_TELEMETRY_DISABLED = "1"'),
        ),
        { status: 'custom-profile' },
      );
    }
  });

  for (const key of ['features', '"features"', "'features'", String.raw`"\u0066eatures"`]) {
    for (const definition of [
      `${key} = { network_proxy = false }`,
      `${key}."network_proxy" = true`,
    ]) {
      it(`refuses root feature definitions using ${definition}`, () => {
        for (const historical of [LEGACY, MINIMAL_OFFLINE]) {
          deepStrictEqual(planConfigRepair(definition + '\n' + historical), {
            status: 'custom-profile',
          });
        }
      });
    }
  }

  for (const definition of [
    '"shell_environment_policy" = { set = { CUSTOM = "keep" } }',
    "'shell_environment_policy'.'set'.CUSTOM = 'keep'",
    'shell_environment_policy."set" = { CUSTOM = "keep" }',
    String.raw`"\u0073hell_environment_policy".set.CUSTOM = "keep"`,
  ]) {
    it(`refuses root environment definitions using ${definition}`, () => {
      for (const historical of [LEGACY, MINIMAL_OFFLINE]) {
        deepStrictEqual(planConfigRepair(definition + '\n' + historical), {
          status: 'custom-profile',
        });
      }
    });
  }

  for (const header of [
    '[shell_environment_policy]',
    '["shell_environment_policy"]',
    "['shell_environment_policy']",
    String.raw`["\u0073hell_environment_policy"]`,
  ]) {
    for (const key of ['set', '"set"', "'set'", String.raw`"\u0073et"`]) {
      it(`refuses an inline environment target under ${header} using ${key}`, () => {
        const prefix = `${header}\n${key} = { CUSTOM = "keep" }\n`;
        deepStrictEqual(planConfigRepair(prefix + LEGACY), { status: 'custom-profile' });
      });
    }
  }

  for (const header of [
    '["features"]',
    "['features']",
    String.raw`["\u0066eatures"]`,
    '[shell_environment_policy."set"]',
    '["shell_environment_policy".set]',
    "['shell_environment_policy'.'set']",
    String.raw`[shell_environment_policy."\u0073et"]`,
    String.raw`["\u0073hell_environment_policy".set]`,
  ]) {
    it(`refuses default table aliases using ${header}`, () => {
      deepStrictEqual(planConfigRepair(header + '\nCUSTOM = "keep"\n' + LEGACY), {
        status: 'custom-profile',
      });
    });
  }

  it('preserves escaped required keys and refuses duplicate, conflicting or dotted aliases', () => {
    const key = String.raw`"\u0054URBO_TELEMETRY_DISABLED"`;
    const source = CONFIG.replace('TURBO_TELEMETRY_DISABLED = "1"', `${key} = "1"`);
    deepStrictEqual(planConfigRepair(source), { status: 'already-fixed' });
    for (const replacement of [
      `${key} = "0"`,
      `${key} = "1"\nTURBO_TELEMETRY_DISABLED = "1"`,
      'TURBO_TELEMETRY_DISABLED.child = "1"',
    ]) {
      deepStrictEqual(
        planConfigRepair(CONFIG.replace('TURBO_TELEMETRY_DISABLED = "1"', replacement)),
        {
          status: 'custom-profile',
        },
      );
    }
    deepStrictEqual(
      planConfigRepair(
        CONFIG.replace('network_proxy = true', String.raw`"\u006eetwork_proxy" = true`),
      ),
      { status: 'already-fixed' },
    );
    deepStrictEqual(
      planConfigRepair(CONFIG.replace('network_proxy = true', 'network_proxy.child = true')),
      {
        status: 'custom-profile',
      },
    );
  });

  for (const [header, scalar, value] of [
    ['[features."network_proxy"]', 'network_proxy = true', 'true'],
    ['[features."network_proxy".deeper]', 'network_proxy = true', 'true'],
    [String.raw`[features."\u006eetwork_proxy"]`, 'network_proxy = true', 'true'],
    [
      '[shell_environment_policy.set."TURBO_TELEMETRY_DISABLED"]',
      'TURBO_TELEMETRY_DISABLED = "1"',
      '"1"',
    ],
    [
      '[shell_environment_policy.set."TURBO_TELEMETRY_DISABLED".deeper]',
      'TURBO_TELEMETRY_DISABLED = "1"',
      '"1"',
    ],
  ]) {
    it(`refuses required scalar keys already defined by the table ${header}`, () => {
      const declaration = `${header}\nchild = ${value}\n`;
      for (const historical of [LEGACY, MINIMAL_OFFLINE]) {
        const source = historical.replace(
          '[permissions.next-erp]',
          declaration + '[permissions.next-erp]',
        );
        deepStrictEqual(planConfigRepair(source), { status: 'custom-profile' });
      }
      const current = CONFIG.replace(scalar + '\n', '') + '\n' + declaration;
      deepStrictEqual(planConfigRepair(current), { status: 'custom-profile' });
    });
  }

  it('keeps literal dotted and longer descendant names distinct from required scalar keys', () => {
    for (const header of [
      '[features."network_proxy.extra"]',
      '[features.network_proxy_extra]',
      '[shell_environment_policy.set."TURBO_TELEMETRY_DISABLED.extra"]',
    ]) {
      const suffix = `\n${header}\nchild = "preserved"\n`;
      const plan = planConfigRepair(LEGACY + suffix);
      equal(plan.status, 'repairable');
      equal(plan.replacement.endsWith(suffix), true);
      equal(planConfigRepair(plan.replacement).status, 'already-fixed');
    }
  });

  it('keeps literal dots and longer prefixes distinct from structural key paths', () => {
    const prefix =
      '"features.network_proxy" = false\n' +
      'features_extra.network_proxy = false\n' +
      '"shell_environment_policy.set" = { CUSTOM = "keep" }\n' +
      'shell_environment_policy_extra.set = { CUSTOM = "keep" }\n';
    const suffix =
      '\n["features.network_proxy"]\nCUSTOM = "table preserved"\n' +
      '\n["shell_environment_policy.set"]\nCUSTOM = "environment table preserved"\n';
    for (const [before, after] of [
      [prefix, ''],
      ['', suffix],
    ]) {
      const source = before + LEGACY + after;
      const plan = planConfigRepair(source);
      equal(plan.status, 'repairable');
      equal(plan.replacement.startsWith(before), true);
      equal(plan.replacement.endsWith(after), true);
      equal(planConfigRepair(plan.replacement).status, 'already-fixed');
    }
    const literalLeaf = CONFIG.replace('network_proxy = true', '"network_proxy.child" = false');
    const leafPlan = planConfigRepair(literalLeaf);
    equal(leafPlan.status, 'repairable');
    match(leafPlan.replacement, /"network_proxy\.child" = false/);
    equal(planConfigRepair(leafPlan.replacement).status, 'already-fixed');
  });

  it('does not treat comments or multiline prose as structural definitions', () => {
    for (const delimiter of ['"""', "'".repeat(3)]) {
      const prefix =
        '# "features".network_proxy = false\n' +
        'developer_instructions = ' +
        delimiter +
        '\n' +
        '"features".network_proxy = false\n' +
        '"shell_environment_policy" = { set = {} }\n' +
        '["features"]\n' +
        delimiter +
        '\n';
      const source = prefix + LEGACY;
      const plan = planConfigRepair(source);
      equal(plan.status, 'repairable');
      equal(plan.replacement.startsWith(prefix), true);
      equal(planConfigRepair(plan.replacement).status, 'already-fixed');
    }
    const prefix = '[shell_environment_policy]\n# "set" = {}\nDOC = """\n"set" = {}\n"""\n';
    const plan = planConfigRepair(prefix + LEGACY);
    equal(plan.status, 'repairable');
    equal(plan.replacement.includes(prefix), true);
    equal(planConfigRepair(plan.replacement).status, 'already-fixed');
  });

  for (const definition of [
    String.raw`["features\q"]`,
    String.raw`["\U00000066eatures"]`,
    String.raw`"features\q".network_proxy = false`,
    '[[features]]',
  ]) {
    it(`leaves unhandled actual syntax for review: ${definition}`, () => {
      deepStrictEqual(planConfigRepair(definition + '\n' + LEGACY), { status: 'custom-profile' });
    });
  }

  it('refuses assignment-looking defaults inside multiline environment values', () => {
    for (const delimiter of ['"""', "'''"]) {
      const source = CONFIG.replace('TURBO_TELEMETRY_DISABLED = "1"\n', '').replace(
        '[shell_environment_policy.set]\n',
        '[shell_environment_policy.set]\nSYNTHETIC = ' +
          delimiter +
          '\nTURBO_TELEMETRY_DISABLED = "1"\n' +
          delimiter +
          '\n',
      );
      deepStrictEqual(planConfigRepair(source), { status: 'custom-profile' });
    }
  });

  it('keeps multiline values in unrelated tables outside the defaults check', () => {
    const suffix = '\n[unrelated]\nvalue = """\nTURBO_TELEMETRY_DISABLED = "0"\n"""\n';
    const source = MINIMAL_DEPENDENCIES + suffix;
    const plan = planConfigRepair(source);
    equal(plan.status, 'repairable');
    equal(plan.replacement.slice(-suffix.length), suffix);
    equal(planConfigRepair(plan.replacement).status, 'already-fixed');
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
    [
      'incomplete network policy',
      () => MINIMAL_OFFLINE.replace('enabled = false', 'enabled = true'),
    ],
    [
      'changed loopback policy',
      () => CONFIG.replace('allow_local_binding = true', 'allow_local_binding = false'),
    ],
    ['disabled proxy', () => CONFIG.replace('network_proxy = true', 'network_proxy = false')],
    [
      'custom cache location',
      () => CONFIG.replace('out/codex-sandbox-cache/pnpm-store', 'C:/custom-store'),
    ],
    [
      'additional registry domain',
      () =>
        CONFIG.replace(
          '"registry.npmjs.org" = "allow"',
          '"registry.npmjs.org" = "allow"\n"*" = "allow"',
        ),
    ],
    [
      'duplicate feature table',
      (s) => s + '\n[features]\nnetwork_proxy = true\n[features]\nother = true\n',
    ],
    [
      'duplicate environment table',
      (s) =>
        s +
        '\n[shell_environment_policy.set]\nLANG = "en"\n[shell_environment_policy.set]\nOTHER = "keep"\n',
    ],
  ]) {
    it(`refuses ${name}`, () => {
      deepStrictEqual(planConfigRepair(change(LEGACY)), { status: 'custom-profile' });
    });
  }

  it('preserves unrelated feature and environment settings while adding missing defaults', () => {
    const featurePrefix = '[features]\nfast_mode = false\n\n';
    const environmentPrefix =
      '[shell_environment_policy.set]\nLANG = "en_US.UTF-8"\nCUSTOM_FLAG = "keep me"\n\n';
    const plan = planConfigRepair(featurePrefix + environmentPrefix + MINIMAL_OFFLINE);
    equal(plan.status, 'repairable');
    match(plan.replacement, /fast_mode = false/);
    match(plan.replacement, /LANG = "en_US.UTF-8"/);
    match(plan.replacement, /CUSTOM_FLAG = "keep me"/);
    equal((plan.replacement.match(/^\[features\]$/gm) ?? []).length, 1);
    equal((plan.replacement.match(/^\[shell_environment_policy\.set\]$/gm) ?? []).length, 1);
    equal(planConfigRepair(plan.replacement).status, 'already-fixed');
  });

  it('preserves explicit compatible proxy and partial cache settings without duplicates', () => {
    const prefix =
      '[features]\nnetwork_proxy = true\nfast_mode = false\n\n' +
      '[shell_environment_policy.set]\nnpm_config_cache = "out/codex-sandbox-cache/npm"\nCUSTOM_FLAG = "keep me"\n\n';
    const plan = planConfigRepair(prefix + LEGACY);
    equal(plan.status, 'repairable');
    equal((plan.replacement.match(/^network_proxy\s*=/gm) ?? []).length, 1);
    equal((plan.replacement.match(/^npm_config_cache\s*=/gm) ?? []).length, 1);
    match(plan.replacement, /fast_mode = false/);
    match(plan.replacement, /CUSTOM_FLAG = "keep me"/);
    equal(planConfigRepair(plan.replacement).status, 'already-fixed');
  });

  it('refuses conflicting defaults before changing an otherwise historical profile', () => {
    for (const prefix of [
      '[features]\nnetwork_proxy = false\n\n',
      '[shell_environment_policy.set]\npnpm_config_store_dir = "C:/custom-store"\n\n',
    ]) {
      for (const historical of [LEGACY, MINIMAL_OFFLINE]) {
        deepStrictEqual(planConfigRepair(prefix + historical), { status: 'custom-profile' });
      }
    }
  });

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

  it('refuses quoted structural defaults before backups or writer calls and preserves bytes', () => {
    const original = '"features".network_proxy = false\n' + LEGACY;
    const f = fixture(original);
    let writes = 0;
    const report = repairWorktrees({
      repoRoot: f.repoRoot,
      worktrees: [f.repoRoot],
      apply: true,
      writer: () => {
        writes++;
      },
    });
    equal(report.records[0].status, 'custom-profile');
    equal(report.manifest, undefined);
    equal(writes, 0);
    equal(readFileSync(f.config, 'utf8'), original);
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

  it('backs up and restores the historical minimal offline profile', () => {
    const f = fixture(MINIMAL_OFFLINE);
    const report = repairWorktrees({
      repoRoot: f.repoRoot,
      worktrees: [f.repoRoot],
      apply: true,
      writer: checkedWriter,
    });
    equal(report.records[0].status, 'repaired');
    equal(planConfigRepair(readFileSync(f.config, 'utf8')).status, 'already-fixed');
    const manifest = JSON.parse(readFileSync(report.manifest, 'utf8'));
    equal(readFileSync(manifest.records[0].backupPath, 'utf8'), MINIMAL_OFFLINE);
    equal(
      restoreManifest(report.manifest, { repoRoot: f.repoRoot, writer: checkedWriter }).records[0]
        .status,
      'restored',
    );
    equal(readFileSync(f.config, 'utf8'), MINIMAL_OFFLINE);
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
