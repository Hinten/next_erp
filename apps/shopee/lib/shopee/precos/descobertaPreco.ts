/**
 * Shopee **price discovery** (#1521, step 13) — the reads a price push is built
 * on, and nothing else. No Shopee call, no write, no clock: this module answers
 * "which listings and which `precos` does this family hold" for an explicit
 * list of anchors (`lerFamiliasDePrecoPorIds`, the manual push), and "what do
 * these produtos' `precos` say NOW" (`lerPrecosDosProdutos`, the SEND-time read
 * — reconcile C-d: the manual push prices each item immediately before sending
 * it, and the second PR's job reuses the same reader at drain time). The second
 * PR adds the account-wide paged reader over the SAME per-anchor join.
 *
 * The shapes it returns are `./planoPreco`'s ({@link FamiliaDePreco},
 * {@link LinkPrecoCru}, {@link FilhoDePreco}); nothing is re-declared here.
 *
 * ## ⚠️ CLASSIC reads, deliberately not step 12's pipeline (reconcile C-r)
 *
 * The stock sync discovers through Firestore Pipelines because it needs a
 * windowed aggregate over the ledger. Price needs none of that — only the
 * links and the `precos` maps — and pipelines run neither in vitest nor in the
 * emulator, while the second PR's job must exercise the REAL discovery in its
 * emulator round trip. So every read here is a batch key read or a plain
 * query, routed through the `@delfrance/data/admin/collections` handles, and
 * this module is testable over the shared in-memory double.
 *
 * ## The reads, per call
 *
 * 1. **The anchors — ONE batch key read** (`getAll`), masked to `precos`. A key
 *    read has no index to ride and none to miss, so root `CLAUDE.md` rule 1's
 *    trap (an unindexed predicate silently full-scanning, billed by data
 *    scanned) cannot be asked here. A missing document is simply absent from
 *    the answer and from the returned map — the caller reports it.
 * 2. **Per anchor, the ONE shared join** ({@link lerFamiliaDePreco}):
 *    - the anchor's WHOLE `prodshopee` subcollection, **no `where`** — the
 *      conta is compared IN MEMORY by the planner. A subcollection read with
 *      no predicate is a key-order scan of one produto's links and needs no
 *      index; a conta predicate would need a collection-scope composite that
 *      nobody has declared, let alone deployed;
 *    - the children, `produtos where paiId == <anchor>`, masked to `precos` —
 *      the `paiId` equality rides the existing `produtos(paiId, nome)`
 *      composite as a prefix (the same read Mercado Livre's price push makes);
 *    - each child's WHOLE `variashopee` subcollection, no `where`, same reason
 *      as the links.
 *    Both link reads are PROJECTED to the fields the planner reads (the lists
 *    below), exactly as step 12's pipeline selects them — a `prodshopee`
 *    carries the whole listing body and none of it is needed here.
 *
 * Cost of one call: 1 batch read + per present anchor (1 + 1 + #children)
 * small reads. The anchors are joined with bounded parallelism through the
 * promoted pool, because this sits in front of a human on a request capped at
 * fifty produtos.
 *
 * Step 1 IS {@link lerPrecosDosProdutos} — the same masked key read the push
 * repeats per item at send time, so the anchor's plan-time `precos` and an
 * item's send-time `precos` are read through one function, one mask and one
 * "absent means deleted" rule. The plan-time copy decides NO price on the
 * manual push any more (it prices at send time); the family keeps it because
 * the family shape is the planner's and the dry run prices from it.
 *
 * ⚠️ **A masked-out field arrives ABSENT, and absent is a legal reading
 * everywhere downstream** — `kitNativo` absent sends, `item_status` absent
 * sends. So a field the planner starts reading MUST be added to its list below
 * in the same change, or the planner reads "absent" for every listing, stays
 * green, and decides wrong. The lists are declared ONCE and both the query
 * mask and the projection copy iterate them, so the two cannot disagree.
 */
import type { DocumentData, Firestore } from 'firebase-admin/firestore';

