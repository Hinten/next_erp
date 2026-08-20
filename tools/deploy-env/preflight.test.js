import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CODEBASES, REGIONS_WITHOUT_TASKS, crossCheckNote, preflight } from './preflight.mjs';

/**
 * The preflight's job is to turn two silent deploy outcomes into loud ones, so
 * these tests assert the MESSAGE as well as the failure: an abort whose text does
 * not say what to export is barely better than the silence it replaced.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GOOD_SA = 'apphosting@p.iam.gserviceaccount.com';

/** A codebase whose task region default is fine, so only the invoker varies. */
const OK = 'mercado-livre';

function run(env, codebase = OK) {
  return preflight(codebase, env);
}

describe('TASKS_INVOKER_SA is mandatory to deploy (#1133)', () => {
  it('fails when unset, naming the var and the export that fixes it', () => {
    const { errors } = run({});

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('TASKS_INVOKER_SA is not set');
    expect(errors[0]).toContain('export TASKS_INVOKER_SA=');
    // The WHY has to travel with the error: this is the failure nobody sees.
    expect(errors[0]).toContain('SILENT');
    expect(errors[0]).toContain('403');
    // And where to find the two emails.
    expect(errors[0]).toContain('DEPLOY.md');
  });

  it.each([
    ['blank', ''],
    ['whitespace', '   '],
  ])('treats a %s value as unset', (_label, value) => {
    const { errors } = run({ TASKS_INVOKER_SA: value });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('TASKS_INVOKER_SA is not set');
  });

  it('passes when set, and reports it as coming from the env', () => {
    const { errors, rows } = run({ TASKS_INVOKER_SA: GOOD_SA });

    expect(errors).toEqual([]);
    expect(rows.find((r) => r.name === 'TASKS_INVOKER_SA')).toEqual({
      name: 'TASKS_INVOKER_SA',
      value: GOOD_SA,
      source: 'env',
    });
  });
});

describe('a region with no Cloud Tasks is refused up front (#1108)', () => {
  it('rejects a task region of us-east5', () => {
    // mercado-pago's onTaskDispatched inherits setGlobalOptions({ region }), so
    // FUNCTIONS_REGION *is* its queue region — and its build.mjs default is
    // us-east5, which is why this codebase cannot deploy as it stands (#1121).
    const { errors } = run({ TASKS_INVOKER_SA: GOOD_SA }, 'mercado-pago');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("FUNCTIONS_REGION resolves to 'us-east5'");
    expect(errors[0]).toContain('NO Cloud Tasks');
  });

  it('accepts the same codebase once a real region is exported', () => {
    const { errors } = run(
      { TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: 'us-east1' },
      'mercado-pago',
    );

    expect(errors).toEqual([]);
  });

  it('reports BOTH problems at once rather than stopping at the first', () => {
    // An operator fixing one and re-running only to hit the other is the kind of
    // friction that gets a guard disabled.
    const { errors } = run({}, 'mercado-pago');

    expect(errors).toHaveLength(2);
  });

  it('keeps the rejected-region list minimal and evidence-based', () => {
    // A false positive here BLOCKS a legitimate deploy, which is worse than the
    // silence this guard exists to break. us-east5 is measured (#1108: 11 of 15
    // functions failed at once). Adding a region needs the same evidence.
    expect([...REGIONS_WITHOUT_TASKS]).toEqual(['us-east5']);
  });
});

