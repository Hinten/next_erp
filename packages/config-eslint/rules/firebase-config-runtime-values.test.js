// Repo-state guard: a per-app `admin.ts` that DERIVES a Storage bucket name must
// also READ `storageBucket` out of `FIREBASE_CONFIG`.
//
// ## Why this needs a guard
//
// Firebase changed the DEFAULT Storage bucket for projects created after late
// 2024 from `<projectId>.appspot.com` to `<projectId>.firebasestorage.app`. The
// classic derivation therefore names a bucket that DOES NOT EXIST, and the
// symptom is an unhandled 500 on the first server-side upload — which is how it
// was found: live, on the Mercado Livre product import.
//
// The real name was available the whole time. Firebase-managed runtimes inject
// `FIREBASE_CONFIG`, and on the deployed backend it is exactly
// `{"databaseURL":"","projectId":"…","storageBucket":"….firebasestorage.app"}`.
// ⚠️ firebase-admin merges that blob into the app ONLY on the no-argument
// `initializeApp()` path (`lib/app/lifecycle.js`: `if (typeof options ===
// 'undefined') { options = loadOptionsFromEnvVar() }`), and every app here passes
// `{ credential, projectId }` — so the value is structurally invisible unless the
// file reads it ITSELF. That is what this guard checks.
//
// ## Why a repo-state guard rather than more unit tests
//
// The unit suites in `apps/{mercado-livre,whatsapp}/lib/firebase/admin.test.ts`
// already own the ORDER of the ladder, and they own it better than a text scan
// ever could. What they cannot cover is a file that does not exist yet.
// `lib/firebase/` is a DELIBERATE per-app copy (root + per-app CLAUDE.md: "each
// backend keeps its own so they deploy + log independently"), so a seventh
// channel backend is created by copying one of the six — and a copy taken from a
// stale source ships with no test at all. Same reasoning as every other guard in
// this directory: a check over a hand-written list cannot catch the thing nobody
// remembered to add.
//
// ## Why a test and not an ESLint rule
//
// The invariant is "file A contains X only if it also contains Y", over a SET of
// files discovered from git. ESLint sees one file at a time and has no way to
// know the set exists.
//
// ## What it deliberately does NOT check
//
// The ORDER of the tiers. A file could read `FIREBASE_CONFIG.storageBucket` BELOW
// the derivation and satisfy this scan while still being wrong. That property is
// semantic, and the two unit suites assert it directly with disagreeing values in
// every case — mutation-proven. Do not extend this guard into it: a line-number
// comparison over source text is exactly the syntactic proxy the
// transaction-inventory guard's header explains was measured and rejected.
//
// Line-based, like its siblings: a deriver that built the suffix out of a
// variable would be invisible. The point is to stop the copy-paste, not to prove
// a theorem.
import { describe, expect, it } from 'vitest';

import { gitGrep, gitLsFiles } from './lib/repo-scan.js';

// The per-app admin bootstrap copies. Kept in a constant rather than spelled out
// in the header above for a dull reason — a doubled star followed by a slash
// would CLOSE a block comment, the same trap `apphosting-next-pinned.test.js`
// calls out.
const PATHSPEC = ':(glob)apps/*/lib/firebase/admin.ts';

/**
 * The DERIVE: a template literal ending `.appspot.com`.
 *
 * ⚠️ The interpolation is required, not a bare `.appspot.com`. Both files also
 * carry that substring inside a `throw new Error(...)` message ("…derived as
 * <projectId>.appspot.com"), so a looser pattern would classify a file that only
 * carries the PROSE as a deriver and demand a tier it has no need for.
 */
const DERIVES = '\\$\\{[A-Za-z_$][A-Za-z0-9_$]*\\}\\.appspot\\.com';

/**
 * The runtime tier: `storageBucket` as a parenthesised string ARGUMENT or as a
 * property ACCESS — i.e. somewhere the value is actually read.
 *
 * ⚠️ Not a bare `storageBucket` substring, and that is load-bearing twice over.
 * `storageBucketNameOrNull()` contains it, so a bare match would be satisfied by
 * the very function whose config tier you just deleted. So does the helper's own
 * signature, `key: 'projectId' | 'storageBucket'`, which survives deleting every
 * CALL to it. Requiring `('storageBucket')` or `.storageBucket` excludes both —
 * verified against the real files, and pinned by the control test below.
 */
const READS_CONFIG = '\\((["\'])storageBucket\\1\\)|\\.storageBucket';

/**
 * A `//` line, a block opener, or a jsdoc continuation.
 *
 * ⚠️ Load-bearing, not defensive. Both files' JSDoc names
 * `FIREBASE_CONFIG.storageBucket` while explaining the tier — so without this
 * filter, deleting the code that reads it would leave this guard satisfied by the
 * comment explaining why it is needed. A vacuous green on the exact regression
 * the file exists to catch.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * ⚠️ Anti-vacuity anchor. The main assertion expects `[]`, which passes just as
 * happily when the pathspec matches nothing. These are the two files that must be
 * classified as derivers for it to mean anything.
 */
