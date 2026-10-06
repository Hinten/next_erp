// Windows-only writes; inspection and planning also run on other platforms.
// Recovery uses built-in Node modules so it works without installed dependencies.
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = 'permissions.next-erp';
const ENV_SECRET = ['.env', 'secrets'].join('.');
const DENIED = [
  '.env',
  '.env.local',
  ENV_SECRET,
  `${ENV_SECRET}.example`,
  'secrets',
  'secrets/**',
  '.ignore',
  '.ignore/**',
];
const DENY_LINES = [...DENIED, ...DENIED.map((path) => `**/${path}`)].map(
  (path) => `${JSON.stringify(path)} = "deny"`,
);
const RUNTIME_LINES = ['":minimal" = "read"', '":tmpdir" = "write"', '":slash_tmp" = "write"'];
const WORKSPACE_LINES = [
  '"." = "write"',
  ...['.git', '.codex', '.agents', '.aws'].map((path) => `${JSON.stringify(path)} = "read"`),
];

export class RepairError extends Error {}
export const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Ignore header-looking lines inside TOML strings. Reject unfamiliar syntax in
// permission tables rather than attempting to rewrite arbitrary TOML.
function tables(source) {
  const result = [];
  let multiline = null;
  let offset = 0;
  for (const line of source.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const header = multiline === null && line.match(/^\s*\[([^\]\r\n]+)\]\s*(?:#.*)?$/);
    if (header) {
      if (result.length) result.at(-1).end = offset;
      result.push({ name: header[1], start: offset, bodyStart: offset + line.length });
    }
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
  if (result.length) result.at(-1).end = source.length;
  return result;
}

function statements(body) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function signature(lines) {
  // Only fixed literals are recognized. Changed quoting/comments are reported
  // as custom, even if they might be equivalent: recovery must be conservative.
  return JSON.stringify(lines.map((line) => line.replace(/\s*=\s*/, '=')).sort());
}

export function planConfigRepair(source) {
  const sections = tables(source).filter(
    (table) => table.name === PROFILE || table.name.startsWith(`${PROFILE}.`),
  );
  if (sections.length === 0) return { status: 'missing-profile' };
  const byName = new Map(sections.map((table) => [table.name, table]));
  const names = [PROFILE, `${PROFILE}.filesystem`, `${PROFILE}.filesystem.":workspace_roots"`];
  const network = `${PROFILE}.network`;
  if (
    byName.size !== sections.length ||
    names.some((name) => !byName.has(name)) ||
    sections.some((table) => ![...names, network].includes(table.name))
  ) {
    return { status: 'custom-profile' };
  }
  const lines = (name) =>
    statements(source.slice(byName.get(name).bodyStart, byName.get(name).end));
  const parent = lines(PROFILE).filter(
    (line) => /^description\s*=\s*"[^"\r\n]*"$/.test(line) === false,
  );
  const fs = lines(names[1]);
  const workspace = lines(names[2]);
  const matches = (actual, expected) => signature(actual) === signature(expected);
  if (
    parent.length === 0 &&
    matches(fs, [...RUNTIME_LINES, 'glob_scan_max_depth = 8']) &&
    matches(workspace, [...WORKSPACE_LINES, ...DENY_LINES]) &&
    byName.has(network) &&
    matches(lines(network), ['enabled = false'])
  )
    return { status: 'already-fixed' };
  if (
    !matches(parent, ['extends = ":workspace"']) ||
    !matches(fs, ['glob_scan_max_depth = 8']) ||
    !matches(workspace, DENY_LINES) ||
    byName.has(network)
  )
    return { status: 'custom-profile' };

  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  let replacement = source;
  const edits = [
    {
      start: byName.get(names[1]).bodyStart,
      end: byName.get(names[1]).bodyStart,
      text: RUNTIME_LINES.join(newline) + newline,
    },
    {
      start: byName.get(names[2]).bodyStart,
      end: byName.get(names[2]).bodyStart,
      text: WORKSPACE_LINES.join(newline) + newline,
    },
  ];
  const parentTable = byName.get(PROFILE);
  const extendsMatch = source
    .slice(parentTable.bodyStart, parentTable.end)
    .match(/^[^\S\r\n]*extends[^\S\r\n]*=[^\S\r\n]*":workspace"[^\S\r\n]*\r?\n?/m);
  edits.push({
    start: parentTable.bodyStart + extendsMatch.index,
    end: parentTable.bodyStart + extendsMatch.index + extendsMatch[0].length,
    text: '',
  });
  const workspaceTable = byName.get(names[2]);
  const body = source.slice(workspaceTable.bodyStart, workspaceTable.end);
  const lastAssignment = [...body.matchAll(/^[^\r\n#]*=\s*"deny"[^\S\r\n]*\r?\n?/gm)].at(-1);
  const insert = workspaceTable.bodyStart + lastAssignment.index + lastAssignment[0].length;
  edits.push({
    start: insert,
    end: insert,
    text: `${newline}[${network}]${newline}enabled = false${newline}`,
  });
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    replacement = replacement.slice(0, edit.start) + edit.text + replacement.slice(edit.end);
  }
  if (planConfigRepair(replacement).status !== 'already-fixed') {
    throw new RepairError('Replacement did not produce the recognized fixed profile.');
  }
  return { status: 'repairable', replacement };
}

function git(root, args) {
  const result = spawnSync('git', ['-c', 'safe.directory=*', '-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    throw new RepairError(
      `Git could not inspect ${root}: ${result.stderr?.trim() || result.error?.code || result.status}`,
    );
  }
  return result.stdout.trim();
}

function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function commonDir(root) {
  return realpathSync(git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

function assertNoLinks(path) {
  let current = resolve(path);
  while (current !== parse(current).root) {
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) throw new RepairError(`Missing path: ${current}`);
    if (stat.isSymbolicLink()) throw new RepairError(`Refusing redirected path: ${current}`);
    current = dirname(current);
  }
  if (!samePath(realpathSync(path), resolve(path))) {
    throw new RepairError(`Refusing redirected path: ${path}`);
  }
}

export function discoverWorktrees(repoRoot = REPO_ROOT) {
  return git(repoRoot, ['worktree', 'list', '--porcelain', '-z'])
    .split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice(9));
}

function verifyWorktree(root, repoRoot) {
  if (!isAbsolute(root)) throw new RepairError('Worktree paths must be absolute.');
  const resolved = resolve(root);
  if (!discoverWorktrees(repoRoot).some((listed) => samePath(resolve(listed), resolved))) {
    throw new RepairError(`Not a registered worktree: ${resolved}`);
  }
  assertNoLinks(resolved);
  if (!samePath(commonDir(resolved), commonDir(repoRoot))) {
    throw new RepairError(`Worktree belongs to another repository: ${resolved}`);
  }
  return resolved;
}

// FileShare.None prevents another Windows process from writing, renaming or
// replacing this file between the hash check and Flush. Preserve its ACLs.
const WINDOWS_WRITE = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$stream = $null
try {
  $item = [IO.FileInfo]::new($request.path)
  $ancestor = $item
  while ($null -ne $ancestor) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      [Console]::Out.Write('redirected'); exit 0
    }
    if ($ancestor -is [IO.FileInfo]) { $ancestor = $ancestor.Directory }
    else { $ancestor = $ancestor.Parent }
  }
  $stream = [IO.File]::Open($request.path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $actual = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
  if ($actual -ne $request.expectedHash) { [Console]::Out.Write('conflict'); exit 0 }
  $bytes = [Convert]::FromBase64String($request.replacement)
  $stream.Position = 0
  $stream.Write($bytes, 0, $bytes.Length)
  $stream.SetLength($bytes.Length)
  $stream.Flush($true)
  [Console]::Out.Write('written')
} catch [IO.IOException] { [Console]::Out.Write('locked-or-io-error') }
finally { if ($null -ne $stream) { $stream.Dispose() } }
`;

export function writeChecked(path, expectedHash, replacement) {
  if (process.platform !== 'win32')
    throw new RepairError('Apply and restore require native Windows.');
  const result = spawnSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_WRITE],
    {
      encoding: 'utf8',
      input: JSON.stringify({
        path,
        expectedHash,
        replacement: Buffer.from(replacement).toString('base64'),
      }),
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0 || result.stdout.trim() !== 'written') {
    throw new RepairError(
      `Configuration was not replaced: ${result.stdout.trim() || result.error?.code || `PowerShell exit ${result.status}`}`,
    );
  }
}

export function repairWorktrees({
  repoRoot = REPO_ROOT,
  worktrees = discoverWorktrees(repoRoot),
  apply = false,
  backupRoot = join(repoRoot, 'out', 'codex-sandbox-repair'),
  writer = writeChecked,
} = {}) {
  if (apply && worktrees.length === 0) throw new RepairError('Select at least one worktree.');
  const report = { mode: apply ? 'apply' : 'dry-run', records: [] };
  // Validate all explicitly selected targets before any mutation.
  const targets = apply ? worktrees.map((root) => verifyWorktree(root, repoRoot)) : worktrees;
  let manifest;
  let manifestPath;
  for (const root of targets) {
    const record = { worktree: root };
    report.records.push(record);
    try {
      const verified = verifyWorktree(root, repoRoot);
      const path = join(verified, '.codex', 'config.toml');
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (!stat) {
        record.status = 'missing-config';
        continue;
      }
      assertNoLinks(path);
      if (!stat.isFile()) throw new RepairError(`Not a regular configuration file: ${path}`);
      const original = readFileSync(path);
      const plan = planConfigRepair(original.toString('utf8'));
      record.status = plan.status;
      if (!apply || plan.status !== 'repairable') continue;
      if (!manifest) {
        const directory = join(backupRoot, randomUUID());
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        assertNoLinks(directory);
        manifestPath = join(directory, 'manifest.json');
        manifest = { version: 1, repositoryCommonDir: commonDir(repoRoot), records: [] };
        report.manifest = manifestPath;
      }
      const backupPath = join(dirname(manifestPath), `${manifest.records.length}.toml`);
      writeFileSync(backupPath, original, { flag: 'wx', mode: 0o600 });
      const entry = {
        worktree: verified,
        backupPath,
        originalHash: hash(original),
        replacementHash: hash(plan.replacement),
      };
      manifest.records.push(entry);
      // Publish rollback information BEFORE replacing the configuration.
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      verifyWorktree(verified, repoRoot);
      assertNoLinks(path);
      writer(path, entry.originalHash, plan.replacement);
      record.status = 'repaired';
    } catch (err) {
      if (!(err instanceof RepairError)) throw err;
      record.status = 'blocked';
      record.reason = err.message;
    }
  }
  return report;
}

export function restoreManifest(
  manifestPath,
  { repoRoot = REPO_ROOT, writer = writeChecked } = {},
) {
  assertNoLinks(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.records) ||
    typeof manifest.repositoryCommonDir !== 'string' ||
    !samePath(manifest.repositoryCommonDir, commonDir(repoRoot))
  ) {
    throw new RepairError(
      'Recovery manifest belongs to another repository or has an unsupported format.',
    );
  }
  const report = { mode: 'restore', records: [] };
  for (const entry of manifest.records) {
    const record = { worktree: entry.worktree };
    report.records.push(record);
    try {
      const root = verifyWorktree(entry.worktree, repoRoot);
      if (
        typeof entry.backupPath !== 'string' ||
        dirname(resolve(entry.backupPath)) !== dirname(resolve(manifestPath)) ||
        !/^[0-9]+\.toml$/.test(relative(dirname(manifestPath), entry.backupPath))
      ) {
        throw new RepairError('Backup must be a numbered TOML file next to the manifest.');
      }
      assertNoLinks(entry.backupPath);
      const original = readFileSync(entry.backupPath);
      const plan = planConfigRepair(original.toString('utf8'));
      if (
        hash(original) !== entry.originalHash ||
        plan.status !== 'repairable' ||
        typeof entry.replacementHash !== 'string' ||
        !/^[a-f0-9]{64}$/.test(entry.replacementHash)
      )
        throw new RepairError('Backup verification failed.');
      const path = join(root, '.codex', 'config.toml');
      assertNoLinks(path);
      const currentHash = hash(readFileSync(path));
      if (currentHash === entry.originalHash) {
        record.status = 'already-restored';
        continue;
      }
      if (currentHash !== entry.replacementHash)
        throw new RepairError('Configuration changed after repair; preserve the newer edit.');
      writer(path, currentHash, original);
      record.status = 'restored';
    } catch (err) {
      if (!(err instanceof RepairError)) throw err;
      record.status = 'blocked';
      record.reason = err.message;
    }
  }
  return report;
}

export function parseArgs(args) {
  const options = { apply: false, worktrees: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--apply') options.apply = true;
    else if (arg === '--worktree' || arg === '--restore') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new RepairError(`Missing value for ${arg}.`);
      if (arg === '--worktree') options.worktrees.push(value);
      else options.restore = resolve(value);
    } else throw new RepairError(`Unknown argument: ${arg}`);
  }
  if (options.restore && (options.apply || options.worktrees.length)) {
    throw new RepairError('--restore cannot be combined with --apply or --worktree.');
  }
  if (options.apply && !options.worktrees.length)
    throw new RepairError('--apply requires explicit --worktree paths.');
  return options;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = options.restore
      ? restoreManifest(options.restore)
      : repairWorktrees({
          apply: options.apply,
          ...(options.worktrees.length ? { worktrees: options.worktrees } : {}),
        });
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    if (report.records.some((record) => ['blocked', 'custom-profile'].includes(record.status)))
      process.exitCode = 1;
  } catch (err) {
    if (!(err instanceof RepairError)) throw err;
    console.error(err.message);
    process.exitCode = 1;
  }
}