describe('the resolved-value table', () => {
  it('marks a value taken from the env differently from a build default', () => {
    const { rows } = run({ TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: 'europe-west4' });
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    expect(byName.FUNCTIONS_REGION).toMatchObject({ value: 'europe-west4', source: 'env' });
    expect(byName.MERCADO_LIVRE_TASKS_REGION).toMatchObject({
      value: 'us-east1',
      source: 'build.mjs default',
    });
  });

  it('covers every codebase, including the deploy-shell rateLimits knobs', () => {
    for (const codebase of Object.keys(CODEBASES)) {
      const { rows } = preflight(codebase, { TASKS_INVOKER_SA: GOOD_SA });
      expect(rows.length, codebase).toBeGreaterThan(1);
      expect(
        rows.some((r) => r.name === 'TASKS_INVOKER_SA'),
        codebase,
      ).toBe(true);
    }
    // The two stock knobs are read through `process.env[name]` (computed access),
    // which esbuild `define` CANNOT rewrite — they are deploy-shell reads baked
    // into the queue config, and nothing else surfaces them.
    const ml = preflight('mercado-livre', { TASKS_INVOKER_SA: GOOD_SA }).rows;
    expect(ml.some((r) => r.name === 'MERCADO_LIVRE_STOCK_DISPATCHES_PER_SECOND')).toBe(true);
    expect(ml.some((r) => r.name === 'MERCADO_LIVRE_STOCK_CONCURRENT_DISPATCHES')).toBe(true);
  });

  it('rejects an unknown codebase instead of silently checking nothing', () => {
    expect(() => preflight('does-not-exist', {})).toThrow(/Unknown functions codebase/);
  });
});

describe('the duplicated defaults still match build.mjs', () => {
  // CODEBASES restates each build.mjs default so the printed table can show what
  // will actually be baked in. Two sources of truth need a test, or the table
  // starts lying — which is worse than not printing it.
  it.each(Object.entries(CODEBASES))('%s', (codebase, spec) => {
    const source = readFileSync(resolve(REPO_ROOT, spec.buildScript), 'utf8');
    for (const [name, expected] of Object.entries(spec.inlined)) {
      const match = new RegExp(`process\\.env\\.${name}\\s*\\|\\|\\s*'([^']*)'`).exec(source);
      expect(match, `${spec.buildScript} does not default ${name}`).not.toBeNull();
      expect(match[1], `${name} default drifted from ${spec.buildScript}`).toBe(expected);
    }
  });

  it('drift-checks the deployShell defaults too, not just the inlined ones', () => {
    // These are restated from `envInt(NAME, N)` in bulkEstoquePlan.ts. Nothing
    // compared them before, so changing either literal left the preflight
    // printing the old number, green, on every deploy — the exact "the table
    // lies" failure the drift test above exists to prevent.
    for (const spec of Object.values(CODEBASES)) {
      const names = Object.keys(spec.deployShell);
      if (names.length === 0) continue;
      const source = readFileSync(resolve(REPO_ROOT, spec.deployShellSource), 'utf8');
      for (const [name, expected] of Object.entries(spec.deployShell)) {
        const match = new RegExp(`envInt\\(\\s*'${name}'\\s*,\\s*(\\d+)\\s*\\)`).exec(source);
        expect(match, `${spec.deployShellSource} has no envInt for ${name}`).not.toBeNull();
        expect(match[1], `${name} drifted from ${spec.deployShellSource}`).toBe(expected);
      }
    }
  });

  it('lists EVERY build.mjs default, so a new define cannot go unlisted', () => {
    // The drift test is otherwise one-directional: it proves each listed entry
    // matches the build, never that the build has nothing the table omits. A new
    // `process.env.X || '…'` would simply be absent, with nothing to notice.
    for (const [codebase, spec] of Object.entries(CODEBASES)) {
      const source = readFileSync(resolve(REPO_ROOT, spec.buildScript), 'utf8');
      const found = [...source.matchAll(/process\.env\.([A-Z0-9_]+)\s*\|\|\s*'[^']*'/g)].map(
        (m) => m[1],
      );
      const missing = found.filter(
        // TASKS_INVOKER_SA is the guard's own subject, handled separately above.
        (name) => name !== 'TASKS_INVOKER_SA' && !(name in spec.inlined),
      );
      expect(
        missing,
        `${spec.buildScript} inlines these but CODEBASES.${codebase} omits them`,
      ).toEqual([]);
    }
  });

  it('names a build script that exists for every codebase', () => {
    for (const [codebase, spec] of Object.entries(CODEBASES)) {
      expect(
        () => readFileSync(resolve(REPO_ROOT, spec.buildScript), 'utf8'),
        codebase,
      ).not.toThrow();
      expect(
        () => readFileSync(resolve(REPO_ROOT, spec.deployConfig), 'utf8'),
        codebase,
      ).not.toThrow();
      expect(
        () => readFileSync(resolve(REPO_ROOT, spec.deployDoc), 'utf8'),
        codebase,
      ).not.toThrow();
    }
  });
});

