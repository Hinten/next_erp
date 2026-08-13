import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

import {
  attributeFile,
  closureOf,
  decide,
  isInert,
  loadWorkspaces,
  parseArgs,
} from '../../../.github/scripts/e2e-affected.mjs';

/**
 * The scope decider behind every e2e lane (`.github/scripts/e2e-affected.mjs`).
 *
 * WHY IT IS TESTED HERE. This script decides whether a lane runs. If it answers
 * "skip" when it should answer "run", unverified code ships behind a green check —
 * which is the exact defect the whole e2e-gate design exists to remove, just
 * relocated from a `paths:` list into a script. So the skip direction is what
 * these tests hammer.
 *
 * The live-repo anchor at the bottom is the direct regression test for the
 * original bug: `apps/web` imports `@delfrance/integrations-nfe`,
 * `@delfrance/integrations-freight-br` and `@delfrance/storage`, and the old
 * hand-written `paths:` list named none of them.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** A throwaway monorepo on disk, so the graph walk is tested on shapes we choose. */
function fixture(manifests) {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-affected-'));
  for (const [dir, json] of Object.entries(manifests)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify(json));
  }
  return root;
}

const temps = [];
const scratch = (manifests) => {
  const root = fixture(manifests);
  temps.push(root);
  return root;
};
/** An empty throwaway directory, torn down with the fixtures. */
const scratchDir = () => {
  const root = mkdtempSync(path.join(tmpdir(), 'e2e-affected-cli-'));
  temps.push(root);
  return root;
};
afterAll(() => temps.forEach((t) => rmSync(t, { recursive: true, force: true })));

const GRAPH = {
  'apps/web': { name: 'web', dependencies: { mid: 'workspace:*' } },
  'apps/other': { name: 'other', dependencies: { lonely: 'workspace:*' } },
  'packages/mid': { name: 'mid', dependencies: { deep: 'workspace:*' } },
  'packages/deep': { name: 'deep' },
  'packages/lonely': { name: 'lonely' },
  'packages/integrations/chan': { name: 'chan' },
};

describe('e2e-affected: the dependency closure', () => {
  it('is transitive, so an indirect dependency still triggers the lane', () => {
    const ws = loadWorkspaces(scratch(GRAPH));
    expect([...closureOf(ws, ['web'])].sort()).toEqual(['deep', 'mid', 'web']);
  });

  it('excludes workspaces nothing in the closure depends on', () => {
    const ws = loadWorkspaces(scratch(GRAPH));
    const closure = closureOf(ws, ['web']);
    expect(closure.has('lonely')).toBe(false);
    expect(closure.has('other')).toBe(false);
  });

  it('grows when a lane declares extra roots', () => {
    const ws = loadWorkspaces(scratch(GRAPH));
    expect([...closureOf(ws, ['web', 'other'])].sort()).toEqual([
      'deep',
      'lonely',
      'mid',
      'other',
      'web',
    ]);
  });

  it('THROWS on an unknown root rather than resolving to nothing', () => {
    const ws = loadWorkspaces(scratch(GRAPH));
    // A typo'd root would otherwise make every path look "outside the closure",
    // so the lane would skip forever while reporting green. Loudest possible
    // failure is the only safe behaviour.
    expect(() => closureOf(ws, ['wbe'])).toThrow(/unknown --roots: wbe/);
  });

  it('attributes a nested package by LONGEST directory prefix', () => {
    const ws = loadWorkspaces(scratch(GRAPH));
    expect(attributeFile(ws, 'packages/integrations/chan/src/x.ts')?.name).toBe('chan');
  });
});

