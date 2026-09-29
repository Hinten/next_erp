/**
 * Prices and stock, WRITTEN (#1517, step 9) — the stock-row reader the preparo
 * needs, the ONE guarded write of the import, and the stock upsert.
 *
 * ## ⚠️ The price patch runs BEFORE the produto merge, and the order is the design
 *
 * On the UPDATE path the price write is a DOTTED-PATH `update` naming only the
 * conta's own tabela key (`precos.<tabelaId>`), so the legacy `precos` map is
 * never re-validated and a sibling tabela provably cannot be touched. It is the
 * one guarded write here (root CLAUDE.md rule 7, tier 1): the patch is derived
 * from the PREPARO's read of the produto, so it asserts THAT read's
 * `updateTime` — carried on the plan, `EscritaDePrecos.lastUpdateTime` — and
 * never a re-read taken here. The window it covers is therefore the whole
 * preparo → patch span, which is where the decision was made: a concurrent
 * writer anywhere in it — a retrying import, the item webhook, an operator
 * saving the produto editor — fails FAILED_PRECONDITION instead of being
 * silently reverted, and the importer re-plans once against a fresh read.
 *
 * The produto merge always writes on the update path (it carries
 * `ultimaModificacao`), which BUMPS `updateTime`. Running the merge first would
 * make this precondition assert a stamp we had just invalidated OURSELVES,
 * failing every single price-writing import. So the guarded write goes first;
 * the only writes the import makes before it are the taxonomia and the
 * categorias, and neither is a produto document, so the stamp the preparo read
 * is still the produto's own unless SOMEONE ELSE wrote it. On CREATE there is
 * nothing to clear and the price is already folded into the full document, so
 * there is no patch at all.
 *
 * ⚠️ What the guard cannot see is a write to a DIFFERENT document. The parent's
 * price is planned only for a parent with no children, and a child created in
 * the preparo → patch window leaves the parent's stamp alone unless its writer
 * also touches the parent — the ERP's own family-forming writer does (it stamps
 * `filhoUnicoId` in the same atomic write), a child written on its own does
 * not. The patch then lands on a parent that now owns a child, and
 * `onProdutoChanged` propagates the parent's map onto that child whenever the
 * parent's `propagatePriceToChildren` is not `false`. Accepted and documented,
 * not guarded: closing it would need the `paiId` query inside the same guard,
 * which a single-document precondition cannot express.
 *
 * Set-only: nothing here ever DELETES a price key. `tabelaPromocionalOuterRef`
 * is never written by an import (#803's stance, taken again for Shopee) — the
 * promotional table belongs to promotions the operator authors in the ERP.
 *
 * ## ⚠️ Stock: the write targets the row it READ
 *
 * The Shopee legacy created stock rows at Firestore AUTO ids. Upserting at the
 * canonical `makeEstoqueUid` beside one of those creates a PHANTOM the operator
 * then sees twice, with the real row invisible to this importer for ever. So the
 * reader answers the document id it found, and only a depósito with no row at
 * all gets a new document at the canonical id.
 *
 * ⚠️ The reservation is read here and added back to the quantity, floored
 * through the shared reader — see {@link lerLinhaDeEstoque}.
 *
 * ⚠️ A parent that owns children NEVER carries stock. That decision lives in the
 * pure planner (which weighs the payload's `has_model` AND the ERP's own child
 * set); this module only ever writes what the plan produced, and a `null`
 * estoque entry means the planner already said no.
 *
 * Next-free, clock-free.
 */
import type { Firestore, Timestamp } from 'firebase-admin/firestore';
import { isFailedPrecondition } from '@delfrance/data/admin';
import { estoqueCollection, produtoCollection } from '@delfrance/data/admin/collections';

import type { LinhaEstoqueLida } from './mapeamento';
import type { EscritaDeEstoque, EscritaDePrecos } from './planoImportacao';

/** The last path segment of an outer ref — `documents/depositos/d1` ⇒ `d1`. */
function idDeRef(ref: string): string {
  const partes = ref.split('/').filter((s) => s.length > 0);
  return partes[partes.length - 1] ?? ref;
}

/**
 * The produto's stock row for ONE depósito, as the plan consumes it.
 *
 * ⚠️ The whole subcollection is read and filtered in memory, deliberately: it
 * holds one row per warehouse (a handful), the legacy ids are auto-generated so
 * there is no id to look up, and a `where('depositoOuterRef','==',…)` would need
 * its own index on a collection group nothing else queries.
 *
 * ⚠️ `quantidadeReservada` is read RAW — the Admin SDK applies no Zod here — and
 * it is deliberately NOT floored at rest (#931): a stored negative is a fact the
 * audit wants to keep visible. It is floored at the one place it is USED, which
 * is the pure planner's `quantidade = <Shopee's buyable count> + reservaEfetiva(...)`
 * arithmetic; carrying the raw value across this seam is what lets that single
 * floor be the single floor.
 */
