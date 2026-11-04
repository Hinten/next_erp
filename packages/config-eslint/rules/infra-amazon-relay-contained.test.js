import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: the AWS CDK stays inside `infra/amazon-relay`, and that
 * workspace runs only lint, typecheck and test.
 *
 * ## Why this lives here and not in the infra package's own suite
 *
 * This directory's suite always runs in `CI test`. The infra package's suite
 * runs only through its `test` script: rename that script and turbo silently
 * skips the package, pins included. So both pins sit here.
 *
 * ## (1) The workspace's scripts are exactly lint, typecheck and test
 *
 * - No `cdk` anywhere: the CLI phones home (telemetry, notices, a version
 *   check), and D11 forbids any network call from CI. Synthesis happens
 *   in-process in the package's tests; the owner runs the CLI by hand at W2a.
 * - No `build` or `synth` script under ANY name: `CI build` runs
 *   `turbo run build`, and `ci.yml`'s job split is free only because turbo's
 *   `^build` edge resolves to zero tasks (no workspace outside `apps/*` defines
 *   `build`; that comment names `packages/*`, `packages/integrations/*` and
 *   `tools/*`, and this pin holds the premise for `infra/*` too). A value scan
 *   alone would miss `"synth": "node --import tsx bin/relay.ts"` and
 *   `"build": "tsc"`, so the KEY set is pinned exactly.
 *
 * ## (2) No other manifest names the CDK or the infra workspace
 *
 * `aws-cdk-lib` is ~137 MB of construct library with no business in a runtime
 * bundle. A manifest outside `infra/amazon-relay` naming it (or `aws-cdk`,
 * `constructs`, or the workspace itself) could import and bundle it. The ROOT
 * `package.json` is scanned too, and it matters most: its dependencies
 * resolve from every workspace through Node's upward walk, so a CDK leak
 * there is importable from `apps/web` without `apps/web` naming it. (A bare
 * doubled-star pathspec needs a slash and so never matches the root file; the
 * root is listed on its own.)
 *
 * This is a test rather than an ESLint rule because the invariant lives in JSON
 * manifests, which ESLint never sees.
 */

const INFRA_DIR = 'infra/amazon-relay';
const INFRA_MANIFEST = `${INFRA_DIR}/package.json`;
const ALLOWED_SCRIPTS = ['lint', 'test', 'typecheck'];
const CONTAINED = ['aws-cdk-lib', 'aws-cdk', 'constructs', '@delfrance/infra-amazon-relay'];
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

/** Every tracked-or-untracked `package.json`, root included. */
function allManifests() {
  // The nested pattern is built in code rather than spelled in a comment: a
  // doubled star followed by a slash would CLOSE a block comment
  // (`apphosting-pnpm-pinned.test.js`, same trap).
  return gitLsFiles(['package.json', ':(glob)**/package.json']);
}

function readManifest(relPath) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
}

/** Problems with a script map: a key outside the allowed set, or `cdk` in a value. */
function scriptProblems(scripts) {
  const problems = [];
  const keys = Object.keys(scripts ?? {}).sort();
  if (JSON.stringify(keys) !== JSON.stringify(ALLOWED_SCRIPTS)) {
    problems.push(
      `scripts are [${keys.join(', ')}], expected exactly [${ALLOWED_SCRIPTS.join(', ')}]`,
    );
  }
  for (const [name, command] of Object.entries(scripts ?? {})) {
    if (/\bcdk\b/.test(String(command))) problems.push(`script "${name}" runs the cdk CLI`);
  }
  return problems;
}

/** `path: field.name` for every contained package a manifest outside the infra workspace names. */
function containmentLeaks(manifests) {
  const leaks = [];
  for (const [relPath, json] of manifests) {
    if (relPath === INFRA_MANIFEST) continue;
    if (json.name === '@delfrance/infra-amazon-relay') {
      leaks.push(`${relPath}: the infra workspace's name, outside ${INFRA_DIR}`);
    }
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(json[field] ?? {})) {
        if (CONTAINED.includes(name)) leaks.push(`${relPath}: ${field}.${name}`);
      }
    }
  }
  return leaks;
}

