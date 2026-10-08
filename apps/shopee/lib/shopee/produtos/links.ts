/**
 * The two Shopee link documents, WRITTEN (#1517, step 9) — the thin applier of
 * the `EscritaDeLink` entries `planejarImportacaoShopee` already built.
 *
 * ## ⚠️ Resolve, then write — the id is never derived (ONE exception: a native kit)
 *
 * `produtoShopeeLinkCollection`'s own header says it: the document ids are
 * Firestore AUTO ids, and the Shopee ids live in the `item_id` / `model_id`
 * FIELDS. So idempotence cannot come from a deterministic id the way it does for
 * a Mercado Livre link — the RESOLVE is the idempotence. A hit MERGEs onto the
 * document the cascade settled on; a miss ADDs a fresh one.
 *
 * ⚠️ **A NATIVE KIT is the exception (step 19, #1527, R-u).** A kit has a
 * second writer the resolve cannot see: the kit create writes its link right
 * after `add_kit_item` answers an `item_id`, with no document before it (L9).
 * An import running between that answer and the create's link write — or after
 * a crash between them — would `add` a SECOND `prodshopee` for one `item_id`.
 * So the kit arm (`kitShopee.ts`'s `comCamposDeKit`) turns a missed listing
 * link into `{ acao: 'merge', docId: idDoVinculoDeKit(integracaoId, item_id) }`
 * and every NEW kit-model row into
 * `{ acao: 'merge', docId: idDaVariacaoDeKit(linkDocId, model_id) }`
 * (`kits/idsKit.ts`): the create computes the same ids, so both writers land on
 * ONE link and ONE row per (link, model) whichever runs first — rule 7 tier 0.
 * A cascade HIT still merges onto the document it found, whatever its id (every
 * pre-step-19 kit link keeps its auto id), and an ordinary listing keeps `add`.
 * Nothing in THIS file changed for it: the merge-at-docId arms below are the
 * applier, and an upsert at a derived id is exactly what they already do.
 *
 * ## ⚠️ `merge`, never `set`
 *
 * `parseMerge` validates only the keys present, so a key this import does not
 * author is never defaulted to `null` and never erased. A `set` would re-parse
 * the whole document and hand every unmentioned field its schema default —
 * silently deleting `violations` (the banned-item push owns it) and any
 * `.passthrough()` key the migrated Flutter corpus carries.
 *
 * ## ⚠️ Two `prodshopee` documents under ONE produto are LEGAL
 *
 * The legacy allowed it and so does this: the group query filters `item_id` AND
 * the conta, so two links naming different listings never collide. The
 * duplicate rule — lexically-first wins, one log line, NEVER a delete
 * (`resolveProduto.ts`) — applies only WITHIN one `item_id`.
 *
 * ## ⚠️ `produtoShopeeOuterRef` is the full LINK document path
 *
 * `produtos/<paiId>/prodshopee/<linkId>`, not the parent produto's path — which
 * is why the parent link is written BEFORE the children. On a first import the
 * parent link is an `add`, so the plan cannot know that id and OMITS the key
 * (`linkPaiRefPendente`); {@link aplicarLinkDaVariacao} stamps it from the id
 * the `add` returned. A forgotten stamp is LOUD, not silent: the field is a
 * required non-nullable `outerRefSchema`, so the write throws.
 *
 * Next-free, clock-free: every stamp arrived on the plan.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { toOuterRef } from '@delfrance/schemas';
import {
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';

import { caminhoDoLinkDaListagem } from './mapeamento';
import type { EscritaDeLink } from './planoImportacao';

/**
 * Write the listing link and answer the document id it now lives at — the id
 * every child link below points AT.
 */
export async function aplicarLinkDaListagem(
  db: Firestore,
  produtoId: string,
  escrita: EscritaDeLink,
): Promise<string> {
  if (escrita.acao === 'merge' && escrita.docId !== null) {
    await produtoShopeeLinkCollection.merge(db, { produtoId }, escrita.docId, escrita.dados);
    return escrita.docId;
  }
  const ref = await produtoShopeeLinkCollection.add(db, { produtoId }, escrita.dados);
  return ref.id;
}

/**
 * Write one model's link.
 *
 * `caminhoDoLinkPai` is the parent link's document PATH. It is stamped here
 * rather than at plan time because on a first import that id does not exist
 * until the `add` above lands.
 */
export async function aplicarLinkDaVariacao(
  db: Firestore,
  produtoId: string,
  escrita: EscritaDeLink,
  paiProdutoId: string,
  linkPaiId: string,
): Promise<void> {
  const dados: Record<string, unknown> = {
    ...escrita.dados,
    produtoShopeeOuterRef: toOuterRef(caminhoDoLinkDaListagem(paiProdutoId, linkPaiId)),
  };
  if (escrita.acao === 'merge' && escrita.docId !== null) {
    await variacaoShopeeLinkCollection.merge(db, { produtoId }, escrita.docId, dados);
    return;
  }
  await variacaoShopeeLinkCollection.add(db, { produtoId }, dados);
}