export async function lerLinhaDeEstoque(
  db: Firestore,
  produtoId: string,
  depositoOuterRef: string | null,
): Promise<LinhaEstoqueLida | null> {
  if (depositoOuterRef === null) return null;
  const depositoId = idDeRef(depositoOuterRef);
  const snap = await estoqueCollection.ref(db, { produtoId }).get();
  for (const doc of snap.docs) {
    const raw = (doc.data() ?? {}) as {
      depositoOuterRef?: unknown;
      quantidade?: unknown;
      quantidadeReservada?: unknown;
    };
    if (typeof raw.depositoOuterRef !== 'string') continue;
    if (idDeRef(raw.depositoOuterRef) !== depositoId) continue;
    return {
      docId: doc.id,
      quantidade: typeof raw.quantidade === 'number' ? raw.quantidade : 0,
      quantidadeReservada:
        typeof raw.quantidadeReservada === 'number' ? raw.quantidadeReservada : 0,
    };
  }
  return null;
}

/**
 * The produto this import planned a price for changed under it.
 *
 * ⚠️ A distinct class, and NOT a `ShopeeImportBlockedError`: a lost precondition
 * is a transient race the importer answers by re-reading and RE-PLANNING the
 * whole item once, whereas a blocked reason is a verdict persisted in
 * `failures[].motivo` and shown to an operator. Conflating them would put "two
 * writers touched one produto at the same second" in a catalogue of broken
 * listings.
 */
export class ShopeePrecoDesatualizadoError extends Error {
  readonly produtoId: string;

  constructor(produtoId: string) {
    super(
      `precos: o produto ${produtoId} mudou entre a leitura e a escrita — ` +
        'reler e replanejar, nunca reaplicar o mesmo patch.',
    );
    this.name = 'ShopeePrecoDesatualizadoError';
    this.produtoId = produtoId;
  }
}

/**
 * The guarded dotted-path price patch.
 *
 * ⚠️ The stamp comes from the PLAN and from nowhere else — there is no stamp
 * parameter and no read here. It is the `updateTime` of the preparo's read the
 * patch was derived from; a patch planned against that read and guarded by a
 * fresher one is an unguarded write wearing a precondition, and an operator's
 * save landing between the two reads is reverted in silence.
 *
 * ⚠️ A plan WITHOUT a stamp is refused before anything is written. There is no
 * unguarded arm: the FakeDb carries a real stamp on every snapshot, so no double
 * needs one, and an arm that quietly drops the precondition is exactly how a
 * preparo that forgot the stamp would ship green.
 *
 * ⚠️ A lost precondition THROWS {@link ShopeePrecoDesatualizadoError}. Returning
 * a verdict would make "the caller forgot to branch" a silent lost update, which
 * is the exact failure the guard exists to make loud.
 */
export async function aplicarPrecosShopee(
  db: Firestore,
  escrita: EscritaDePrecos | null,
): Promise<void> {
  if (escrita === null) return;
  const patch = escrita.patch;
  if (Object.keys(patch).length === 0) return;

  const { lastUpdateTime } = escrita;
  if (lastUpdateTime === undefined || lastUpdateTime === null) {
    throw new Error(
      `precos: o plano do produto ${escrita.produtoId} não carrega o carimbo da leitura ` +
        'de que foi derivado — um patch de preço sem guarda nunca é escrito.',
    );
  }

  const ref = produtoCollection.docRef(db, {}, escrita.produtoId);
  try {
    // The cast is the seam's: the plan carries the stamp as `unknown` because
    // nothing in this module reads it — it goes straight back to the SDK that
    // produced it (or to the double that mimics it).
    await ref.update(patch, { lastUpdateTime: lastUpdateTime as Timestamp });
  } catch (err) {
    if (isFailedPrecondition(err)) throw new ShopeePrecoDesatualizadoError(escrita.produtoId);
    throw err;
  }
}

/**
 * Create or overwrite one stock row.
 *
 * ⚠️ The overwrite is a MERGE of `quantidade` + `ultimaModificacao` only. A full
 * write would re-stamp `quantidadeReservada` from the plan, and the plan does
 * not own the reservation — the picking flow does.
 */
export async function aplicarEstoqueShopee(
  db: Firestore,
  escrita: EscritaDeEstoque | null,
): Promise<void> {
  if (escrita === null) return;
  const { produtoId, docId, data } = escrita;
  if (escrita.criar) {
    await estoqueCollection.docRef(db, { produtoId }, docId).set(estoqueCollection.parse(data));
    return;
  }
  await estoqueCollection.merge(db, { produtoId }, docId, {
    quantidade: data.quantidade,
    ultimaModificacao: data.ultimaModificacao,
  });
}
