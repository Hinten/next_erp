/**
 * The two Shopee link documents, WRITTEN (#1517, step 9) — the thin applier of
 * the `EscritaDeLink` entries `planejarImportacaoShopee` already built.
 *
 * ## ⚠️ Resolve, then write — the id is never derived
 *
 * `produtoShopeeLinkCollection`'s own header says it: the document ids are
 * Firestore AUTO ids, and the Shopee ids live in the `item_id` / `model_id`
 * FIELDS. So idempotence cannot come from a deterministic id the way it does for
 * a Mercado Livre link — the RESOLVE is the idempotence. A hit MERGEs onto the
 * document the cascade settled on; a miss ADDs a fresh one.
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
