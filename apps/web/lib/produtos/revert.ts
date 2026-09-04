import { type DocumentReference, type Firestore, getDocFromServer } from 'firebase/firestore';
import { TRUNCATED_VALUE_KEY, valuesEqual } from '@delfrance/core';
import {
  operacaoIdFromImpostoRef,
  type ImpostoProduto,
  type ProdutoExtraData,
} from '@delfrance/schemas';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import { impostoProdutoCollection } from '@/lib/data/impostoProdutoCollection';

/**
 * Per-field revert support for the "Modificações" tab — a WHITELIST of safe
 * fields that can be STAGED back to a prior `historicoDeModificacoes` value,
 * scoped by which document the entry touched (`subcolecao: null` = the
 * produto doc itself, `'extraData'` / `'imposto'` = the matching
 * subcollection). Deliberately excludes anything server-owned/denormalized
 * (`componentesKitKeys`, `fotosArquivosIds`, …), identity/reference fields
 * that drive cascades (`paiId`, `filhoUnicoId`, `variacoesUid`, `grupoDeVariacoesUid`), and
 * media (`fotos`/`videos`/`anexos` — those have their own staged-delete UX).
 */
export interface RevertScopeFields {
  produto: ReadonlySet<string>;
  extraData: ReadonlySet<string>;
  imposto: 'all-except-ignored';
}

/**
 * Revertible top-level fields on the `produtos/{id}` doc itself.
 *
 * ⚠️ Every one of these must have a RENDERED INPUT on the produto form —
 * `produtoFields.test.ts` asserts the set is disjoint from
 * `PRODUTO_EXCLUDED_FIELDS`. Since a revert is staged into that form (#660)
 * rather than written directly, offering one for a field the form does not show
 * tells the operator a value is waiting to be reviewed with nothing to review
 * and no tab to jump to. `ordem` was in this list and is excluded from the form,
 * which is exactly that case: it is server-ordering, not operator data.
 */
export const REVERTIBLE_PRODUTO_FIELDS: ReadonlySet<string> = new Set([
  'nome',
  'sku',
  'gtin',
  'codPai',
  'codFornecedor',
  'custo',
  'precos',
  'pesoLiquidoKg',
  'pesoBrutoKg',
  'alturaCm',
  'larguraCm',
  'profundidadeCm',
  'publicado',
  'ofereceFreteGratis',
  'permiteVendaSemEstoque',
  'ehUsado',
  'crossdocking',
  'categoriaProdutoOuterRef',
  'tabelaDeMedidasModaUid',
  'propagatePriceToChildren',
]);

/** Revertible fields on the `produtos/{id}/extraData/singleton` doc. */
export const REVERTIBLE_EXTRA_DATA_FIELDS: ReadonlySet<string> = new Set([
  'descricao',
  'marca',
  'metaDescricao',
  'keyWords',
  'youtube',
  'condicao',
  'coteudoAdulto',
  'itensNoKit',
  'googleMerchantData',
]);

/** `imposto` fields NEVER revertible — server/doc identity, not user data. */
const IMPOSTO_IGNORED_FIELDS: ReadonlySet<string> = new Set(['id', 'timestamp']);

export const REVERT_SCOPE_FIELDS: RevertScopeFields = {
  produto: REVERTIBLE_PRODUTO_FIELDS,
  extraData: REVERTIBLE_EXTRA_DATA_FIELDS,
  imposto: 'all-except-ignored',
};

/** `true` when `value` is the `diffDocumentFields` truncation sentinel (`@delfrance/core`). */
function isTruncationSentinel(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<string, unknown>)[TRUNCATED_VALUE_KEY] === true
  );
}

/**
 * Whether a single field change from a `historicoDeModificacoes` entry can be
 * restored. `subcolecao` picks the whitelist scope (`null` = produto doc,
 * `'extraData'`/`'imposto'` = the matching subcollection; anything else is
 * never revertible — v1 only knows these three). Either side of `change`
 * being the truncation sentinel blocks the revert regardless of whitelist
 * membership: the trigger never stored the real value, so there is nothing
 * to restore TO (or FROM, for the conflict check). Callers must not call this
 * for a `create`/`delete` kind entry — those never show a Restaurar control.
 */
export function isRevertible(
  subcolecao: string | null,
  field: string,
  change: { old: unknown; new: unknown },
): { ok: boolean; reason: string | null } {
  if (isTruncationSentinel(change.old) || isTruncationSentinel(change.new)) {
    return { ok: false, reason: 'Valor muito grande para restaurar automaticamente.' };
  }
  const whitelisted =
    subcolecao === null
      ? REVERTIBLE_PRODUTO_FIELDS.has(field)
      : subcolecao === 'extraData'
        ? REVERTIBLE_EXTRA_DATA_FIELDS.has(field)
        : subcolecao === 'imposto'
          ? !IMPOSTO_IGNORED_FIELDS.has(field)
          : false;
  if (!whitelisted) {
    return { ok: false, reason: 'Este campo não pode ser restaurado.' };
  }
  return { ok: true, reason: null };
}

