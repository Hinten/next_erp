import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { normalizeLineEndings } from '../../../tools/normalize-line-endings.mjs';
import { REPO_ROOT } from './lib/repo-scan.js';

const repos = [];
const SOURCE = 'apps/probe/source.ts';
const FUTURE_TEXT = 'apps/probe/source.future-extension';
const SOURCE_BYTES = Buffer.from('export const value = 1;\n');
const BINARY_BYTES = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0a]);
const CRLF_XSD_FILES = [
  'packages/integrations/nfe/generated/conscad/consCad_v2.00.xsd',
  'packages/integrations/nfe/generated/conscad/leiauteConsultaCadastro_v2.00.xsd',
];
const XSD_FILES = [
  ...CRLF_XSD_FILES,
  'packages/integrations/nfe/generated/conscad/retConsCad_v2.00.xsd',
  'packages/integrations/nfe/generated/conscad/tiposBasico_v1.03.xsd',
];

// Hooks can export Git variables targeting the real index. Never inherit them
// into the scratch repository, and exclude global attributes/config too.
function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  return {
    ...env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
  };
}

function makeRepo(withAttributes = true) {
  const root = mkdtempSync(join(tmpdir(), 'erp-line-endings-'));
  repos.push(root);
  const env = childEnv();
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.autocrlf=true', '-c', 'core.safecrlf=false', ...args], {
      cwd: root,
      env,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  git('init', '--quiet');
  if (withAttributes) copyFileSync(join(REPO_ROOT, '.gitattributes'), join(root, '.gitattributes'));

  const files = {
    [SOURCE]: SOURCE_BYTES,
    [FUTURE_TEXT]: SOURCE_BYTES,
    'image.bin': BINARY_BYTES,
    '.env.example': Buffer.from('EXAMPLE=value\n'),
    'credentials.json': Buffer.from('{}\n'),
  };
  for (const file of XSD_FILES) files[file] = readFileSync(join(REPO_ROOT, file));
  for (const [file, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), bytes);
  }
  git('add', '--', '.');
  // Force a real checkout through Git's smudge conversion, not a read of the
  // original files we just wrote. No commit, hooks, or network are involved.
  for (const file of Object.keys(files)) unlinkSync(join(root, file));
  if (withAttributes) unlinkSync(join(root, '.gitattributes'));
  git('checkout-index', '--all');
  return { root, env, git, files };
}

afterAll(() => {
  for (const root of repos) rmSync(root, { recursive: true, force: true });
});

describe('repository line endings on a Windows-style checkout', () => {
  it('the control checkout really converts LF to CRLF without attributes', () => {
    const { root } = makeRepo(false);
    expect(readFileSync(join(root, SOURCE))).toEqual(Buffer.from('export const value = 1;\r\n'));
  });

  it('keeps source LF and binary/vendor artifacts byte-identical with autocrlf=true', () => {
    const { root, files } = makeRepo();
    expect(readFileSync(join(root, SOURCE))).toEqual(SOURCE_BYTES);
    expect(readFileSync(join(root, FUTURE_TEXT))).toEqual(SOURCE_BYTES);
    expect(readFileSync(join(root, 'image.bin'))).toEqual(BINARY_BYTES);
    for (const file of XSD_FILES) {
      expect(files[file].includes(Buffer.from('\r\n'))).toBe(CRLF_XSD_FILES.includes(file));
      expect(readFileSync(join(root, file))).toEqual(files[file]);
    }
  });

  it('repairs CRLF and mixed endings without losing edits, bytes, or index state', () => {
    const { root, env, git, files } = makeRepo();
    const prefix = Buffer.from([0xef, 0xbb, 0xbf]);
    const edited = Buffer.concat([prefix, Buffer.from('edited ç\r\nnext line\n')]);
    const expected = Buffer.concat([prefix, Buffer.from('edited ç\nnext line\n')]);
    writeFileSync(join(root, SOURCE), edited);
    writeFileSync(join(root, FUTURE_TEXT), Buffer.from('export const value = 1;\r\n'));
    writeFileSync(join(root, '.env.example'), 'EXAMPLE=value\r\n');
    writeFileSync(join(root, 'credentials.json'), '{}\r\n');
    writeFileSync(join(root, 'untracked.ts'), 'leave me\r\n');
    const indexBefore = git('ls-files', '--stage', '-z');

    const result = normalizeLineEndings(root, { env });
    expect(result.normalized.sort()).toEqual([FUTURE_TEXT, SOURCE].sort());
    expect(result.skipped.sort()).toEqual(['.env.example', 'credentials.json']);
    expect(readFileSync(join(root, SOURCE))).toEqual(expected);
    expect(readFileSync(join(root, FUTURE_TEXT))).toEqual(SOURCE_BYTES);
    expect(readFileSync(join(root, '.env.example'), 'utf8')).toBe('EXAMPLE=value\r\n');
    expect(readFileSync(join(root, 'credentials.json'), 'utf8')).toBe('{}\r\n');
    expect(readFileSync(join(root, 'untracked.ts'), 'utf8')).toBe('leave me\r\n');
    expect(readFileSync(join(root, 'image.bin'))).toEqual(BINARY_BYTES);
    for (const file of XSD_FILES) expect(readFileSync(join(root, file))).toEqual(files[file]);
    expect(git('ls-files', '--stage', '-z')).toBe(indexBefore);
    expect(normalizeLineEndings(root, { env }).normalized).toEqual([]);
  });
});