const MUST_DERIVE = [
  'apps/mercado-livre/lib/firebase/admin.ts',
  'apps/whatsapp/lib/firebase/admin.ts',
];

const FIX = [
  'Fix: insert the runtime tier between the override and the derivation, so the',
  'ladder reads',
  '',
  '  FIREBASE_STORAGE_BUCKET -> FIREBASE_CONFIG.storageBucket -> <projectId>.appspot.com',
  '',
  'Copy `firebaseConfigValue()` from a sibling that already has it (today',
  'apps/mercado-livre or apps/whatsapp). The per-app copies are deliberate (see',
  'each app CLAUDE.md), so COPY it rather than importing it. Two things to keep',
  'verbatim:',
  '',
  '  - TRUTHINESS, not a `typeof` check alone. The FIREBASE_CONFIG blob really',
  '    does carry empty values ("databaseURL":""), so a type-only check hands back',
  '    the empty string and stops the ladder on a value that resolves nothing.',
  '  - `if (!(err instanceof SyntaxError)) throw err;` — root CLAUDE.md rule 6.',
  '',
  'If your app needs no Storage bucket, delete the derivation instead: four of the',
  'six copies (mercado-pago, melhor-envio, nfe, integrations) carry no storage',
  'helper at all and are the better base to copy from.',
].join('\n');

const pathOf = (hit) => hit.replace(/:\d+:[\s\S]*$/, '');
const textOf = (hit) => hit.replace(/^[^:]+:\d+:/, '');

const derivers = () => gitGrep({ patterns: [DERIVES], pathspecs: [PATHSPEC], mode: 'extended' });

