import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: the ROOT `package.json` pins pnpm to an EXACT version in
 * `engines.pnpm`, that version equals the one in `packageManager`, and no other
 * manifest declares either field.
 *
 * ## Why this needs a guard at all
 *
 * Firebase App Hosting installs dependencies with the GCP buildpack
 * `google.nodejs.pnpm`, whose `detectPNPMVersion` opens with
 *
 *     if pjs == nil || (pjs.Engines.PNPM == "" && pjs.PackageManager == "") {
 *         // pinned tool version, then latestPackageVersion("pnpm")
 *     }
 *
 * and then, past that branch, gives `engines.pnpm` PRECEDENCE over
 * `packageManager`. Two consequences, both counter-intuitive:
 *
 *   1. The safe-looking fallback (a pinned tool version, else the registry's
 *      `latest`) runs ONLY when BOTH fields are empty. Declaring `engines.pnpm`
 *      opts out of it.
 *   2. `packageManager` — which root CLAUDE.md calls the sole authority for pnpm,
 *      and which IS exactly that for corepack in CI — is never even read while
 *      `engines.pnpm` is set. CI and the cloud were resolving pnpm through two
 *      different fields, and only one of them was pinned.
 *
 * A RANGE in `engines.pnpm` is then resolved against the npm registry to the
 * highest published match. "Highest published" is not "latest": npm carries
 * versions published under other dist-tags, and a plain `X.Y.Z` on a prerelease
 * CHANNEL still satisfies an ordinary semver range.
 *
 * That is not theoretical. On 2026-08-24 the staging deploy of
 * `apps/mercado-livre` died with
 *
 *     Installing pnpm v11.24.0
 *     pnpm v11.24.0 detected (>= 11.0.0), downloading tarball.
 *     fetching .../releases/download/v11.24.0/pnpm-linux-x64.tar.gz
 *       returned HTTP status: 404
 *     ERROR: failed to build: exit status 1
 *
 * `engines.pnpm` was `>=11.0.0`. It resolved to `11.24.0` — real on npm, but
 * published under the `next-11` dist-tag (npm `latest` was `11.23.0`), and pnpm
 * had cut no GitHub RELEASE for it. For pnpm `>= 11.0.0` the buildpack downloads
 * a standalone tarball from `releases/download/v<version>/pnpm-linux-x64.tar.gz`,
 * so a version that exists on npm but not on GitHub 404s and takes the whole
 * deploy down inside the pnpm buildpack — before a line of app code is built.
 *
 * ⚠️ Nothing in the repo changed on the day it broke, and nothing will change on
 * the day it heals: pnpm eventually cuts the release and the same commit starts
 * building again. That is precisely why this is a guard and not a bug report —
 * the failure is a coin flip owned by an upstream publish schedule, and the only
 * thing under our control is refusing to ask for a range.
 *
 * Same rule and same reasoning as `apphosting-next-pinned.test.js` and
 * `runtime-deps-pinned.test.js`: an **external resolver reads the manifest
 * without our lockfile or workspace context**, so a range there ships a version
 * no CI lane ever ran. It is a separate file because the surface is disjoint from
 * both (one field pair, in one manifest, read by a different buildpack).
 *
 * This is a test rather than an ESLint rule because the invariant lives in JSON
 * manifests, which ESLint (one JS/TS file at a time) never sees. Failing the test
 * fails CI exactly like a lint error would.
 */

/** Exact semver — no range, no `^`, no `~`, no `x`, no `||`, no prerelease. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * `pnpm@X.Y.Z`, optionally carrying corepack's integrity suffix.
 *
 * The `+sha…` half is tolerated rather than required: `corepack use pnpm@…`
 * appends it, a hand edit does not, and the buildpack is happy either way. Only
 * the version half is compared.
 */
const PACKAGE_MANAGER = /^pnpm@(\d+\.\d+\.\d+)(\+[\w.-]+)?$/;

