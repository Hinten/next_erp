import { describe, expect, it } from 'vitest';
import { gitGrep } from './lib/repo-scan.js';

/**
 * Every file using a shared **equivalence-key helper** is inventoried here, with
 * what its fold deliberately treats as equal and what must stay distinct. Use
 * one of those helpers in a new file and this test fails until you say which.
 *
 * ## The bug class (#1372)
 *
 * A *fold* is a transform whose OUTPUT decides whether two values are "the
 * same". The size-chart row diff folded `value_name` by parsing it to a NUMBER
 * so a pt-BR separator would not read as an edit — and collapsed far more than
 * the separator:
 *
 * | stored  | edited   | folded | verdict      |
 * |---------|----------|--------|--------------|
 * | `90,5`  | `90,50`  | `90.5` | "no change"  |
 * | `01`    | `1`      | `1`    | "no change"  |
 *
 * Both are real edits. `persistProgress` opens with `if (!updated) return;`, so
 * the edit reached neither Mercado Livre **nor** Firestore — it vanished behind
 * a 200, with a success toast on screen.
 *
 * ⭐ **A test that a normalization APPLIES is not a test of its SCOPE.** Eight
 * mutation tests ran against that fold before it shipped. Every one asked "does
 * the fold work?" — none asked "does it fold more than intended?". So a fold
 * needs BOTH: a pair that must come out equal, and a **near-miss** that must
 * stay distinct.
 *
 * ## Why this is a test and not an ESLint rule
 *
 * "This fold collapses more than intended" is semantic — it depends on what the
 * consumer means by "the same", which is nowhere in the syntax. The identical
 * reasoning is recorded in `reserva-arithmetic-inventory.test.js` for #931 and
 * in root `CLAUDE.md` rule 7 for transaction guards (#776). So this asserts the
 * one thing that IS mechanically checkable — the SET of files involved — and
 * makes the contract a reviewed artifact. Failing it fails CI exactly like a
 * lint error.
 *
 * ## ⚠️ What this does NOT catch
 *
 * A **hand-rolled** fold that uses no shared helper —
 * `a.trim().toLowerCase() === b.trim().toLowerCase()` — matches nothing here and
 * is invisible to this guard. Widening the pattern to raw `.toLowerCase()`
 * comparisons was measured and rejected: it lands in a ~47-file band of
 * formatters (`sanitizeCep`, `normalizeTelefone`) that are not this bug class,
 * and a guard with that many false positives trains people to add files without
 * reading them — which is the failure mode `reserva-arithmetic-inventory`
 * documents. The mitigation is convention: comparisons go through the shared
 * readers, the same trade `me-money-single-reader` and
 * `decimal-input-single-reader` already make.
 */

/**
 * The shared helpers whose output is (or can be) an equivalence key.
 *
 * ⚠️ Word-bounded, so `denormalizeLoosely` and `deepEqualityHint` do NOT match.
 * A guard with false positives is worse than none — see the control at the
 * bottom of this file.
 */
const PATTERN =
  '\\b(normalizeLoose|parseDecimalPtBr|parseCentesimos|localizarDecimal|deepEqual|stripNullsDeep|skuDoMembroUnico|skuPaiDoMembroUnico)\\b';

/**
 * Source only. Tests are excluded deliberately: a test SHOULD exercise a fold
 * from both sides, and inventorying test files would bury the one new source
 * call site this exists to surface.
 */
const PATHSPECS = [
  '*.ts',
  '*.tsx',
  '*.mjs',
  ':(exclude)*.test.ts',
  ':(exclude)*.test.tsx',
  ':(exclude)*.spec.ts',
  ':(exclude)apps/web/e2e/*',
  ':(exclude)tools/test-fixtures/*',
  ':(exclude)packages/config-eslint/rules/*',
];

/**
 * Path → what the fold collapses, what must stay distinct, and the test that
 * pins it. Grouped by role; the grouping IS the audit.
 */
