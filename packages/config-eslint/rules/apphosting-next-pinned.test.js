import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT, gitLsFiles } from './lib/repo-scan.js';

/**
 * Repo invariant: every app with an `apphosting.yaml` declares `next` as an EXACT
 * literal version in `dependencies` — never `catalog:`, never a `^`/`~` range — and
 * that version equals the `pnpm-workspace.yaml` catalog's.
 *
 * Why this needs a guard at all. Firebase App Hosting builds these apps with the GCP
 * buildpack `google.nodejs.firebasenextjs`, which computes `FRAMEWORK_VERSION` as
 * `nodejs.Version(nodeDeps, "next")` — a LOCKFILE read that does **not** understand
 * `pnpm-lock.yaml`. On that failure it silently falls back to
 * `nodeDeps.PackageJSON.Dependencies["next"]`, i.e. the RAW manifest string.
 * `@apphosting/adapter-nextjs` then feeds that string to
 * `semver.satisfies(spec, SAFE_NEXTJS_VERSIONS)`, and `Range.test` returns `false` for
 * anything it cannot parse as a *version* — so `catalog:` AND `^16.2.6` both fail. The
 * deploy dies at build time with
 *
 *   Error: CVE-2025-55182: Vulnerable Next version catalog: detected. Deployment blocked.
 *
 * which is a **false positive** — this repo is on a patched line — but it is unfixable
 * from the outside: the buildpack `Override`s `FRAMEWORK_VERSION` *after* computing it,
 * so setting the var in `apphosting.yaml` does nothing, and `apphosting.yaml` has no
 * build-root/build-command knob to point at a `pnpm deploy` artifact. The manifest is
 * the only surface we control.
 *
 * That is not theoretical, and this is the SECOND time. PR #410 (`c667bdf0`, 2026-07-03)
 * hit exactly this wall with `^16.2.6` and fixed it with exact literals; the pnpm catalog
 * migration (`ea8910c5`, 2026-07-21) replaced them with `catalog:` and re-broke every
 * backend. The reason lived only in a commit message, so nothing failed until a human
 * tried to deploy months later. This file is that missing signal.
 *
 * Same rule, and same reasoning, as `runtime-deps-pinned.test.js`: an **external
 * resolver reads the manifest without our lockfile or workspace context**. It is a
 * separate file rather than a `PINNED` entry there because the file sets are disjoint
 * (the app manifests here vs the nested `functions` ones there) and none of that guard's
 * five artifact manifests contains `next` at all. (Spelled out in prose for a dull
 * reason: the literal star-slash sequence in those globs would CLOSE this comment — the
 * same trap `runtime-deps-pinned.test.js` calls out.)
 *
 * This is a test rather than an ESLint rule because the invariant spans several files
 * and compares them against a YAML file, which ESLint (one JS/TS file at a time) never
 * sees. Failing the test fails CI exactly like a lint error would.
 */

/**
 * The App Hosting backends that exist today. Discovery below is a glob keyed on the
 * PRESENCE of `apphosting.yaml`, so a new backend is covered the day its config lands
 * and does not need adding here; this list exists only as an anchor, so a glob that
 * silently stops matching fails loudly instead of vacuously passing over an empty set.
 *
 * `apps/webchat` is deliberately absent — it is a static export served by classic
 * Firebase Hosting (`firebase.json`), has no `apphosting.yaml`, and never touches this
 * buildpack. If it ever gains one, the glob pulls it in and this guard demands the pin
 * BEFORE the deploy fails, which is the whole point of keying on the config file.
 */
const KNOWN_APPHOSTING_APPS = [
  'apps/integrations',
  'apps/melhor-envio',
  'apps/mercado-livre',
  'apps/mercado-pago',
  'apps/nfe',
  'apps/shopee',
  'apps/web',
  'apps/whatsapp',
];

/**
 * The manifests that must KEEP `next: "catalog:"`. With `cleanupUnusedCatalogs: true`,
 * pnpm deletes a catalog entry that zero workspace projects reference — so if every
 * manifest went literal, the next `pnpm install` would silently drop `next: 16.2.6`
 * from `pnpm-workspace.yaml` and the catalog-agreement assertion below would have
 * nothing left to compare against. Neither of these is read by any buildpack:
 * `apps/webchat` is a static export, `packages/ui` is a library devDependency.
 */