const ROOT = 'package.json';

/**
 * Every tracked-or-untracked `package.json`, root included.
 *
 * Ask git rather than walking the filesystem — same reasoning as the sibling
 * guards: a walk needs a skip-list, and the directories it must skip
 * (`node_modules`, the generated `.deploy/` artifacts, the gitignored `.old/`
 * Flutter reference) are exactly the ones that produce false positives. git
 * already excludes all three. The `--others` pass inside `gitLsFiles` catches a
 * new workspace before it is committed.
 *
 * git emits forward slashes on every platform, including Windows. Compare the
 * results as RAW STRINGS — running them through `path.join`/`resolve` first would
 * back-slash them on Windows and red every assertion locally while staying green
 * in CI.
 */
function allManifests() {
  // Two pathspecs: the bare root file, and a `:(glob)` one for every nested
  // manifest. The nested pattern is written in the code below rather than shown
  // in the comment above for a dull reason — a doubled star followed by a slash
  // would CLOSE that block comment, the same trap `apphosting-next-pinned.test.js`
  // calls out.
  return gitLsFiles([ROOT, ':(glob)**/package.json']);
}

function manifest(relPath) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
}

const FIX = [
  'Fix: keep BOTH root fields on the same exact version, in the same commit:',
  '',
  '  "packageManager": "pnpm@<X.Y.Z>",',
  '  "engines": { "node": ">=22", "pnpm": "<X.Y.Z>" }',
  '',
  'Then run `pnpm install` and commit the lockfile if it moved.',
  '',
  '⚠️ Before bumping, check that the version has a GitHub release carrying',
  '`pnpm-linux-x64.tar.gz` — being on npm is NOT enough. The App Hosting',
  'buildpack downloads that asset, and npm publishes ahead of the release.',
].join('\n');