const INVENTARIO = {
  // ---- Folds that DECIDE SAMENESS — each names its near-miss test ---------
  'apps/mercado-livre/lib/marketplace/fixtures/piiScan.ts':
    '`deepEqual` compares a committed wire body against its own re-redaction, so the fold decides "did redaction leave this leaf alone?". Equal: nothing beyond structural identity — same keys, same order-independent key SET, same primitive values, `null` only equal to `null`. Distinct: a redacted placeholder vs the value it replaced (that inequality IS the finding), `null` vs `"REDACTED"`, `0` vs `"0"`, and an array whose length differs. ⚠️ The dangerous direction here is folding too MUCH: a `deepEqual` that coerced types or ignored key order would report a leaked street address as "unchanged" and the corpus would ship it. Near-miss: `piiScan.test.ts` — "CONTROL A (known-bad) — an unredacted body reports every personal leaf" (must differ) paired with "CONTROL B (known-good) — the redacted body is a fixpoint, so it reports nothing" (must not).',
  'apps/mercado-livre/lib/marketplace/size-charts/sizeChartSync.ts':
    '⚠️ The #1372 site. `canonicalMeasureNames` folds every `value_name` through `localizarDecimal` for the row diff — SEPARATOR only. Equal: `90.5` ≡ `90,5`. Distinct: `90,5` ≠ `90,50`, `01` ≠ `1` — ML echoes the label verbatim on the anúncio. Near-miss: "a TRAILING-ZERO edit is a real change" + "a LABEL edit that only drops a leading zero".',
  'apps/web/lib/mercado-livre/chartDedupe.ts':
    '`parseCentesimos` keys the `atribuidos`/`pedidos` sets deciding which measurements duplicate. Equal: `10,5` ≡ `10.50` (ML receives the same `struct.number`, so they WOULD duplicate on its side). Distinct: one hundredth apart — that is the whole offset mechanism. Near-miss: "walks past a value a later row already holds".',
  'apps/web/lib/mercado-livre/chartRows.ts':
    'TWO folds. (1) `prefillSizeEquivalence` matches a size label by `normalizeLoose` — equal: case + diacritics; distinct: EXACT only, never a prefix, or `4` would claim `40`. Near-miss: "never matches a PREFIX or a near-miss". (2) `seedRows` applies `localizarDecimal` as a display transform on `kind === "number"` parts only — near-miss: "does NOT localize a dot in a non-numeric part".',
  'packages/integrations/mercado-livre/src/ai/medidasApply.ts':
    '`normalizeLoose` resolves a model answer onto a grid row and onto a closed-list option (BOTH the scalar and the array path); `localizarDecimal` localises a numeric answer. Equal: case + diacritics, nothing else. Distinct: a sibling one letter away, and a bare PREFIX of an option. Near-miss: "picks the option that matches, not the sibling one letter away" + "refuses a bare PREFIX of an option, keeping it as free text" + "never matches a PREFIX of a standard size" + "does NOT localize a dot in a non-numeric column".',
  'packages/integrations/mercado-livre/src/ai/attributeApply.ts':
    '`normalizeLoose` resolves a model answer onto ML’s option list. Equal: case + diacritics. Distinct: a sibling one letter away, and a bare PREFIX — a same-length pair alone kills a TRUNCATING fold but not a `.startsWith` one, so the test carries both. Near-miss: "picks the option that matches, not a sibling differing by one letter".',
  'packages/integrations/mercado-livre/src/ai/medidasSchema.ts':
    '`normalizeLoose` is the DEDUPE key for row labels — a collision drops a row and sets `truncated`, so it must fold exactly what `applyAiMedidas` resolves with and no more. Near-miss: "keeps two size labels that differ by more than case and accents".',

  // ---- The helpers themselves --------------------------------------------
  'packages/schemas/src/produto/pureLogic/familia.ts':
    'DEFINES the pair. `skuDoMembroUnico` derives a sole member sku as `<paiSku>-UN`; `skuPaiDoMembroUnico` is its inverse. The fold that matters is the MIRROR one: `planejarSincronizacaoDoMembroUnico` compares a stored member sku against `skuDoMembroUnico(paiAntes.sku)`, and a mismatch reads as "the operator diverged this field" — permanent, so an over-eager fold silently stops `sku` propagating for ever. Equal: leading/trailing whitespace on the parent value, since both sides trim; exactly one trailing suffix on the inverse. Distinct: `CAM-UNI` vs `CAM-UN`, and a base whose own code ends in `-UN` (parent `PARAFUSO-UN` gives member `PARAFUSO-UN-UN`, and the inverse gives `PARAFUSO-UN` — ONE suffix, never two). The inverse is genuinely AMBIGUOUS for a legacy member stored before the derivation existed, and the test pins that as a known limitation rather than hiding it. Near-miss: "strips at most one suffix" plus "leaves a sku that carries no suffix alone", and the ambiguity itself is pinned by "cannot tell a legacy member from a derived one when the parent sku ends in the suffix".',
  'apps/mercado-livre/lib/marketplace/pedidos/orderProdutoResolve.ts':
    'Uses the INVERSE to ask whether the ML `seller_sku` is a sole member one. The fold alone is NOT the decision: stripping also matches a variation child of a familia de MUITOS, because `cartesianVariations` builds `parentSku + codigo` and a codigo of `-UN` produces the identical string — binding its parent would move stock on a produto that owns no estoque rows. The rung is gated on `ehFamiliaDeUm`, i.e. on `filhoUnicoId`; the fold only proposes a candidate. Near-miss: "does NOT bind the parent when the sku belongs to a variation of a familia de MUITOS".',
  'apps/mercado-livre/lib/marketplace/importacao/import.ts':
    'Uses the INVERSE for rung 3 of the User-Products parent-sku cascade, and deliberately does not trust it alone: `skuPaiDeMembroUnicoExistente` strips only when a root produto really carries the stripped value, because rung 3 mostly serves familias this app never published. Equal: a member sku derived from an existing root. Distinct: a seller code that merely ends in `-UN`, where blind stripping mints a SECOND parent produto on re-import. Near-miss: "rung 3 — keeps a seller code that merely ENDS in the suffix".',
  'apps/web/app/(app)/despacho/checkout/_components/resolveScan.ts':
    'Uses the INVERSE to index a familia-de-um member under the sku printed on the box, which is the parent one. Gated on `paiId`, never on the sku shape: a ROOT whose own code ends in `-UN` would otherwise claim the stripped code, and scanning some OTHER produto sku would check off this line. Equal: a member derived sku and its parent one. Distinct: an own-sku match always wins, via two passes and last-wins. Near-miss: "registers no parent form for a ROOT whose own sku ends in the suffix".',
  'apps/web/app/(app)/produtos/_components/VariationManager.tsx':
    'Uses the DERIVE only, to stage the promoted survivor sku when the last variation is deleted and that row becomes the sole member. Not a comparison — it produces the value written, and the document takes the same value from the `espelhoDoPai` spread.',
  'packages/core/src/decimal/index.ts':
    'Defines `localizarDecimal` / `parseDecimalPtBr` / `parseCentesimos`. Own tests carry both directions, incl. the ambiguous forms each REFUSES to fold (`1.234,5`, three decimals).',
  'packages/ai/src/text.ts':
    'Defines `normalizeLoose` (trim, pt-BR lowercase, NFD, strip diacritics). The one place the fold’s exact reach is specified.',

  // ---- Not a comparison ---------------------------------------------------
  'apps/web/app/(app)/medidas/_components/SizeChartGrid.tsx':
    'Uses `localizarDecimal` as an INPUT transform on a numeric cell (typed `10.5` becomes `10,5`), never to compare. Nothing decides sameness here.',
  'packages/ai/src/index.ts': 'Barrel re-export of `normalizeLoose`. No fold.',
  'packages/ai/src/cells.ts':
    'Comment only — names `normalizeLoose` when explaining a neighbouring trade. No fold.',
  'packages/data/src/produto/usecases.ts':
    'Comment only — names `skuDoMembroUnico` to explain why `FilhoParaDuplicar.novoSku` is DISCARDED for a sole member (the sku is derived from the parent, not minted per child). The file never calls it: `buildDuplicarProdutoWriteOps` delegates to `montarMembroUnico`, so the derived value arrives already built and is written verbatim. Nothing here decides sameness — the family-of-one branch keys on `filhoUnicoId`, never on a sku.',
};

