import { type DocumentReference, type Firestore, getDocFromServer } from 'firebase/firestore';
import { TRUNCATED_VALUE_KEY, valuesEqual } from '@delfrance/core';
import { produtoCollection } from '@/lib/data/produtoCollection';
import { produtoExtraDataCollection } from '@/lib/data/produtoExtraDataCollection';
import { impostoProdutoCollection } from '@/lib/data/impostoProdutoCollection';

/**
 * Per-field revert support for the "Modificações" tab — a WHITELIST of safe
 * fields that can be restored to a prior `historicoDeModificacoes` value,
 * scoped by which document the entry touched (`subcolecao: null` = the
 * produto doc itself, `'extraData'` / `'imposto'` = the matching
 * subcollection). Deliberately excludes anything server-owned/denormalized
 * (`componentesKitKeys`, `fotosArquivosIds`, …), identity/reference fields
 * that drive cascades (`paiId`, `variacoesUid`, `grupoDeVariacoesUid`), and
 * media (`fotos`/`videos`/`anexos` — those have their own staged-delete UX).
 */
export interface RevertScopeFields {
  produto: ReadonlySet<string>;
  extraData: ReadonlySet<string>;
  imposto: 'all-except-ignored';
}

/** Revertible top-level fields on the `produtos/{id}` doc itself. */
export const REVERTIBLE_PRODUTO_FIELDS: ReadonlySet<string> = new Set([
  'nome',
  'sku',
  'gtin',
  'codPai',
  'codFornecedor',
  'ordem',
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

/** One field revert to apply — everything `checkRevert`/`applyRevert` need. */
export interface RevertTarget {
  produtoId: string;
  subcolecao: string | null;
  docId: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

/** Resolves the converter-bound doc ref a revert target writes/reads through. */
function refFor(db: Firestore, target: RevertTarget): DocumentReference {
  if (target.subcolecao === null) {
    // The produto doc's entries carry docId == produtoId; key on `produtoId`
    // (the produto the UI is editing) so a malformed/mismatched target can
    // never read or write a DIFFERENT produto than the one it names.
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
 * Writes `target.oldValue` back onto `target.field`, via the collection
 * handle's `merge()` (never a raw `setDoc`/`updateDoc` — see the repo-wide
 * partial-update rule). `oldValue ?? null`: Firestore writes never contain
 * `undefined`, and a field that didn't exist before this entry's change
 * reverts to `null` (matching how the trigger itself coerces a missing
 * "before" value when it records history).
 *
 * Reverting a parent produto's `precos` re-fires the
 * `onProdutoPrecoCustoChanged` trigger like any other precos write — a new
 * `historicoDeModificacoes` entry and re-propagation to variation children.
 * That is intentional (see the ModificacoesManager's inline warning), not a
 * bug to work around here.
 */
export async function applyRevert(db: Firestore, target: RevertTarget): Promise<void> {
  // The whitelist is enforced HERE, not only at the UI gate: Firestore rules
  // don't re-encode it (a produto-writer may write any produto field), so a
  // crafted or future caller must not be able to revert an excluded field
  // (fotos, paiId, denorms…) by skipping the ModificacoesManager.
  const gate = isRevertible(target.subcolecao, target.field, {
    old: target.oldValue,
    new: target.newValue,
  });
  if (!gate.ok) {
    throw new Error(`revert: campo "${target.field}" não é restaurável — ${gate.reason}`);
  }
  const patch = { [target.field]: target.oldValue ?? null };
  if (target.subcolecao === null) {
    // Same rule as `refFor`: the produto scope keys on `produtoId`, never on
    // the entry-carried `docId`.
    await produtoCollection.merge(db, {}, target.produtoId, patch);
    return;
  }
  if (target.subcolecao === 'extraData') {
    await produtoExtraDataCollection.merge(
      db,
      { produtoId: target.produtoId },
      target.docId,
      patch,
    );
    return;
  }
  if (target.subcolecao === 'imposto') {
    await impostoProdutoCollection.merge(db, { produtoId: target.produtoId }, target.docId, patch);
    return;
  }
  throw new Error(`revert: unsupported subcolecao "${target.subcolecao}"`);
}
