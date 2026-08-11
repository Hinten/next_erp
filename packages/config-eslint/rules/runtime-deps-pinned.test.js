import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Repo invariant: in a **deploy-artifact manifest**, the Firebase SDK specs are
 * pinned to an EXACT version, and that version equals the `pnpm-workspace.yaml`
 * catalog's.
 *
 * Why this needs a guard at all. Each `scripts/prepare-deploy.mjs` emits a minimal
 * `package.json` carrying its `dependencies` **verbatim**, and every
 * `firebase.*.deploy.json` sets `ignore: ["node_modules"]` — so the artifact that
 * reaches the gen2 buildpack has the dependency list but **no lockfile**. The cloud
 * `npm install` therefore resolves each spec fresh, and a RANGE resolves to whatever
 * is newest at deploy time. Nothing in CI runs that install, so the version that
 * ships was never the version that was tested.
 *
 * That is not theoretical. `firebase-functions@7.3.2` — a PATCH over 7.3.0 — moved
 * `express` from `^4.21.0` to `^5.2.1` (an Express major, for CVE remediation). With
 * `^7.3.0` in the artifacts and 7.3.0 in `pnpm-lock.yaml`, every function deployed
 * after 2026-07-28 ran Express 5 in production while CI still tested Express 4, and
 * no signal existed anywhere. Exact pins close that: the lockfile, CI, and the cloud
 * install all name one version, and moving it is a visible edit.
 *
 * This is a test rather than an ESLint rule for the same reason as
 * `env-example-location.test.js`: the invariant spans several files and compares them
 * against a YAML file, which ESLint (one JS/TS file at a time) never sees. Failing the
 * test fails CI exactly like a lint error would.
 *
 * Scope note: the OTHER runtime deps in these same blocks
 * (`@google-cloud/firestore`, `sharp`, `xmllint-wasm`) still carry `^` ranges and
 * float in the cloud the same way. That is a deliberate, known carve-out, not an
 * oversight — the two SDKs below are the ones whose transitive tree reaches every
 * trigger. Extending the guard is a one-line change to `PINNED`.
 */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The two packages whose version must be deliberate. Both are esbuild `external`
 * in every codebase's `build.mjs`, so the artifact's spec — not the bundle — decides
 * what actually executes in the cloud.
 */
const PINNED = ['firebase-admin', 'firebase-functions'];

/**
 * The manifests that exist today. Discovery below is a glob, so a NEW codebase is
 * covered automatically and does not need adding here; this list exists only as an
 * anchor, so a glob that silently stops matching fails loudly instead of vacuously
 * passing over an empty set.
 */
const KNOWN_ARTIFACT_MANIFESTS = [
  'apps/functions/package.json',
  'apps/mercado-livre/functions/package.json',
  'apps/mercado-pago/functions/package.json',
  'apps/nfe/functions/package.json',
  'apps/whatsapp/functions/package.json',
];

/** Exact semver — no `^`, `~`, `x`, range, `catalog:`, `workspace:*` or URL. */
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Ask git rather than walking the filesystem — same reasoning as
 * `env-example-location.test.js`: a walk needs a skip-list, and the directories it
 * must skip (`node_modules`, `.deploy/`, the gitignored `.old/` Flutter reference,
 * `.claude/worktrees` checkouts) are exactly the ones that produce false positives.
 * The `--others` pass catches a new manifest before it is committed.
 *
 * ⚠️ The `:(glob)` prefix is load-bearing, and so is `**` rather than `*`. Git has
 * TWO pathspec dialects and they disagree about `/`:
 *   - **default** (no magic) matches with wildmatch WITHOUT `WM_PATHNAME`, so a bare
 *     `*` DOES cross `/` — `*functions/package.json` finds all five.
 *   - **`:(glob)`** sets `WM_PATHNAME`, so `*` stops at `/` and only `**` crosses it.
 * Both dialects can express this correctly, but each is a trap in the other's terms:
 * `:(glob)*functions/package.json` matches NOTHING, and the plausible-looking
 * `apps/` + `**` + `/functions/package.json` WITHOUT `:(glob)` silently returns only
 * FOUR — it drops `apps/functions/package.json`, the storage codebase, because there
 * `**` has no directory to match. A reviewer misread the default form as the glob
 * form, which is reason enough to spell the dialect out rather than lean on the
 * default. (The glob is split across backticks above for a dull reason: the literal
 * two-star-slash sequence would CLOSE this block comment.)
 *
 * `:(glob)apps/**` + `/functions/package.json` therefore matches
 * `apps/functions/package.json` AND every `apps/<channel>/functions/package.json`,
 * and nothing else in the repo. If you change this, re-check it against BOTH the
 * five-manifest anchor test below and a deliberately renamed codebase.
 */