import {
  produtoCollection,
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { executarEmPool } from '../core/pool';
import type { VarLinkShopeeCru } from '../core/vinculosShopee';
import type { FamiliaDePreco, FilhoDePreco, LinkPrecoCru } from './planoPreco';

/* -------------------------------------------------------------------------- */
/*                               THE PROJECTIONS                              */
/* -------------------------------------------------------------------------- */

/**
 * The `prodshopee` fields the planner reads — rung 0's conta, rung 2's id,
 * rung 3's kit flag and rung 4's two lifecycle spellings. `linkDocId` is the
 * document id, added by the projection. Step 12's stock-only fields are not
 * read, nor `category_id` (the price body carries no category) and
 * `pausadoPeloErp` (a paused listing's price is still sent).
 */
const CAMPOS_DO_VINCULO = [
  'contaProdutoShopeeOuterRef',
  'item_id',
  'item_status',
  'estadoAnuncio',
  'kitNativo',
] as const;

/**
 * The `variashopee` fields the shared folds read, step 12's list verbatim.
 * ⚠️ `produtoShopeeOuterRef` is LOAD-BEARING: two `prodshopee` under one
 * produto are legal, and this ref — never the produto — binds a model to its
 * listing. Drop it and every family with two listings hands each one the
 * other's models.
 */
const CAMPOS_DO_VINCULO_DE_MODELO = [
  'contaVariacaoShopeeOuterRef',
  'produtoShopeeOuterRef',
  'model_id',
  'tier_index',
  'model_status',
  'modeloAusenteEm',
] as const;

/** The produto field every read here masks to. */
const CAMPOS_DO_PRODUTO = ['precos'] as const;

/**
 * How many anchors are joined at once. A bound of this module's own, not an
 * operator knob: each join is 2 + #children small reads, and the request
 * that drives it is already capped at fifty produtos.
 */
const LARGURA_DA_JUNCAO = 4;

/** Copy exactly the listed keys that are PRESENT — an absent field stays absent. */
function projetar(
  dados: DocumentData | undefined,
  campos: readonly string[],
): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  if (dados === undefined) return saida;
  for (const campo of campos) {
    if (Object.hasOwn(dados, campo)) saida[campo] = dados[campo];
  }
  return saida;
}

