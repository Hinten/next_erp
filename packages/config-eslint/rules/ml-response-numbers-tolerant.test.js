// Repo-state guard: no numeric field in the Mercado Livre RESPONSE schemas may be
// a bare `z.number()`.
//
// ## What broke in production
//
// On 2026-08-21 `GET /collections/174034247387` answered with `order_id` quoted
// (`"2000018052464608"`) while `id` stayed a JSON number. `types.ts` declared both
// `z.number().int()`, so Zod rejected the WHOLE body, the pagamento never
// imported, the pedido stuck at `emProcessamento`, and Cloud Tasks retried the
// identical request until the notification parked (#1087). `mlNumber()` /
// `mlInt()` in the plugin's `src/mlNumber.ts` accept both shapes without ever
// inventing a value.
//
// ⚠️ The blast radius was out of all proportion to the field: `order_id` is only a
// FALLBACK for the order key. `parseOk` validates the whole body before any caller
// reads a field, so ONE mistyped field costs the entire resource.
//
// ## Why it is invisible when violated
//
// Adding a field to `types.ts` as `z.number()` is a one-line, obviously-correct
// diff. Nothing fails: not tsc (the inferred OUTPUT type is identical), not
// ESLint, not the unit tests — every fixture in the package is hand-written with
// JSON numbers, because that is what ML's docs show. The defect only appears the
// day ML quotes THAT field, on a real seller's real order, as a parked
// notification. A revert is equally invisible: `z.number()` is what the rest of
// the world's Zod looks like, so removing the helper reads as a cleanup.
//
// ## Why a test rather than an ESLint rule
//
// A rule would have to decide, per member expression, whether a `z.number()` is
// (a) a tolerated union operand, (b) inside the module that DEFINES the tolerance,
// or (c) in a package where strictness is correct — `packages/schemas` write
// validators must reject a quoted number, and `apps/nfe`'s `z.coerce.number()` on
// a `?dpi=` query param is right. All three are FILE-SCOPED facts, which a rule
// (one file at a time, no repo context) cannot express and a pathspec states in
// three lines. Failing this test fails CI exactly like a lint error would — the
// same reasoning as `env-example-location.test.js`.
import { describe, expect, it } from 'vitest';

import { gitGrep } from './lib/repo-scan.js';

/**
 * The ML plugin's whole `src/`, minus the module that DEFINES the tolerance.
 *
 * ⚠️ The `:(glob)` prefix and the `**` go together. Git has two pathspec dialects
 * that disagree about `/`: under `:(glob)` a single `*` does NOT cross a slash, so
 * `:(glob)…/src/*.ts` silently returns 9 files and misses `src/ai/` and
 * `src/mapping/` entirely — while `:(glob)…/src/**` returns all 22. (The DEFAULT
 * dialect runs without `WM_PATHNAME`, where a bare `src/*.ts` does cross and also
 * returns 22.) Either spelling works; mixing them is what silently shrinks the
 * scan. The anti-vacuity anchor below is what catches it if this drifts.
 */
const PATHSPECS = [
  ':(glob)packages/integrations/mercado-livre/src/**/*.ts',
  ':(exclude,glob)packages/integrations/mercado-livre/src/mlNumber.ts',
];

/** Both bans in ONE spawn — `git grep` ORs its `-e` patterns. */
const PATTERNS = ['z\\.number\\(', 'z\\.coerce\\.number'];

/**
 * `//`, `/*`, or a jsdoc continuation `*`.
 *
 * ⚠️ Not optional. `types.ts` writes `` `z.number()` `` in PROSE — the docstring
 * explaining why `mlMissedFeedSchema` keeps its unions. A guard that reports its
 * own rationale as a violation is a guard people learn to ignore.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * The older, per-field tolerance idiom, in either operand order. Left alone on
 * purpose: these are not all numeric — `mlShipmentAddressSchema.street_number`
 * carries `'S/N'` and `'123-A'` on real Brazilian addresses — and the id ones
 * exist because every consumer compares them as STRINGS.
 */
