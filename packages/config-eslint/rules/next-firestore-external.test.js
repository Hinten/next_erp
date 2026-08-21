import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitGrep, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: a Next app whose BUNDLE can reach `@google-cloud/firestore` — the root
 * entry or ANY subpath, imported by the app itself or by any workspace package it pulls
 * in — lists it in `serverExternalPackages` in its `next.config.ts`, and declares it in
 * its `package.json` `dependencies`.
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

/**
 * A dependency edge that must survive, so the workspace-closure walk cannot silently
 * degenerate to "the app's own source" and re-open the gap it exists to close.
 *
 * `@delfrance/data` is the load-bearing one: it is the shared Firestore layer, six of
 * the eight Next apps bundle it, and it is where an admin-SDK pipelines import would
 * most plausibly land. `@delfrance/core` is reached only THROUGH it, so it also proves
 * the walk is transitive rather than one level deep.
 */
const KNOWN_CLOSURE = {
  'apps/mercado-livre': ['packages/data', 'packages/schemas', 'packages/core'],
};

// Scope of the import scan, as git pathspecs.
//
// ⚠️ `packages/` is in scope as well as `apps/`, and that is the whole reason the
// dependency walk below exists. A Next app bundles its workspace dependencies — that is
// what `transpilePackages` asks for, and it is the default for anything not externalized
// — so an `@google-cloud/firestore` import landing in `packages/data/src/admin/**` puts
// the SDK in the bundle of EVERY backend importing it, while `firebase-admin` stays
// external: the identical double-instance failure, arriving through a file no app owns.
// Six of the eight Next apps bundle `@delfrance/data` today and five of them have no
// `serverExternalPackages` key at all, so an `apps/`-only scan would report a clean
// green for all of them. Root `CLAUDE.md` already advertises the Pipelines API as "used
// in `packages/data`" — the client SDK there today (`firebase/firestore/pipelines`, a
// different package, correctly not matched), but the admin one is one import away.
//
// Three exclusions, each for something `next build` does not bundle:
//
//   - the nested Cloud Functions codebases under an app (one directory level down,
//     named `functions`) are esbuild sub-builds that already mark the SDK external;
//   - test files are vitest's — this is what keeps `bulkEstoquePlan.test.ts`'s
//     `vi.mock('@google-cloud/firestore/pipelines', …)` from being read as an import,
//     and this file's own `HAZARD_PACKAGES` literal from matching itself;
//   - `packages/config-eslint/rules/` needs no separate exclusion: every file in it is
//     a test file already covered above.
//
// Everything else is in scope, including `scripts/`. Those are standalone tsx/node CLIs
// that `next build` never traces, so keeping them in over-includes — but the remedy for
// a false positive is one inert line of config, and the remedy for a false negative is a
// 500 in production. Over-inclusion is the safe direction.
//
// `apps/functions` (the storage Cloud Functions codebase) is NOT excluded here and does
// not need to be: it has no `next.config.ts`, so it is not a Next app, and nothing
// depends on it — so no app's closure reaches it.
//
// ⚠️ The `:(glob)` prefix is load-bearing. Git has two pathspec dialects: the default
// matches without `WM_PATHNAME`, so a bare `*` crosses `/`; `:(glob)` sets it, so `*`
// stops at `/` and only `**` crosses. Every entry is written in the glob dialect and
// must stay that way — see the longer note in `runtime-deps-pinned.test.js`. (The globs
// are assembled from fragments for a dull reason: writing the literal star-slash
// sequence inline would close a block comment, which is why this note is a line
// comment.)
const SCAN_PATHSPECS = [
  ':(glob)apps/**',
  ':(glob)packages/**',
  `:(exclude,glob)apps/*/functions/${'**'}`,
  `:(exclude,glob)${'**'}/*.test.ts`,
  `:(exclude,glob)${'**'}/*.test.tsx`,
  `:(exclude,glob)${'**'}/*.test.js`,
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

function findNextApps() {
  return gitLsFiles(':(glob)apps/*/next.config.ts').map((p) =>
    p.replace(/\/next\.config\.ts$/, ''),
  );
}

/** `{ '@delfrance/data' → 'packages/data' }` for every workspace member. */
function workspaceMembers() {
  const out = new Map();
  for (const relPath of gitLsFiles([
    ':(glob)apps/*/package.json',
    `:(glob)packages/${'**'}/package.json`,
  ])) {
    const { name } = JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
    if (typeof name === 'string') out.set(name, relPath.replace(/\/package\.json$/, ''));
  }
  return out;
}

/**
 * The workspace member directory a file belongs to — the LONGEST member dir that is a
 * path prefix of it — or null when it belongs to none.
 *
 * Longest, not first: `packages/integrations/mercado-livre` and a hypothetical
 * `packages/integrations` would both prefix-match a file in the former, and only the
 * deeper one is the package that actually declares the dependency.
 */
function memberDirOf(relPath, memberDirs) {
  const parts = relPath.split('/');
  for (let i = parts.length - 1; i > 0; i -= 1) {
    const candidate = parts.slice(0, i).join('/');
    if (memberDirs.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Every workspace member a Next app's bundle can reach — the transitive closure of its
 * `dependencies`, which is the block whose contents `next build` traces and bundles.
 *
 * ⚠️ `dependencies` only, deliberately. A `devDependency` is not part of the shipped
 * graph, so including it would flag an app for a hazard its bundle never contains — and
 * every workspace member devDepends on `@delfrance/config-eslint`, i.e. on THIS file's
 * package, which would make the closure meaningless.
 */
function bundledMembers(appDir, members) {
  const seen = new Set();
  const queue = [appDir];
  while (queue.length > 0) {
    const dir = queue.pop();
    const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, dir, 'package.json'), 'utf8'));
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const depDir = members.get(name);
      if (depDir === undefined || seen.has(depDir)) continue;
      seen.add(depDir);
      queue.push(depDir);
    }
  }
  return seen;
}