const CATALOG_KEEPERS = [
  { manifest: 'apps/webchat/package.json', field: 'dependencies' },
  { manifest: 'packages/ui/package.json', field: 'devDependencies' },
];

/**
 * Exact STABLE semver — no `^`, `~`, `x`, range, `catalog:`, `workspace:*` or URL, and
 * additionally no prerelease/build metadata.
 *
 * ⚠️ Deliberately STRICTER than `runtime-deps-pinned.test.js`'s `EXACT_SEMVER`, which
 * admits `-rc.1`/`+build`. That guard only needs a spec the cloud `npm install` can
 * resolve, and a prerelease qualifies. Here the spec is additionally judged by
 * `checkNextJSVersion`, which routes prereleases down a DIFFERENT branch:
 *
 *     const baseVersion = isPrerelease ? semVer.coerce(version)?.version : null;
 *     const isSafe = satisfies(version, SAFE_NEXTJS_VERSIONS)
 *       || (baseVersion && satisfies(baseVersion, STRICTLY_SAFE_NEXTJS_VERSIONS));
 *
 * A prerelease never satisfies `SAFE_NEXTJS_VERSIONS` (semver only matches a prerelease
 * against a comparator carrying one), so it is decided by its COERCED base against
 * `STRICTLY_SAFE_NEXTJS_VERSIONS` — a range sitting one patch HIGHER on every backport
 * line (`~16.0.8` vs `~16.0.7`, `~15.5.8` vs `~15.5.7`, …). So `16.0.7` deploys and
 * `16.0.7-canary.1` does NOT, and CVE_FLOOR below models only the stable path. Rather
 * than encode a second, higher floor for a case this repo has never used, reject
 * prereleases outright: it keeps the floor honest instead of silently optimistic.
 * (It also keeps the floor's `Number()` parse total — `'6-canary'` is `NaN`.)
 */
