import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitGrep, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: a Next app that imports `@google-cloud/firestore` — the root entry
 * or ANY subpath — lists it in `serverExternalPackages` in its `next.config.ts`, and
 * declares it in its `package.json` `dependencies`.
 *
 * ## Why this needs a guard at all
 *
 * `firebase-admin` IS in Next 16's default `serverExternalPackages`
 * (`next/dist/lib/server-external-packages.jsonc`); `@google-cloud/firestore` is NOT.
 * So an app that takes its `Firestore` handle from `firebase-admin/firestore` and its
 * pipeline builders from `@google-cloud/firestore/pipelines` reaches ONE package
 * through TWO resolution paths, and the bundler instantiates it separately for each.
 *
 * Nothing about that is visible until a request runs. The Pipelines API overloads
 * every stage on `instanceof` (`build/src/pipelines/pipeline-util.js`):
 *
 *     function isExpr(val)        { return val instanceof expression_1.Expression; }
 *     function isAliasedExpr(val) { return val instanceof expression_1.AliasedExpression; }
 *
 * A cross-copy expression is therefore not REJECTED — `define()` / `select()` fall
 * through to the other overload, read `.variables` off an object that has none, and
 * hand `undefined` to `selectablesToMap`, whose `for (const selectable of selectables)`
 * throws `TypeError: selectables is not iterable`. V8 names the loop variable, so the
 * production log reports a word that appears nowhere in this repo and points at a
 * minified chunk.
 *
 * That is not theoretical. It 500'd every
 * `POST /api/marketplace/mercado-livre/enviar-estoque` on the deployed App Hosting
 * backend, and the pre-fix build embedded the SDK in TWO separate 2.0 MB server
 * chunks. With the entry in place the same build emits one plain `require()` that
 * resolves to the very directory `firebase-admin` resolves its own copy to, so Node's
 * module cache hands both sides one instance.
 *
 * ## Why nothing else catches it
 *
 * Three independent reasons, which is what makes it worth a file of its own:
 *   1. vitest runs unbundled — one module instance, so `instanceof` always holds;
 *   2. the Pipelines API does not run in the Firestore emulator (Standard edition),
 *      so every emulator lane drives these paths through test seams;
 *   3. the Cloud Functions codebases externalize the SDK in their OWN esbuild config
 *      (`apps/mercado-livre/functions/build.mjs`), so the identical source is correct
 *      there and wrong only under Next.
 * Build, typecheck, lint and the whole suite pass either way. The only signal is a
 * 500 in production.
 *
 * Same shape, and same reasoning, as `apphosting-next-pinned.test.js` and
 * `ai-root-entry-browser-safe.test.js`: an invariant that is stated, true today, and
 * completely invisible when violated — where the edit that breaks it (deleting a
 * config line that appears to do nothing) is the least suspicious edit in the file.
 *
 * A test rather than an ESLint rule because the invariant spans a source tree, a
 * `next.config.ts` and a `package.json`, and ESLint sees one file at a time. Failing
 * the test fails CI exactly like a lint error would.
 */

/**
 * Packages whose identity is load-bearing at RUNTIME — i.e. something checks
 * `instanceof` across the boundary — and which a Next app can reach through a second
 * resolution path because a default-external package already depends on them.
 *
 * One entry today; kept as a list, like `PINNED` in `runtime-deps-pinned.test.js` and
 * `SERVER_ONLY` in `ai-root-entry-browser-safe.test.js`, so extending it is one line.
 */
const HAZARD_PACKAGES = ['@google-cloud/firestore'];

/**
 * The Next apps that exist today. Discovery below is a glob keyed on the PRESENCE of
 * `next.config.ts`, so a new app is covered the day its config lands and does not need
 * adding here; this list exists only as an anchor, so a glob that silently stops
 * matching fails loudly instead of vacuously passing over an empty set.
 *
 * `apps/functions`, `apps/docs` and `apps/example` are deliberately absent — none is a
 * Next app, so none has a `next.config.ts` and none is bundled by `next build`.
 * `apps/functions/src/estoques/aplicarBalanco.ts` DOES import the pipelines subpath and
 * is correctly out of scope: its esbuild config externalizes the SDK.
 */
const KNOWN_NEXT_APPS = [
  'apps/integrations',
  'apps/melhor-envio',
  'apps/mercado-livre',
  'apps/mercado-pago',
  'apps/nfe',
  'apps/web',
  'apps/webchat',
  'apps/whatsapp',
];

