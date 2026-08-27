// Repo-state guard: Melhor Envio's monetary fields are read through
// `parseMePrice` and nothing else.
//
// ## Why this one needs a guard of its own
//
// `@delfrance/core/wire` states three rules for a provider's numbers. Two are
// enforced: RESPONSE fields must be tolerant
// (`integration-response-numbers-tolerant.test.js`), REQUEST fields may stay
// strict only via a reviewed `ALLOWED_STRICT` entry (same file, plus its
// staleness test). The third — "ME money is a union; read it through ONE named
// function, never a local `Number()`" — had nothing.
//
// ⚠️ And it is the one already known to get broken. `MelhorEnvioFields.tsx`
// carried a private four-line `parsePrice` doing `Number(s)`, behind a `?? 0`,
// on the freight value the operator saves onto the pedido — so `''` quoted at
// R$ 0,00, `'0x1F'` at R$ 31,00 and `'1e3'` at R$ 1.000,00. It survived because
// it looks right and nothing could see it (#1251).
//
// Neither existing mechanism can cover this:
//   - the schema guard's `isOffender` short-circuits on `UNION_LINE`, and these
//     three fields ARE `z.union([z.string(), z.number()])` — invisible to it by
//     construction;
//   - `delfrance/no-ad-hoc-money-rounding` matches `toFixed(2)` and
//     `Math.round(x * 100)`, and has no `Number(…)` / `parseFloat(…)` pattern.
//
// ## What it checks
//
// A `Number(` or `parseFloat(` applied on the same line as an ME money
// identifier, anywhere the ME quote flow lives. That is deliberately narrow: it
// is the shape the real defect took, and a broader "no bare Number() anywhere"
// would drown in legitimate uses.
//
// ## What it cannot catch
//
// Line-based, like its sibling — a reader split across two lines
// (`const raw = q.price;` then `Number(raw)`) is invisible. Prettier keeps the
// common form on one line, and the point is to stop the easy copy-paste, not to
// prove a theorem.
import { describe, expect, it } from 'vitest';

import { gitGrep } from './lib/repo-scan.js';

/** Everywhere the Melhor Envio quote/label flow reads a price. */
const PATHSPECS = [
  ':(glob)packages/integrations/freight-br/src/**/*.ts',
  ':(glob)apps/web/**/frete/**',
  ':(glob)apps/melhor-envio/**/*.ts',
];

/** `Number(` / `parseFloat(` on the same line as an ME monetary field. */
const PATTERNS = ['(Number|parseFloat)\\([^)]*(price|custom_price|discount)'];

/** `//`, `/*`, or a jsdoc continuation `*` — the docstrings here name both. */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/**
 * ⚠️ Anti-vacuity anchor. Every assertion below expects `[]`, which passes just
 * as happily when the pathspec matches NOTHING. These are the files that must be
 * in the scan for it to mean anything: the one that defines the reader and the
 * one that had the private copy.
 */
const MUST_REACH = [
  'packages/integrations/freight-br/src/melhor-envio/types.ts',
  'apps/web/app/(app)/pedidos/_components/tabs/frete/MelhorEnvioFields.tsx',
];

const FIX = [
  'Fix: read it through `parseMePrice` (exported from',
  '`@delfrance/integrations-freight-br/http-client`), which is built on',
  '`parseWireDecimal` and returns null — never 0 — for anything it cannot read.',
  '',
  "A bare `Number(s)` reads '' as 0, '0x1F' as 31 and '1e3' as 1000. On a freight",
  'price that lands in `valorCobrado` / `custoCalculado` / `custoFinal`, which is',
  'what the operator is charged.',
  '',
  'If you genuinely need a different reading, change `parseMePrice` — one place,',
  'with tests — rather than growing a second copy here (#810).',
].join('\n');

function textOf(hit) {
  return hit.replace(/^[^:]+:\d+:/, '');
}

describe('Melhor Envio money is read in exactly one place', () => {
  it('the scan actually reaches the files that matter', () => {
    // `parseMePrice` itself is the probe: it exists in the definition file and
    // in the screen that consumes it, so finding it proves both pathspecs match.
    const reached = new Set(
      gitGrep({ patterns: ['parseMePrice'], pathspecs: PATHSPECS, mode: 'extended', list: true }),
    );
    const missing = MUST_REACH.filter((f) => !reached.has(f));
    expect(
      missing,
      [
        'These files were not reached by the git pathspec, so every other assertion',
        'in this file is passing over an empty set:',
        ...missing.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no private `Number()` / `parseFloat()` over an ME price', () => {
    const offenders = gitGrep({
      patterns: PATTERNS,
      pathspecs: PATHSPECS,
      mode: 'extended',
      list: false,
    }).filter((hit) => !COMMENT_LINE.test(textOf(hit)));

    expect(
      offenders,
      [
        'Melhor Envio types `price` / `custom_price` / `discount` by ENDPOINT — strings',
        'in `calculate`, numbers in the cart 201 — so they are a union, and the one',
        'place that reading happens is `parseMePrice`. A second copy is how #810',
        'started. Offending lines:',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        FIX,
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ the pattern matches the real defect and spares the real code', () => {
    // Positive and negative controls on synthetic strings, so the scanner cannot
    // rot into matching nothing while still reporting green. The first line is
    // VERBATIM the one this guard exists because of.
    const re = new RegExp(PATTERNS[0]);
    const theRealDefect = '  const n = Number(s); // was parsePrice() in MelhorEnvioFields';
    const viaIdentifier = '    const price = Number(option.custom_price ?? option.price);';
    const floatVariant = '    const d = parseFloat(q.discount);';
    const correct = '    const price = parseMePrice(q.custom_price ?? q.price);';
    const unrelated = '    const qty = Number(row.quantidade);';

    expect(re.test(viaIdentifier)).toBe(true);
    expect(re.test(floatVariant)).toBe(true);
    expect(re.test(correct)).toBe(false);
    expect(re.test(unrelated)).toBe(false);
    // ⚠️ Honest limit, asserted rather than claimed: the bare `Number(s)` the
    // defect actually shipped names no price identifier on its own line, so this
    // guard would NOT have caught it in place — only the copy-paste that reads
    // the field directly. Deleting the private helper is what closed that one.
    expect(re.test(theRealDefect)).toBe(false);

    expect(COMMENT_LINE.test('  // const price = Number(q.price);')).toBe(true);
    expect(COMMENT_LINE.test('   * `Number(q.price)` is banned here')).toBe(true);
  });
});
