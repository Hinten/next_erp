import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: every `env:` entry in an App Hosting manifest names a
 * `variable` and carries a non-empty `value` or a non-empty `secret`.
 *
 * ## Why this needs a guard at all
 *
 * App Hosting's preparer validates the manifest before a line of app code is
 * built, and refuses an entry with neither field set:
 *
 *     fah/invalid-apphosting-yaml — either 'value' or 'secret' field is required
 *
 * An EMPTY string counts as unset. `apps/shopee/apphosting.yaml` carried a
 * `SHOPEE_TASKS_REGION` row whose value was the empty string, meant as a
 * placeholder for the deploying shell to fill in. Nothing fills it in — the
 * manifest is uploaded as committed — so the Shopee backend could not build on
 * ANY project, and no CI lane noticed (#1944): nothing here reads manifest env
 * rows, and the build that does read them runs only at deploy time.
 *
 * Same failure class as `apphosting-next-pinned.test.js` and
 * `apphosting-pnpm-pinned.test.js`: an external consumer reads a file our CI
 * never exercises, and the first signal is a dead deploy.
 *
 * ## Why a line scan and not a YAML parse
 *
 * `packages/config-eslint` has no YAML dependency, and this directory's standing
 * convention is to reach for git/regex rather than add one (see
 * `lib/workflow-scan.js`). The manifests use one shape — block-style list items
 * under a top-level `env:` — and the scanner below REFUSES anything else (a
 * flow-style `- { … }` item, an inline `env: [...]`) instead of guessing, so a
 * shape it cannot read is a failure, never a silent pass.
 *
 * This is a test rather than an ESLint rule because the invariant lives in YAML,
 * which ESLint never sees. Failing the test fails CI exactly like a lint error.
 */

const PREPARER_ERROR =
  "`fah/invalid-apphosting-yaml` — \"either 'value' or 'secret' field is required\"";

/**
 * Every App Hosting manifest: the base `apphosting.yaml` of each backend plus
 * any environment override (`apphosting.<env>.yaml`), which the preparer merges
 * over the base and validates the same way.
 *
 * Ask git rather than walking the filesystem — same reasoning and the same
 * `:(glob)` single-level match as `apphosting-next-pinned.test.js`. git emits
 * forward slashes on every platform; compare them as raw strings.
 */
function findManifests() {
  return gitLsFiles([':(glob)apps/*/apphosting.yaml', ':(glob)apps/*/apphosting.*.yaml']);
}

/** Sentinel for a `|`/`>` block-scalar indicator; the caller reads the body. */
const BLOCK = Symbol('block scalar');

/**
 * Decode one YAML scalar as written after `key:` on a single line.
 *
 * Returns `null` for an absent value (`key:` with nothing after it, or `~` /
 * `null`), `BLOCK` for a block-scalar indicator, `undefined` for a quoted
 * scalar the scanner cannot close, and the decoded string otherwise.
 */
function decodeScalar(raw) {
  const text = raw.trim();
  if (text === '' || text.startsWith('#')) return null;
  if (/^[|>][-+0-9]*\s*(#.*)?$/.test(text)) return BLOCK;
  if (text.startsWith("'")) {
    const m = /^'((?:[^']|'')*)'\s*(#.*)?$/.exec(text);
    return m ? m[1].replace(/''/g, "'") : undefined;
  }
  if (text.startsWith('"')) {
    const m = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(text);
    return m ? m[1] : undefined;
  }
  // Plain scalar: a `#` starts a comment only after whitespace.
  const plain = text.replace(/\s+#.*$/, '');
  return plain === '~' || plain === 'null' ? null : plain;
}

/**
 * `{ entries, problems }` for the top-level `env:` block of one manifest.
 *
 * Each entry is `{ line, fields }`, where `fields` maps every key declared at
 * the item's own indent to its decoded scalar (`null` when absent). `line` is
 * the 1-based line of the item's `-`. Comment and blank lines are skipped
 * BEFORE anything is matched, so prose naming a field never stands in for one —
 * except inside a `|`/`>` block scalar's body, where a `#` line is content.
 *
 * `problems` lists shapes the scanner refuses to read.
 */
function scanEnv(source) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => /^env\s*:/.test(l));
  const problems = [];
  if (start === -1) return { entries: [], problems };

  const inline = decodeScalar(lines[start].replace(/^env\s*:/, ''));
  if (inline !== null) {
    problems.push(`line ${start + 1}: inline \`env:\` value — write block-style list items`);
    return { entries: [], problems };
  }

  const entries = [];
  let itemIndent = null;
  let keyIndent = null;
  let current = null;
  let blockKey = null;

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    // A column-0 `-` is still an item: YAML lets a block sequence sit at its
    // parent key's indent, and stopping there would skip the whole block.
    if (/^[^\s#-]/.test(line)) break;
    const indent = line.match(/^ */)[0].length;

    // Inside a `|`/`>` block scalar a `#` is content, not a comment, so the
    // body is read BEFORE comment lines are dropped.
    if (blockKey && line.trim() !== '' && indent > keyIndent) {
      const prev = current.fields[blockKey];
      current.fields[blockKey] = `${prev}${prev ? '\n' : ''}${line.trim()}`;
      continue;
    }
    if (line.trim() === '' || line.trim().startsWith('#')) continue;

    const dash = /^( *)- *(.*)$/.exec(line);

    if (dash && (itemIndent === null || indent === itemIndent)) {
      itemIndent = indent;
      const rest = dash[2];
      if (rest.startsWith('{') || rest.startsWith('[')) {
        problems.push(`line ${i + 1}: flow-style item — write \`- variable: …\` block style`);
        current = null;
        continue;
      }
      current = { line: i + 1, fields: {} };
      entries.push(current);
      keyIndent = line.length - rest.length;
      blockKey = null;
      if (rest !== '') readKey(rest, i);
      continue;
    }

    if (!current) {
      problems.push(`line ${i + 1}: content under \`env:\` outside any list item`);
      continue;
    }

    if (keyIndent === null) keyIndent = indent;
    if (indent === keyIndent) {
      blockKey = null;
      readKey(line.slice(indent), i);
    }
    // Deeper lines under any other key (`availability:`'s list) are not ours.
  }

  return { entries, problems };

  function readKey(text, i) {
    const m = /^([A-Za-z_][\w-]*)\s*:(?:\s+(.*))?$/.exec(text);
    if (!m) {
      problems.push(`line ${i + 1}: cannot read \`${text}\` as \`key: value\``);
      return;
    }
    const value = decodeScalar(m[2] ?? '');
    if (value === undefined) {
      problems.push(`line ${i + 1}: unterminated quoted scalar for \`${m[1]}\``);
      return;
    }
    if (value === BLOCK) {
      current.fields[m[1]] = '';
      blockKey = m[1];
    } else {
      current.fields[m[1]] = value;
    }
  }
}

