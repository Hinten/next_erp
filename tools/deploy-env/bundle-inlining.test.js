import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CODEBASES } from './preflight.mjs';

/**
 * Repo invariant: a region that `build.mjs` `define`s must actually reach the
 * BUNDLE as a literal — including inside the enqueuers, not just `options.ts`.
 *
 * WHY THIS EXISTS. esbuild's `define` substitutes a **static member expression**
 * (`process.env.FUNCTIONS_REGION`) and nothing else. That makes the invariant
 * depend on the SHAPE of the read, which is invisible at every call site and
 * survives typecheck, lint and the whole test suite.
 *
 * It was broken exactly once, by the change that introduced `requireRegion`: the
 * first version took `(names, process.env)` and indexed the env dynamically. Every
 * enqueuer compiled to a live `process.env` read, the deploy artifact ships no
 * `.env`, and gen2/Cloud Run exposes no region variable — so post-deploy every
 * enqueue would have thrown `MissingRegionError`: `finalizarBalanco` →
 * `processarBalanco`, `onProdutoChanged` → `recalcularDimensoesKit`, and the whole
 * Mercado Livre fan-out.
 *
 * ⚠️ **No other check could have caught it.** The emulator lanes set the region in
 * the job `env:` and `emulators:exec` inherits the shell, so the dynamic read
 * resolved there and would have failed only in the cloud — the same "green in CI,
 * broken in production" shape the region work exists to remove. Reading the built
 * artifact is the only evidence that the substitution happened.
 *
 * ⚠️ The assertion has to target the CALL SITES, not the bundle as a whole. The
 * first version of this guard asserted "the value appears somewhere and
 * `process.env.X` appears nowhere" — and a mutation test proved it useless:
 * `options.ts` reads the variable statically and always gets the literal, so the
 * value is present even when every enqueuer reads dynamically. It reproduced the
 * original bug's own blind spot. So instead: every `requireRegion(` in the built
 * bundle must be an object literal, and every defined region key inside one must
 * carry a quoted literal rather than a live read.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/** Unlikely to collide with anything esbuild emits, and obvious in a failure. */
const SENTINEL = 'sentinel-region-42';

/**
 * The region variables each codebase inlines, taken from the preflight's own
 * table: a `null` default there means "region, no default" (see its ⚠️). Deriving
 * them keeps this guard from drifting away from what the builds actually define.
 */
function regionVarsOf(spec) {
  return Object.entries(spec.inlined)
    .filter(([, fallback]) => fallback === null)
    .map(([name]) => name);
}

const codebases = Object.entries(CODEBASES);

/**
 * CALLS to `requireRegion`, never its declaration — the bundled `@delfrance/core`
 * module contributes `function requireRegion(candidates) {`, which would otherwise
 * be counted and reported as a non-literal call.
 */
const CALL = /(?<!function )requireRegion\(\s*/g;

describe('build.mjs inlines the region into the bundle, not just options.ts', () => {
  it('every codebase inlines its region at every requireRegion call site', async () => {
    // ⚠️ Only the codebases that BUNDLE an enqueuer can be checked. mercado-pago
    // and whatsapp keep theirs in the Next app (`lib/…`), whose region comes from
    // apphosting.yaml at runtime rather than from a `define` — their functions
    // bundle legitimately contains no call. So the anti-vacuous assertion is on
    // the TOTAL below, not per codebase.
    let callsChecked = 0;
    const offenders = [];

    for (const [codebase, spec] of codebases) {
      const regionVars = regionVarsOf(spec);
      const env = Object.fromEntries(regionVars.map((name, i) => [name, `${SENTINEL}-${i}`]));

      const previous = {};
      for (const [name, value] of Object.entries(env)) {
        previous[name] = process.env[name];
        process.env[name] = value;
      }

      const outDir = mkdtempSync(join(tmpdir(), 'region-inlining-'));
      const outfile = join(outDir, 'index.js');
      try {
        const { bundle } = await import(
          `file://${resolve(REPO_ROOT, spec.buildScript).replace(/\\/g, '/')}`
        );
        await bundle(outfile);
        const built = readFileSync(outfile, 'utf8');

        // 1. Every call must be an object literal. The dynamic-env shape that
        //    broke this — `requireRegion(names, process.env)`, or anything
        //    computing the object — is not one, and `define` cannot see inside it.
        for (const m of built.matchAll(CALL)) {
          callsChecked += 1;
          if (built[m.index + m[0].length] !== '{') {
            offenders.push(
              `${codebase}: a requireRegion call is not an object literal — ` +
                '`define` cannot substitute inside a computed argument',
            );
          }
        }

        // 2. Inside those literals, a DEFINED region must be a quoted literal. A
        //    surviving read resolves to undefined in the cloud, where the artifact
        //    ships no `.env` and Cloud Run exposes no region variable.
        for (const name of regionVars) {
          for (const _ of built.matchAll(new RegExp(`${name}:\\s*process\\.env`, 'g'))) {
            offenders.push(
              `${codebase}: \`${name}\` is still read at runtime inside a ` +
                'requireRegion call — the build did not inline it there',
            );
          }
          if (!built.includes(env[name])) {
            offenders.push(
              `${codebase}: ${spec.buildScript} defines ${name}, but its value ` +
                'never reaches the bundle at all — check the `define` map',
            );
          }
        }
      } finally {
        rmSync(outDir, { recursive: true, force: true });
        for (const [name, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[name];
          else process.env[name] = value;
        }
      }
    }

    expect(
      offenders,
      [
        'esbuild `define` only substitutes a STATIC member expression, so the',
        'region reaches the bundle only when each call site is written',
        '`requireRegion({ VAR: process.env.VAR })`. Where it does not, the read',
        'stays live — and resolves to undefined after a deploy, so every enqueue',
        'throws while CI stays green (the emulator lanes have the variable in the',
        'shell).',
        '',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);

    // Anti-vacuous: if the enqueuers stop being bundled, or the call is renamed,
    // every loop above iterates nothing and this suite passes having built five
    // bundles and checked none of them.
    expect(
      callsChecked,
      'No requireRegion call was found in ANY functions bundle. Either the ' +
        'enqueuers left those codebases or the call was renamed — either way this ' +
        'guard is no longer checking anything.',
    ).toBeGreaterThan(0);
  });
});
