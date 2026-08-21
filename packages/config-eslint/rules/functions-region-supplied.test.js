import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repo invariant: every workflow job that BUILDS a Cloud Functions bundle must
 * supply `FUNCTIONS_REGION`.
 *
 * This is the mirror image of `delfrance/no-hardcoded-gcp-region`. That rule bans a
 * region literal in source, because a hardcoded fallback is how this project ended
 * up running functions, queues and Firestore in three regions with nothing ever
 * failing — an enqueue against the wrong region is DROPPED while the route still
 * returns 200 (#1108), so the first signal was the inter-region transfer bill.
 *
 * Removing those fallbacks fixes the silence and creates one new way to break: a
 * build with no region now REFUSES (`requireBuildRegion`, tools/deploy-env). That is
 * the intended trade — loud beats silent — but it means every surface that builds a
 * bundle has to supply the value, and a workflow that forgets goes red for a reason
 * that reads like an unrelated build error.
 *
 * Not hypothetical either. `ci-storage.yml`'s emulator lane carried the comment "the
 * function region resolves from the FUNCTIONS_REGION param default — no env needed
 * here". It happened to survive, because the JOB sets one; the comment was simply
 * wrong, and nothing would have caught it if it had been right.
 *
 * This is a test rather than an ESLint rule because the invariant lives in workflow
 * YAML, which ESLint never sees. Failing it fails CI exactly like a lint error would.
 *
 * ⚠️ Not a YAML parse, deliberately — same reason `ci-lane-gates.test.js` gives:
 * `on:` is a YAML 1.1 boolean, so a naive parse keys that block as `true` and a test
 * reading it sees `undefined` for every file and passes vacuously. A line scan cannot
 * develop that failure mode.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * Commands that produce a bundle whose region is inlined at build time. Each is the
 * literal text a workflow `run:` step contains.
 *
 * ⚠️ `prepare-deploy` covers the predeploy hooks, which call `build.mjs` in turn —
 * the region is required just as much there, one level down.
 */
const BUILD_COMMANDS = ['functions build', 'prepare-deploy'];

/**
 * Workflows known to build a bundle. An anchor list, so the pathspec below cannot
 * quietly stop matching and leave this suite passing over an empty set — the failure
 * mode every glob-driven guard in this directory has to defend against.
 */
const KNOWN_BUILDERS = [
  '.github/workflows/ci-mercado-livre.yml',
  '.github/workflows/ci-storage.yml',
  '.github/workflows/copilot-setup-steps.yml',
  '.github/workflows/e2e-emulator.yml',
];

/** Tracked + untracked, so a new workflow counts before it is committed. */
function findWorkflows() {
  const ls = (...args) =>
    execFileSync('git', [...args, '--', ':(glob).github/workflows/*.y*ml'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

  return [...new Set([...ls('ls-files'), ...ls('ls-files', '--others', '--exclude-standard')])];
}

/**
 * ⚠️ Normalize line endings. `core.autocrlf=true` checks these files out as CRLF on
 * Windows while CI sees LF, and every scan below is line-oriented. A vacuous local
 * green is exactly what these guards exist to prevent.
 */
const read = (file) => readFileSync(resolve(REPO_ROOT, file), 'utf8').split('\r\n').join('\n');

const buildsABundle = (source) => BUILD_COMMANDS.some((cmd) => source.includes(cmd));

describe('a workflow that builds a functions bundle supplies its region', () => {
  it('finds every known builder', () => {
    const found = new Set(findWorkflows());
    const missing = KNOWN_BUILDERS.filter((p) => !found.has(p));

    expect(
      missing,
      [
        'These workflows were not found by the git pathspec. Either they moved',
        '(update KNOWN_BUILDERS) or `:(glob).github/workflows/*.y*ml` stopped matching',
        '— in which case this whole guard silently stopped checking anything:',
        ...missing.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('still recognises those builders by their build command', () => {
    // Guards the scan itself: if BUILD_COMMANDS drifts from how the workflows
    // actually invoke the build, the assertion below passes over an empty set.
    const unrecognised = KNOWN_BUILDERS.filter((p) => !buildsABundle(read(p)));

    expect(
      unrecognised,
      [
        'These are known to build a functions bundle, but none of BUILD_COMMANDS',
        `(${BUILD_COMMANDS.join(', ')}) appears in them. The scan below would skip`,
        'them and pass without checking anything:',
        ...unrecognised.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('every builder sets FUNCTIONS_REGION', () => {
    const offenders = findWorkflows()
      .filter((p) => buildsABundle(read(p)))
      .filter((p) => !/^\s*FUNCTIONS_REGION\s*:/m.test(read(p)));

    expect(
      offenders,
      [
        'These workflows build a Cloud Functions bundle but never set',
        'FUNCTIONS_REGION. There is no default any more — `requireBuildRegion`',
        'REFUSES the build — so the lane fails with what reads like an unrelated',
        'build error. Add it to the job’s `env:` block:',
        '',
        '  env:',
        '    FUNCTIONS_REGION: us-central1',
        '',
        'Offending workflows:',
        ...offenders.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('no workflow sets a region to an empty value', () => {
    // Blank counts as unset everywhere in this repo (#887) — `requireBuildRegion`
    // trims — so `FUNCTIONS_REGION:` with nothing after it reads as configured
    // and behaves as missing. That is the exact confusion these guards remove.
    const offenders = [];
    for (const file of findWorkflows()) {
      const lines = read(file).split('\n');
      lines.forEach((line, i) => {
        const match = /^\s*((?:NEXT_PUBLIC_)?[A-Z_]*REGION)\s*:\s*(.*)$/.exec(line);
        if (!match) return;
        const value = match[2].trim();
        if (value === '' || value === "''" || value === '""') {
          offenders.push(`${file}:${i + 1} ${match[1]}`);
        }
      });
    }

    expect(
      offenders,
      [
        'A region set to an empty value reads as configured and behaves as unset,',
        'which is the confusion this whole change removes. Give it a real value or',
        'delete the line:',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
