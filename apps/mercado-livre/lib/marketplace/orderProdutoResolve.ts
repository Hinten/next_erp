/**
 * Produto resolution for ONE Mercado Livre order line (#792).
 *
 * Legacy resolved the variation CHILD (`_makeItemDoPedido`,
 * `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart:3179-3211`)
 * by probing the `marketplace` denorm array with
 * `externalId: variation_id ?? item.id`. That read path was never ported, and
 * `import.ts`'s `resolveExistingProduto` — which the order import reused
 * instead — structurally CANNOT return a child: its link step queries the
 * `produtoMercadoLivre` collection group, which only ever exists under a
 * parent/simple produto (children carry `variacaoMercadoLivre`), and its SKU
 * step filters `paiId == null`, which excludes every child by construction.
 *
 * The denorm array is NOT the fix. It is write-only in this app (only the
 * deployed Flutter backend `array-contains`es it, `publish.ts:285-295`), it has
 * no declared index, and it is slated for removal (#992). The link
 * subcollections this same app writes carry everything needed, already indexed:
 *
 *   parent/simple  produtos/{parentId}/produtoMercadoLivre/{doc}   id == item.id
 *   variations[]   produtos/{childId}/variacaoMercadoLivre/{doc}   id == variation_id
 *                                                                 + produtoMercadoLivreOuterRef
 *   User-Products  produtos/{childId}/variacaoMercadoLivre/{doc}   itemId == item.id
 *
 * ---- Why this lives here and not in `import.ts` --------------------------
 * `resolveExistingProduto` is SHARED with the product-import path
 * (`import.ts:248`), which depends on `paiId == null` to bind a parent listing
 * to a ROOT produto — widening it there would let a parent listing bind to a
 * variation child. So the order-only cascade (child-first, widened SKU) is its
 * own function, and the shared one is reused unchanged for its link step.
 *
 * ---- Cost ---------------------------------------------------------------- *
 * Child-first does NOT mean an extra query per line: a simple listing answers
 * on the parent link alone (one collectionGroup query — exactly what the code
 * did before), because `isUserProductModel` on that same link doc tells us
 * there is no child to look for. Only a variation line pays a second query.
 * Every shape below is served by an index already declared in
 * `firestore.indexes.json` (#779) — on Firestore Enterprise an unindexed
 * predicate silently full-scans and is billed by data scanned.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { toOuterRef } from '@delfrance/schemas';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { resolveExistingProduto } from './import';
import { refMatchesIntegracao } from './linkRefs';

/** Which rung of the cascade answered — diagnostic only, never persisted. */
export type OrderLineMatchKind =
  | 'parent-link'
  | 'variation-link'
  | 'up-member-link'
  | 'sku-child'
  | 'sku-root'
  | 'sku-any';

export interface ResolvedOrderLineProduto {
  /** The produto the order line binds to — the CHILD for a variation sale. */
  produtoId: string;
  via: OrderLineMatchKind;
}

export interface OrderLineProdutoQuery {
  /** `order_items[].item.id` — the LISTING id (parent for `variations[]`). */
  itemId: string;
  /** `order_items[].item.variation_id`, stringified; null for a simple/UP line. */
  variationId: string | null;
  /** `order_items[].item.seller_sku`. */
  sku: string | null;
  integracaoId: string;
}

/**
 * Resolve the ERP produto for one ML order line, child-first:
 *
 *  1. the parent/simple `produtoMercadoLivre` link (`id == item.id`);
 *  2. `variation_id` present → the `variacaoMercadoLivre` link with that id,
 *     SCOPED to the parent link (a variation id is only unique within its item);
 *  3. no `variation_id` but the line is a User-Products member → the
 *     `variacaoMercadoLivre` link with `itemId == item.id`;
 *  4. SKU, most specific scope first (child of the known parent → root → any);
 *  5. null — the caller keeps `produtoUid: null` and records an incidente.
 *
 * A simple listing short-circuits at (1) and is byte-identical to the previous
 * behaviour, including which produto wins.
 */