/**
 * `{ 'apps/x': ['apps/x/lib/a.ts', 'packages/data/src/b.ts', …] }` — every Next app
 * whose BUNDLE can reach `pkg`, with the importing files, whether they sit in the app
 * itself or in a workspace package the app pulls in. One `git grep` per hazard package,
 * memoized by `repo-scan`, so offender messages can name the package they are about.
 */
function findImporters(pkg) {
  const members = workspaceMembers();
  const memberDirs = new Set(members.values());

  // Importing files, grouped by the workspace member that owns them.
  const filesByMember = new Map();
  for (const file of gitGrep({
    patterns: importPattern(pkg),
    pathspecs: SCAN_PATHSPECS,
    mode: 'extended',
  })) {
    const dir = memberDirOf(file, memberDirs);
    if (dir === null) continue;
    if (!filesByMember.has(dir)) filesByMember.set(dir, []);
    filesByMember.get(dir).push(file);
  }

  const byApp = new Map();
  for (const app of findNextApps()) {
    // The app's own source, plus everything it bundles. A hit owned by a member no Next
    // app reaches is correct and expected — `apps/functions` imports the pipelines
    // subpath and externalizes it in its own esbuild config.
    const reachable = [app, ...bundledMembers(app, members)];
    const files = reachable.flatMap((dir) => filesByMember.get(dir) ?? []);
    if (files.length > 0) byApp.set(app, files);
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

  it('the workspace dependency walk still resolves, and transitively', () => {
    // Guards the half of the scan that no app owns. If `bundledMembers` ever returned an
    // empty set — a renamed manifest field, a `workspace:*` spec that stopped resolving,
    // a members map keyed on the wrong string — the guard would quietly narrow back to
    // "the app's own source" and a hazard import landing in `packages/data` would be
    // invisible again, which is the exact gap this walk exists to close.
    const members = workspaceMembers();
    const missing = [];
    for (const [app, expected] of Object.entries(KNOWN_CLOSURE)) {
      const closure = bundledMembers(app, members);
      for (const dep of expected) {
        if (!closure.has(dep)) missing.push(`${app} → no longer bundles ${dep}`);
      }
    }
    expect(
      missing,
      [
        'The workspace closure no longer contains these edges. If the dependency really',
        'was dropped, update KNOWN_CLOSURE in the same commit. Otherwise the walk broke,',
        'and the scan has silently narrowed to each app`s own source — a hazard import in',
        'a shared package would no longer be seen by any of the assertions below:',
        ...missing.map((p) => `  - ${p}`),
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
