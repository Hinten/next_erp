// Run explicitly from an external terminal when the active sandbox cannot read
// its own runtime or linked-worktree metadata. No dependencies are required.
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { hash, RepairError, tables, writeChecked } from './repair-worktree-config.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), '..');
const PROFILE_TABLE = ['permissions', 'next-erp', 'filesystem'];

function stringValue(literal) {
  if (literal.startsWith("'")) return literal.slice(1, -1);
  return JSON.parse(literal);
}

function keyParts(text) {
  const result = [];
  let remaining = text.trim();
  while (remaining) {
    const part = remaining.match(/^("(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)/);
    if (!part) return null;
    result.push(/^["']/.test(part[0]) ? stringValue(part[0]) : part[0]);
    remaining = remaining.slice(part[0].length).trimStart();
    if (!remaining) return result;
    if (!remaining.startsWith('.')) return null;
    remaining = remaining.slice(1).trimStart();
    if (!remaining) return null;
  }
  return null;
}

function assignment(line) {
  const match = line.match(
    /^\s*((?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+)(?:\s*\.\s*(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_-]+))*)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/,
  );
  return match ? { keys: keyParts(match[1]), value: stringValue(match[2]) } : null;
}

function sameKeys(actual, expected) {
  return actual?.length === expected.length && actual.every((key, i) => key === expected[i]);
}

function normalizePath(path, home) {
  const expanded =
    path.startsWith('~/') || path.startsWith('~\\') ? join(home, path.slice(2)) : path;
  if (!isAbsolute(expanded)) return expanded;
  const normalized = resolve(expanded).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function assertNarrowPath(path) {
  if (!isAbsolute(path) || resolve(path) === parse(resolve(path)).root) {
    throw new RepairError('Host grants must name concrete tool or repository paths, not roots.');
  }
}

function insideDirectory(directory, path) {
  const child = relative(resolve(directory), resolve(path));
  return child === '' || (!isAbsolute(child) && !child.split(/[\\/]/).includes('..'));
}

function assertNoLinks(path) {
  let current = resolve(path);
  while (current !== parse(current).root) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat || stat.isSymbolicLink()) throw new RepairError('Missing or redirected host path.');
    current = dirname(current);
  }
  if (normalizePath(realpathSync(path), '') !== normalizePath(resolve(path), '')) {
    throw new RepairError('Refusing a redirected host path.');
  }
}

export function discoverHostGrants({ home = homedir(), repoRoot = REPO_ROOT } = {}) {
  const runtime = join(home, '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies');
  assertNoLinks(runtime);
  if (!lstatSync(runtime).isDirectory())
    throw new RepairError('Bundled runtime is not a directory.');

  const pointer = join(repoRoot, '.git');
  const pointerStat = lstatSync(pointer);
  if (pointerStat.isSymbolicLink()) throw new RepairError('Refusing redirected Git metadata.');
  let common = pointer;
  if (pointerStat.isFile()) {
    const match = readFileSync(pointer, 'utf8').match(/^gitdir: ([^\r\n]+)\r?\n?$/);
    if (!match) throw new RepairError('Unrecognized linked-worktree Git pointer.');
    const admin = resolve(repoRoot, match[1]);
    assertNoLinks(admin);
    const commonPointer = join(admin, 'commondir');
    assertNoLinks(commonPointer);
    const relativeCommon = readFileSync(commonPointer, 'utf8').trim();
    if (!relativeCommon || /[\r\n]/.test(relativeCommon)) {
      throw new RepairError('Unrecognized shared Git directory pointer.');
    }
    common = resolve(admin, relativeCommon);
  }
  assertNoLinks(common);
  if (
    basename(common) !== '.git' ||
    !lstatSync(common).isDirectory() ||
    !lstatSync(join(common, 'objects')).isDirectory() ||
    !lstatSync(join(common, 'HEAD')).isFile()
  ) {
    throw new RepairError('Expected the active repository shared .git directory.');
  }

  const grants = [
    { path: realpathSync(runtime), access: 'read' },
    { path: realpathSync(common), access: 'write' },
  ];
  const gitconfig = join(home, '.gitconfig');
  const gitconfigStat = lstatSync(gitconfig, { throwIfNoEntry: false });
  if (gitconfigStat) {
    assertNoLinks(gitconfig);
    if (!gitconfigStat.isFile()) throw new RepairError('Global Git configuration is not a file.');
    grants.push({ path: realpathSync(gitconfig), access: 'read' });
  }
  for (const grant of grants) assertNarrowPath(grant.path);
  return grants;
}

export function hostPathDiagnostics(source) {
  const findings = [];
  let current = [];
  const headers = new Map(tables(source).map((table) => [table.start, keyParts(table.name)]));
  let offset = 0;
  let lineNumber = 0;
  let multiline = null;
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    lineNumber++;
    const insideString = multiline !== null;
    if (headers.has(offset)) {
      current = headers.get(offset) ?? [':unrecognized-table'];
      if (sameKeys(current, ['sandbox_workspace_write'])) {
        findings.push({ kind: 'legacy-workspace-settings', line: lineNumber });
      }
      if (
        current[0] === 'permissions' &&
        current[2] === 'filesystem' &&
        /^X:[\\/]/i.test(current[3] ?? '')
      ) {
        findings.push({ kind: 'x-drive-filesystem-grant', line: lineNumber });
      }
    } else if (!insideString && /^\s*\[\[.*\]\]\s*(?:#.*)?$/.test(line)) {
      // Array-table bodies are not the top-level configuration either.
      current = [':array-table'];
    }
    const topLevel = !insideString && current.length === 0;
    if (topLevel && /^\s*(?:sandbox_mode|"sandbox_mode"|'sandbox_mode')\s*=/.test(line)) {
      findings.push({ kind: 'legacy-sandbox-mode', line: lineNumber });
    }
    const readsDefault =
      topLevel &&
      /^\s*(?:default_permissions|"default_permissions"|'default_permissions')\s*=/.test(line);
    const entry =
      !insideString && (current[0] === 'permissions' || readsDefault) ? assignment(line) : null;
    if (readsDefault) {
      const diagnostic = { kind: 'default-permission-profile', line: lineNumber };
      if (
        entry &&
        sameKeys(entry.keys, ['default_permissions']) &&
        /^:?[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(entry.value)
      ) {
        diagnostic.profile = entry.value;
      }
      findings.push(diagnostic);
    }
    if (
      current.length === 2 &&
      entry?.value === ':workspace' &&
      sameKeys(entry.keys, ['extends'])
    ) {
      findings.push({ kind: 'workspace-inheritance', line: lineNumber });
    }
    if (
      current[0] === 'permissions' &&
      current[2] === 'filesystem' &&
      sameKeys(entry?.keys, [':root']) &&
      ['read', 'write'].includes(entry.value)
    )
      findings.push({ kind: 'broad-root-grant', line: lineNumber });
    if (
      current[0] === 'permissions' &&
      current[2] === 'filesystem' &&
      /^X:[\\/]/i.test(entry?.keys[0] ?? '')
    )
      findings.push({ kind: 'x-drive-filesystem-grant', line: lineNumber });
    if (
      !insideString &&
      sameKeys(current, ['sandbox_workspace_write']) &&
      /^\s*writable_roots\s*=/.test(line)
    )
      findings.push({ kind: 'additional-writable-roots', line: lineNumber });
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      if (multiline !== null) {
        if (multiline === '"""' && line[i] === '\\') {
          i++;
          continue;
        }
        if (line.startsWith(multiline, i)) {
          multiline = null;
          i += 2;
        }
      } else if (quote !== null) {
        if (quote === '"' && line[i] === '\\') i++;
        else if (line[i] === quote) quote = null;
      } else if (line[i] === '#') break;
      else if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        multiline = line.slice(i, i + 3);
        i += 2;
      } else if (line[i] === '"' || line[i] === "'") quote = line[i];
    }
    offset += line.length;
  }
  return findings;
}

function hasLegacyHostSettings(diagnostics) {
  return diagnostics.some(({ kind }) =>
    ['legacy-sandbox-mode', 'legacy-workspace-settings'].includes(kind),
  );
}

function possibleBroadPathSources(diagnostics) {
  return diagnostics.filter(({ kind }) =>
    [
      'workspace-inheritance',
      'broad-root-grant',
      'x-drive-filesystem-grant',
      'additional-writable-roots',
    ].includes(kind),
  );
}

function planHostSelection(source, defaultPermissions) {
  if (defaultPermissions !== undefined && defaultPermissions !== ':workspace') {
    throw new RepairError('Only an explicit --default-permissions :workspace is supported.');
  }
  const diagnostics = hostPathDiagnostics(source);
  if (hasLegacyHostSettings(diagnostics)) {
    return { status: 'blocked-legacy-settings', diagnostics };
  }
  const selectors = diagnostics.filter(({ kind }) => kind === 'default-permission-profile');
  if (selectors.length > 1 || (selectors.length === 1 && !selectors[0].profile)) {
    return { status: 'blocked-invalid-default', diagnostics };
  }
  const selected = selectors[0]?.profile;
  if (
    selected?.startsWith(':') &&
    ![':workspace', ':read-only', ':danger-full-access'].includes(selected)
  ) {
    return { status: 'blocked-invalid-default', diagnostics };
  }
  if (selected && !selected.startsWith(':')) {
    const defined = tables(source).some((table) => {
      const keys = keyParts(table.name);
      return keys?.[0] === 'permissions' && keys[1] === selected;
    });
    if (!defined) return { status: 'blocked-invalid-default', diagnostics };
  }
  if (defaultPermissions !== undefined && selected && selected !== defaultPermissions) {
    return { status: 'blocked-conflicting-default', diagnostics };
  }
  if (!selected && defaultPermissions === undefined) {
    return { status: 'blocked-missing-default', diagnostics };
  }
  if (!selected) {
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const bom = source.startsWith('\uFEFF') ? '\uFEFF' : '';
    return {
      status: 'ready',
      source: bom + 'default_permissions = ":workspace"' + newline + source.slice(bom.length),
      addsDefaultPermissions: true,
      diagnostics,
    };
  }
  return { status: 'ready', source, addsDefaultPermissions: false, diagnostics };
}

export function planHostAccess(source, { home = homedir(), grants, defaultPermissions } = {}) {
  const originalSource = source;
  const selection = planHostSelection(source, defaultPermissions);
  if (selection.status !== 'ready') return selection;
  source = selection.source;
  if (!Array.isArray(grants) || !grants.length) throw new RepairError('No verified host grants.');
  for (const grant of grants) {
    assertNarrowPath(grant.path);
    if (!['read', 'write'].includes(grant.access)) throw new RepairError('Invalid host grant.');
  }
  const sections = tables(source).map((table) => ({ ...table, keys: keyParts(table.name) }));
  const filesystem = sections.filter((table) => sameKeys(table.keys, PROFILE_TABLE));
  if (filesystem.length > 1)
    throw new RepairError('Duplicate host filesystem tables; review manually.');

  // Reject inline/dotted structural definitions rather than creating a second
  // TOML definition of the same table. No global configuration is reserialized.
  const structural = [
    { keys: [], property: 'permissions' },
    { keys: ['permissions'], property: 'next-erp' },
    { keys: ['permissions', 'next-erp'], property: 'filesystem' },
  ];
  for (const { keys, property } of structural) {
    const bodies = keys.length
      ? sections
          .filter((table) => sameKeys(table.keys, keys))
          .map((table) => source.slice(table.bodyStart, table.end))
      : [source.slice(0, sections[0]?.start ?? source.length)];
    const pattern = new RegExp(`^\\s*(?:${property}|"${property}"|'${property}')\\s*(?:[.=])`, 'm');
    if (bodies.some((body) => pattern.test(body))) {
      throw new RepairError('Inline or dotted host permission definitions require manual review.');
    }
  }
  const expected = new Map(grants.map((grant) => [normalizePath(grant.path, home), grant]));
  if (expected.size !== grants.length) throw new RepairError('Duplicate requested host grants.');
  for (const table of sections) {
    if (
      table.keys?.length > 3 &&
      sameKeys(table.keys.slice(0, 3), PROFILE_TABLE) &&
      expected.has(normalizePath(table.keys[3], home))
    ) {
      throw new RepairError(
        'A scoped host table already controls a required path; review manually.',
      );
    }
  }
  const existing = new Set();
  if (filesystem.length) {
    const table = filesystem[0];
    for (const line of source.slice(table.bodyStart, table.end).split(/\r?\n/)) {
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      if (/^\s*glob_scan_max_depth\s*=\s*\d+\s*(?:#.*)?$/.test(line)) continue;
      const entry = assignment(line);
      if (!entry || entry.keys.length !== 1 || !['read', 'write', 'deny'].includes(entry.value)) {
        throw new RepairError('Unrecognized host filesystem settings; review manually.');
      }
      const normalized = normalizePath(entry.keys[0], home);
      if (existing.has(normalized))
        throw new RepairError('Duplicate host path settings; review manually.');
      existing.add(normalized);
      if (expected.has(normalized) && entry.value !== expected.get(normalized).access) {
        throw new RepairError(
          'A required host path has a conflicting permission; review manually.',
        );
      }
    }
  }
  const missing = [...expected].filter(([path]) => !existing.has(path)).map(([, grant]) => grant);
  if (!missing.length)
    return {
      status: source === originalSource ? 'already-configured' : 'repairable',
      replacement: source,
    };
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const lines =
    missing
      .map(
        (grant) =>
          `${JSON.stringify(grant.path.replaceAll('\\', '/'))} = ${JSON.stringify(grant.access)}`,
      )
      .join(newline) + newline;
  let replacement;
  if (filesystem.length) {
    const insert = filesystem[0].bodyStart;
    const separator = source.slice(0, insert).endsWith('\n') ? '' : newline;
    replacement = source.slice(0, insert) + separator + lines + source.slice(insert);
  } else {
    replacement =
      source +
      (source.endsWith('\n') || !source ? '' : newline) +
      newline +
      '[permissions.next-erp.filesystem]' +
      newline +
      lines;
  }
  return { status: 'repairable', replacement };
}

export function configureHostAccess({
  apply = false,
  defaultPermissions,
  home = homedir(),
  repoRoot = REPO_ROOT,
  writer = writeChecked,
} = {}) {
  const configPath = join(home, '.codex', 'config.toml');
  assertNoLinks(configPath);
  if (!lstatSync(configPath).isFile())
    throw new RepairError('User configuration must be a regular file.');
  const original = readFileSync(configPath);
  const source = original.toString('utf8');
  const selection = planHostSelection(source, defaultPermissions);
  const diagnostics = selection.diagnostics;
  if (selection.status !== 'ready') {
    return {
      mode: apply ? 'apply' : 'dry-run',
      status: selection.status,
      configPath,
      grants: [],
      configurationDiagnostics: diagnostics,
      possibleBroadPathSources: possibleBroadPathSources(diagnostics),
    };
  }
  const grants = discoverHostGrants({ home, repoRoot });
  const plan = planHostAccess(source, { home, grants, defaultPermissions });
  const report = {
    mode: apply ? 'apply' : 'dry-run',
    status: plan.status,
    configPath,
    grants,
    addsDefaultPermissions: selection.addsDefaultPermissions,
    configurationDiagnostics: diagnostics,
    possibleBroadPathSources: possibleBroadPathSources(diagnostics),
  };
  if (!apply || plan.status !== 'repairable') return report;
  // Global config can contain MCP credentials. Its original bytes must stay
  // outside every workspace and outside the new runtime read grant.
  const backupDirectory = join(home, '.codex', 'backups', 'host-access', randomUUID());
  if (insideDirectory(repoRoot, backupDirectory)) {
    throw new RepairError('Host backups must remain outside the repository.');
  }
  let existingParent = dirname(backupDirectory);
  while (!lstatSync(existingParent, { throwIfNoEntry: false }))
    existingParent = dirname(existingParent);
  assertNoLinks(existingParent);
  mkdirSync(backupDirectory, { recursive: true, mode: 0o700 });
  assertNoLinks(backupDirectory);
  const backupPath = join(backupDirectory, 'original.toml');
  const manifestPath = join(backupDirectory, 'manifest.json');
  writeFileSync(backupPath, original, { flag: 'wx', mode: 0o600 });
  const manifest = {
    version: 1,
    kind: 'host-access',
    configPath,
    originalHash: hash(original),
    replacementHash: hash(plan.replacement),
    grants,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
  assertNoLinks(configPath);
  writer(configPath, manifest.originalHash, plan.replacement);
  return { ...report, status: 'configured', manifest: manifestPath };
}

export function restoreHostAccess(
  manifestPath,
  { home = homedir(), repoRoot = REPO_ROOT, writer = writeChecked } = {},
) {
  if (
    !insideDirectory(join(home, '.codex', 'backups', 'host-access'), manifestPath) ||
    insideDirectory(repoRoot, manifestPath) ||
    basename(manifestPath) !== 'manifest.json'
  ) {
    throw new RepairError(
      'Host backup manifest must remain in this user backup directory, outside the repository.',
    );
  }
  assertNoLinks(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const configPath = join(home, '.codex', 'config.toml');
  if (
    manifest.version !== 1 ||
    manifest.kind !== 'host-access' ||
    normalizePath(manifest.configPath ?? '', home) !== normalizePath(configPath, home)
  ) {
    throw new RepairError('Host backup does not belong to this user configuration.');
  }
  const backupPath = join(dirname(manifestPath), 'original.toml');
  assertNoLinks(backupPath);
  assertNoLinks(configPath);
  const original = readFileSync(backupPath);
  if (
    hash(original) !== manifest.originalHash ||
    typeof manifest.replacementHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(manifest.replacementHash)
  ) {
    throw new RepairError('Host backup verification failed.');
  }
  const currentHash = hash(readFileSync(configPath));
  if (currentHash === manifest.originalHash) return { status: 'already-restored', configPath };
  if (currentHash !== manifest.replacementHash)
    throw new RepairError('Host configuration changed after repair; preserve the newer edit.');
  writer(configPath, currentHash, original);
  return { status: 'restored', configPath };
}

export function parseHostArgs(args) {
  const options = { apply: false };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new RepairError('Duplicate host configuration option.');
    seen.add(arg);
    if (arg === '--apply') options.apply = true;
    else if (arg === '--default-permissions') {
      const value = args[++i];
      if (value !== ':workspace') {
        throw new RepairError('Only an explicit --default-permissions :workspace is supported.');
      }
      options.defaultPermissions = value;
    } else if (arg === '--restore') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new RepairError('Missing host backup manifest.');
      options.restore = resolve(value);
    } else {
      throw new RepairError(
        'Use no arguments, --apply, --default-permissions :workspace, or --restore <manifest>.',
      );
    }
  }
  if (options.restore && (options.apply || options.defaultPermissions !== undefined)) {
    throw new RepairError('--restore cannot be combined with --apply or --default-permissions.');
  }
  if (options.restore) return { restore: options.restore };
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const options = parseHostArgs(process.argv.slice(2));
    const report = options.restore
      ? restoreHostAccess(options.restore)
      : configureHostAccess(options);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.status.startsWith('blocked-')) process.exitCode = 1;
  } catch (err) {
    if (!(err instanceof RepairError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}
