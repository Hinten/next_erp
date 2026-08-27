import { describe, expect, it } from 'vitest';
import { gitGrep } from './lib/repo-scan.js';

/**
 * Every file that touches the stock RESERVATION is inventoried here, with how it
 * treats the value. Add a file that mentions `quantidadeReservada` (or any
 * `*Reservada` / bare `reservada`) and this test fails until you list it and say
 * which case you are in.
 *
 * ## Why this is a test and not an ESLint rule (#931)
 *
 * A lint rule was evaluated and **cannot catch this bug class**. The defect #931
 * was opened for lived in `importCore.ts`, which never contains the identifier at
 * all: it reads `args.existingEstoqueReservada` — a plain local, fed from a bare
 * `.data()` read three files away — and the arithmetic
 * (`availableQuantity + reservada`) sits on a different line from any name a rule
 * could key on. Following a value from an untyped read into an expression is
 * dataflow analysis; the repo's one type-aware rule (`prefer-schema-enum`) works
 * only because it keys on *declarations*, and there is no declaration to key on
 * here. A rule would have passed the very commit it was written to prevent.
 *
 * So this asserts the one thing that IS mechanically checkable — the SET of files
 * involved — and makes the justification a reviewed artifact. It is the same
 * shape as `env-secrets-no-copy.test.js`, `env-example-location.test.js` and
 * `defaultQuery.indexes.test.ts`: failing the test fails CI exactly like a lint
 * error would.
 *
 * ## The invariant being protected
 *
 * `disponivel = quantidade − quantidadeReservada`, so a NEGATIVE reservation
 * *increases* availability — `8 − (−2) = 10` — and nothing guarantees the stored
 * value is non-negative (the ML sweep reads raw pipeline rows, the ML import a
 * bare `.data()`, and the Flutter app plus every Admin SDK writer bypass the Zod
 * schema entirely). That is the one failure direction that makes Mercado Livre
 * sell stock the store does not have. See ADR 0014 §7.
 */

/**
 * `Reservada` (the camelCase suffix) or a standalone lowercase `reservada`.
 *
 * ⚠️ NOT a case-insensitive `reservada`: that also matches **`preservada`**
 * ("preserved" in Portuguese), which appears in `IcmsSection.tsx` and has nothing
 * to do with stock. A false positive in a guard like this trains people to add
 * files to the inventory without reading them, which defeats it.
 */
const PATTERN = 'Reservada|\\breservada\\b';

/**
 * Source only. Tests, e2e specs and seed fixtures are excluded: they *should*
 * construct negative reservations freely — several exist precisely to pin the
 * floor — and inventorying them would be noise that hides a real new call site.
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
 * Path → what that file does with the reservation. Grouped by treatment; the
 * grouping IS the audit #931 asked for.
 */