function findArtifactManifests() {
  const ls = (...args) =>
    execFileSync('git', [...args, '--', ':(glob)apps/**/functions/package.json'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);

  return [...new Set([...ls('ls-files'), ...ls('ls-files', '--others', '--exclude-standard')])];
}

/**
 * Read one spec out of the `pnpm-workspace.yaml` catalog.
 *
 * A line-anchored regex, not a YAML parse: this workspace declares only `eslint` and
 * `vitest`, and the precedent in this directory is to reach for `git` rather than add
 * a dependency. The catalog is a flat two-space-indented `name: version` map, and
 * anchoring to that shape means a malformed read returns `undefined` and fails the
 * assertion rather than silently matching something else.
 */
function catalogSpec(name) {
  const yaml = readFileSync(resolve(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf8');
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = yaml.match(new RegExp(`^ {2}'?${escaped}'?: *(\\S+)$`, 'm'));
  return match?.[1];
}

/** The `dependencies` block ONLY — that is what `prepare-deploy.mjs` copies. */
function runtimeDeps(relPath) {
  const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, relPath), 'utf8'));
  return pkg.dependencies ?? {};
}

const FIX = [
  'Fix: pin it to the exact version, and bump `pnpm-workspace.yaml`s catalog plus',
  'ALL of these manifests in the same commit, then run `pnpm install`:',
  ...KNOWN_ARTIFACT_MANIFESTS.map((p) => `  - ${p}`),
].join('\n');

describe('deploy-artifact runtime deps are pinned exactly', () => {
  it('finds every known artifact manifest', () => {
    // Anchor for the glob. If this fails, the pathspec above stopped matching and
    // every other assertion in this file is passing over an empty set.
    const found = new Set(findArtifactManifests());
    const missing = KNOWN_ARTIFACT_MANIFESTS.filter((p) => !found.has(p));
    expect(
      missing,
      [
        'These deploy-artifact manifests were not found by the git pathspec.',
        'Either they moved (update KNOWN_ARTIFACT_MANIFESTS) or the pathspec',
        '`:(glob)apps/**/functions/package.json` no longer matches them — in which case this',
        'whole guard silently stopped checking anything:',
        ...missing.map((p) => `  - ${p}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('the catalog pins both SDKs exactly', () => {
    // The catalog drives the lockfile (`catalogMode: strict`), i.e. what CI tests.
    // A range here means CI's version drifts on any re-resolve, so the artifacts
    // could be exact and still not match what was tested.
    for (const name of PINNED) {
      const spec = catalogSpec(name);
      expect(spec, `\`${name}\` is missing from the pnpm-workspace.yaml catalog.`).toBeDefined();
      expect(
        EXACT_SEMVER.test(spec),
        `pnpm-workspace.yaml catalog has \`${name}: ${spec}\` — must be an exact version.\n${FIX}`,
      ).toBe(true);
    }
  });

  it('declares both SDKs in every artifact manifest', () => {
    // Without this, a manifest that DROPPED `firebase-functions` from `dependencies`
    // would sail through the exactness check below — there would simply be no spec
    // to test. A vacuous pass here is worse than a failure: the artifact would build
    // and the cloud install would resolve the SDK as an undeclared transitive dep.
    const offenders = [];
    for (const relPath of findArtifactManifests()) {
      const deps = runtimeDeps(relPath);
      for (const name of PINNED) {
        if (!(name in deps)) offenders.push(`${relPath} → missing \`${name}\``);
      }
    }
    expect(
      offenders,
      [
        'Every Cloud Functions deploy artifact must declare both Firebase SDKs in its',
        '`dependencies` (the block prepare-deploy.mjs copies verbatim):',
        ...offenders.map((o) => `  - ${o}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('pins both SDKs to the exact catalog version in every artifact manifest', () => {
    const expected = Object.fromEntries(PINNED.map((name) => [name, catalogSpec(name)]));
    const offenders = [];

    for (const relPath of findArtifactManifests()) {
      const deps = runtimeDeps(relPath);
      for (const name of PINNED) {
        const spec = deps[name];
        if (spec === undefined) continue; // reported by the previous test
        if (!EXACT_SEMVER.test(spec)) {
          offenders.push(`${relPath} → \`${name}: ${spec}\` is not an exact version`);
        } else if (spec !== expected[name]) {
          offenders.push(
            `${relPath} → \`${name}: ${spec}\` disagrees with the catalog (${expected[name]})`,
          );
        }
      }
    }

    expect(
      offenders,
      [
        'A deploy artifact ships NO lockfile, so a range or a disagreeing pin means the',
        'cloud `npm install` resolves a version CI never tested (firebase-functions@7.3.2',
        'moved express 4→5 in a PATCH release exactly this way).',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        FIX,
      ].join('\n'),
    ).toEqual([]);
  });
});
