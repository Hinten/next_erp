import type { DocumentReference, Firestore } from 'firebase/firestore';
import {
  type ImpostoCategoria,
  impostoCategoriaSchema,
  issuesDeEmissaoDasLinhas,
  nveCarriesValue,
  operacaoIdFromImpostoRef,
} from '@delfrance/schemas';
import { nowMillis } from '@delfrance/core/datetime';
import type {
  TransactionWrite,
  TransactionWriteContext,
  TransactionDocumentGuard,
  ValidationIssue,
} from '@delfrance/ui';
import { impostoCategoriaCollection } from '@/lib/data/impostoCategoriaCollection';

/**
 * The categoria page's `validate`: refuses to save a per-operação imposto row
 * the NF-e engine would refuse (#1655) — the same verdicts the engine throws
 * from, behind its own tier gate, so a row with no `origem` is never blocked.
 * `impostos` stays null until the Impostos tab seeds it, so a save that never
 * opened the tab checks nothing; once seeded, EVERY row is checked (each is
 * rewritten on save). Module-level so ObjectView's resolver memo stays stable.
 */
export function validarImpostosDaCategoria(values: Record<string, unknown>): ValidationIssue[] {
  return issuesDeEmissaoDasLinhas(values.impostos as unknown[] | null | undefined, 'impostos');
}

/**
 * True when `v` is, or recursively contains, a non-null leaf. A nested all-null
 * object (e.g. a toggled-then-cleared RTC blob `{ CST: null, is: {…null} }`)
 * correctly reads as empty — mirrors `hasNonNullLeaf` in
 * `packages/data/src/produto/usecases.ts` so categoria + produto agree.
 */
function hasNonNullLeaf(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === 'object') {
    return Object.values(v as Record<string, unknown>).some(hasNonNullLeaf);
  }
  return true;
}

/** True when a categoria imposto entry has any value worth persisting. */
export function categoriaImpostoCarriesInfo(imp: ImpostoCategoria): boolean {
  const strings = [
    imp.origem,
    imp.cfop,
    imp.cfopInterestadual,
    imp.NCM,
    imp.CEST,
    imp.CNPJFab,
    imp.cBenef,
    imp.extipi,
    imp.unidade,
  ];
  const configs = [
    imp.configuracaoICMS,
    imp.configuracaoIPI,
    imp.configuracaoPIS,
    imp.configuracaoCOFINS,
    imp.configuracaoPISST,
    imp.configuracaoISSQN,
    imp.retencao,
  ];
  // ⚠️ `NVE` and `indEscala` are NOT strings on the wire (#466) — see the twin
  // check in `packages/data/src/produto/usecases.ts`, which carries the full
  // note. `nveCarriesValue` is shared with it precisely because these two are
  // character-identical and have drifted before; it accepts the raw pre-#466
  // scalar a failed `parseSoftRead` hands back, which this decision runs on
  // BEFORE `impostoCategoriaSchema.parse` below.
  return (
    strings.some((v) => typeof v === 'string' && v.trim() !== '') ||
    nveCarriesValue(imp.NVE) ||
    imp.indEscala != null ||
    imp.compoeValorTotalDaNFe != null ||
    configs.some((c) => c != null) ||
    hasNonNullLeaf(imp.configuracaoIBSCBS)
  );
}

/**
 * The categoria's transient per-operação `imposto` docs to write
 * ATOMICALLY with the categoria doc (ObjectView `transactionWrites`). One doc
 * per active operação keyed by the operação id; an emptied entry that was
 * previously saved is deleted. Mirrors `buildProdutoTransactionWrites`'s imposto
 * leg, but with the correct-spelling `impostoCategoriaOperacaoOuterRef` scope key.
 */
export function buildCategoriaImpostoTransactionWrites(
  db: Firestore,
  categoriaId: string,
  values: Record<string, unknown>,
  context?: TransactionWriteContext,
): TransactionWrite[] {
  const impostos = (values.impostos as ImpostoCategoria[] | null) ?? null;
  if (!impostos || impostos.length === 0) return [];
  const writes: TransactionWrite[] = [];
  for (const imp of impostos) {
    const operacaoId = operacaoIdFromImpostoRef(imp.impostoCategoriaOperacaoOuterRef);
    if (!operacaoId) continue; // the UI only edits per-operação entries
    const ref = impostoCategoriaCollection.docRef(
      db,
      { categoriaId },
      operacaoId,
    ) as DocumentReference<unknown>;
    const guard: TransactionDocumentGuard = {
      baseline: context?.getBaseline(ref.path),
      label: `Imposto da categoria — operação ${operacaoId}`,
      formField: 'impostos',
      toFormValue: (current, formValue) => {
        const rows = (formValue as ImpostoCategoria[] | null) ?? [];
        const next = impostoCategoriaSchema.parse(
          current === null
            ? { impostoCategoriaOperacaoOuterRef: `operacao/${operacaoId}` }
            : {
                ...current,
                id: operacaoId,
                impostoCategoriaOperacaoOuterRef: `operacao/${operacaoId}`,
              },
        );
        const found = rows.some(
          (row) => operacaoIdFromImpostoRef(row.impostoCategoriaOperacaoOuterRef) === operacaoId,
        );
        return found
          ? rows.map((row) =>
              operacaoIdFromImpostoRef(row.impostoCategoriaOperacaoOuterRef) === operacaoId
                ? next
                : row,
            )
          : [...rows, next];
      },
    };
    if (categoriaImpostoCarriesInfo(imp)) {
      writes.push({
        type: 'set',
        ref,
        guard,
        data: impostoCategoriaSchema.parse({
          ...imp,
          id: operacaoId,
          impostoCategoriaOperacaoOuterRef: `operacao/${operacaoId}`,
          dataCadastro: imp.dataCadastro ?? nowMillis(),
        }) as Record<string, unknown>,
      });
    } else if (imp.id != null) {
      writes.push({ type: 'delete', ref, guard });
    }
  }
  return writes;
}