const INVENTARIO = {
  // ---- The floor itself ---------------------------------------------------
  'packages/schemas/src/produto/collection/estoque.ts':
    'Defines `reservaEfetiva` (the single floor) and `estoqueDisponivel`. The schema deliberately carries NO `.min(0)` — it failed the whole document in `parseSoftRead`.',

  // ---- Reads it, floors via reservaEfetiva / estoqueDisponivel -----------
  'apps/mercado-livre/lib/marketplace/importacao/importCore.ts':
    'Adds the reservation BACK into `quantidade` (ML `available_quantity` is `disponivel`). Both arms floor with `reservaEfetiva`; a raw negative would shrink stock on every re-import.',
  'apps/mercado-livre/lib/marketplace/estoque/bulkEstoquePlan.ts':
    'Sweep math over RAW pipeline rows. Every availability read goes through `estoqueDisponivel`. `desfazerMovimento` may synthesize a negative on purpose — floored downstream, pinned by a test.',
  'apps/mercado-livre/lib/marketplace/anuncios/upSoleMember.ts':
    '#1087 sole-member plan. SPLITS the parent row when publish gives a User-Products produto its one child: the child takes `quantidade - reservaEfetiva(...)` and the parent is left holding exactly the reserve. Floored through `reservaEfetiva`, then `Math.max(0, ...)` on the difference, so a negative stored value can neither inflate what moves nor push the remainder below zero. The reserve stays put deliberately — an open pedido’s release decrements the produto its LINE names, which is the parent.',
  'apps/mercado-livre/lib/marketplace/anuncios/upSoleMemberWrite.ts':
    '#1087 sole-member writer. Reads `quantidadeReservada` off the stored row and hands it to the planner above UNFLOORED and untyped — the floor is that planner’s, in one place, and this file does no arithmetic on it.',
  'apps/mercado-livre/scripts/check-deposito-source.ts':
    '#802 pre-flip check. Compares `disponivel` at the conta’s depósito against the legacy hardcoded one, both through `estoqueDisponivel`, so the floor is the sweep’s own. A missing doc or a missing field reads as 0 — deliberately, since that is exactly what the sweep publishes for a family with no estoque at the depósito.',
  'apps/web/app/(app)/pedidos/_components/useEstoqueDisponivel.ts':
    'Pedido-form availability. Sums through `estoqueDisponivel` / `estoqueDisponivelComKit`.',
  'apps/web/app/(app)/produtos/_components/EstoqueManager.tsx':
    'Estoque tab. Displays the stored value verbatim (deliberately — the defect must stay visible) and computes availability through `estoqueDisponivel`.',
  'apps/web/app/(app)/produtos/_components/EstoqueMovimentacaoModal.tsx':
    'Movement editor. Local input state only; availability preview goes through `estoqueDisponivel`.',

  // ---- Writes it, floors the RESULT ---------------------------------------
  'apps/functions/src/estoques/aplicarEstoque.ts':
    'Read-free WriteBatch: `increment` followed by `FieldValue.maximum(0)` on the same doc, so the stored counter cannot land below zero.',
  'apps/functions/src/estoques/sincronizarEstoquePedido.ts':
    'Transactional pedido→estoque sync. Floors with `Math.max(0, …)` and raises an `estoque-drift` incidente when the floor absorbs a release.',
  'packages/data/src/produto/usecases.ts':
    '`planMovimentacao`. Clamps a balanço’s counted reservation and the resulting saldo; the entrada/saída DELTA stays signed by design (it is an increment).',
  'packages/data/src/balanco/finalizePlan.ts':
    'Balanço finalize planner. `contadoresSaos` treats a negative reservation as STORED JUNK, so such a row is deliberately not `inalterado` — it gets a real write and self-heals; the clamp itself happens once, inside `planMovimentacao`.',

  // ---- Rejects a bad value at a boundary ----------------------------------
  'packages/data/src/produto/estoqueComando.ts':
    'The `aplicarEstoque` callable input — UNTRUSTED. Keeps `z.number().min(0).finite()`; this is where a negative write is actually rejected.',
  'packages/schemas/src/produto/pageModel/pageModel.ts':
    'Produto page validation. Flags a negative reservation (and one exceeding the quantity) so a defective row is visible to a human, not only in a console.warn.',

  // ---- Signed delta — must NOT be floored ---------------------------------
  'tools/migrations/src/2026-08-historico-estoque-v2/transform.ts':
    '⚠️ v1→v2 ledger. `movimentoReservada` is a SIGNED delta; flooring it would corrupt the summable-ledger invariant ADR 0014 §4 depends on.',
  'packages/data/src/pedido/estoquePlan.ts':
    '⚠️ Plan-space deltas (`resAlvo − resAplicado`), not the stored counter. A negative delta is a release and must stay signed.',

  // ---- Raw read; floored by its consumer ----------------------------------
  'apps/mercado-livre/lib/marketplace/importacao/import.ts':
    '`readEstoque` returns the stored value RAW on purpose (nothing launders the evidence); its only consumer is `importCore`, which floors.',
  'apps/mercado-livre/lib/marketplace/importacao/importVariations.ts':
    'Second copy of `readEstoque`, same contract.',
  'apps/functions/src/estoques/aplicarBalanco.ts':
    'Passes the stored counters into `planejarItemBalanco` straight off `.data()`, uncoerced on purpose — `finalizePlan` owns both the coercion and the `>= 0` sanity check.',

  // ---- Declarations, display, diagnostics — no arithmetic -----------------
  'packages/schemas/src/produto/collection/historicoEstoque.ts':
    'Ledger schema: declares `movimentoReservada` / `saldoReservada`. No arithmetic.',
  'packages/schemas/src/pedido/collection/pedido.ts':
    'Declares `estoqueAplicado.reservado`, the per-pedido snapshot of held reservation.',
  'packages/schemas/src/pedido/pureLogic/estoque.ts':
    'Decides WHETHER to reserve (a boolean); no numeric reservation math.',
  'packages/data/src/admin/collections/incidenteCollection.ts':
    'Comment only — names the estoque-drift incidente.',
  'apps/web/lib/data/estoqueProdutoCollection.ts':
    'Comment only — notes the counters are movement-owned.',
  'apps/web/app/(app)/pedidos/_components/tabs/EstoqueSyncTab.tsx':
    'Displays `movimentoReservada` as a signed delta. No arithmetic.',
  'apps/mercado-livre/scripts/check-stock-indexes.mjs':
    'Index-verification script mirroring the sweep pipelines. Projections and seed fixtures only.',

  // ---- Reads it in order to REPORT on it ---------------------------------
  'tools/migrations/src/2026-08-estoque-reservada-negativa/predicate.ts':
    'The #931 audit’s classifier. Reads the stored value RAW on purpose — it is the evidence — and only uses `estoqueDisponivel` to report what the row would have invented.',
  'tools/migrations/src/2026-08-estoque-reservada-negativa/audit.ts':
    'The audit’s walk. Filters `< 0` in memory and reads each hit’s ledger; writes nothing (`--apply` is rejected).',
};

