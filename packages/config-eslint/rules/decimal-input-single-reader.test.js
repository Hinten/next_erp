// Repo-state guard: a field an operator can type a DECIMAL into goes through
// `DecimalInput`, never a bare Mantine `<NumberInput>`.
//
// ## Why this needs a guard rather than a review habit
//
// Mantine's `NumberInput` deliberately hands `onChange` a STRING — not
// `payload.floatValue` — for every in-progress decimal. Four patterns in its
// source force that branch: a trailing separator (`"1."`), a trailing zero
// (`"1.50"`), a leading decimal zero (`"0."`), and the empty/sign-only field.
//
// So the coercion that reads correct —
//
//     onChange={(v) => field.onChange(typeof v === 'number' ? v : null)}
//
// — answers the very keystroke that OPENS the decimal with `null`, and a
// controlled input then re-renders empty. The operator sees the form wipe
// itself, and no decimal can be entered however slowly they type. The `: 0` and
// `: <previous value>` variants are the same defect wearing a different fallback.
//
// It survived in thirteen places at once because every one of them looks right:
// nothing throws, no test fails, and the type checker is satisfied — `v` really
// is `string | number` and the guard really does narrow it. The only signal was
// an operator saying "a form fica limpando".
//
// ## What it checks
//
// A `<NumberInput` JSX tag anywhere in `apps/web` or `packages/ui`, minus a
// carve-out list. The carve-outs are keyed BY PATH: these files are near-copies
// of one another (row editors, filter bars), so a flat list of excused strings
// would leak one file's excuse to every other file holding the same line — the
// failure mode #1276 found in `KNOWN_TOLERANT_LINES`.
//
// ## What it cannot catch
//
// It is a tag scan, so it says nothing about a `<DecimalInput>` wired to a bad
// `onChange`. That is what `packages/ui/src/inputs/DecimalInput.test.tsx` is
// for — a controlled harness driving the exact intermediate strings Mantine
// emits. The two together are the coverage; neither alone is.
import { describe, expect, it } from 'vitest';

import { gitGrep } from './lib/repo-scan.js';

/** Every surface that renders a form field for an operator. */
const PATHSPECS = [':(glob)apps/web/**/*.tsx', ':(glob)packages/ui/src/**/*.tsx'];

const PATTERN = '<NumberInput';

/**
 * `//`, `/*`, or a jsdoc continuation `*`.
 *
 * ⚠️ Load-bearing, and found the hard way: the FIRST version of this guard
 * scanned file names only and reported `PesoField.tsx` — the file the whole
 * change exists to fix — because its docblock says "never a bare
 * `<NumberInput>`". A tag scan that cannot tell code from prose punishes the
 * comment that explains the rule.
 */
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/;

/** `path:line:text` -> `text`. git emits forward slashes on every platform. */
function textOf(hit) {
  return hit.replace(/^[^:]+:\d+:/, '');
}

/** `path:line:text` -> `path`. */
function fileOf(hit) {
  return hit.slice(0, hit.indexOf(':'));
}

/**
 * The wrapper itself — it renders the one `<NumberInput>` everything else goes
 * through, so the "this is an integer field" claim below cannot apply to it.
 */
const OWNERS = new Set(['packages/ui/src/inputs/DecimalInput.tsx']);

/**
 * The files allowed to render a bare `<NumberInput>`, and why.
 *
 * ⚠️ Path-keyed on purpose. Every value here is a claim about ONE file; a flat
 * list of excused line texts would let a row editor inherit its sibling's
 * excuse, which is exactly how a near-copy defect stays invisible.
 *
 * Every entry except the owner is the same claim: **this field is an integer**,
 * declared with `allowDecimal={false}`, so no keystroke can reach Mantine's
 * in-progress-decimal branch at all — and that claim is now VERIFIED against
 * the file rather than trusted as prose.
 */
const CARVE_OUTS = {
  'packages/ui/src/inputs/DecimalInput.tsx': 'owns the wrapper — this IS the one reader',
  'packages/ui/src/object/FieldRenderer.tsx':
    "the 'integer' and 'currency' (centavos) kinds; the 'number' kind uses DecimalInput",
  'apps/web/app/(app)/pedidos/_components/PagamentosSection.tsx':
    'parcelas, nº do cheque, intervalo — all allowDecimal={false}',
  'apps/web/app/(app)/pedidos/_components/NfColumnFilter.tsx': 'nº da NF — allowDecimal={false}',
  'apps/web/app/(app)/nfe/comunicacoes/_components/EnviNfeFilterBar.tsx':
    'nº do recibo — allowDecimal={false}',
  'apps/web/app/(app)/logistica/_components/HorarioCorteEditor.tsx':
    'hora/minuto — allowDecimal={false}',
  'apps/web/app/(app)/logistica/_components/FaixaCepEditor.tsx':
    'prazo em dias — allowDecimal={false} (custo and preço use DecimalInput)',
  'apps/web/app/(app)/configuracoes/filiais/[id]/inutilizar/_components/InutilizarForm.tsx':
    'série and the nNF range — allowDecimal={false}',
  'apps/web/app/(app)/configuracoes/ia/_components/ConfigIaPanel.tsx':
    'máximo de tokens — allowDecimal={false} (temperatura uses DecimalInput)',
  'apps/web/app/(app)/relatorios/produtos/page.tsx': 'top N — allowDecimal={false}',
  'apps/web/app/(app)/produtos/_components/KitManager.tsx':
    'quantidade de componentes — allowDecimal={false}',
  'apps/web/app/(app)/produtos/_components/ExtraDataManager.tsx':
    'Google Merchant multipack/quantidade — allowDecimal={false}',
  'apps/web/app/(app)/balanco/_components/LancamentoForm.tsx':
    'quantidade contada — allowDecimal={false}',
  'apps/web/app/(app)/canais/webchat/_components/MensagensInatividadeField.tsx':
    'tempo_inatividade em segundos — allowDecimal={false}',
};