export async function resolveOrderLineProduto(
  db: Firestore,
  query: OrderLineProdutoQuery,
): Promise<ResolvedOrderLineProduto | null> {
  const { itemId, variationId, sku, integracaoId } = query;

  // (1) Parent/simple link. `sku: null` selects EXACTLY the link step of the
  // shared resolver — its own SKU fallback is root-only and would pre-empt the
  // child steps below.
  const parent = await resolveExistingProduto(db, itemId, null, integracaoId);
  const parentLinkOuterRef =
    parent && parent.linkDocId
      ? toOuterRef(`produtos/${parent.produtoId}/produtoMercadoLivre/${parent.linkDocId}`)
      : null;

  if (variationId != null) {
    // (2) legacy `variations[]`: the child link's numeric `id`, scoped to the
    // parent link. Both filters server-side and exact string equality on the
    // ref — same reasoning as `importVariations.ts:261-270`: filtering the ref
    // in memory would pull every same-id link doc in the database.
    if (parentLinkOuterRef) {
      const numericId = numericVariationId(variationId);
      if (numericId != null) {
        const snap = await variacaoMercadoLivreLinkCollection
          .groupQuery(db)
          .where('id', '==', numericId)
          .where('produtoMercadoLivreOuterRef', '==', parentLinkOuterRef)
          .limit(1)
          .get();
        const childId = snap.docs[0]?.ref.parent?.parent?.id;
        if (childId) return { produtoId: childId, via: 'variation-link' };
      }
    }
  } else if (parent == null || isUserProductLink(parent.linkRaw)) {
    // (3) User-Products: each member is its OWN item, so `item.id` names the
    // CHILD. Two shapes reach here — a family with a `family_id` (the parent
    // link carries `id == family_id`, so step 1 missed) and a family whose
    // `family_id` is null (`canonicalId == item.id`, so step 1 matched the
    // family PARENT and the child must still win).
    const child = await resolveUpMemberChild(db, itemId, integracaoId);
    if (child) return { produtoId: child, via: 'up-member-link' };
  } else {
    // A parent link that is NOT a User-Products family and a line with no
    // variation_id: a simple listing. Nothing more specific exists.
    return { produtoId: parent.produtoId, via: 'parent-link' };
  }

  // (4) SKU, narrowest scope first.
  if (sku) {
    if (parent) {
      const childBySku = await firstProdutoId(
        produtoCollection
          .ref(db, {})
          .where('sku', '==', sku)
          .where('paiId', '==', parent.produtoId)
          .limit(1),
      );
      if (childBySku) return { produtoId: childBySku, via: 'sku-child' };
    }

    // Root-only — today's shape, kept ahead of the unscoped step so a simple
    // listing's SKU fallback still resolves to the same produto it always did.
    const rootBySku = await firstProdutoId(
      produtoCollection.ref(db, {}).where('sku', '==', sku).where('paiId', '==', null).limit(1),
    );
    if (rootBySku) return { produtoId: rootBySku, via: 'sku-root' };

    // Unscoped — legacy parity (`sku__isEqualTo(sku).first()` had no `paiId`
    // filter) and the only rung that can match a variation child of a DIFFERENT
    // parent. Neither account- nor parent-verified, hence the warning.
    const anyBySku = await firstProdutoId(
      produtoCollection.ref(db, {}).where('sku', '==', sku).limit(1),
    );
    if (anyBySku) {
      console.warn('[mercado-livre] produto do item resolvido apenas pelo SKU (sem vínculo)', {
        itemId,
        variationId,
        sku,
        produtoId: anyBySku,
      });
      return { produtoId: anyBySku, via: 'sku-any' };
    }
  }

  // (5) Unresolved. The caller keeps `produtoUid: null` — inert for stock
  // (`calcularAlteracoesEstoque` skips null/'NONE') — and records an incidente.
  return null;
}

