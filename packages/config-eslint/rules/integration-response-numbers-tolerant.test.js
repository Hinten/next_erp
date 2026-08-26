// Repo-state guard: no numeric field in a channel integration's RESPONSE schemas
// may be a bare `z.number()`.
//
// ## What broke in production
//
// On 2026-08-21 `GET /collections/174034247387` answered with `order_id` quoted
// (`"2000018052464608"`) while `id` stayed a JSON number. `types.ts` declared both
// `z.number().int()`, so Zod rejected the WHOLE body, the pagamento never
// imported, the pedido stuck at `emProcessamento`, and Cloud Tasks retried the
// identical request until the notification parked (#1087). `wireNumber()` /
// `wireInt()` in `@delfrance/core/wire` accept both shapes without ever inventing
// a value.
//
// ⚠️ The blast radius was out of all proportion to the field: `order_id` is only a
// FALLBACK for the order key. `parseOk` validates the whole body before any caller
// reads a field, so ONE mistyped field costs the entire resource.
//
// ## Why it is invisible when violated
//
// Adding a field to `types.ts` as `z.number()` is a one-line, obviously-correct
// diff. Nothing fails: not tsc (the inferred OUTPUT type is identical), not
// ESLint, not the unit tests — every fixture in these packages is hand-written with
// JSON numbers, because that is what the providers' docs show. The defect only
// appears the day the provider quotes THAT field, on a real seller's real order, as
// a parked notification. A revert is equally invisible: `z.number()` is what the
// rest of the world's Zod looks like, so removing the helper reads as a cleanup.
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
//
// ## What it cannot catch
//
// 1. It is LINE-BASED, so `z\n  .number()` is invisible. Prettier (printWidth 100)
//    never breaks a chain this short and `pnpm format:check` gates CI, so this is
//    not reachable in practice — but a hand-broken chain would escape.
// 2. It does not look INSIDE `z.union([...])`, so a money field hiding in one stays
//    uncoerced. `mlShipmentPaymentSchema.amount` is exactly that case today.
// 3. It does not reach the channel APPS — `apps/mercado-livre` and
//    `apps/mercado-pago`, whose only provider-inbound numeric schemas are the
//    notification wire payloads, already tolerant via the shared `asInt`/`asMillis`
//    pre-parse in `@delfrance/data/admin/notifications` — nor
//    `packages/integrations/freight-br`, which answers the same question a THIRD
//    way (money as `z.string()`) and whose `types.ts` mixes request and response
//    shapes, so it cannot be swept wholesale. That is its own decision (#1251).
// 4. It does not scan `packages/core`, which is where the tolerance is DEFINED and
//    therefore the one place a bare `z.number()` is correct.
// 5. It assumes every schema under a scanned `src/` is a RESPONSE schema — true
//    today, since each `types.ts` holds only response shapes and nothing else in
//    those trees declares a `z.number()`. But `mercado-livre/src/mapping/` builds
//    the outbound REQUEST payloads (as plain objects, no schema), and for a request
//    shape strictness is CORRECT: we must not coerce a stringified number on the
//    way OUT. The pathspec still covers it deliberately — a response schema quietly
//    added there would otherwise escape in silence, which is the worse failure — so
//    the FIX text names the case and `ALLOWED_STRICT` absorbs it as one reviewed
//    edit.
import { describe, expect, it } from 'vitest';

import { gitGrep } from './lib/repo-scan.js';

/**
 * Every channel integration package whose `src/` holds provider RESPONSE schemas.
 *
 * ⚠️ The `:(glob)` prefix and the `**` go together. Git has two pathspec dialects
 * that disagree about `/`: under `:(glob)` a single `*` does NOT cross a slash, so
 * `:(glob)…/src/*.ts` silently returns 9 files and misses `src/ai/` and
 * `src/mapping/` entirely — while `:(glob)…/src/**` returns all 22. (The DEFAULT
 * dialect runs without `WM_PATHNAME`, where a bare `src/*.ts` does cross and also
 * returns 22.) Either spelling works; mixing them is what silently shrinks the
 * scan. The per-file anchors below are what catch it if this drifts.
 *
 * No exclusion is needed for the module that DEFINES the tolerance: it lives in
 * `packages/core/src/wire/`, outside every pathspec here.
 */