/**
 * The importers that exist today, per hazard package. If a scan ever comes back empty
 * the assertions below are vacuous — they would pass over nothing while the bug they
 * exist for shipped. Mirrors `ai-root-entry-browser-safe.test.js`'s "the walk actually
 * reaches the modules it is meant to police".
 */
const KNOWN_IMPORTERS = {
  '@google-cloud/firestore': ['apps/mercado-livre'],
};

// Scope of the import scan, as git pathspecs. Two exclusions, each for a build that is
// NOT `next build`:
//
//   - the nested Cloud Functions codebases under an app (one directory level down,
//     named `functions`) are esbuild sub-builds that already mark the SDK external;
//   - `.test.ts` files are vitest's, never bundled — this is what keeps
//     `bulkEstoquePlan.test.ts`'s `vi.mock('@google-cloud/firestore/pipelines', …)`
//     from being read as an import.
//
// Everything else under an app IS in scope, including `scripts/`. Those are standalone
// tsx/node CLIs that `next build` never traces, so keeping them in over-includes — but
// the remedy for a false positive is one inert line of config, and the remedy for a
// false negative is a 500 in production. Over-inclusion is the safe direction.
//
// `apps/functions` (the storage Cloud Functions codebase) is NOT excluded here and does
// not need to be: it has no `next.config.ts`, so the bucketing below drops it.
//
// ⚠️ The `:(glob)` prefix is load-bearing. Git has two pathspec dialects: the default
// matches without `WM_PATHNAME`, so a bare `*` crosses `/`; `:(glob)` sets it, so `*`
// stops at `/` and only `**` crosses. Both exclusions are written in the glob dialect
// and must stay that way — see the longer note in `runtime-deps-pinned.test.js`. (The
// globs are assembled from fragments below for a dull reason: writing the literal
// star-slash sequence inline would close a block comment, which is why this note is a
// line comment.)
const SCAN_PATHSPECS = [
  ':(glob)apps/**',
  `:(exclude,glob)apps/*/functions/${'**'}`,
  `:(exclude,glob)apps/${'**'}/*.test.ts`,
];

/** Escape a package name for use inside a POSIX extended regular expression. */
function escapeEre(name) {
  return name.replace(/[.[\]{}()*+?^$|\\]/g, '\\$&');
}

/**
 * `import … from 'pkg'`, `import 'pkg'`, `import('pkg')`, `require('pkg')` — for the
 * package itself or any subpath of it.
 *
 * ⚠️ `[[:space:]]`, not `\s`. Git's `-E` is POSIX ERE and the bracket expression is the
 * portable spelling; these guards are expected to pass on Windows checkouts too.
 */
function importPattern(pkg) {
  return `(from|import|require)[[:space:]]*\\(?[[:space:]]*['"]${escapeEre(pkg)}(/[^'"]*)?['"]`;
}

/** `apps/<name>/…` → `apps/<name>`, or null for anything shallower. */
function appOf(relPath) {
  const parts = relPath.split('/');
  return parts.length > 2 && parts[0] === 'apps' ? `${parts[0]}/${parts[1]}` : null;
}

function findNextApps() {
  return gitLsFiles(':(glob)apps/*/next.config.ts').map((p) =>
    p.replace(/\/next\.config\.ts$/, ''),
  );
}

/**
 * `{ 'apps/x': ['apps/x/lib/a.ts', …] }` — every Next app whose bundled source imports
 * `pkg`, with the files that do. One `git grep` per package, memoized by `repo-scan`, so
 * the offender messages can name the package they are actually about.
 */
function findImporters(pkg) {
  const nextApps = new Set(findNextApps());
  const hits = gitGrep({
    patterns: importPattern(pkg),
    pathspecs: SCAN_PATHSPECS,
    mode: 'extended',
  });

  const byApp = new Map();
  for (const file of hits) {
    const app = appOf(file);
    // A hit outside a Next app is correct and expected — apps/functions imports the
    // pipelines subpath and externalizes it in its own esbuild config.
    if (app === null || !nextApps.has(app)) continue;
    if (!byApp.has(app)) byApp.set(app, []);
    byApp.get(app).push(file);
  }
  return byApp;
}

/**
 * The strings inside a config's `serverExternalPackages: [...]` array literal, or null
 * when the file has no such key or does not spell it as an inline literal.
 *
 * A shape regex rather than a TS parse — the standing convention in this directory is
 * to reach for git/regex instead of a new dependency (`catalogSpec` in both precedents
 * does the same to YAML). The entries are string literals, so there is no nested `]` to
 * confuse the non-greedy class.
 */
