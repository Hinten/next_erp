/**
 * The create-time SKU probe of the Loja Integrada product import (master plan step 9): before the
 * import CREATES any produto, every SKU the create would write — the parent's, each variation's,
 * and a sole member's derived one — is looked up across the WHOLE ERP catalogue, so the import
 * never writes a second produto with a SKU the ERP already has.
 *
 * ## Why it lives here
 *
 * On this data `sku` is the de-facto unique produto key: two produtos with one SKU make every
 * order resolver answer "ambiguous", so a sale moves no stock. The decision "may this SKU be
 * created?" therefore reads Firestore AND folds a SKU, and `resolveProdutoPorSku.ts` is the
 * precedent for where that pair lives: a `packages/data` function owns its fold's use and its
 * `equivalence-fold-inventory` row, and its callers (the import's family create and add-variation
 * paths) carry neither.
 *
 * ## What it answers
 *
 * Per SKU, two lists of produto ids, roots and variations alike (no `paiId` filter: a store
 * variation's SKU equal to an ERP ROOT's, or to ANOTHER family's variation, is the same
 * collision):
 *
 *  - `exatos`: the stored `sku` is the SAME string, byte for byte (`mesmoSkuLi`'s identity);
 *  - `parecidos`: the stored `sku` is one of the store SKU's OTHER probe forms (`skuParecidoLi`:
 *    trimmed, upper-cased, lower-cased, and both after trimming) — a near duplicate a person must
 *    look at; the import neither creates beside it nor links by it.
 *
 * ⚠️ A guard for the common cases, never a full fold: only the STORE side is folded. An ERP SKU
 * in MIXED case (`'Abc-1'` against the store's `'abc-1'`) or with spaces at its own ends
 * (`'ABC-1 '` against `'ABC-1'`) is NOT reached — the Simular report is the backstop for those.
 *
 * ## Cost
 *
 * One unscoped `produtos where sku in [...]` per {@link MAX_VALORES_IN_SONDA_SKU_LI} probe forms,
 * projected to `sku`, all served by the `produtos (sku ASC)` index declared in
 * `firestore.indexes.json` (on Firestore Enterprise an unindexed predicate silently full-scans and
 * bills the data scanned). The forms of every SKU are de-duplicated before they are chunked.
 *
 * ## Race discipline
 *
 * A read, never a write. The caller runs it in the SAME dispatch immediately before its commit,
 * with no Loja Integrada call in between, and its create ids are keyed by the SKU, so a racing
 * create of the same SKU collides on the id (`ALREADY_EXISTS`). The residual — an operator's
 * hand-made produto (an auto id) landing between this probe and the commit — is caught by the
 * next run's match, which then finds two produtos for one SKU.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { skuParecidoLi } from '@delfrance/schemas';

import { produtoCollection } from '../collections';

/** Firestore's ceiling on the values of one `in` filter. */
export const MAX_VALORES_IN_SONDA_SKU_LI = 30;

/** What the probe found for ONE store SKU. Ids sorted ascending, never repeated. */
export interface SondaSkuLi {
  /** Produtos whose stored `sku` is exactly this SKU. */
  readonly exatos: readonly string[];
  /** Produtos whose stored `sku` is another probe form of it (never one already in `exatos`). */
  readonly parecidos: readonly string[];
}

/**
 * Probe the whole ERP catalogue for each SKU a create would write.
 *
 * Every SKU must be a non-empty string: a store product with no SKU is refused before any create
 * (`sem-sku`), so an empty one here is a caller bug, and it throws a `RangeError` before any read
 * rather than answering "no collision" for a SKU nothing can be created with. An empty list reads
 * nothing.
 *
 * Firestore errors propagate: the dispatch that called it retries.
 *
 * Equal (an `exatos` hit): a variation's `'X-AZ'` against an ERP ROOT `'X-AZ'` or another family's
 * variation `'X-AZ'`; a derived `'X-UN'` against an existing `'X-UN'`.
 * Parecido: `'abc-1'`, `'ABC-1 '` or `' Abc-1'` against an ERP `'ABC-1'`.
 * Distinct (no hit): `'X-AZ'` against `'X-AZUL'`; `'ABC-2'`, `'ABC1'`, `'ABC-1-UN'` against
 * `'ABC-1'`; a numeric stored `123` against `'123'`. Not reached (the stated limit): `'abc-1'`
 * against an ERP `'Abc-1'`, and `'ABC-1'` against an ERP `'ABC-1 '`.
 */
export async function sondarSkusLi(
  db: Firestore,
  skus: readonly string[],
): Promise<ReadonlyMap<string, SondaSkuLi>> {
  const formasPorSku = new Map<string, ReadonlySet<string>>();
  for (const sku of skus) {
    if (typeof sku !== 'string' || sku === '') {
      throw new RangeError('sondarSkusLi: um SKU vazio não pode ser sondado (sem-sku)');
    }
    // `skuParecidoLi` lists the SKU itself first; the set keeps the exact form beside the others.
    if (!formasPorSku.has(sku)) formasPorSku.set(sku, new Set(skuParecidoLi(sku)));
  }

  const formas: string[] = [];
  const vistas = new Set<string>();
  for (const formasDoSku of formasPorSku.values()) {
    for (const forma of formasDoSku) {
      if (!vistas.has(forma)) {
        vistas.add(forma);
        formas.push(forma);
      }
    }
  }

  const blocos: string[][] = [];
  for (let i = 0; i < formas.length; i += MAX_VALORES_IN_SONDA_SKU_LI) {
    blocos.push(formas.slice(i, i + MAX_VALORES_IN_SONDA_SKU_LI));
  }
  const snaps = await Promise.all(
    blocos.map((bloco) =>
      produtoCollection.ref(db, {}).where('sku', 'in', bloco).select('sku').get(),
    ),
  );

  const exatos = new Map<string, Set<string>>();
  const parecidos = new Map<string, Set<string>>();
  for (const sku of formasPorSku.keys()) {
    exatos.set(sku, new Set());
    parecidos.set(sku, new Set());
  }
  for (const snap of snaps) {
    for (const doc of snap.docs) {
      const armazenado: unknown = (doc.data() as Record<string, unknown>).sku;
      // Firestore's `in` is type-strict, so only a string can come back; anything else names no SKU.
      if (typeof armazenado !== 'string') continue;
      for (const [sku, formasDoSku] of formasPorSku) {
        if (armazenado === sku) exatos.get(sku)?.add(doc.id);
        else if (formasDoSku.has(armazenado)) parecidos.get(sku)?.add(doc.id);
      }
    }
  }

  const saida = new Map<string, SondaSkuLi>();
  for (const sku of formasPorSku.keys()) {
    saida.set(sku, {
      exatos: [...(exatos.get(sku) ?? [])].sort(),
      parecidos: [...(parecidos.get(sku) ?? [])].sort(),
    });
  }
  return saida;
}
