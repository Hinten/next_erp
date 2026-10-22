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

const OK = 'mercado-livre';

/**
 * Every region is mandatory now, so a bare `run({})` would report the missing
 * regions alongside whatever the test is actually about. `REGIONS` supplies them
 * so each describe block isolates its own subject; the block below owns the
 * missing-region behaviour and passes them explicitly instead.
 */
const REGIONS = { FUNCTIONS_REGION: 'us-central1', MERCADO_LIVRE_TASKS_REGION: 'us-central1' };

function run(env, codebase = OK) {
  return preflight(codebase, { ...REGIONS, ...env });
}

/** Same, without the region backfill — for the tests that assert on its absence. */
function runBare(env, codebase = OK) {
  return preflight(codebase, env);
}

describe('a region with no default is mandatory', () => {
  it('refuses an unset FUNCTIONS_REGION, naming it and how to set it', () => {
    const { errors, rows } = runBare({ TASKS_INVOKER_SA: GOOD_SA }, 'nfe');

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('FUNCTIONS_REGION is not set, and it has NO default');
    expect(errors[0]).toContain('export FUNCTIONS_REGION=');
    // The WHY travels with the error — this is the failure nobody sees.
    expect(errors[0]).toContain('dropped');
    expect(rows.find((r) => r.name === 'FUNCTIONS_REGION')).toMatchObject({
      value: '(unset)',
      source: 'MISSING — build refuses',
    });
  });

  it('reports every missing region at once, not just the first', () => {
    // mercado-livre inlines two, and an operator fixing them one deploy at a
    // time is exactly the loop this preflight exists to collapse.
    const { errors } = runBare({ TASKS_INVOKER_SA: GOOD_SA });

    expect(errors).toHaveLength(2);
    expect(errors.map((e) => e.split(' ')[0]).sort()).toEqual([
      'FUNCTIONS_REGION',
      'MERCADO_LIVRE_TASKS_REGION',
    ]);
  });

  it('still refuses a key whose default is legitimately kept', () => {
    // FIREBASE_DATABASE_ID keeps its `|| 'default'` — it names this repo's
    // Firestore database, which really is a constant. Only regions lost theirs.
    const { rows } = runBare({ TASKS_INVOKER_SA: GOOD_SA });

    expect(rows.find((r) => r.name === 'FIREBASE_DATABASE_ID')).toMatchObject({
      value: 'default',
      source: 'build.mjs default',
    });
  });
});

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
    // FUNCTIONS_REGION *is* its queue region. It used to DEFAULT to us-east5,
    // which is why the codebase could not deploy as it stood (#1121); the default
    // is gone, so the value is set explicitly here to keep testing the guard
    // rather than the missing-value path.
    const { errors } = runBare(
      { TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: 'us-east5' },
      'mercado-pago',
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("FUNCTIONS_REGION resolves to 'us-east5'");
    expect(errors[0]).toContain('NO Cloud Tasks');
  });

  it('accepts the same codebase once a real region is exported', () => {
    const { errors } = run(
      { TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: 'us-central1' },
      'mercado-pago',
    );

    expect(errors).toEqual([]);
  });

  it('reports BOTH problems at once rather than stopping at the first', () => {
    // An operator fixing one and re-running only to hit the other is the kind of
    // friction that gets a guard disabled. The region is set explicitly to a BAD
    // one: left unset it would report "missing" instead, which is a different
    // pairing and would not exercise this guard alongside the invoker check.
    const { errors } = runBare({ FUNCTIONS_REGION: 'us-east5' }, 'mercado-pago');

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
    // FIREBASE_DATABASE_ID is the only inlined key that still HAS a default, so
    // it is what proves the two sources still render differently.
    expect(byName.FIREBASE_DATABASE_ID).toMatchObject({
      value: 'default',
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
  //
  // ⚠️ A `null` entry asserts the OPPOSITE: that build.mjs has no default for
  // that key. Re-adding one is the regression this guards — a literal in
  // build.mjs is how this project deployed into three regions with nothing
  // failing, and it would also make the table's `(unset)` row a lie.
  it.each(Object.entries(CODEBASES))('%s', (codebase, spec) => {
    const source = readFileSync(resolve(REPO_ROOT, spec.buildScript), 'utf8');
    for (const [name, expected] of Object.entries(spec.inlined)) {
      const match = new RegExp(`process\\.env\\.${name}\\s*\\|\\|\\s*'([^']*)'`).exec(source);

      if (expected === null) {
        expect(
          match?.[1],
          `${spec.buildScript} defaults ${name} to '${match?.[1]}'. Regions must have ` +
            'NO default — use requireBuildRegion so an unset value stops the build.',
        ).toBeUndefined();
        expect(
          new RegExp(`requireBuildRegion\\(\\s*'${name}'`).test(source),
          `${spec.buildScript} must read ${name} via requireBuildRegion`,
        ).toBe(true);
        continue;
      }

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
      // Both shapes count: a `|| '<default>'` and a `requireBuildRegion('X')`
      // are equally invisible to the table if CODEBASES omits them.
      const required = [...source.matchAll(/requireBuildRegion\(\s*'([A-Z0-9_]+)'/g)].map(
        (m) => m[1],
      );
      const missing = [...found, ...required].filter(
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
  // Regions go through `requireBuildRegion`, which trims; the other inlined keys
  // are a bare `process.env.X || '<default>'` and are inlined VERBATIM. Padding
  // is refused for both, because which keys tolerate it is not something a deploy
  // should have to know.
  it('rejects a region with surrounding whitespace', () => {
    const { errors } = runBare(
      { TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: ' us-central1 ' },
      'nfe',
    );

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('surrounding whitespace');
    expect(errors[0]).toContain('VERBATIM');
  });

  it('treats a whitespace-ONLY region as unset AND as padded', () => {
    // `requireBuildRegion` trims, so `'   '` supplies nothing — the row is
    // MISSING rather than defaulted (there is no default left to fall to), and
    // the padding is reported as well so the operator sees why it looked set.
    const { errors, rows } = runBare({ TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: '   ' }, 'nfe');

    expect(rows.find((r) => r.name === 'FUNCTIONS_REGION')?.source).toBe('MISSING — build refuses');
    expect(errors.some((e) => e.includes('surrounding whitespace'))).toBe(true);
    expect(errors.some((e) => e.includes('has NO default'))).toBe(true);
  });

  it('accepts a clean value', () => {
    const { errors } = runBare(
      { TASKS_INVOKER_SA: GOOD_SA, FUNCTIONS_REGION: 'us-central1' },
      'nfe',
    );

    expect(errors).toEqual([]);
  });
});

describe('the backend cross-check note', () => {
  /**
   * A `SHOPEE_TASKS_REGION` row in an App Hosting manifest. It takes the key on
   * the item's own `-` line or a continuation line, with or without a space
   * before the colon, and the name plain, quoted, or as the body of a `|`/`>`
   * block scalar on the next line (whose header may carry its own comment), with
   * an optional trailing comment. A `#` line never matches: the manifest's prose
   * names the variable there.
   *
   * Still NOT covered: a flow-style `- { … }` item and a quoted key
   * (`"variable": …`), both of which apphosting-env-entries.test.js refuses
   * outright; and a tag, anchor or alias in front of the name (`!!str X`,
   * `&a X`), which that guard lets through and nothing here reads.
   */
  const SHOPEE_REGION_ROW =
    /^\s*(?:-\s*)?variable[ \t]*:(?:[ \t]*[|>][-+0-9]*[ \t]*(?:#.*)?$)?\s*['"]?SHOPEE_TASKS_REGION['"]?\s*(?:#.*)?$/m;

  /**
   * The ONLY place that matcher meets a manifest. It reads the live
   * apps/shopee/apphosting.yaml and answers twice: for the file as committed,
   * and for the same file with `row` spliced in as the first `env:` item. Every
   * caller asserts both answers, so the live check cannot be deleted on its own:
   * dropping it changes what this returns and reds every case below, where a
   * separate assertion could vanish and leave them green over a file nobody read.
   */
  function shopeeRegionRow(row) {
    const manifest = CODEBASES.shopee.backendManifest;
    const live = readFileSync(resolve(REPO_ROOT, manifest), 'utf8');
    const spliced = live.replace(/^env:[ \t]*\r?\n/m, (head) => `${head}${row}`);
    expect(spliced, `no \`env:\` line in ${manifest} to splice the row under`).not.toBe(live);
    return { live: SHOPEE_REGION_ROW.test(live), withRow: SHOPEE_REGION_ROW.test(spliced) };
  }

  const HOUSE_ROW = '  - variable: SHOPEE_TASKS_REGION\n    value: fixture-region\n';

  // The region abort tells a mercado-pago/whatsapp operator to export
  // FUNCTIONS_REGION=us-east1, which moves the queue — while their backends set
  // NO region variable, so the enqueuer keeps resolving us-east5. Obeying the
  // remedy would create the very mismatch this PR fixed for mercado-livre.
  it.each([
    ['mercado-livre', 'MERCADO_LIVRE_TASKS_REGION'],
    ['mercado-pago', 'MERCADO_PAGO_TASKS_REGION'],
    ['whatsapp', 'WHATSAPP_TASKS_REGION'],
    ['nfe', 'NFE_TASKS_REGION'],
    ['shopee', 'SHOPEE_TASKS_REGION'],
    // The push receiver enqueues from App Hosting (step 3, PR 3-c).
    ['amazon', 'AMAZON_TASKS_REGION'],
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

  it('sends shopee to the console, never to its manifest — which has no row for it', () => {
    // apps/shopee/apphosting.yaml keeps SHOPEE_TASKS_REGION out on purpose: a
    // value there reaches EVERY project's backend, and unset is the safe state
    // (the enqueue throws, the sweep drains). A note telling the operator to add
    // the row would undo that the moment it was obeyed — and the manifest is read
    // here too, so the note and the file cannot disagree silently.
    const note = crossCheckNote('shopee', 'us-east1');
    const manifest = CODEBASES.shopee.backendManifest;

    expect(note).toContain("THIS project's App Hosting console");
    expect(note).toContain(`never in ${manifest}`);
    expect(note).not.toContain(`Set it in ${manifest}`);
    // The file half: no row as committed, and the house spelling would be seen.
    expect(shopeeRegionRow(HOUSE_ROW)).toEqual({ live: false, withRow: true });
  });

  // The live answer can only ever be "absent", so on its own it cannot show the
  // matcher fires at all. These rows are what a re-added SHOPEE_TASKS_REGION row
  // could look like, each spliced into the real file. Each is valid block-style
  // App Hosting YAML that apphosting-env-entries.test.js lets through: it allows
  // a space before the colon, decodes quotes, block scalars and trailing
  // comments, and takes the keys in any order. (A `|` body keeps a trailing
  // newline in the name; catching it anyway errs toward red.)
  // ⚠️ The first matcher here took only an unquoted `- variable: X` with nothing
  // after it, and missed the value-first, commented and quoted rows. The second
  // still missed a space before the colon and both block scalars; the third, a
  // block-scalar header carrying its own comment.
  it.each([
    ['the house spelling', HOUSE_ROW],
    ['value first', '  - value: fixture-region\n    variable: SHOPEE_TASKS_REGION\n'],
    [
      'a trailing comment',
      '  - variable: SHOPEE_TASKS_REGION # #1108\n    value: fixture-region\n',
    ],
    ['double-quoted', '  - variable: "SHOPEE_TASKS_REGION"\n    value: fixture-region\n'],
    ['single-quoted', "  - variable: 'SHOPEE_TASKS_REGION'\n    value: fixture-region\n"],
    ['a space before the colon', '  - variable : SHOPEE_TASKS_REGION\n    value: fixture-region\n'],
    [
      'a folded block scalar',
      '  - variable: >-\n      SHOPEE_TASKS_REGION\n    value: fixture-region\n',
    ],
    [
      'a literal block scalar',
      '  - variable: |\n      SHOPEE_TASKS_REGION\n    value: fixture-region\n',
    ],
    [
      'a block-scalar header with a comment',
      '  - variable: >- # note\n      SHOPEE_TASKS_REGION\n    value: fixture-region\n',
    ],
    ['CRLF line ends', '  - variable: SHOPEE_TASKS_REGION\r\n    value: fixture-region\r\n'],
  ])('the row matcher catches %s', (_, row) => {
    expect(shopeeRegionRow(row)).toEqual({ live: false, withRow: true });
  });

  // The near-misses must stay distinct. A commented-out row sets nothing, and
  // the manifest's warning about this variable is all `#` lines, so a matcher
  // that read comments would red the live check the day that warning quotes the
  // row it forbids. A block scalar's body ends where its indentation does, so
  // the name in the next key's value is not the variable.
  it.each([
    ['a commented-out row', '  # - variable: SHOPEE_TASKS_REGION\n'],
    ['a longer variable name', '  - variable: SHOPEE_TASKS_REGION_OVERRIDE\n    value: x\n'],
    ['the name as another row value', '  - variable: OTHER_VAR\n    value: SHOPEE_TASKS_REGION\n'],
    [
      'a block-scalar row naming another variable',
      '  - variable: >-\n      OTHER_VAR\n    value: SHOPEE_TASKS_REGION\n',
    ],
    [
      'the name only in a block header comment',
      '  - variable: >- # SHOPEE_TASKS_REGION\n      OTHER_VAR\n    value: x\n',
    ],
  ])('the row matcher ignores %s', (_, row) => {
    expect(shopeeRegionRow(row)).toEqual({ live: false, withRow: false });
  });

  it('keeps the manifest wording where the manifest does hold the row', () => {
    // The near-miss: mercado-livre's manifest CARRIES its region row, so the
    // console-only branch must not leak into the other codebases' notes.
    const note = crossCheckNote('mercado-livre', 'us-east1');

    expect(note).toContain('Set it in apps/mercado-livre/apphosting.yaml (or the console)');
    expect(note).not.toContain('never in');
  });

  it('has no backend note for storage, which no backend enqueues', () => {
    // `processarBalanco` is enqueued by the finalizarBalanco callable and by
    // itself — both inside the codebase, so there is no second env to agree with.
    expect(CODEBASES.storage.backendVar).toBeNull();
    expect(crossCheckNote('storage', 'us-east1')).toBeNull();
  });

  it('has no backend note for loja-integrada until its App Hosting enqueuer exists', () => {
    // Step 3 enqueues only from inside the functions (the order poller), so there
    // is no `apphosting.yaml` row to cross-check. Step 4 adds the first App
    // Hosting enqueuer: it sets both values, moves this codebase into the
    // `it.each` above and deletes this test — a deliberate edit, not a drift.
    expect(CODEBASES['loja-integrada'].backendVar).toBeNull();
    expect(CODEBASES['loja-integrada'].backendManifest).toBeNull();
    expect(crossCheckNote('loja-integrada', 'us-east1')).toBeNull();
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
