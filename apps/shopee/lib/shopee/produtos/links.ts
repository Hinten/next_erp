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
 * document the cascade settled on; a miss ADDs a fresh one; a DRAFT the cascade
 * chose to adopt (#1911) is taken by a guarded `update` — see below.
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
 * ## ⚠️ Nothing here deletes — the ONE `prodshopee` delete is a DRAFT's discard
 *
 * This applier, the import and every publish path only ever `merge` / `add` /
 * guarded-`update` a link: a link we did not write may be the only binding a
 * legacy row has. Since #1911 (P4) exactly ONE path in this app deletes a
 * `prodshopee` document, and it is not here: the draft route's discard
 * (`POST …/rascunho/descartar` → `../anuncios/rascunho.ts`). Its bounds are
 * the whole exception:
 *
 *  - it deletes only a DRAFT (`ehRascunhoShopee`: no `item_id`, not
 *    `kitNativo`) — never a listing link, and never a `variashopee` row (a
 *    draft has none; rows are minted only after the first create answers);
 *  - only as rule 7 tiers 3 + 1: `delete({ lastUpdateTime })` against the
 *    snapshot that decided — one whose publish lock was not in progress (nor in
 *    its post-expiry grace), whose projection equals the `base` the operator
 *    saw, and, when its last create is `incerta`, only on the operator's
 *    attestation; a lost precondition re-reads and re-decides;
 *  - a publish whose create lands after the discard does not resurrect it: its
 *    write-back #1 finds no draft and `add`s a fresh link, so the listing is
 *    never orphaned (`../anuncios/reservaRascunho.ts`, the claim).
 *
 * ## ⚠️ ADOPTING a draft is rule 7 tier 1 (#1911, D5 / K1-8)
 *
 * The parent link may be an ADOPTION ({@link EscritaDeAdocaoDeRascunho}): the
 * cascade found ONE draft of this produto and conta whose own publish may have
 * created this very listing (`resolveProduto.ts`, `veredictoDeAdocaoShopee`).
 * The listing then takes the draft's document instead of a second link. Loop ≤
 * {@link TENTATIVAS_DA_ADOCAO}, each pass on a FRESH read:
 *
 *  - still adoptable (re-derived from THAT read — draft, conta, evidence,
 *    window) ⇒ `update({…the import's fields, publicacaoEmCurso: null,
 *    criacaoIncertaDesde: null, falhaPublicacao: null}, {lastUpdateTime})`;
 *  - `item_id` already OURS (the publish's write-back #1 claim, or another
 *    import, got there first) ⇒ the plain merge onto it — converged, and the
 *    publish state it holds is not ours to clear;
 *  - anything else — gone, claimed by ANOTHER item, no longer adoptable ⇒
 *    `add` a fresh link (today's fork: two linked listings, never a lost
 *    `item_id`), one warn;
 *  - `FAILED_PRECONDITION` ⇒ re-read and re-derive (never a re-apply); a third
 *    loss rethrows.
 *
 * A live publish lock does NOT block it: clearing the lock is the point (a
 * lock left behind reads `em-andamento` / `incerta` for ever and blocks the
 * produto's other drafts on the conta), and the publish run that held it
 * refuses to send on its pre-send re-read (the draft now has an `item_id`) or,
 * past the send, converges through its claim.
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
import { isFailedPrecondition } from '@delfrance/data/admin/grpcErrors';

import { caminhoDoLinkDaListagem } from './mapeamento';
import type {
  EscritaDeAdocaoDeRascunho,
  EscritaDeLink,
  EscritaDeLinkDaListagem,
} from './planoImportacao';
import { veredictoDeAdocaoShopee } from './resolveProduto';

/** How many fresh reads an adoption makes before a lost precondition is rethrown. */
export const TENTATIVAS_DA_ADOCAO = 3;

/**
 * Write the listing link and answer the document id it now lives at — the id
 * every child link below points AT.
 */
export async function aplicarLinkDaListagem(
  db: Firestore,
  produtoId: string,
  escrita: EscritaDeLinkDaListagem,
): Promise<string> {
  if (escrita.acao === 'adotar') return await adotarRascunho(db, produtoId, escrita);
  if (escrita.acao === 'merge' && escrita.docId !== null) {
    await produtoShopeeLinkCollection.merge(db, { produtoId }, escrita.docId, escrita.dados);
    return escrita.docId;
  }
  const ref = await produtoShopeeLinkCollection.add(db, { produtoId }, escrita.dados);
  return ref.id;
}

/**
 * The ADOPTION arm of {@link aplicarLinkDaListagem} (#1911) — the loop the
 * header describes. Every pass decides from its OWN fresh read, and the guarded
 * `update` asserts that read's stamp: the decision and the precondition are one
 * read, so the cascade's earlier verdict is never re-applied over a draft that
 * moved (rule 7 tier 1).
 *
 * @returns the id of the link that now records the listing — the draft's, or a
 *   fresh one when the draft could not be taken.
 */
async function adotarRascunho(
  db: Firestore,
  produtoId: string,
  escrita: EscritaDeAdocaoDeRascunho,
): Promise<string> {
  const { adocao } = escrita;
  const ref = produtoShopeeLinkCollection.docRef(db, { produtoId }, escrita.docId);
  // The import's fields, plus each first-time-only key the read document lacks.
  const dadosSobre = (armazenado: Record<string, unknown>): Record<string, unknown> => ({
    ...escrita.dados,
    ...Object.fromEntries(
      Object.entries(escrita.seAusentes).filter(
        ([chave]) => armazenado[chave] === undefined || armazenado[chave] === null,
      ),
    ),
  });

  for (let tentativa = 1; ; tentativa += 1) {
    const snap = await ref.get();
    const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;

    // Converged: this listing already lives here. Its publish state belongs to
    // whoever claimed it, so nothing is cleared — the plain merge.
    if (raw !== null && raw.item_id === adocao.itemId) {
      await produtoShopeeLinkCollection.merge(db, { produtoId }, escrita.docId, dadosSobre(raw));
      return escrita.docId;
    }

    const veredicto =
      raw === null
        ? 'ausente'
        : veredictoDeAdocaoShopee(raw, adocao.integracaoId, adocao.createTimeS);
    if (raw === null || veredicto !== 'adotavel') {
      console.warn(
        '[shopee/importacao] o rascunho já não é adotável por este anúncio; criando um vínculo novo',
        { produtoId, linkDocId: escrita.docId, itemId: adocao.itemId, veredicto },
      );
      const novo = await produtoShopeeLinkCollection.add(db, { produtoId }, dadosSobre({}));
      return novo.id;
    }

    const patch = produtoShopeeLinkCollection.parseMerge({
      ...dadosSobre(raw),
      ...escrita.limpeza,
    });
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return escrita.docId;
    } catch (err) {
      if (!isFailedPrecondition(err) || tentativa >= TENTATIVAS_DA_ADOCAO) throw err;
    }
  }
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