describe('a padded value is refused rather than silently trimmed', () => {
  // `build.mjs` is a bare `process.env.X || '<default>'` — no trim — so `''`
  // falls through but `'   '` is inlined VERBATIM. Without this check the table
  // reported the trimmed value while the bundle got the padded one.
  it('rejects a region with surrounding whitespace', () => {
    const { errors } = run({ TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: ' us-east1 ' }, 'nfe');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('surrounding whitespace');
    expect(errors[0]).toContain('VERBATIM');
  });

  it('still treats a whitespace-ONLY value as unset, matching `||`', () => {
    // `'   ' || 'us-east1'` is `'   '` in build.mjs, so this is flagged too —
    // but as the whitespace error, not as a missing value.
    const { errors, rows } = run({ TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: '   ' }, 'nfe');

    expect(rows.find((r) => r.name === 'FUNCTIONS_REGION')?.source).toBe('build.mjs default');
    expect(errors.some((e) => e.includes('surrounding whitespace'))).toBe(true);
  });

  it('accepts a clean value', () => {
    const { errors } = run({ TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: 'us-east1' }, 'nfe');

    expect(errors).toEqual([]);
  });
});

describe('the backend cross-check note', () => {
  // The region abort tells a mercado-pago/whatsapp operator to export
  // FUNCTIONS_REGION=us-east1, which moves the queue — while their backends set
  // NO region variable, so the enqueuer keeps resolving us-east5. Obeying the
  // remedy would create the very mismatch this PR fixed for mercado-livre.
  it.each([
    ['mercado-livre', 'MERCADO_LIVRE_TASKS_REGION'],
    ['mercado-pago', 'MERCADO_PAGO_TASKS_REGION'],
    ['whatsapp', 'WHATSAPP_TASKS_REGION'],
    ['nfe', 'NFE_TASKS_REGION'],
  ])('%s gets a note naming the backend variable and its manifest', (codebase, backendVar) => {
    // ⚠️ Assert the NOTE, not just the table entry. An earlier version of these
    // tests checked `CODEBASES[x].backendVar` only, and reverting the function to
    // `if (codebase !== 'mercado-livre') return null` stayed GREEN — the data was
    // right while the thing that uses it was broken.
    const note = crossCheckNote(codebase, 'us-east1');

    expect(note, `${codebase} must get a backend cross-check note`).not.toBeNull();
    expect(note).toContain(backendVar);
    expect(note).toContain(CODEBASES[codebase].backendManifest);
    expect(note).toContain('us-east1');
    expect(CODEBASES[codebase].backendManifest).toMatch(/apphosting\.yaml$/);
  });

  it('has no backend note for storage, which no backend enqueues', () => {
    // `processarBalanco` is enqueued by the finalizarBalanco callable and by
    // itself — both inside the codebase, so there is no second env to agree with.
    expect(CODEBASES.storage.backendVar).toBeNull();
    expect(crossCheckNote('storage', 'us-east1')).toBeNull();
  });

  it('surfaces the runtime override on the queue that has no sweep', () => {
    const { rows } = preflight('storage', { TASKS_INVOKER_SA: GOOD_SA });

    expect(rows.some((r) => r.name === 'BALANCO_TASKS_REGION')).toBe(true);
  });
});

describe('every deploy config runs the preflight', () => {
  // The guard is only real if it is wired. A codebase whose predeploy forgets it
  // deploys exactly as before — silently.
  it.each(Object.entries(CODEBASES))('%s', (codebase, spec) => {
    const config = JSON.parse(readFileSync(resolve(REPO_ROOT, spec.deployConfig), 'utf8'));
    const predeploy = config.functions[0].predeploy;

    expect(predeploy[0], `${spec.deployConfig} must run the preflight FIRST`).toBe(
      `node tools/deploy-env/preflight.mjs ${codebase}`,
    );
    expect(predeploy.some((c) => c.includes('prepare-deploy.mjs'))).toBe(true);
  });
});