const isFilled = (v) => typeof v === 'string' && v.trim() !== '';

/** Human-readable violations for one manifest's source. */
function envViolations(relPath, source) {
  const { entries, problems } = scanEnv(source);
  const out = problems.map(
    (p) => `${relPath} ${p} (this guard reads only block-style \`env:\` items)`,
  );
  for (const { line, fields } of entries) {
    const variable = fields.variable;
    if (!isFilled(variable)) {
      out.push(`${relPath}:${line} — env entry has no \`variable\``);
      continue;
    }
    if (!isFilled(fields.value) && !isFilled(fields.secret)) {
      out.push(
        `${relPath}:${line} — \`${variable}\` has neither a non-empty \`value\` nor a non-empty \`secret\``,
      );
    }
  }
  return out;
}

function read(relPath) {
  return readFileSync(resolve(REPO_ROOT, relPath), 'utf8');
}

const FIX = [
  `App Hosting refuses this manifest before building: ${PREPARER_ERROR}.`,
  'An empty string counts as unset, and nothing fills a placeholder in at deploy',
  'time — the manifest is uploaded exactly as committed (#1944).',
  '',
  'Fix: give the entry a real `value`, point it at a Secret Manager `secret`, or',
  'delete the row and let the code read the variable from wherever it is',
  'actually supplied.',
].join('\n');