const PATHSPECS = [
  ':(glob)packages/integrations/mercado-livre/src/**/*.ts',
  ':(glob)packages/integrations/mercado-pago/src/**/*.ts',
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
 * Source lines allowed to keep a strict `z.number()`, keyed by file and then by
 * the exact source line, each mapped to its reason.
 *
 * DELIBERATELY EMPTY. No field in a scanned `types.ts` today has a caller that
 * reads its REJECTION as a signal. The map exists so that adding the first one is a
 * reviewed edit to this file rather than an argument in a PR thread, and the
 * staleness test below stops it rotting into decoration.
 *
 * ⚠️ Keyed by PATH for the same reason {@link KNOWN_TOLERANT_LINES} is, pointed
 * the other way. A flat map would make a carve-out written for ONE package
 * exempt an identically-spelled line in a sibling — the packages are
 * near-copies, so `amount: z.number().nullable().optional(),` is not an
 * identity — and its staleness check would stay green as long as *either*
 * package still had the line. An assertion running over an empty set and an
 * exemption applying to a file nobody reviewed it for are the same bug.
 *
 * It is empty today, which is exactly why the shape is settled now: the FIX text
 * below actively invites the first entry, and by then the structure is not a
 * free change any more.
 *
 * @type {Record<string, Record<string, string>>}
 */
const ALLOWED_STRICT = {};

/**
 * Lines that must still be found by the scan, keyed by the file they live in.
 *
 * ⚠️ Anti-vacuity anchor, and the KEY is the load-bearing half. Every other
 * assertion here expects `[]`, which passes just as happily when the scan is
 * BROKEN — a mistyped pathspec, an exclusion that swallows the tree, a `git grep`
 * that matched nothing — as when the tree is clean.
 *
 * ⚠️ A FLAT list of lines does not survive a second package. The channels are
 * near-identical, so `expires_in: wireNumber(),` and
 * `transaction_amount: wireNumber().nullable().optional(),` occur in more than one
 * `types.ts` — a flat anchor would be satisfied by whichever package still matches,
 * and a pathspec that silently stopped reaching the OTHER one would look green
 * while its "has no bare z.number()" assertion ran over an empty set. Keying by
 * path means every listed file must be reached in its own right.
 */
const KNOWN_TOLERANT_LINES = {
  'packages/integrations/mercado-livre/src/types.ts': [
    'expires_in: wireNumber(),',
    'transaction_amount: wireNumber().nullable().optional(),',
    'total_paid_amount: wireNumber().nullable().optional(),',
    'resource_id: wireInt(),',
  ],
  // ⚠️ Two of these four lines are IDENTICAL to Mercado Livre's above. That is
  // the point: the packages are near-copies, so only the KEY distinguishes
  // "Mercado Pago is still being scanned" from "some file somewhere still has
  // this line". Spread from the token block to the payment block.
  'packages/integrations/mercado-pago/src/types.ts': [
    'expires_in: wireNumber(),',
    'user_id: wireInt().nullable().optional(),',
    'transaction_amount: wireNumber().nullable().optional(),',
    'marketplace_fee: wireNumber().nullable().optional(),',
  ],
};

/** Well below the 75 + 13 the two sweeps converted — a rot detector, not a spec. */
const TOLERANT_FLOOR = 75;

const FIX = [
  'Fix: use `wireNumber()` — or `wireInt()` where the field carried `.int()` — from',
  '`@delfrance/core/wire`, keeping every modifier in the same order:',
  '',
  '    price: z.number().nullable().optional()          ->  wireNumber().nullable().optional()',
  '    id:    z.number().int()                          ->  wireInt()',
  '    total: z.number().int().nullable().default(null) ->  wireInt().nullable().default(null)',
  '',
  "`z.coerce.number()` is NOT the fix: it reads '' and null as 0 and true as 1, and",
  'these are money fields.',
  '',
  'Do NOT add a per-channel copy of the coercer. The rule lives in',
  '`packages/core/src/wire/` precisely because the same payment resource drifted',
  'through two different providers (#1087, #1251) and a second copy drifts (#810).',
  '',
  'Is your schema validating something we SEND rather than something the provider',
  'sends us? Then tolerance is the WRONG direction and none of the above applies — a',
  'request shape should reject a stringified number, not coerce it. Add its exact',
  'source line to ALLOWED_STRICT in this file, UNDER ITS FILE PATH, with that as',
  'the reason — the map is Record<path, Record<sourceLine, reason>>, so a carve-out',
  'excuses that line in that file only and never the same text in a sibling package.',
].join('\n');

/** `path:line:text` triples, left in git's own order because they feed a message. */
function scan(patterns) {
  return gitGrep({ patterns, pathspecs: PATHSPECS, mode: 'extended', list: false });
}

/** `'a/b.ts:12:  x: z.number(),'` -> `'  x: z.number(),'` */
function textOf(hit) {
  return hit.replace(/^[^:]+:\d+:/, '');
}

/** `'a/b.ts:12:  x: z.number(),'` -> `'a/b.ts'` (git always emits forward slashes) */
function pathOf(hit) {
  return hit.slice(0, hit.indexOf(':'));
}

/**
 * Is this exact source line carved out for THIS file?
 *
 * ⚠️ Looked up under the path, never as a flat membership test — a carve-out
 * excuses one line in one file, not that text everywhere.
 *
 * ⚠️ Split out, rather than made a defaulted parameter of `isOffender`, so the
 * self-test can drive it with a synthetic NON-empty map (the real one ships
 * empty, which would make a path-keying assertion vacuous) WITHOUT putting an
 * optional second parameter on a function that is passed to `.filter()`.
 * `Array.prototype.filter` calls its callback with `(element, index, array)`, so
 * `\`.filter(isOffender)\`` would have bound the INDEX to that parameter and
 * silently excused nothing — invisible while the map is empty, and a hole the
 * day it is not.
 */
function isExcused(path, text, allowed) {
  return text.trim() in (allowed[path] ?? {});
}

function isOffender(hit) {
  const text = textOf(hit);
  if (COMMENT_LINE.test(text)) return false;
  if (UNION_LINE.test(text)) return false;
  return !isExcused(pathOf(hit), text, ALLOWED_STRICT);
}

describe('channel response schemas tolerate a quoted number', () => {
  it('the scan actually reaches every schema file', () => {
    const hits = scan(['wireNumber\\(', 'wireInt\\(']);
    const byPath = new Map();
    for (const hit of hits) {
      const path = pathOf(hit);
      if (!byPath.has(path)) byPath.set(path, new Set());
      byPath.get(path).add(textOf(hit).trim());
    }

    const missing = Object.entries(KNOWN_TOLERANT_LINES).flatMap(([path, lines]) =>
      lines.filter((l) => !byPath.get(path)?.has(l)).map((l) => `${path}: ${l}`),
    );
    expect(
      missing,
      [
        'These lines were not found by the git pathspec, in the file that must contain',
        'them. Either the sweep was reverted, or the pathspec stopped matching that',
        'package — in which case every other assertion in this file is passing over an',
        'empty set for it:',
        ...missing.map((l) => `  - ${l}`),
      ].join('\n'),
    ).toEqual([]);
    expect(
      hits.length,
      `Only ${String(hits.length)} wireNumber()/wireInt() call sites found; the sweeps converted 75 (ML) + 13 (MP).`,
    ).toBeGreaterThanOrEqual(TOLERANT_FLOOR);
  });

  it('has no bare `z.number()` and no `z.coerce.number()`', () => {
    const offenders = scan(PATTERNS).filter(isOffender);
    expect(
      offenders,
      [
        'A quoted number from a provider must not fail the parse of a whole resource.',
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
    const present = new Map();
    for (const hit of scan(PATTERNS)) {
      const path = pathOf(hit);
      if (!present.has(path)) present.set(path, new Set());
      present.get(path).add(textOf(hit).trim());
    }
    // ⚠️ Matched per FILE, not against the union: a carve-out must not be kept
    // alive by an identically-spelled line in a package it was never written for.
    const stale = Object.entries(ALLOWED_STRICT).flatMap(([path, lines]) =>
      Object.keys(lines)
        .filter((l) => !present.get(path)?.has(l))
        .map((l) => `${path}: ${l}`),
    );
    expect(
      stale,
      [
        'These ALLOWED_STRICT entries match no line any more, in the file they were',
        'written for — the field was renamed, deleted, or already converted. Remove',
        'them, so the carve-out list keeps being read as current rather than as',
        'decoration:',
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
    const fixed = '    transaction_amount: wireNumber().nullable().optional(),';

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

  it('⚠️ an ALLOWED_STRICT carve-out excuses ONE file, not that line everywhere', () => {
    // The control for the path-keying, driven with a synthetic map because the
    // real one ships empty — which would make this assertion vacuous.
    //
    // The two lookups below are the SAME source line in two different files.
    // That is the realistic case, not a contrived one: the channel packages are
    // near-copies, so a request-shaped carve-out in one would silently exempt a
    // response field of the same name in another. A flat map answers `true`
    // twice here; keyed by path it answers true, then false.
    const carved = {
      'packages/integrations/freight-br/src/melhor-envio/types.ts': {
        'width: z.number(),': 'REQUEST — outbound volume, tolerance is the wrong direction',
      },
    };
    const line = '  width: z.number(),';

    expect(
      isExcused('packages/integrations/freight-br/src/melhor-envio/types.ts', line, carved),
    ).toBe(true);
    expect(isExcused('packages/integrations/mercado-pago/src/types.ts', line, carved)).toBe(false);
  });

  it('⚠️ every ALLOWED_STRICT entry survives the REAL `.filter(isOffender)` call', () => {
    // ⛔ The control the lookup test above cannot give, and the reason it is
    // written through `.filter` rather than by calling `isOffender(hit)`.
    //
    // `Array.prototype.filter` invokes its callback as `(element, index, array)`.
    // Give `isOffender` an optional second parameter — say, to make the carve-out
    // map injectable for a test — and `.filter(isOffender)` silently binds the
    // INDEX to it, so nothing is ever excused. That version passes every
    // assertion that calls the helper directly, and it is invisible for exactly
    // as long as `ALLOWED_STRICT` is empty. It cost this stack a red suite the
    // first time the map gained entries.
    //
    // So: build the offender list the way production does, then assert no
    // carved-out line is in it. Vacuous while the map is empty, load-bearing the
    // moment it is not.
    const offenders = new Set(scan(PATTERNS).filter(isOffender));
    const notHonoured = Object.entries(ALLOWED_STRICT).flatMap(([path, lines]) =>
      Object.keys(lines).flatMap((l) =>
        [...offenders].filter((h) => pathOf(h) === path && textOf(h).trim() === l),
      ),
    );
    expect(
      notHonoured,
      [
        'These lines are listed in ALLOWED_STRICT but the real scan still reports them',
        'as offenders, so the carve-out is not reaching `isOffender` at all:',
        ...notHonoured.map((h) => `  - ${h}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ pathOf splits a hit the same way git spells it', () => {
    // The anchor map is keyed by path, so a wrong split would silently make every
    // `byPath.get(path)` lookup miss and turn the positive control into noise.
    expect(pathOf('packages/integrations/mercado-livre/src/types.ts:42:  x: wireInt(),')).toBe(
      'packages/integrations/mercado-livre/src/types.ts',
    );
    expect(textOf('packages/integrations/mercado-livre/src/types.ts:42:  x: wireInt(),')).toBe(
      '  x: wireInt(),',
    );
  });
});