/** One field revert to stage — everything `checkRevert`/`buildRevertPrefill` need. */
export interface RevertTarget {
  produtoId: string;
  subcolecao: string | null;
  docId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** Resolves the converter-bound doc ref a revert target reads through. */
function refFor(db: Firestore, target: RevertTarget): DocumentReference {
  if (target.subcolecao === null) {
    // The produto doc's entries carry docId == produtoId; key on `produtoId`
    // (the produto the UI is editing) so a malformed/mismatched target can
    // never read a DIFFERENT produto than the one it names.
    return produtoCollection.docRef(db, {}, target.produtoId) as DocumentReference;
  }
  if (target.subcolecao === 'extraData') {
    return produtoExtraDataCollection.docRef(
      db,
      { produtoId: target.produtoId },
      target.docId,
    ) as DocumentReference;
  }
  if (target.subcolecao === 'imposto') {
    return impostoProdutoCollection.docRef(
      db,
      { produtoId: target.produtoId },
      target.docId,
    ) as DocumentReference;
  }
  throw new Error(`revert: unsupported subcolecao "${target.subcolecao}"`);
}

/**
 * Advisory conflict check — there is no optimistic locking anywhere in this
 * app (last-write-wins), so this is the closest we get to warning a user
 * their revert would clobber a newer edit. Reads the target doc FRESH from
 * the server (never the local cache: a stale read would silently hide a
 * genuine conflict) and compares `field`'s current value against the
 * `new` side the history entry recorded — if they differ, someone/something
 * changed the field again since this entry was written.
 */
export async function checkRevert(
  db: Firestore,
  target: RevertTarget,
): Promise<{ conflict: boolean; currentValue: unknown }> {
  const snap = await getDocFromServer(refFor(db, target));
  const data = snap.data() as Record<string, unknown> | undefined;
  const currentValue = data ? (data[target.field] ?? null) : null;
  return { conflict: !valuesEqual(currentValue, target.newValue), currentValue };
}

/**
 * A revert that could not be staged. Separate from the plain `Error` a gate
 * violation raises so the UI can narrow on it (repo rule 6) and show the
 * operator the pt-BR reason instead of rethrowing.
 */
export class RevertPrefillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RevertPrefillError';
  }
}

/** The `setValue(key, value)` arguments that stage one revert in the form. */
export interface RevertPrefill {
  /** TOP-LEVEL form key to write — never a dotted path. */
  key: string;
  value: unknown;
}

/**
 * The current form values a revert has to be folded into. Both are TRANSIENT
 * fields on the produto page model, `null` until their own tab seeds them —
 * the caller must load them first (see `ModificacoesManager`), because folding
 * an `extraData` revert into an empty object would blank every sibling field of
 * that document on save.
 */
export interface RevertPrefillBase {
  extraData: ProdutoExtraData | null;
  impostos: ImpostoProduto[] | null;
}

/**
 * Builds the form pre-fill that STAGES a revert — nothing is written here.
 *
 * "Restaurar" used to `merge()` straight to Firestore, which the open form was
 * never told about: the operator saw a success toast over an unchanged screen,
 * and the next "Salvar" wrote the stale form values back over the revert
 * (#660). Staging instead means the revert rides the normal save — one write,
 * one history entry, the usual validation, and for a parent's `precos` the
 * usual re-propagation to variation children — and stays reviewable until the
 * operator commits it.
 *
 * Pure, so the mapping from a history entry to a form key is unit-testable
 * without React or Firestore.
 *
 * `oldValue ?? null`: Firestore writes never contain `undefined`, and a field
 * that did not exist before this entry's change reverts to `null` (matching how
 * the trigger coerces a missing "before" value when it records history).
 */
export function buildRevertPrefill(target: RevertTarget, base: RevertPrefillBase): RevertPrefill {
  // The whitelist is enforced HERE, not only at the UI gate: this is the single
  // choke point every revert passes through, so a crafted or future caller must
  // not be able to stage an excluded field (fotos, paiId, denorms…) by skipping
  // the ModificacoesManager. Firestore rules don't re-encode it — a
  // produto-writer may write any produto field.
  const gate = isRevertible(target.subcolecao, target.field, {
    old: target.oldValue,
    new: target.newValue,
  });
  if (!gate.ok) {
    throw new Error(`revert: campo "${target.field}" não é restaurável — ${gate.reason}`);
  }
  const oldValue = target.oldValue ?? null;

  if (target.subcolecao === null) {
    // Produto-doc fields are form keys 1:1 — the trigger records top-level keys
    // and only the pedido source ever expands to dotted ones.
    return { key: target.field, value: oldValue };
  }

  if (target.subcolecao === 'extraData') {
    if (base.extraData === null) {
      throw new RevertPrefillError('Os dados da aba Descrição ainda não foram carregados.');
    }
    return { key: 'extraData', value: { ...base.extraData, [target.field]: oldValue } };
  }

  if (target.subcolecao === 'imposto') {
    if (base.impostos === null) {
      throw new RevertPrefillError('Os dados da aba Impostos ainda não foram carregados.');
    }
    // The entry's docId IS the operação id; the form rows carry it inside
    // `impostoOpercaoOuterRef`. A row can be missing when its operação was
    // deactivated after the entry was recorded — the tab would not render it,
    // so there is nowhere to stage the value.
    const index = base.impostos.findIndex(
      (row) => operacaoIdFromImpostoRef(row.impostoOpercaoOuterRef) === target.docId,
    );
    if (index < 0) {
      throw new RevertPrefillError(
        'A operação deste imposto não está mais ativa — não é possível restaurar pelo formulário.',
      );
    }
    const rows = [...base.impostos];
    rows[index] = { ...rows[index], [target.field]: oldValue } as ImpostoProduto;
    return { key: 'impostos', value: rows };
  }

  throw new Error(`revert: unsupported subcolecao "${target.subcolecao}"`);
}