const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * The floor of the branch this repo is on, from `@apphosting/adapter-nextjs`'s
 * `SAFE_NEXTJS_VERSIONS` (`>=16.1.0 || ~16.0.7 || ~v15.5.7 || …`). Once the pin above is
 * a parseable version the adapter's CVE gate starts working CORRECTLY, which means a
 * downgrade below the patched line would block the deploy for real — in the cloud, with
 * the same opaque message that cost a full investigation twice. This moves that
 * discovery into CI.
 *
 * ⚠️ Deliberately NOT a copy of the upstream range: those are several disjoint backport
 * branches on a moving target, and `packages/config-eslint` has no `semver` dependency
 * (this directory's standing convention is to reach for git/regex, not a new dep). It is
 * a floor for the 16.x line, NOT a general safety oracle. If you deliberately move to a
 * 15.x or 16.0.x backport line, consult `SAFE_NEXTJS_VERSIONS` — do not widen this.
 */
const CVE_FLOOR = [16, 1, 0];

/**
 * Ask git rather than walking the filesystem — same reasoning as
 * `runtime-deps-pinned.test.js`: a walk needs a skip-list, and the directories it must
 * skip (`node_modules`, `.deploy/`, the gitignored `.old/` Flutter reference,
 * `.claude/worktrees` checkouts) are exactly the ones that produce false positives. The
 * `--others` pass catches a new backend before it is committed.
 *
 * ⚠️ The `:(glob)` prefix is load-bearing here in the OPPOSITE direction to the one
 * `runtime-deps-pinned.test.js` warns about. Git has two pathspec dialects: the default
 * matches without `WM_PATHNAME`, so a bare `*` DOES cross `/`; `:(glob)` sets it, so `*`
 * stops at `/`. We want it to stop — `:(glob)apps/` + `*` + `/apphosting.yaml` matches
 * exactly one directory level. Drop the prefix and `*` starts crossing `/`, which is how
 * a sibling guard would begin dragging `apps/<channel>/functions/` into a scope where
 * `next` is absent by design.
 *
 * git emits forward slashes on every platform, including Windows. Compare the results as
 * RAW STRINGS — running them through `path.join`/`resolve` first would back-slash them
 * on Windows and red every assertion locally while staying green in CI.
 */
function findApphostingApps() {
  return gitLsFiles(':(glob)apps/*/apphosting.yaml').map((p) =>
    p.replace(/\/apphosting\.yaml$/, ''),
  );
}

/**
 * Read one spec out of the `pnpm-workspace.yaml` catalog.
 *
 * A line-anchored regex, not a YAML parse — the precedent in this directory is to reach
 * for `git` rather than add a dependency. ⚠️ The `$` anchor is why the explanatory
 * comment above `next:` in `pnpm-workspace.yaml` sits on its OWN lines: a trailing
 * `# …` on the entry itself would break this read and fail the suite for the wrong
 * reason.
 */
function catalogSpec(name) {
  const yaml = readFileSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = yaml.match(new RegExp(`^ {2}'?${escaped}'?: *(\\S+)$`, 'm'));
  return match?.[1];
}

function manifest(relPath) {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
}

const FIX = [
  'Fix: `next` propagates by COPY, not by reference. Bump `pnpm-workspace.yaml`s catalog',
  'AND every one of these manifests in the same commit, then run `pnpm install`:',
  ...KNOWN_APPHOSTING_APPS.map((p) => `  - ${p}/package.json`),
  '',
  '⚠️ Do NOT bump with `pnpm add`: under `catalogMode: strict` it rewrites the spec back',
  'to `catalog:`, which is the exact string that blocks the deploy.',
].join('\n');

describe('App Hosting apps pin next to an exact literal version', () => {
  it('finds every known App Hosting backend', () => {
    // Anchor for the glob. If this fails, the pathspec above stopped matching and every
    // other assertion in this file is passing over an empty set.
    const found = new Set(findApphostingApps());
    const missing = KNOWN_APPHOSTING_APPS.filter((p) => !found.has(p));
    expect(
      missing,
      [
        'These App Hosting backends were not found by the git pathspec.',
        'Either they moved (update KNOWN_APPHOSTING_APPS) or the pathspec',
        '`:(glob)apps/*/apphosting.yaml` no longer matches them — in which case this',
        'whole guard silently stopped checking anything:',
        ...missing.map((p) => `  - ${p}/apphosting.yaml`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('the catalog still pins next exactly', () => {
    const spec = catalogSpec('next');
    expect(
      spec,
      [
        '`next` is missing from the pnpm-workspace.yaml catalog. Two ways that happens:',
        '  1. `cleanupUnusedCatalogs: true` deleted it because no manifest references',
        '     `catalog:` for next any more — see the keeper test below;',
        '  2. a trailing `# comment` was added on the `next:` line itself, which breaks',
        '     this file`s line-anchored read (keep comments on their own lines).',
      ].join('\n'),
    ).toBeDefined();
    expect(
      EXACT_SEMVER.test(spec),
      `pnpm-workspace.yaml catalog has \`next: ${spec}\` — must be an exact version.\n${FIX}`,
    ).toBe(true);
  });

  it('the pinned version clears the App Hosting CVE floor', () => {
    const spec = catalogSpec('next');
    // Guard the read BEFORE splitting: a missing catalog entry (cleanupUnusedCatalogs,
    // or a trailing comment breaking the line-anchored regex) would otherwise throw a
    // bare TypeError here and bury the actionable message the previous test prints.
    expect(
      spec,
      '`next` is missing from the pnpm-workspace.yaml catalog — see the catalog test above ' +
        'for the two ways that happens. Fix that first; this floor check depends on it.',
    ).toBeDefined();
    const parts = spec.split('.').map(Number);
    const [major, minor] = parts;
    const clears = major > CVE_FLOOR[0] || (major === CVE_FLOOR[0] && minor >= CVE_FLOOR[1]);
    expect(
      clears,
      [
        `\`next: ${spec}\` is below the ${CVE_FLOOR.join('.')} floor of the 16.x line.`,
        'Once the spec is a parseable version, `@apphosting/adapter-nextjs`s',
        '`checkNextJSVersion` gate works correctly — and would block the deploy for real',
        'with `CVE-2025-55182: Vulnerable Next version … detected`.',
        'This floor covers the 16.x line ONLY. If you are deliberately moving to a 15.x or',
        '16.0.x backport, check it against the adapter`s SAFE_NEXTJS_VERSIONS first.',
      ].join('\n'),
    ).toBe(true);
  });

  it('declares next in dependencies in every App Hosting app', () => {
    // Without this, an app that MOVED `next` to devDependencies would sail through the
    // checks below — there would simply be no spec to test. That relocation is itself
    // the bug: the buildpack's fallback reads `dependencies` only, so it would get an
    // empty spec and block the deploy exactly the same way.
    const offenders = [];
    for (const app of findApphostingApps()) {
      const deps = manifest(`${app}/package.json`).dependencies ?? {};
      if (!('next' in deps)) offenders.push(`${app}/package.json → missing \`next\``);
    }
    expect(
      offenders,
      [
        'Every App Hosting app must declare `next` in `dependencies` — that is the only',
        'field the buildpack reads when it falls back off the lockfile:',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('pins next to the exact catalog version in every App Hosting app', () => {
    const expected = catalogSpec('next');
    const offenders = [];

    for (const app of findApphostingApps()) {
      const spec = (manifest(`${app}/package.json`).dependencies ?? {}).next;
      if (spec === undefined) continue; // reported by the previous test
      if (!EXACT_SEMVER.test(spec)) {
        offenders.push(`${app}/package.json → \`next: ${spec}\` is not an exact version`);
      } else if (spec !== expected) {
        offenders.push(
          `${app}/package.json → \`next: ${spec}\` disagrees with the catalog (${expected})`,
        );
      }
    }

    expect(
      offenders,
      [
        'The App Hosting buildpack cannot read pnpm-lock.yaml, so it reads this raw string',
        'and hands it to `semver.satisfies`, which rejects anything that is not a bare',
        'version. BOTH `catalog:` and `^16.2.6` blow up the deploy with',
        '`CVE-2025-55182: Vulnerable Next version <spec> detected. Deployment blocked.`',
        '— a false positive that has now cost two investigations (PR #410, then again',
        'after the catalog migration re-broke it).',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        FIX,
      ].join('\n'),
    ).toEqual([]);
  });

  it('keeps a `catalog:` consumer so cleanupUnusedCatalogs cannot delete the entry', () => {
    const offenders = [];
    for (const { manifest: relPath, field } of CATALOG_KEEPERS) {
      const spec = (manifest(relPath)[field] ?? {}).next;
      if (spec !== 'catalog:') {
        offenders.push(`${relPath} → ${field}.next is \`${spec}\`, expected \`catalog:\``);
      }
    }
    expect(
      offenders,
      [
        'These manifests are the only remaining `catalog:` consumers of `next`, which',
        'makes them load-bearing: `cleanupUnusedCatalogs: true` deletes a catalog entry',
        'with zero consumers on the next `pnpm install`. Literalise or drop them ALL and',
        '`next: <version>` silently vanishes from pnpm-workspace.yaml, after which the two',
        'catalog assertions above have nothing left to compare against.',
        '',
        'Neither is read by a buildpack — apps/webchat is a static export to classic',
        'Firebase Hosting, packages/ui is a library devDependency — so neither carries the',
        'deploy exposure that forced the literal pins.',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        'If you genuinely must change one, move the keeper to another workspace member and',
        'update CATALOG_KEEPERS in the same commit.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('keeps packages/ui`s peer range broad', () => {
    // Guards the tidy-up this change invites: "make it consistent" → pin the peer too.
    // Libraries keep broad ranges (root CLAUDE.md), and a peerDependency is never read
    // by the buildpack.
    const peer = (manifest('packages/ui/package.json').peerDependencies ?? {}).next;
    expect(peer, '`packages/ui` must declare a `next` peerDependency.').toBeDefined();
    expect(
      EXACT_SEMVER.test(peer),
      `packages/ui peerDependencies.next is \`${peer}\` — libraries keep BROAD ranges, ` +
        'never an exact pin. The App Hosting literal applies to app `dependencies` only.',
    ).toBe(false);
  });
});