/* -------------------------------------------------------------------------- */

/**
 * The variation CHILD produto for a User-Products member id. The
 * `variacaoMercadoLivre` link has no conta field to filter server-side (adding
 * one would pollute the legacy `VariacoesML` wire — `import.ts:619-621`), so
 * ownership is verified by following `produtoMercadoLivreOuterRef` to the family
 * PML doc and matching ITS `contaOuterRef`. An MLB item id is globally unique on
 * ML, so >1 hit only means the same listing imported under several accounts — a
 * small set, and `limit(10)` bounds a pathological scan.
 *
 * Same shape as `itemsPricesSync.ts`'s `resolvePriceTarget` variation branch and
 * `import.ts`'s `resolveExistingUpParent` step 1 — a third local copy per this
 * folder's small-local-duplicates convention (`itemsPricesSync.ts:345-347`).
 * Note what differs: those two return the family PARENT, this returns the CHILD
 * (`d.ref.parent.parent.id`), which is the produto that owns the stock.
 */
async function resolveUpMemberChild(
  db: Firestore,
  itemId: string,
  integracaoId: string,
): Promise<string | null> {
  const snap = await variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('itemId', '==', itemId)
    .limit(10)
    .get();
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    const pmlOuterRef = raw.produtoMercadoLivreOuterRef;
    if (typeof pmlOuterRef !== 'string') continue;
    const parsed = parsePmlOuterRef(pmlOuterRef);
    if (!parsed) continue;
    const pmlSnap = await produtoMercadoLivreLinkCollection
      .docRef(db, { produtoId: parsed.produtoId }, parsed.linkId)
      .get();
    if (!pmlSnap.exists) continue;
    const pmlRaw = pmlSnap.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(pmlRaw.contaOuterRef, integracaoId)) continue;
    const childId = d.ref.parent?.parent?.id;
    if (childId) return childId;
  }
  return null;
}

/** First matching `produtos` doc id, or null. */
async function firstProdutoId(query: FirebaseFirestore.Query): Promise<string | null> {
  const snap = await query.get();
  return snap.docs[0]?.id ?? null;
}

/**
 * Whether a `produtoMercadoLivre` link doc describes a User-Products family.
 * The field is `isUserProductModel` on the link (`mercadoLivreLink.ts:123`);
 * a legacy Flutter doc written before it existed is absent → false, which is
 * the correct reading (User-Products post-dates it).
 */
function isUserProductLink(linkRaw: Record<string, unknown> | null): boolean {
  return linkRaw?.isUserProductModel === true;
}

/**
 * ML variation ids are numeric on the wire even though the order line carries
 * them as `number | string`; null when non-numeric. Must key on the SAME value
 * `assembleVariationChildPlan` stamps onto the link's `id` field, so this is the
 * same plain-integer regex as `importVariations.ts:314-316` /
 * `importCore.ts:428-430`.
 */
function numericVariationId(variationId: string): number | null {
  return /^-?\d+$/.test(variationId) ? Number(variationId) : null;
}

/**
 * Parse a canonical `documents/produtos/<produtoId>/produtoMercadoLivre/<linkId>`
 * outer-ref into its produto + link doc ids — a local copy of `import.ts`'s
 * private helper (same 6-liner; `itemsPricesSync.ts:349-355` and
 * `importMigration.ts` each carry their own for the same reason).
 */
function parsePmlOuterRef(ref: string): { produtoId: string; linkId: string } | null {
  const segs = ref.split('/').filter(Boolean);
  const i = segs.indexOf('produtos');
  if (i === -1 || i + 3 >= segs.length) return null;
  if (segs[i + 2] !== 'produtoMercadoLivre') return null;
  return { produtoId: segs[i + 1]!, linkId: segs[i + 3]! };
}