describe('e2e-affected: the verdict', () => {
  const ws = () => loadWorkspaces(scratch(GRAPH));

  const verdict = (files, roots = ['web']) => {
    const workspaces = ws();
    return decide({ workspaces, closure: closureOf(workspaces, roots), files });
  };

  it('runs when a closure member changed', () => {
    expect(verdict(['packages/deep/src/a.ts']).runE2e).toBe(true);
  });

  it('skips when every path belongs outside the closure', () => {
    expect(verdict(['apps/other/x.ts', 'packages/lonely/y.ts']).runE2e).toBe(false);
  });

  it('runs when ANY path is in the closure, even among many that are not', () => {
    expect(verdict(['apps/other/x.ts', 'packages/mid/y.ts', 'packages/lonely/z.ts']).runE2e).toBe(
      true,
    );
  });

  it('runs for a path belonging to no workspace at all', () => {
    // Root configs, firestore rules, CI definitions. Unattributable is never a
    // reason to skip — it is a reason to admit we do not know.
    for (const file of [
      'firestore.rules',
      'firestore.indexes.json',
      'pnpm-lock.yaml',
      'firebase.e2e.json',
      '.github/workflows/e2e-cadastros.yml',
      'some-new-toplevel-thing/x.ts',
    ]) {
      expect(verdict([file]).runE2e, `${file} must force a run`).toBe(true);
    }
  });

  it('treats documentation and agent tooling as inert', () => {
    expect(verdict(['README.md', '.claude/settings.json', 'LICENSE']).runE2e).toBe(false);
  });

  it('lets inert win over attribution, so a README inside the closure still skips', () => {
    expect(isInert('apps/web/README.md')).toBe(true);
    expect(verdict(['apps/web/README.md']).runE2e).toBe(false);
  });

  it('does NOT treat .github as inert, so a workflow edit self-tests', () => {
    expect(isInert('.github/workflows/e2e-vendas.yml')).toBe(false);
  });

  it('reports the path that forced the run, for the job summary', () => {
    const { reason, rows } = verdict(['apps/other/x.ts', 'packages/deep/b.ts']);
    expect(reason).toContain('packages/deep/b.ts');
    expect(rows.find((r) => r.file === 'apps/other/x.ts').kind).toBe('outside');
    expect(rows.find((r) => r.file === 'packages/deep/b.ts').kind).toBe('run');
  });
});

/**
 * VERSION SKEW — the CLI's behaviour when it cannot answer the question.
 *
 * These run the real script in a child process, because the thing under test is
 * what lands in `$GITHUB_OUTPUT` and what the process exit code is. Both are
 * invisible to an in-process import: the CLI block is guarded on
 * `process.argv[1]`, and the fail-safe lives in its `catch`.
 *
 * WHY IT MATTERS. GitHub runs a pull_request's workflow YAML from the MERGE REF
 * while the lanes check out the PR HEAD, so the caller is always >= this script and
 * never older. A branch predating a flag — or predating the whole file — is normal,
 * not exotic; it cost two red lanes on runs 31719660542 and 31704153529.
 */
describe('e2e-affected: the CLI fails safe in the direction its MODE declares', () => {
  const SCRIPT = resolve(REPO_ROOT, '.github/scripts/e2e-affected.mjs');

  /**
   * Run the CLI and return `{ status, outputs }`, where `outputs` is the parsed
   * `$GITHUB_OUTPUT` file.
   *
   * ⚠️ `GITHUB_STEP_SUMMARY` is deleted, not overridden with a temp path: on a CI
   * runner it is a real file, and the script appends its attribution table to it.
   * Leaving it set would splatter these fixtures across the job summary.
   */
  const runCli = (args, { script = SCRIPT } = {}) => {
    const dir = scratchDir();
    const outPath = path.join(dir, 'github-output.txt');
    writeFileSync(outPath, '');
    const env = { ...process.env, GITHUB_OUTPUT: outPath };
    delete env.GITHUB_STEP_SUMMARY;

    const proc = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8' });
    const outputs = Object.fromEntries(
      readFileSync(outPath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq), line.slice(eq + 1)];
        }),
    );
    return { status: proc.status, outputs, stderr: proc.stderr };
  };

  /** A `--files` path that does not exist — the cheapest way to make it throw. */
  const MISSING_FILES = ['--files', path.join(tmpdir(), 'e2e-affected-no-such-file.txt')];

  it('POSITIVE CONTROL: a missing script exits non-zero and writes NOTHING', () => {
    // This is the failure the workflow-side `if !` guard exists for, and the reason
    // the script's own `catch` cannot cover it: node dies at module resolution, so
    // no JavaScript in this file ever runs. If this test ever goes green-with-output,
    // the guard in every lane has become unnecessary — check before removing it.
    const { status, outputs } = runCli(['--roots', '@delfrance/web', ...MISSING_FILES], {
      script: resolve(REPO_ROOT, '.github/scripts/does-not-exist.mjs'),
    });

    expect(status).not.toBe(0);
    expect(outputs).toEqual({});
  });

  it('a crash in --roots mode RUNS the lane', () => {
    // A wrong skip ships unverified code, so uncertainty must cost a CI run.
    const { status, outputs } = runCli(['--roots', '@delfrance/web', ...MISSING_FILES]);

    expect(status).toBe(0);
    expect(outputs.run_e2e).toBe('true');
    expect(outputs.reason).toContain('fail safe');
  });

  it('a crash in --only-paths mode does NOT run the live suite', () => {
    // The inversion. `--only-paths` serves `nfe-live` alone, which emits test
    // documents at SEFAZ homologação against a rate-limited endpoint
    // (cStat=656) — and `NFE_CI_LIVE_ENABLED=true` on this repo, so this is a
    // real emission path. The offline NF-e suite has already run and the gate
    // states out loud that live did not, so skipping is the cheap mistake here.
    // Before this rule the catch emitted `run_e2e=true` unconditionally, which
    // `ci-nfe.yml` maps straight onto `run_live`.
    const { status, outputs } = runCli(['--only-paths', 'apps/nfe', ...MISSING_FILES]);

    expect(status).toBe(0);
    expect(outputs.run_e2e).toBe('false');
    expect(outputs.reason).toContain('SEFAZ');
  });

  it('rejects an unrecognised flag instead of swallowing it as a value', () => {
    // The generalised skew: a flag added to the merge-ref YAML reaches an older
    // copy of this script. Silently absorbing `--brand-new-flag` as a value for
    // whichever flag preceded it is how a skewed run produces a WRONG verdict
    // rather than a loud one.
    expect(() => parseArgs(['--roots', 'a', '--brand-new-flag', 'z'])).toThrow(
      /unknown flag --brand-new-flag/,
    );
    // ...and legitimate values that merely LOOK odd still parse.
    expect(parseArgs(['--lane', 'nfe (live)', '--only-paths', 'apps/nfe']).onlyPaths).toEqual([
      'apps/nfe',
    ]);
  });

  it('routes that rejection through the mode-correct fail-safe, both ways', () => {
    // The throw is only useful if it lands in the same direction rule as any other
    // crash — otherwise a new flag would force SEFAZ traffic on every stale branch.
    const roots = runCli(['--roots', '@delfrance/web', '--brand-new-flag', 'z', ...MISSING_FILES]);
    expect(roots.outputs.run_e2e).toBe('true');

    const live = runCli(['--only-paths', 'apps/nfe', '--brand-new-flag', 'z', ...MISSING_FILES]);
    expect(live.outputs.run_e2e).toBe('false');
  });

  it('still answers normally when nothing is wrong', () => {
    // Anti-vacuity: every assertion above is about failure paths. If the CLI were
    // broken outright they would all still pass.
    const dir = scratchDir();
    const files = path.join(dir, 'changed.txt');
    writeFileSync(files, 'apps/web/app/page.tsx\n');

    expect(runCli(['--roots', '@delfrance/web', '--files', files]).outputs.run_e2e).toBe('true');
    expect(runCli(['--only-paths', 'apps/nfe', '--files', files]).outputs.run_e2e).toBe('false');
  });
});