const FIX = [
  'Fix: render `DecimalInput` from `@delfrance/ui` instead.',
  '',
  'It sets the pt-BR separator, keeps `thousandSeparator` and the padded',
  '`fixedDecimalScale` out of the typing path, and routes `onChange` through',
  '`parseDecimalInput` — the one place the "Mantine emits a string mid-decimal"',
  'rule is written.',
  '',
  'If the field is genuinely an INTEGER, say so with `allowDecimal={false}` and',
  'add the file to CARVE_OUTS in this test with that reason. Do not add an entry',
  'for a field an operator can type a decimal into: that is the defect.',
].join('\n');

/** Files that must be in the scan for any `[]` assertion below to mean anything. */
const MUST_REACH = [
  'packages/ui/src/inputs/DecimalInput.tsx',
  'apps/web/app/(app)/produtos/_components/PesoField.tsx',
];

/** Files rendering a `<NumberInput>` in CODE — comment mentions excluded. */
function offendingFiles() {
  const hits = gitGrep({ patterns: [PATTERN], pathspecs: PATHSPECS, mode: 'fixed', list: false });
  return [...new Set(hits.filter((h) => !COMMENT_LINE.test(textOf(h))).map(fileOf))].sort();
}

describe('decimal inputs go through DecimalInput', () => {
  it('the scan actually reaches both roots', () => {
    // ⚠️ Anti-vacuity. The assertions below expect `[]`, which passes just as
    // happily when the pathspec matches nothing at all. `DecimalInput` itself is
    // the probe: the name exists in the package that defines it AND in the app
    // that consumes it, so finding both proves each pathspec matches.
    const reached = new Set(
      gitGrep({ patterns: ['DecimalInput'], pathspecs: PATHSPECS, mode: 'fixed', list: true }),
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

  it('has no bare <NumberInput> outside the carve-outs', () => {
    const offenders = offendingFiles().filter((f) => !(f in CARVE_OUTS));

    expect(
      offenders,
      [
        'A bare <NumberInput> wipes the field on the keystroke that opens a decimal,',
        'because Mantine emits a STRING for every in-progress value. Offending files:',
        '',
        ...offenders.map((o) => `  - ${o}`),
        '',
        FIX,
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ every carve-out actually IS integer-only, so the reason is not just prose', () => {
    // ⭐ The reason strings were unenforced when this guard was written, and one
    // of the thirteen was simply FALSE: `ConfigIaPanel` claimed
    // `allowDecimal={false}` while rendering a bare decimal-capable field, so
    // `maxOutputTokens` (a `z.number().int()`) accepted 4096.5 and failed at
    // save time as a raw ZodError. An excuse nothing checks is an excuse that
    // drifts. Every non-owner entry makes the identical claim, so it is cheap
    // to verify: one `allowDecimal={false}` per `<NumberInput>` in the file.
    const counts = (pattern) => {
      const hits = gitGrep({
        patterns: [pattern],
        pathspecs: PATHSPECS,
        mode: 'fixed',
        list: false,
      });
      const byFile = new Map();
      for (const h of hits) {
        if (COMMENT_LINE.test(textOf(h))) continue;
        const f = fileOf(h);
        byFile.set(f, (byFile.get(f) ?? 0) + 1);
      }
      return byFile;
    };
    const inputs = counts(PATTERN);
    const guarded = counts('allowDecimal={false}');

    const unbacked = Object.keys(CARVE_OUTS)
      .filter((f) => !OWNERS.has(f))
      .map((f) => ({ f, n: inputs.get(f) ?? 0, g: guarded.get(f) ?? 0 }))
      .filter(({ n, g }) => g < n);

    expect(
      unbacked,
      [
        'These files are excused as "integer-only" but do not carry one',
        '`allowDecimal={false}` per `<NumberInput>`, so the stated reason is not true',
        'of the file and the field can take a decimal:',
        ...unbacked.map(({ f, n, g }) => `  - ${f}: ${n} <NumberInput>, ${g} allowDecimal={false}`),
        '',
        'Either add `allowDecimal={false}` (if it really is an integer field) or',
        'render `DecimalInput` and drop the carve-out.',
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ the comment filter spares prose and still catches code', () => {
    // Controls on synthetic lines, so the filter cannot rot into excluding
    // everything while the suite still reports green. The first two are VERBATIM
    // the shapes that made the first version of this guard wrong.
    const prose = [
      ' * ⚠️ The input is `DecimalInput`, never a bare `<NumberInput>`. This field',
      '// <NumberInput> was the old shape',
      '/* <NumberInput ... */',
    ];
    const code = ['    <NumberInput', '  return <NumberInput value={x} />;'];
    expect(prose.filter((l) => !COMMENT_LINE.test(l))).toEqual([]);
    expect(code.filter((l) => !COMMENT_LINE.test(l))).toEqual(code);
  });

  it('⚠️ every carve-out still renders one, so the list cannot rot', () => {
    // A carve-out for a file that no longer offends is an excuse nobody is
    // using, and the next reader copies it into a file that does.
    const offending = new Set(offendingFiles());
    const stale = Object.keys(CARVE_OUTS).filter((f) => !offending.has(f));
    expect(
      stale,
      [
        'These files are excused from the <NumberInput> ban but no longer render one.',
        'Delete their CARVE_OUTS entries:',
        ...stale.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });
});