const UNION_LINE = /z\.union\(\[/;

/**
 * Source lines allowed to keep a strict `z.number()`, each mapped to its reason.
 *
 * DELIBERATELY EMPTY. No field in `types.ts` today has a caller that reads its
 * REJECTION as a signal. The map exists so that adding the first one is a reviewed
 * edit to this file rather than an argument in a PR thread, and the staleness test
 * below stops it rotting into decoration.
 *
 * @type {Record<string, string>}
 */
const ALLOWED_STRICT = {};

/**
 * Lines that must still be found by the scan, spread from the top of `types.ts`
 * to the claims block.
 *
 * ⚠️ Anti-vacuity anchor. Every other assertion here expects `[]`, which passes
 * just as happily when the scan is BROKEN — a mistyped pathspec, an exclusion that
 * swallows the tree, a `git grep` that matched nothing — as when the tree is
 * clean. This is the positive control that tells the two apart.
 */
const KNOWN_TOLERANT_LINES = [
  'expires_in: mlNumber(),',
  'transaction_amount: mlNumber().nullable().optional(),',
  'total_paid_amount: mlNumber().nullable().optional(),',
  'resource_id: mlInt(),',
];

/** Well below the 75 the sweep converted — a rot detector, not a spec. */
const TOLERANT_FLOOR = 60;

const FIX = [
  'Fix: use `mlNumber()` — or `mlInt()` where the field carried `.int()` — from',
  '`./mlNumber`, keeping every modifier in the same order:',
  '',
  '    price: z.number().nullable().optional()          ->  mlNumber().nullable().optional()',
  '    id:    z.number().int()                          ->  mlInt()',
  '    total: z.number().int().nullable().default(null) ->  mlInt().nullable().default(null)',
  '',
  "`z.coerce.number()` is NOT the fix: it reads '' and null as 0 and true as 1, and",
  'these are money fields. If a field genuinely must reject a numeric string, add its',
  'exact source line to ALLOWED_STRICT in this file, with the reason.',
].join('\n');

/** `path:line:text` triples, left in git's own order because they feed a message. */
function scan(patterns) {
  return gitGrep({ patterns, pathspecs: PATHSPECS, mode: 'extended', list: false });
}

/** `'a/b.ts:12:  x: z.number(),'` -> `'  x: z.number(),'` */
function textOf(hit) {
  return hit.replace(/^[^:]+:\d+:/, '');
}

function isOffender(hit) {
  const text = textOf(hit);
  if (COMMENT_LINE.test(text)) return false;
  if (UNION_LINE.test(text)) return false;
  return !(text.trim() in ALLOWED_STRICT);
}

describe('Mercado Livre response schemas tolerate a quoted number', () => {
  it('the scan actually reaches the schema file', () => {
    const found = scan(['mlNumber\\(', 'mlInt\\(']).map((h) => textOf(h).trim());
    const missing = KNOWN_TOLERANT_LINES.filter((l) => !found.includes(l));
    expect(
      missing,
      [
        'These lines were not found by the git pathspec. Either the sweep was reverted,',
        'or the pathspec stopped matching — in which case every other assertion in this',
        'file is passing over an empty set:',
        ...missing.map((l) => `  - ${l}`),
      ].join('\n'),
    ).toEqual([]);
    expect(
      found.length,
      `Only ${String(found.length)} mlNumber()/mlInt() call sites found; the sweep converted 75.`,
    ).toBeGreaterThanOrEqual(TOLERANT_FLOOR);
  });

  it('has no bare `z.number()` and no `z.coerce.number()`', () => {
    const offenders = scan(PATTERNS).filter(isOffender);
    expect(
      offenders,
      [
        'A quoted number from Mercado Livre must not fail the parse of a whole resource.',
        'When `GET /collections/{id}` sent one, the payment never imported, the pedido',
        'stuck at `emProcessamento`, and Cloud Tasks retried identically until the',
        'notification parked (#1087). Offending lines:',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        FIX,
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no STALE ALLOWED_STRICT entry', () => {
    const present = new Set(scan(PATTERNS).map((h) => textOf(h).trim()));
    const stale = Object.keys(ALLOWED_STRICT).filter((l) => !present.has(l));
    expect(
      stale,
      [
        'These ALLOWED_STRICT entries match no line any more — the field was renamed,',
        'deleted, or already converted. Remove them, so the carve-out list keeps being',
        'read as current rather than as decoration:',
        ...stale.map((l) => `  - ${l}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ classifies prose, unions and real declarations correctly', () => {
    // Self-test with synthetic strings — a positive AND a negative control — so the
    // scanner cannot rot into matching nothing while still reporting green. The
    // first case is REAL: it is the `mlMissedFeedSchema` docstring in `types.ts`.
    const prose = ' *    to `z.number()` here would fail the parse for the whole page; the single';
    const union = '    street_number: z.union([z.number(), z.string()]).nullable().optional(),';
    const unionReversed = '    id: z.union([z.string(), z.number()]).nullable().default(null),';
    const bare = '    transaction_amount: z.number().nullable().optional(),';
    const coerced = '    dpi: z.coerce.number().int().min(150),';
    const fixed = '    transaction_amount: mlNumber().nullable().optional(),';

    expect(isOffender(`p.ts:1:${prose}`)).toBe(false);
    expect(isOffender(`p.ts:2:${union}`)).toBe(false);
    expect(isOffender(`p.ts:3:${unionReversed}`)).toBe(false);
    expect(isOffender(`p.ts:4:${bare}`)).toBe(true);
    expect(isOffender(`p.ts:5:${coerced}`)).toBe(true);

    // Prove the PATTERNS themselves, not just the filter: a converted line must
    // never even reach `isOffender`.
    expect(PATTERNS.some((p) => new RegExp(p).test(fixed))).toBe(false);
    expect(PATTERNS.some((p) => new RegExp(p).test(bare))).toBe(true);
    expect(PATTERNS.some((p) => new RegExp(p).test(coerced))).toBe(true);
  });
});