describe('e2e-affected: anchored to the real repo', () => {
  const workspaces = loadWorkspaces(REPO_ROOT);

  it("sees this monorepo's workspaces", () => {
    // Anti-vacuity: every assertion below is trivially true against an empty map.
    expect(workspaces.size).toBeGreaterThan(20);
    expect(workspaces.get('@delfrance/web')?.dir).toBe('apps/web');
  });

  it("puts the three packages the old paths: list forgot INSIDE apps/web's closure", () => {
    const closure = closureOf(workspaces, ['@delfrance/web']);

    // These are the actual defect. `apps/web` imports @delfrance/integrations-nfe
    // in 33 files, @delfrance/integrations-freight-br in 15 and @delfrance/storage
    // in 12 — and the hand-written `paths:` filter that used to gate the staging
    // lanes named none of them, so a change to any one shipped with zero e2e.
    for (const pkg of [
      '@delfrance/integrations-nfe',
      '@delfrance/integrations-freight-br',
      '@delfrance/storage',
      // Reached via tools/test-fixtures. A ruleset change breaks every staging
      // spec, so it has to be in the closure too.
      '@delfrance/rules-gen',
    ]) {
      expect(closure.has(pkg), `${pkg} must be in apps/web's dependency closure`).toBe(true);
    }
  });

  it('keeps the channel apps OUT, so their PRs still skip correctly', () => {
    const closure = closureOf(workspaces, ['@delfrance/web']);

    // The fix must not degenerate into "run everything". These are separate
    // deployables that apps/web does not import; PRs confined to them skipped e2e
    // before this change and must go on skipping it.
    for (const pkg of [
      '@delfrance/mercado-livre-app',
      '@delfrance/mercado-pago-app',
      '@delfrance/whatsapp-app',
      '@delfrance/nfe-app',
      '@delfrance/integrations-mercado-livre',
      '@delfrance/docs',
    ]) {
      expect(closure.has(pkg), `${pkg} must NOT be in apps/web's closure`).toBe(false);
    }
  });

  it('gives the emulator lane its functions root, which apps/web alone would miss', () => {
    expect(closureOf(workspaces, ['@delfrance/web']).has('@delfrance/functions')).toBe(false);
    expect(
      closureOf(workspaces, ['@delfrance/web', '@delfrance/functions']).has('@delfrance/functions'),
    ).toBe(true);
  });
});