describe('the root manifest pins pnpm to one exact version', () => {
  it('declares both fields the buildpack reads', () => {
    // Anchor. Every assertion below reads one of these two fields, so if a
    // rename or a deletion emptied them this file would pass over nothing —
    // and, worse, emptying BOTH is itself a behaviour change: it hands the
    // cloud back to the pinned-tool-version/`latest` fallback branch.
    const pjs = manifest(ROOT);
    expect(
      pjs.packageManager,
      [
        'The root `packageManager` field is gone. Corepack derives the pnpm CI',
        'runs from it (every lane runs a bare `corepack enable`, pinning nothing),',
        'so removing it silently changes which pnpm builds this repo.',
      ].join('\n'),
    ).toBeDefined();
    expect(
      pjs.engines?.pnpm,
      [
        'The root `engines.pnpm` field is gone. That is not neutral: with both it',
        'and `packageManager` empty, `detectPNPMVersion` falls into its pinned-',
        'then-`latest` branch and the cloud picks a pnpm nobody here chose.',
      ].join('\n'),
    ).toBeDefined();
  });

  it('pins engines.pnpm to an exact version', () => {
    const spec = manifest(ROOT).engines?.pnpm;
    expect(
      EXACT_SEMVER.test(String(spec)),
      [
        `Root \`engines.pnpm\` is \`${spec}\` — it must be an EXACT version.`,
        '',
        'This field outranks `packageManager` in the App Hosting pnpm buildpack,',
        'and a range there is resolved against the npm registry at DEPLOY time to',
        'the highest published match — including a version published under a',
        'non-`latest` dist-tag whose GitHub release does not exist yet. That is',
        'the 404 that killed the 2026-08-24 staging deploy (see the file header).',
        '',
        FIX,
      ].join('\n'),
    ).toBe(true);
  });

  it('declares packageManager as pnpm at an exact version', () => {
    const spec = manifest(ROOT).packageManager;
    expect(
      PACKAGE_MANAGER.test(String(spec)),
      [
        `Root \`packageManager\` is \`${spec}\`, expected \`pnpm@<X.Y.Z>\`.`,
        '',
        'Corepack requires an exact version here, and every CI lane relies on it:',
        'they run `corepack enable` and pin nothing on purpose (#612).',
        '',
        FIX,
      ].join('\n'),
    ).toBe(true);
  });

  it('keeps engines.pnpm and packageManager on the same version', () => {
    const pjs = manifest(ROOT);
    const engines = String(pjs.engines?.pnpm);
    const declared = PACKAGE_MANAGER.exec(String(pjs.packageManager))?.[1];
    expect(
      engines,
      [
        `\`engines.pnpm\` is ${engines} but \`packageManager\` says ${declared}.`,
        '',
        'These must agree, because DIFFERENT CONSUMERS READ DIFFERENT FIELDS:',
        'corepack (all 21 CI lanes, and local dev) reads `packageManager`, while',
        'the App Hosting buildpack reads `engines.pnpm` FIRST and never looks at',
        '`packageManager` while it is set. Letting them drift means CI and the',
        'cloud build this repo with two different pnpm versions, and only CI is',
        'ever observed. Worse, pnpm hard-fails a local install when the running',
        'version does not satisfy `engines` — so the drift surfaces as a confusing',
        'local error rather than as the deploy problem it actually is.',
        '',
        FIX,
      ].join('\n'),
    ).toBe(declared);
  });

  it('keeps engines.node a RANGE', () => {
    // Guards the tidy-up this change invites: "make it consistent" → pin node
    // exactly too. Do not. pnpm fails an install outright when the running
    // version does not satisfy `engines`, and contributors run assorted 22/24
    // patch releases; App Hosting itself ran 24.19.0 on the build above while
    // `.nvmrc` and every CI lane say 22. `pnpm` is safe to pin ONLY because
    // `packageManager` already forces that exact version through corepack.
    const spec = manifest(ROOT).engines?.node;
    expect(spec, 'The root `engines.node` field is gone.').toBeDefined();
    expect(
      EXACT_SEMVER.test(String(spec)),
      [
        `Root \`engines.node\` is \`${spec}\` — an exact pin. It must stay a RANGE.`,
        '',
        'pnpm errors out of a local install when the running Node does not satisfy',
        '`engines`, so an exact pin breaks every contributor on a different patch',
        'release for no gain: the App Hosting runtime version comes from',
        '`GOOGLE_RUNTIME_VERSION`, not from this field.',
      ].join('\n'),
    ).toBe(false);
  });

  it('leaves the pnpm version undeclared in every other manifest', () => {
    const manifests = allManifests();

    // Anti-vacuity anchor for the pathspec. This repo has 40+ workspace
    // manifests plus the four nested `functions` ones; if the glob silently
    // stopped matching, the scan below would pass over an empty set.
    expect(
      manifests.length,
      'The `package.json` pathspec stopped matching — this scan is checking nothing.',
    ).toBeGreaterThan(30);
    expect(manifests, 'The root manifest itself must be in the scan.').toContain(ROOT);

    const offenders = [];
    for (const relPath of manifests) {
      if (relPath === ROOT) continue;
      const pjs = manifest(relPath);
      if (pjs.packageManager !== undefined) {
        offenders.push(`${relPath} → packageManager: ${pjs.packageManager}`);
      }
      if (pjs.engines?.pnpm !== undefined) {
        offenders.push(`${relPath} → engines.pnpm: ${pjs.engines.pnpm}`);
      }
    }

    expect(
      offenders,
      [
        'Only the ROOT manifest may name a pnpm version. A second declaration is',
        'not additive — it is a second source of truth that no single consumer',
        'reads consistently, and the one place it matters (the App Hosting',
        'buildpack) resolves against whichever manifest it happens to load.',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        'Note `engines.node` is deliberately allowed here: the five backend',
        'manifests that carry it state a runtime floor, not a tool version.',
      ].join('\n'),
    ).toEqual([]);
  });
});