describe('the env-entry scanner (self-test)', () => {
  // ⚠️ No fixture below carries a COMMENT that spells the shape under test.
  // A matcher that wrongly scanned comments would then still find the shape in
  // the real row and pass for the wrong reason. The shapes appear only where
  // they are meant to be read; the comment-skipping test proves the opposite
  // direction with the comment and the row disagreeing.
  const BLANK = [
    'runConfig:',
    '  minInstances: 0',
    'env:',
    '  - variable: SHOPEE_TASKS_REGION',
    "    value: ''",
    '    availability:',
    '      - RUNTIME',
    '',
  ].join('\n');

  it('flags the blank row #1944 removed', () => {
    expect(envViolations('x.yaml', BLANK)).toEqual([
      'x.yaml:4 — `SHOPEE_TASKS_REGION` has neither a non-empty `value` nor a non-empty `secret`',
    ]);
  });

  it('flags every other spelling of "unset"', () => {
    for (const spelling of ['""', '', '~', 'null', "'  '", '|', '>-']) {
      const src = BLANK.replace("value: ''", `value: ${spelling}`.trimEnd());
      expect(envViolations('x.yaml', src), `value: ${spelling}`).toHaveLength(1);
    }
    const noField = BLANK.replace("    value: ''\n", '');
    expect(envViolations('x.yaml', noField)).toHaveLength(1);
    const blankSecret = BLANK.replace("value: ''", "secret: ''");
    expect(envViolations('x.yaml', blankSecret)).toHaveLength(1);
  });

  it('passes a real value and a real secret', () => {
    const src = [
      'env:',
      '  - variable: TZ',
      '    value: America/Sao_Paulo',
      '    availability:',
      '      - RUNTIME',
      '  - variable: SHOPEE_PARTNER_KEY',
      '    secret: SHOPEE_PARTNER_KEY',
      '  - variable: QUOTED',
      "    value: 'it''s set'",
      '  - variable: BLOCK',
      '    value: |',
      '      multi',
      '      line',
      '',
    ].join('\n');
    expect(envViolations('x.yaml', src)).toEqual([]);
    const { entries } = scanEnv(src);
    expect(entries.map((e) => e.fields.variable)).toEqual([
      'TZ',
      'SHOPEE_PARTNER_KEY',
      'QUOTED',
      'BLOCK',
    ]);
    expect(entries[0].fields.value).toBe('America/Sao_Paulo');
    expect(entries[2].fields.value).toBe("it's set");
    expect(entries[3].fields.value).toBe('multi\nline');
  });

  it('reads the row, never a comment beside it', () => {
    const commentSaysFilled = BLANK.replace(
      "    value: ''",
      "    # value: us-east1\n    value: ''",
    );
    expect(envViolations('x.yaml', commentSaysFilled)).toHaveLength(1);

    const commentSaysBlank = BLANK.replace("    value: ''", "    # value: ''\n    value: us-east1");
    expect(envViolations('x.yaml', commentSaysBlank)).toEqual([]);
  });

  it('flags an entry with no variable', () => {
    const src = ['env:', '  - value: us-east1', '    availability:', '      - RUNTIME'].join('\n');
    expect(envViolations('x.yaml', src)).toEqual(['x.yaml:2 — env entry has no `variable`']);
  });

  it('refuses shapes it cannot read rather than passing them', () => {
    expect(envViolations('x.yaml', "env:\n  - { variable: X, value: '' }\n")).toHaveLength(1);
    expect(envViolations('x.yaml', 'env: []\n')).toHaveLength(1);
  });

  it('reads items written at the env key’s own indent', () => {
    // Valid YAML, and App Hosting rejects a blank row in it just the same. A
    // scanner that took the column-0 `-` for the next top-level key would read
    // no entries at all and pass.
    const src = [
      'env:',
      '- variable: SHOPEE_TASKS_REGION',
      "  value: ''",
      '  availability:',
      '    - RUNTIME',
      '- variable: TZ',
      '  value: America/Sao_Paulo',
      'runConfig:',
      '  minInstances: 0',
      '',
    ].join('\n');
    expect(envViolations('x.yaml', src)).toEqual([
      'x.yaml:2 — `SHOPEE_TASKS_REGION` has neither a non-empty `value` nor a non-empty `secret`',
    ]);
    expect(scanEnv(src).entries.map((e) => e.fields.variable)).toEqual([
      'SHOPEE_TASKS_REGION',
      'TZ',
    ]);
  });

  it('keeps a `#` line inside a block scalar as content', () => {
    const src = ['env:', '  - variable: BLOCK', '    value: |', '      #hash-first', ''].join('\n');
    expect(envViolations('x.yaml', src)).toEqual([]);
    expect(scanEnv(src).entries[0].fields.value).toBe('#hash-first');
  });

  it('stops at the next top-level key', () => {
    const src = `${BLANK}outputFiles:\n  - variable: NOT_ENV\n`;
    expect(scanEnv(src).entries).toHaveLength(1);
  });
});

describe('every App Hosting manifest has well-formed env entries', () => {
  const manifests = findManifests();

  it('discovers the manifests', () => {
    // Anti-vacuity anchor: ten backends carry an `apphosting.yaml` today. If the
    // pathspec silently stopped matching, the scan below would pass over nothing.
    expect(
      manifests.length,
      'The apphosting pathspec stopped matching — this scan is checking nothing.',
    ).toBeGreaterThanOrEqual(10);
    expect(manifests).toContain('apps/nfe/apphosting.yaml');
  });

  it('reads the env entries it should', () => {
    // Anchor for the scanner itself: a known value and a known secret must come
    // back decoded, or a scanner that reads nothing would report no violations.
    const nfe = scanEnv(read('apps/nfe/apphosting.yaml')).entries;
    expect(nfe.find((e) => e.fields.variable === 'TZ')?.fields.value).toBe('America/Sao_Paulo');

    const total = manifests.reduce((n, p) => n + scanEnv(read(p)).entries.length, 0);
    expect(total, 'Fewer env entries than expected — is the scanner reading them?').toBeGreaterThan(
      10,
    );
  });

  it('gives every entry a variable and a non-empty value or secret', () => {
    const offenders = manifests.flatMap((p) => envViolations(p, read(p)));
    expect(offenders, [...offenders.map((o) => `  - ${o}`), '', FIX].join('\n')).toEqual([]);
  });
});
