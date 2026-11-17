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
 *    criacaoIncertaDesde: null, criacaoIncertaSku: null, falhaPublicacao: null},
 *    {lastUpdateTime})`;
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
 * ## ⚠️ The GUARDED merge (`merge-guardado`) — an ERP edit is never silently discarded
 *
 * An operator can EDIT a PUBLISHED listing in the ERP; the edit is saved on the
 * `prodshopee` link only and a later «Republicar» sends it (the edit route
 * stamps `edicaoErpRevisao` + `edicaoErpPendenteEm`). From that moment every
 * OTHER writer of the link's CONTENT fields (`CAMPOS_DE_EDICAO_ERP_SHOPEE`) is a
 * potential silent overwrite of the edit, so the three of them — the product
 * import's parent-link write and publish write-backs #1 and #2 — go through
 * {@link aplicarLinkDaListagemComGuarda}. Rule 7 tier 1: each attempt reads the
 * link FRESH, RE-DECIDES from that read and writes with
 * `update(patch, { lastUpdateTime })`; the decision is never a value captured
 * before an await. The three guards decide whether the content keys go in:
 *
 *  - `importacao` — content only while NO edit is pending (the import reads
 *    Shopee's copy, which is older than a pending edit);
 *  - `write-back-1` — content only while the revision still equals the one the
 *    publish body was built from. Otherwise the edit survives and the pending
 *    flag is SET (`nowMs`); when the body does carry the edit the flag is
 *    CLEARED (`null`) — this publish just sent it;
 *  - `write-back-2` — content only while the revision still equals AND nothing
 *    is pending (the read-back reports what was sent, never a newer edit).
 *
 * Non-content keys (status, timestamps…) are always written. `seAusentes`
 * (first-time-only keys) fill only a key the fresh read holds as absent or
 * `null` — so a legacy non-numeric `publicadoEm` / `dataCadastro` is now left
 * as stored where write-back #1 used to re-stamp it (accepted: it only ever
 * meant "first seen"). A lost precondition re-reads; after
 * {@link TENTATIVAS_DA_ESCRITA_GUARDADA} losses the IMPORT rethrows (its own
 * retry ladder takes over, like the adoption arm), while a WRITE-BACK falls
 * back to a plain handle merge of the NON-content keys — it never rethrows,
 * because a publish that already reached Shopee must still record its status.
 * Write-back #1's fallback SETS the pending flag only when there is an edit to
 * protect (a revision on the body it sent or on the last read), never on a
 * link nobody edited. ⚠️ `update()`
 * REPLACES nested maps (`description_info`, `pre_order`, `tax_info`) where the
 * old set-merge deep-merged them — accepted: Shopee's read is the whole truth.
 *
 * Next-free, clock-free: every stamp arrived on the plan.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  edicaoErpPendenteShopee,
  revisaoDeEdicaoErpShopee,
  semCamposDeEdicaoErpShopee,
  toOuterRef,
} from '@delfrance/schemas';
import {
  produtoShopeeLinkCollection,
  variacaoShopeeLinkCollection,
} from '@delfrance/data/admin/collections';
import { isFailedPrecondition, isNotFound } from '@delfrance/data/admin/grpcErrors';

import { caminhoDoLinkDaListagem } from './mapeamento';
import type {
  EscritaDeAdocaoDeRascunho,
  EscritaDeLink,
  EscritaDeLinkDaListagem,
  EscritaDeLinkGuardada,
} from './planoImportacao';
import { veredictoDeAdocaoShopee } from './resolveProduto';

/** How many fresh reads an adoption makes before a lost precondition is rethrown. */
export const TENTATIVAS_DA_ADOCAO = 3;

/** How many fresh reads a guarded write makes before it falls back (D-B). */
export const TENTATIVAS_DA_ESCRITA_GUARDADA = 3;

/** What a listing-link write answered: the document id, and whether an ERP edit held its content. */
export interface ResultadoDaEscritaDeLink {
  readonly docId: string;
  /** `true` when the content keys were withheld to keep a pending/newer ERP edit. */
  readonly edicaoErpPreservada: boolean;
}

/**
 * Write the listing link and answer the document id it now lives at — the id
 * every child link below points AT.
 */
export async function aplicarLinkDaListagem(
  db: Firestore,
  produtoId: string,
  escrita: EscritaDeLinkDaListagem,
): Promise<string> {
  return (await aplicarLinkDaListagemComGuarda(db, produtoId, escrita)).docId;
}

/**
 * {@link aplicarLinkDaListagem} that also reports whether an ERP edit held the
 * content back. The non-guarded arms behave exactly as before
 * (`edicaoErpPreservada: false`).
 */
export async function aplicarLinkDaListagemComGuarda(
  db: Firestore,
  produtoId: string,
  escrita: EscritaDeLinkDaListagem,
): Promise<ResultadoDaEscritaDeLink> {
  if (escrita.acao === 'adotar') {
    return { docId: await adotarRascunho(db, produtoId, escrita), edicaoErpPreservada: false };
  }
  if (escrita.acao === 'merge-guardado') return await mergeGuardado(db, produtoId, escrita);
  if (escrita.acao === 'merge' && escrita.docId !== null) {
    await produtoShopeeLinkCollection.merge(db, { produtoId }, escrita.docId, escrita.dados);
    return { docId: escrita.docId, edicaoErpPreservada: false };
  }
  const ref = await produtoShopeeLinkCollection.add(db, { produtoId }, escrita.dados);
  return { docId: ref.id, edicaoErpPreservada: false };
}

/**
 * The GUARDED arm — see the header. Every pass decides from its OWN fresh read
 * and asserts that read's stamp, so a decision is never re-applied over a link
 * an operator edited in between (rule 7 tier 1).
 */
async function mergeGuardado(
  db: Firestore,
  produtoId: string,
  escrita: EscritaDeLinkGuardada,
): Promise<ResultadoDaEscritaDeLink> {
  const { guarda } = escrita;
  const ref = produtoShopeeLinkCollection.docRef(db, { produtoId }, escrita.docId);
  // The last fresh read — what the D-B fallback decides from. `null` = absent.
  let ultimoRaw: Record<string, unknown> | null = null;

  for (let tentativa = 1; tentativa <= TENTATIVAS_DA_ESCRITA_GUARDADA; tentativa += 1) {
    const snap = await ref.get();
    if (!snap.exists) {
      ultimoRaw = null;
      // No document ⇒ nothing to protect: the merge creates it, as before.
      await produtoShopeeLinkCollection.merge(db, { produtoId }, escrita.docId, {
        ...escrita.dados,
        ...escrita.seAusentes,
      });
      return { docId: escrita.docId, edicaoErpPreservada: false };
    }
    const raw = (snap.data() ?? {}) as Record<string, unknown>;
    ultimoRaw = raw;

    // Re-derived from THIS read on every attempt.
    const levaConteudo =
      guarda.tipo === 'importacao'
        ? !edicaoErpPendenteShopee(raw)
        : guarda.tipo === 'write-back-1'
          ? revisaoDeEdicaoErpShopee(raw) === guarda.revisao
          : revisaoDeEdicaoErpShopee(raw) === guarda.revisao && !edicaoErpPendenteShopee(raw);

    const patch = produtoShopeeLinkCollection.parseMerge({
      ...(levaConteudo ? escrita.dados : semCamposDeEdicaoErpShopee(escrita.dados)),
      ...Object.fromEntries(
        Object.entries(escrita.seAusentes).filter(
          ([chave]) => raw[chave] === undefined || raw[chave] === null,
        ),
      ),
      ...(guarda.tipo === 'write-back-1'
        ? { edicaoErpPendenteEm: levaConteudo ? null : guarda.nowMs }
        : {}),
    });
    try {
      await ref.update(patch as Record<string, unknown>, { lastUpdateTime: snap.updateTime });
      return { docId: escrita.docId, edicaoErpPreservada: !levaConteudo };
    } catch (err) {
      if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
      // The IMPORT has a retry ladder of its own (the queue, the next run):
      // a third loss rethrows, like the adoption arm — never a content-less
      // write that would leave Shopee's newer read behind for no edit at all.
      if (guarda.tipo === 'importacao' && tentativa >= TENTATIVAS_DA_ESCRITA_GUARDADA) throw err;
    }
  }

  // D-B, the WRITE-BACKS only: contention won every pass. A publish that
  // already reached Shopee must still record its status, so this never
  // rethrows. The content keys are NOT written (an edit may be there), and
  // write-back #1 SETS the pending flag only when there is an edit to protect —
  // a revision on the body it sent or on the last read. A never-edited link
  // never gets a flag nothing but a republish could clear.
  const haEdicao =
    (guarda.tipo !== 'importacao' && guarda.revisao !== null) ||
    revisaoDeEdicaoErpShopee(ultimoRaw) !== null;
  console.warn(
    '[shopee/links] escrita guardada perdeu a precondição em todas as tentativas; gravando só o que não é conteúdo',
    { produtoId, linkDocId: escrita.docId, guarda: guarda.tipo, haEdicao },
  );
  const primeiraVez =
    ultimoRaw === null
      ? escrita.seAusentes
      : Object.fromEntries(
          Object.entries(escrita.seAusentes).filter(
            ([chave]) => ultimoRaw?.[chave] === undefined || ultimoRaw[chave] === null,
          ),
        );
  await produtoShopeeLinkCollection.merge(db, { produtoId }, escrita.docId, {
    // The link vanished on the last pass ⇒ nothing to protect: the whole patch.
    ...(ultimoRaw === null ? escrita.dados : semCamposDeEdicaoErpShopee(escrita.dados)),
    ...primeiraVez,
    ...(guarda.tipo === 'write-back-1' && haEdicao && ultimoRaw !== null
      ? { edicaoErpPendenteEm: guarda.nowMs }
      : {}),
  });
  return {
    docId: escrita.docId,
    edicaoErpPreservada: ultimoRaw !== null && (haEdicao || edicaoErpPendenteShopee(ultimoRaw)),
  };
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