/** A document id comparator — the join's output order is the key order, made explicit. */
function porId(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/* -------------------------------------------------------------------------- */
/*                               THE SHARED JOIN                              */
/* -------------------------------------------------------------------------- */

/**
 * **The ONE per-anchor join** — the only definition the by-ids reader and the
 * second PR's paged reader use, so the family a human pushes and the family
 * the job sends are read identically (step 12's "one join, two readers").
 *
 * `precosDoAnchor` arrives from the caller's own anchor read, which already
 * paid for it.
 */
async function lerFamiliaDePreco(
  db: Firestore,
  anchorId: string,
  precosDoAnchor: unknown,
): Promise<FamiliaDePreco> {
  const [linksSnap, filhosSnap] = await Promise.all([
    produtoShopeeLinkCollection
      .ref(db, { produtoId: anchorId })
      .select(...CAMPOS_DO_VINCULO)
      .get(),
    produtoCollection
      .ref(db, {})
      .where('paiId', '==', anchorId)
      .select(...CAMPOS_DO_PRODUTO)
      .get(),
  ]);

  const links: LinkPrecoCru[] = linksSnap.docs
    .map((doc) => ({ ...projetar(doc.data(), CAMPOS_DO_VINCULO), linkDocId: doc.id }))
    .sort((a, b) => porId(a.linkDocId, b.linkDocId));

  const children: FilhoDePreco[] = await Promise.all(
    filhosSnap.docs.map(async (filhoDoc): Promise<FilhoDePreco> => {
      const varSnap = await variacaoShopeeLinkCollection
        .ref(db, { produtoId: filhoDoc.id })
        .select(...CAMPOS_DO_VINCULO_DE_MODELO)
        .get();
      const varLinks: VarLinkShopeeCru[] = varSnap.docs
        .map((varDoc) => ({
          ...projetar(varDoc.data(), CAMPOS_DO_VINCULO_DE_MODELO),
          varLinkDocId: varDoc.id,
        }))
        .sort((a, b) => porId(a.varLinkDocId, b.varLinkDocId));
      return {
        produtoId: filhoDoc.id,
        precos: projetar(filhoDoc.data(), CAMPOS_DO_PRODUTO).precos,
        varLinks,
      };
    }),
  );
  children.sort((a, b) => porId(a.produtoId, b.produtoId));

  return { anchorId, precos: precosDoAnchor, links, children };
}

/* -------------------------------------------------------------------------- */
/*                         THE PRICES OF NAMED PRODUTOS                        */
/* -------------------------------------------------------------------------- */

/**
 * The `precos` of an explicit list of produtos, read NOW — ONE batch key read
 * (`getAll`), masked to `precos`, through the admin handle.
 *
 * The send-time read of reconcile C-d: the manual push calls it inside each
 * item's pool task, immediately before the sender, with exactly the produtos
 * that price that item; the second PR's job calls it at drain time. Both then
 * hand the map to the pure `precificarItem`, unchanged.
 *
 * - The value is the stored `precos` map RAW (`unknown`) — `precoDaTabela`
 *   reads it, nothing here interprets it.
 * - ⚠️ **Presence is EXISTENCE.** A produto that does not exist is ABSENT from
 *   the map; a produto that exists without a `precos` field is PRESENT with an
 *   `undefined` value. Both price as "no price" downstream, and neither
 *   throws: a produto deleted between a plan and its send answers
 *   `preco-nao-encontrado`, never an error.
 * - Duplicates are collapsed; an empty list answers an empty map with ZERO
 *   reads (a batch read of nothing is refused by the SDK).
 * - Matched by DOCUMENT ID, never by position in the answer.
 * - A read failure propagates: nothing is caught here.
 */
export async function lerPrecosDosProdutos(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<ReadonlyMap<string, unknown>> {
  const ids = [...new Set(produtoIds)];
  const precos = new Map<string, unknown>();
  if (ids.length === 0) return precos;

  const snaps = await db.getAll(...ids.map((id) => produtoCollection.docRef(db, {}, id)), {
    fieldMask: [...CAMPOS_DO_PRODUTO],
  });
  for (const snap of snaps) {
    if (!snap.exists) continue;
    precos.set(snap.id, projetar(snap.data(), CAMPOS_DO_PRODUTO).precos);
  }
  return precos;
}

/* -------------------------------------------------------------------------- */
/*                               THE BY-IDS READER                            */
/* -------------------------------------------------------------------------- */

/**
 * The families of an explicit list of ANCHORS — the manual push.
 *
 * - The ids are read VERBATIM as anchors: resolving a requested variation
 *   child to its anchor is the caller's step, before this one.
 * - Duplicates are collapsed; an empty list answers an empty map with ZERO
 *   reads (a batch read of nothing is refused by the SDK).
 * - ⚠️ **A missing anchor is ABSENT from the map** — never a row with empty
 *   links, which would read as `sem-link` ("no listing on this conta") for a
 *   produto that does not exist at all. The caller diffs its request against
 *   the keys and reports `produto-nao-encontrado`.
 * - The anchors are matched by DOCUMENT ID, never by position in the answer,
 *   and the map is built in request order (deduplicated), whatever order the
 *   joins finish in.
 * - A read failure propagates: nothing is caught here, so a Firestore outage
 *   is the caller's thrown error, never a family that silently lost its links.
 */
export async function lerFamiliasDePrecoPorIds(
  db: Firestore,
  args: { readonly anchorIds: readonly string[] },
): Promise<ReadonlyMap<string, FamiliaDePreco>> {
  const anchorIds = [...new Set(args.anchorIds)];
  const familias = new Map<string, FamiliaDePreco>();
  if (anchorIds.length === 0) return familias;

  // Read 1 — the send-time reader, reused: one masked key read, absent = missing.
  const precosPorAnchor = await lerPrecosDosProdutos(db, anchorIds);

  const presentes = anchorIds.filter((id) => precosPorAnchor.has(id));
  const lidas: (FamiliaDePreco | undefined)[] = new Array<FamiliaDePreco | undefined>(
    presentes.length,
  );
  await executarEmPool(presentes, LARGURA_DA_JUNCAO, async (anchorId, indice) => {
    lidas[indice] = await lerFamiliaDePreco(db, anchorId, precosPorAnchor.get(anchorId));
  });

  for (const familia of lidas) {
    if (familia !== undefined) familias.set(familia.anchorId, familia);
  }
  return familias;
}