function serverExternalPackages(app) {
  const source = readFileSync(resolve(REPO_ROOT, app, 'next.config.ts'), 'utf8');
  const block = source.match(/serverExternalPackages\s*:\s*\[([^\]]*)\]/);
  if (block === null) return null;
  return [...block[1].matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
}

function manifest(app) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, app, 'package.json'), 'utf8'));
}

const WHY = [
  'Why: `firebase-admin` is in Next`s DEFAULT serverExternalPackages and this package',
  'is not, so bundling it gives the two sides a SEPARATE module instance each. Every',
  'Pipelines API stage overloads on `instanceof`, so the mismatch is not rejected — it',
  'is reinterpreted as an options object and the request dies at runtime with',
  '`TypeError: selectables is not iterable`. Build, typecheck, lint and vitest all pass.',
].join('\n');

describe('Next apps keep the Firestore SDK external', () => {
  it('finds every known Next app', () => {
    // Anchor for the glob. If this fails, the pathspec stopped matching and every other
    // assertion in this file is passing over an empty set.
    const found = new Set(findNextApps());
    const missing = KNOWN_NEXT_APPS.filter((p) => !found.has(p));
    expect(
      missing,
      [
        'These Next apps were not found by the git pathspec. Either they moved (update',
        'KNOWN_NEXT_APPS) or `:(glob)apps/*/next.config.ts` no longer matches them — in',
        'which case this whole guard silently stopped checking anything:',
        ...missing.map((p) => `  - ${p}/next.config.ts`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('the import scan still reaches the apps it is meant to police', () => {
    // Guards the guard. A pathspec or pattern that matched nothing would make both
    // assertions below vacuously true, and this file would keep passing while checking
    // nothing at all.
    const missing = [];
    for (const pkg of HAZARD_PACKAGES) {
      const importers = findImporters(pkg);
      for (const app of KNOWN_IMPORTERS[pkg] ?? []) {
        if (!importers.has(app)) missing.push(`${app} → no longer imports \`${pkg}\``);
      }
    }
    expect(
      missing,
      [
        'The import scan no longer sees these apps importing a hazard package.',
        'If the import genuinely moved or went away, update KNOWN_IMPORTERS in the same',
        'commit. Otherwise SCAN_PATHSPECS or importPattern() stopped matching, and the',
        'assertions below are now vacuous:',
        ...missing.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('every importing Next app lists the package in serverExternalPackages', () => {
    const offenders = [];

    for (const pkg of HAZARD_PACKAGES) {
      for (const [app, files] of findImporters(pkg)) {
        const declared = serverExternalPackages(app);
        if (declared === null) {
          offenders.push(
            `${app}/next.config.ts → no inline \`serverExternalPackages: [...]\` array ` +
              `(needs \`${pkg}\`; imported by ${files[0]})`,
          );
        } else if (!declared.includes(pkg)) {
          offenders.push(
            `${app}/next.config.ts → \`serverExternalPackages\` is missing \`${pkg}\` ` +
              `(imported by ${files[0]})`,
          );
        }
      }
    }

    expect(
      offenders,
      [
        'A Next app that imports one of these packages must keep it OUT of the bundle:',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        WHY,
        '',
        'Fix: add it to `serverExternalPackages` in that app`s next.config.ts, as an',
        'inline array literal (apps/nfe/next.config.ts and apps/mercado-livre/next.config.ts',
        'are the precedents). Next merges the entry with its own defaults, so',
        '`firebase-admin` stays external too.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('every importing Next app declares the package in dependencies', () => {
    // Without this, an app could externalize a package it does not depend on and the
    // assertion above would still pass — while the deployed runtime failed to resolve
    // it. An externalized package is a plain `require()` at runtime, so it has to be
    // installable: same reasoning as `runtime-deps-pinned.test.js`'s "declares both
    // SDKs in every artifact manifest".
    const offenders = [];

    for (const pkg of HAZARD_PACKAGES) {
      for (const [app, files] of findImporters(pkg)) {
        const deps = manifest(app).dependencies ?? {};
        if (!(pkg in deps)) {
          offenders.push(`${app}/package.json → missing \`${pkg}\` (imported by ${files[0]})`);
        }
      }
    }

    expect(
      offenders,
      [
        'An externalized package is emitted as a plain `require()` and resolved from',
        'node_modules at runtime, so it must be a real `dependencies` entry of the app —',
        'reaching it as an undeclared transitive dep of firebase-admin is exactly the',
        'second resolution path this guard exists to prevent:',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