/** Files matching the pattern, over the index + untracked-but-not-ignored. */
function ficheirosComReserva() {
  return gitGrep({ patterns: PATTERN, pathspecs: PATHSPECS, mode: 'extended' });
}

describe('every file touching the stock reservation is inventoried', () => {
  it('has no UNLISTED file mentioning the reservation', () => {
    const naoListados = ficheirosComReserva().filter((f) => !(f in INVENTARIO));
    expect(
      naoListados,
      [
        'These files touch `quantidadeReservada` (or a `*Reservada` sibling) and are not in',
        'INVENTARIO. A negative reservation INCREASES availability (`8 - (-2) = 10`) and',
        'nothing guarantees the stored value is >= 0, so a new call site has to state which',
        'case it is in:',
        '',
        '  - reading it for availability  -> go through `estoqueDisponivel` / `reservaEfetiva`',
        '  - writing the counter          -> floor the RESULT (`Math.max(0, ...)` / `maximum(0)`)',
        '  - a signed ledger/plan delta   -> do NOT floor it, and say so',
        '',
        'Then add the file here with that one-liner. Offending files:',
        ...naoListados.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('has no STALE entry for a file that no longer mentions it', () => {
    const atuais = new Set(ficheirosComReserva());
    const obsoletos = Object.keys(INVENTARIO).filter((f) => !atuais.has(f));
    expect(
      obsoletos,
      [
        'These INVENTARIO entries no longer match anything — the file was renamed, deleted,',
        'or stopped touching the reservation. Remove them, so the inventory keeps being read',
        'as current rather than decoration:',
        ...obsoletos.map((f) => `  - ${f}`),
      ].join('\n'),
    ).toEqual([]);
  });

  it('⚠️ does not match `preservada`, which is an unrelated Portuguese word', () => {
    // A guard with false positives trains people to add files without reading
    // them, which defeats the point. `IcmsSection.tsx` says "preservada"
    // ("preserved") and has nothing to do with stock.
    const regex = new RegExp(PATTERN);
    expect(regex.test('preservada')).toBe(false);
    expect(regex.test('quantidadeReservada')).toBe(true);
    expect(regex.test('existingStock?.reservada')).toBe(true);
    expect(regex.test('movimentoReservada')).toBe(true);
  });
});