/** Files matching the pattern, over the index + untracked-but-not-ignored. */
function ficheirosComFold() {
  return gitGrep({ patterns: PATTERN, pathspecs: PATHSPECS, mode: 'extended' });
}

describe('every file folding a value to decide sameness is inventoried', () => {
  it('has no UNLISTED file using an equivalence-key helper', () => {
    const naoListados = ficheirosComFold().filter((f) => !(f in INVENTARIO));
    expect(
      naoListados,
      [
        'These files use a shared equivalence-key helper — a transform whose OUTPUT can',
        'decide whether two values are "the same". #1372 shipped one that collapsed',
        "`'90,5'` with `'90,50'` and `'01'` with `'1'`; the edit reached neither Mercado",
        'Livre nor Firestore and the operator saw a success toast.',
        '',
        'Add the file to INVENTARIO with a one-liner saying:',
        '',
        '  - what the fold DELIBERATELY treats as equal;',
        '  - what must stay DISTINCT, naming the near-miss test that pins it;',
        '  - or "not a comparison" when the helper is used for display/input only.',
        '',
        '⭐ A test that the fold APPLIES is not a test of its SCOPE. If you cannot name',
        'a near-miss test, write one first — that is the check this guard exists for.',
        '',
        'Offending files:',
        ...naoListados.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no STALE entry for a file that no longer uses one', () => {
    const atuais = new Set(ficheirosComFold());
    const obsoletos = Object.keys(INVENTARIO).filter((f) => !atuais.has(f));
    expect(
      obsoletos,
      [
        'These INVENTARIO entries no longer match anything — the file was renamed,',
        'deleted, or stopped using an equivalence-key helper. Remove them, so the',
        'inventory keeps being read as current rather than decoration:',
        ...obsoletos.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ matches the real helpers and NOT their lookalikes', () => {
    // A checker needs two controls: the known-bad must match and the known-good
    // must not. Without the negative half, widening the pattern until it caught
    // everything would go unnoticed — and a guard with false positives trains
    // people to add files without reading them, which defeats it entirely.
    const regex = new RegExp(PATTERN);

    expect(regex.test('normalizeLoose(row.size)')).toBe(true);
    expect(regex.test('const v = parseCentesimos(s.value_name);')).toBe(true);
    expect(regex.test('return canonicalMeasureNames(stripNullsDeep(copy));')).toBe(true);
    expect(regex.test('!deepEqual(rowDiffShape(row), rowDiffShape(storedRow))')).toBe(true);

    expect(regex.test('denormalizeLoosely(x)')).toBe(false);
    expect(regex.test('deepEqualityHint')).toBe(false);
    expect(regex.test('parseDecimalPtBrasil(x)')).toBe(false);
    expect(regex.test('localizarDecimalPlaces(x)')).toBe(false);
  });

  it('⚠️ still covers the file the guard was written for', () => {
    // The regression control. #1372's defect lived in `sizeChartSync.ts`; a
    // pattern that stopped matching it would leave the guard green over the very
    // bug it exists to prevent.
    expect(ficheirosComFold()).toContain(
      'apps/mercado-livre/lib/marketplace/size-charts/sizeChartSync.ts',
    );
  });
});