describe('infra/amazon-relay runs only lint, typecheck and test', () => {
  it('the workspace manifest exists and is the infra package', () => {
    expect(allManifests()).toContain(INFRA_MANIFEST);
    expect(readManifest(INFRA_MANIFEST).name).toBe('@delfrance/infra-amazon-relay');
  });

  it('has exactly the three scripts, none running the cdk CLI', () => {
    expect(scriptProblems(readManifest(INFRA_MANIFEST).scripts)).toEqual([]);
  });

  it('pins the CDK library exactly and does not depend on the CLI', () => {
    const json = readManifest(INFRA_MANIFEST);
    const deps = { ...json.dependencies, ...json.devDependencies };
    expect(deps['aws-cdk-lib']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(deps.constructs).toMatch(/^\d+\.\d+\.\d+$/);
    expect(deps['aws-cdk']).toBeUndefined();
  });

  it('flags a build, synth or cdk script in each of its natural forms (synthetic)', () => {
    const base = { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest run' };
    expect(scriptProblems({ ...base, synth: 'node --import tsx bin/relay.ts' })).not.toEqual([]);
    expect(scriptProblems({ ...base, build: 'tsc' })).not.toEqual([]);
    expect(scriptProblems({ ...base, cdk: 'cdk synth' })).not.toEqual([]);
    expect(scriptProblems({ ...base, test: 'vitest run && cdk synth' })).toEqual([
      'script "test" runs the cdk CLI',
    ]);
    expect(scriptProblems({ lint: 'eslint .', test: 'vitest run' })).not.toEqual([]);
  });

  it('accepts the three plain scripts (synthetic negative)', () => {
    expect(scriptProblems({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc' })).toEqual([]);
  });
});

describe('no manifest outside infra/amazon-relay names the CDK', () => {
  it('scans every manifest, the root one included (anti-vacuity)', () => {
    const manifests = allManifests();
    expect(manifests.length).toBeGreaterThanOrEqual(30);
    expect(manifests).toContain('package.json');
    expect(manifests).toContain(INFRA_MANIFEST);
  });

  it('finds no leak in the repo', () => {
    const leaks = containmentLeaks(allManifests().map((p) => [p, readManifest(p)]));
    expect(leaks, 'the CDK belongs to infra/amazon-relay alone').toEqual([]);
  });

  it('flags a CDK name in the ROOT manifest and in any dependency field (synthetic)', () => {
    expect(
      containmentLeaks([['package.json', { devDependencies: { 'aws-cdk-lib': '2.272.0' } }]]),
    ).toEqual(['package.json: devDependencies.aws-cdk-lib']);
    expect(
      containmentLeaks([
        ['apps/x/package.json', { optionalDependencies: { constructs: '10.8.1' } }],
        ['packages/y/package.json', { peerDependencies: { 'aws-cdk': '*' } }],
        [
          'tools/z/package.json',
          { dependencies: { '@delfrance/infra-amazon-relay': 'workspace:*' } },
        ],
      ]),
    ).toEqual([
      'apps/x/package.json: optionalDependencies.constructs',
      'packages/y/package.json: peerDependencies.aws-cdk',
      'tools/z/package.json: dependencies.@delfrance/infra-amazon-relay',
    ]);
  });

  it('passes the infra manifest itself and near-miss names (synthetic negative)', () => {
    expect(
      containmentLeaks([
        [INFRA_MANIFEST, { devDependencies: { 'aws-cdk-lib': '2.272.0', constructs: '10.8.1' } }],
        ['apps/x/package.json', { dependencies: { 'aws-cdk-lib-extra': '1.0.0', construct: '1' } }],
      ]),
    ).toEqual([]);
  });
});
