import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CODEBASES } from './preflight.mjs';

/**
 * Repo invariant: every Cloud Functions bundle can be LOADED the way firebase-tools'
 * trigger analysis loads it, and declares at least one endpoint.
 *
 * WHY THIS EXISTS. A `firebase deploy --only functions:<codebase>` starts by
 * spawning the SDK's own `firebase-functions` bin inside the artifact, which
 * imports `index.js` and serialises every exported trigger. If that import throws,
 * nothing deploys — and nothing BEFORE the deploy ever imports the bundle:
 * typecheck and lint read the sources, vitest runs them unbundled, and
 * `bundle-inlining.test.js` builds every bundle but only reads it as text.
 *
 * It was broken exactly that way, for five weeks, in `nfe`. Its `build.mjs` did not
 * list `@google-cloud/firestore` as external, so the day the Simples apuração
 * runner started importing `@google-cloud/firestore/pipelines` (9b6785de3) the
 * bundle inlined the SDK — and with it google-gax, which reads `__dirname` at
 * module load. The output is ESM, where `__dirname` does not exist, so the artifact
 * threw `ReferenceError: __dirname is not defined in ES module scope` on import.
 * Every gate stayed green; the first signal would have been the next human deploy
 * failing at trigger analysis.
 *
 * So this suite builds each `CODEBASES` bundle and runs that same bin over it, with
 * the same `FUNCTIONS_MANIFEST_OUTPUT_PATH` contract firebase-tools uses. It is
 * offline: loading a bundle defines triggers, it does not reach any Google API.
 *
 * ⚠️ The bundle is written INSIDE the owning app's `node_modules/.cache/`, not in
 * the OS tmpdir. Its externals (`firebase-admin`, `firebase-functions`,
 * `@google-cloud/firestore`, …) are plain imports resolved by walking up from the
 * bundle's own directory, so a tmpdir bundle would fail to load for a reason the
 * deploy never has — and `prepare-deploy.mjs` solves the same problem with a
 * `node_modules` junction. `.cache` rather than `dist/` because builds wipe
 * `dist/`, and turbo may run one concurrently with this test.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');

/** Any real-looking region: loading only needs the build to accept it. */
const REGION = 'us-east1';

const codebases = Object.entries(CODEBASES);

/** Every region variable any codebase inlines without a default (`null` in the table). */
const regionVars = [
  ...new Set(
    codebases.flatMap(([, spec]) =>
      Object.entries(spec.inlined)
        .filter(([, fallback]) => fallback === null)
        .map(([name]) => name),
    ),
  ),
];

/**
 * The nearest ancestor of `dir` whose `node_modules` holds the Functions SDK — the
 * directory the deploy junction points at. For a nested codebase
 * (`apps/nfe/functions`) that is the parent app, which owns the install.
 */
function installRootOf(dir) {
  for (let d = dir; d !== dirname(d); d = dirname(d)) {
    if (existsSync(join(d, 'node_modules', 'firebase-functions', 'package.json'))) return d;
  }
  throw new Error(`no node_modules/firebase-functions above ${dir} — run \`pnpm install\``);
}

/** The SDK's own manifest bin, from its package.json — the one firebase-tools spawns. */
function functionsBin(installRoot) {
  const sdkDir = join(installRoot, 'node_modules', 'firebase-functions');
  const { bin } = JSON.parse(readFileSync(join(sdkDir, 'package.json'), 'utf8'));
  const rel = typeof bin === 'string' ? bin : bin['firebase-functions'];
  return join(sdkDir, rel);
}

/**
 * Run `script` under this Node and resolve with its exit status and stderr. Never
 * rejects on a non-zero exit — the status IS the assertion.
 */
function run(script, options) {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [script],
      { ...options, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        done({ status: error ? (error.code ?? 1) : 0, stderr: stderr || String(error ?? '') });
      },
    );
  });
}

/** The last lines of a child's stderr — the throw site, without 300 frames of bundle. */
function tail(text, lines = 12) {
  return text.trim().split(/\r?\n/).slice(-lines).join('\n');
}

const previous = {};

beforeAll(() => {
  for (const name of regionVars) {
    previous[name] = process.env[name];
    process.env[name] = REGION;
  }
});

afterAll(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe('every Cloud Functions bundle loads under firebase-tools trigger analysis', () => {
  it('covers every codebase in the preflight table', () => {
    // Anti-vacuous: `CODEBASES` is the source of the loop below. Eight today — if
    // it ever came back empty, every per-codebase case would vanish with it.
    expect(codebases.length).toBeGreaterThanOrEqual(8);
  });

  // ⚠️ Each case bundles up to ~6 MB with esbuild and then imports it in a child
  // Node process — ~10s apiece, 85s for the eight run one after another, hence
  // `concurrent`. The timeout is generous on purpose, like bundle-inlining's: it
  // is here to catch a hang, not to police build speed.
  it.concurrent.each(codebases)(
    '%s',
    async (codebase, spec) => {
      const buildScript = resolve(REPO_ROOT, spec.buildScript);
      const installRoot = installRootOf(dirname(buildScript));
      const cacheDir = join(installRoot, 'node_modules', '.cache');
      mkdirSync(cacheDir, { recursive: true });
      const outDir = mkdtempSync(join(cacheDir, `bundle-load-${codebase}-`));

      try {
        const { bundle } = await import(pathToFileURL(buildScript).href);
        await bundle(join(outDir, 'index.js'));
        // The fields of the artifact manifest the loader reads: ESM, entry point.
        writeFileSync(
          join(outDir, 'package.json'),
          JSON.stringify({ type: 'module', main: 'index.js' }) + '\n',
        );

        const manifestPath = join(outDir, 'functions.json');
        const child = await run(functionsBin(installRoot), {
          // ⚠️ cwd, not an argument: the bin ignores a lone directory argument
          // and loads `.`.
          cwd: outDir,
          env: {
            ...process.env,
            GCLOUD_PROJECT: 'demo-erp',
            FUNCTIONS_MANIFEST_OUTPUT_PATH: manifestPath,
          },
        });

        expect(
          child.status,
          [
            `${spec.buildScript}: the bundle does not load — \`firebase deploy\` would`,
            'fail at trigger analysis before deploying anything. A common cause is a',
            'dependency that should be EXTERNAL being inlined into the ESM bundle',
            '(`__dirname` / `require` at module scope); compare its `external` list',
            'with apps/shopee/functions/build.mjs.',
            '',
            tail(child.stderr),
          ].join('\n'),
        ).toBe(0);

        const { endpoints } = JSON.parse(readFileSync(manifestPath, 'utf8'));
        expect(
          Object.keys(endpoints ?? {}),
          `${spec.buildScript}: the bundle loads but declares no function`,
        ).not.toEqual([]);
      } finally {
        rmSync(outDir, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