describe('a derived Storage bucket name is the LAST resort', () => {
  it('the scan reaches every per-app admin bootstrap', () => {
    const found = gitLsFiles([PATHSPEC]);
    expect(
      found.length,
      'The apps/<app>/lib/firebase/admin.ts pathspec stopped matching — this scan is checking nothing.',
    ).toBeGreaterThanOrEqual(6);
    for (const f of MUST_DERIVE) {
      expect(found, `${f} must be in the scan.`).toContain(f);
    }
  });

  it('the scan still classifies the two known derivers as derivers', () => {
    const missing = MUST_DERIVE.filter((f) => !derivers().includes(f));
    expect(
      missing,
      [
        'These files derive <projectId>.appspot.com but the DERIVES pattern no',
        'longer matches them, so the assertion below is passing over an empty set:',
        ...missing.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('every deriver also reads FIREBASE_CONFIG.storageBucket', () => {
    const readsConfig = new Set(
      gitGrep({ patterns: [READS_CONFIG], pathspecs: [PATHSPEC], mode: 'extended', list: false })
        .filter((hit) => !COMMENT_LINE.test(textOf(hit)))
        .map(pathOf),
    );
    const offenders = derivers().filter((f) => !readsConfig.has(f));

    expect(
      offenders,
      [
        'These files fall back to <projectId>.appspot.com without first asking the',
        "runtime for the project's REAL default bucket. On a project created after",
        'late 2024 that name does not exist, and the symptom is a 500 on the first',
        'server-side upload:',
        '',
        ...offenders.map((f) => `  - ${f}`),
        '',
        FIX,
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ the patterns match the real code and spare the prose', () => {
    // Positive AND negative controls on synthetic strings: a checker needs two,
    // or it can rot into matching nothing while still reporting green.
    const derives = new RegExp(DERIVES);
    expect(derives.test('  return `${projectId}.appspot.com`;')).toBe(true);
    expect(derives.test('  return projectId ? `${projectId}.appspot.com` : null;')).toBe(true);
    // The error MESSAGE is prose — it must not make a file look like a deriver.
    expect(
      derives.test("      'a service account so it can be derived as <projectId>.appspot.com).',"),
    ).toBe(false);

    const reads = new RegExp(READS_CONFIG);
    expect(reads.test("  const fromConfig = firebaseConfigValue('storageBucket');")).toBe(true);
    expect(reads.test('  const bucket = parsed.storageBucket;')).toBe(true);
    // Neither the sibling function nor the helper's own type signature counts.
    expect(reads.test('  const name = storageBucketNameOrNull();')).toBe(false);
    expect(
      reads.test(
        "export function firebaseConfigValue(key: 'projectId' | 'storageBucket'): string {",
      ),
    ).toBe(false);

    // And the comment filter really does fire on the JSDoc that names the tier.
    expect(COMMENT_LINE.test(" * `FIREBASE_CONFIG.storageBucket` (the runtime's OWN answer)")).toBe(
      true,
    );
    expect(COMMENT_LINE.test("  const fromConfig = firebaseConfigValue('storageBucket');")).toBe(
      false,
    );
  });
});

/**
 * Second invariant, same family, different value: a server surface that reads
 * `GOOGLE_CLOUD_PROJECT` must also consult `FIREBASE_CONFIG`.
 *
 * ⚠️ `GOOGLE_CLOUD_PROJECT` is NOT injected by App Hosting / Cloud Run. The
 * container runtime contract sets only PORT / K_SERVICE / K_REVISION /
 * K_CONFIGURATION; the project id is reachable from the metadata server and
 * never as an env var. Verified against the deployed backend — neither
 * `GOOGLE_CLOUD_PROJECT` nor `FIREBASE_PROJECT_ID` is present there.
 *
 * `packages/ai/src/admin/provider.ts` carried a comment asserting the opposite
 * ("injected by App Hosting / Cloud Run") and stopped its ladder one tier short.
 * Every AI call on staging therefore threw `AiNotConfiguredError` — found by a
 * human trying to fill a tabela de medidas, not by any test. The six
 * `lib/firebase/admin.ts` copies carried the same false comment but happened to
 * have the fallback, which is why only one surface broke.
 *
 * ⚠️ SCOPE: this asserts the file CONSULTS `FIREBASE_CONFIG` — not where in
 * the ladder, and not that the parsed value is used. Both are semantic and are
 * owned by the unit suites, which mutation-prove them. What this catches is the
 * copy-paste: a NEW server surface that reads `GOOGLE_CLOUD_PROJECT` and stops
 * there. It would not catch deleting the tier while leaving the parser behind —
 * `no-unused-vars` covers that, and a text scan should not pretend to.
 */
const READS_GCP = 'process.env.GOOGLE_CLOUD_PROJECT';
const READS_FIREBASE_CONFIG = 'process.env.FIREBASE_CONFIG';

/** Every server surface, tests excluded — they legitimately stub these vars. */
const SOURCE_PATHSPECS = ['apps', 'packages'];
const isTest = (p) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);

/**
 * ⚠⚠ Anti-vacuity anchor. The assertion expects `[]`, which passes just as
 * happily over an empty set. These are the surfaces that must be discovered.
 */
const MUST_READ_GCP = [
  'apps/mercado-livre/lib/firebase/admin.ts',
  'apps/whatsapp/lib/firebase/admin.ts',
  'packages/ai/src/admin/provider.ts',
];

describe('a server surface that reads GOOGLE_CLOUD_PROJECT also consults FIREBASE_CONFIG', () => {
  const readers = () =>
    gitGrep({ patterns: [READS_GCP], pathspecs: SOURCE_PATHSPECS, mode: 'fixed' }).filter(
      (p) => !isTest(p),
    );

  it('the scan finds every known reader', () => {
    const found = readers();
    expect(
      found.length,
      'The GOOGLE_CLOUD_PROJECT scan stopped matching — this guard is checking nothing.',
    ).toBeGreaterThanOrEqual(7);
    for (const f of MUST_READ_GCP) {
      expect(found, `${f} must be in the scan.`).toContain(f);
    }
  });

  it('every reader also consults FIREBASE_CONFIG', () => {
    const consults = new Set(
      gitGrep({
        patterns: [READS_FIREBASE_CONFIG],
        pathspecs: SOURCE_PATHSPECS,
        mode: 'fixed',
        list: false,
      })
        .filter((hit) => !COMMENT_LINE.test(textOf(hit)))
        .map(pathOf)
        .filter((p) => !isTest(p)),
    );
    const offenders = readers().filter((f) => !consults.has(f));

    expect(
      offenders,
      [
        'These files read GOOGLE_CLOUD_PROJECT without falling back to',
        'FIREBASE_CONFIG.projectId:',
        '',
        ...offenders.map((f) => `  - ${f}`),
        '',
        'GOOGLE_CLOUD_PROJECT is NOT set on App Hosting / Cloud Run. The container',
        'contract sets only PORT / K_SERVICE / K_REVISION / K_CONFIGURATION, and the',
        'project id lives on the metadata server. On the deployed backend neither',
        'GOOGLE_CLOUD_PROJECT nor FIREBASE_PROJECT_ID is present, so a ladder that',
        'stops at them resolves NOTHING in production while working fine locally.',
        '',
        'Fix: add a final tier reading `projectId` out of FIREBASE_CONFIG. Copy the',
        'parser from a sibling that already has one — today `firebaseConfigProjectId()`',
        'in packages/ai/src/admin/provider.ts or `firebaseConfigValue()` in any',
        'apps/<app>/lib/firebase/admin.ts. Keep both details verbatim: the narrow',
        'catch (`if (!(err instanceof SyntaxError)) throw err;`) and the',
        'TRUTHINESS check — an env var set to the empty string must not',
        'short-circuit a ladder whose later tier holds the real answer.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ the test-file filter spares tests but not real sources', () => {
    // Controls both ways: tests legitimately stub these vars and must be
    // excluded, but a source file must never be.
    expect(isTest('packages/ai/src/admin/provider.test.ts')).toBe(true);
    expect(isTest('apps/mercado-livre/lib/firebase/admin.test.ts')).toBe(true);
    expect(isTest('packages/ai/src/admin/provider.ts')).toBe(false);
    expect(isTest('apps/whatsapp/lib/firebase/admin.ts')).toBe(false);
  });
});
