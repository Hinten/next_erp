import type { DocumentReference, Firestore } from 'firebase/firestore';
import {
  type ImpostoCategoria,
  impostoCategoriaSchema,
  operacaoIdFromImpostoRef,
} from '@delfrance/schemas';
import { nowMillis } from '@delfrance/core/datetime';
import type {
  TransactionWrite,
  TransactionWriteContext,
  TransactionDocumentGuard,
} from '@delfrance/ui';
import { impostoCategoriaCollection } from '@/lib/data/impostoCategoriaCollection';

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
    imp.NVE,
    imp.CEST,
    imp.indEscala,
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
  return (
    strings.some((v) => typeof v === 'string' && v.trim() !== '') ||
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
