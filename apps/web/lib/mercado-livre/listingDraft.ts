/**
 * Creating the listing draft — the document everything else in this editor
 * needs in order to exist.
 *
 * ## Why this exists
 *
 * Until now a `produtoMercadoLivre` link doc was only ever born server-side, in
 * `publishProduto`. For a produto the Flutter app never touched that produced a
 * deadlock:
 *
 *   no link doc → no editor renders → no `category_id` → publish raises
 *   "categoria do Mercado Livre não definida" as a 422 → and that throw happens
 *   BEFORE `writeLinkDoc`, so the failed publish leaves no doc behind → no link
 *   doc.
 *
 * S2 made it visible rather than causing it: publish used to pick a category
 * itself with `suggestCategories(nome, 1)[0]` and no human in the loop, which is
 * the silent behaviour #799 asked us to remove. Removing it is right — the
 * category must be *offered* — but it left nothing to break the cycle. This is
 * that something.
 */
import { addDoc, getDocs, runTransaction, type Firestore } from 'firebase/firestore';
import { buildQuery, groupQuery, whereEqual } from '@delfrance/data';
import { ESTADO_PUBLICACAO_ML, toOuterRef, type ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { produtoMercadoLivreLinkCollection } from '@/lib/data/produtoMercadoLivreLinkCollection';
import { variacaoMercadoLivreLinkCollection } from '@/lib/data/variacaoMercadoLivreLinkCollection';

export interface ListingDraftArgs {
  integracaoId: string;
  /** Seeds the listing title; the operator edits it afterwards. */
  produtoNome: string;
  /** What the operator chose in the Tipo de anúncio select, if anything. */
  listingTypeId: string | null;
  nowMs: number;
  /**
   * Which draft this is for the account.
   *
   * `'primeiro'` — the account has no anúncio yet, so the doc id is the
   * integração id and the write is guarded (see {@link draftDocId}).
   *
   * `'adicional'` — the operator asked for ANOTHER anúncio on an account that
   * already has one. "Another one" has no deterministic name, so the id is a
   * fresh auto-id and there is nothing to check for first.
   */
  modo: DraftMode;
}

export type DraftMode = 'primeiro' | 'adicional';

/**
 * The document a "Preparar anúncio" writes.
 *
 * Deliberately the same shape `publishProduto`'s `writeLinkDoc` creates on a
 * first publish — same `contaOuterRef` form, same `title` fallback, same
 * `dataCadastro` — so a draft made here and a doc made there are
 * indistinguishable downstream. The rest of the fields come from the schema's
 * own defaults (`channels: ['marketplace']`, `condition: 'new'`,
 * `site_id: 'MLB'`), which is what the converter fills on write.
 *
 * `estado` is `'r'` (rascunho) and `id` is null: nothing has reached ML yet.
 */
export function buildListingDraft(args: ListingDraftArgs): ProdutoMercadoLivreLink {
  return {
    contaOuterRef: `documents/integracao/${args.integracaoId}`,
    channels: ['marketplace'],
    estado: ESTADO_PUBLICACAO_ML.rascunho,
    status: null,
    sub_status: null,
    id: null,
    sku: null,
    descricao: null,
    site_id: 'MLB',
    title: args.produtoNome.trim(),
    category_id: null,
    condition: 'new',
    listing_type_id: args.listingTypeId,
    crossdocking: null,
    freteGratis: false,
    precoPublicado: null,
    tarifaFrete: null,
    comissao: null,
    isUserProductModel: false,
    video_id: null,
    attributes: null,
    errors: null,
    ultimaModificacao: args.nowMs,
    dataCadastro: args.nowMs,
  } as ProdutoMercadoLivreLink;
}

/**
 * The FIRST draft on an account gets the **integração id** as its document id,
 * not a fresh auto-id.
 *
 * That is tier 0 of the lost-update ladder — the race is made impossible rather
 * than detected. Two operators (or one impatient double-click) both land on the
 * same document, so the second attempt finds the first's draft instead of
 * creating a duplicate listing for the same account. Auto-id documents written
 * by Flutter or by an earlier publish keep their own ids and are found by the
 * `contaOuterRef` filter exactly as before; nothing downstream reads meaning
 * into a link doc's id.
 *
 * ⚠️ It applies to the first draft only. A produto may carry SEVERAL anúncios on
 * one account, and a deliberate second one is intent, not a race — there is
 * nothing for a deterministic id to deduplicate against. Those get auto-ids; see
 * `modo` on {@link ListingDraftArgs}.
 */
export function draftDocId(integracaoId: string): string {
  return integracaoId;
}

export type DraftOutcome = 'created' | 'exists';

/**
 * Create a draft listing for an account.
 *
 * Two shapes, because the two cases have different races.
 *
 * **`'primeiro'`** — the account has no anúncio yet. The read and the write
 * share a transaction so "check then create" cannot interleave with another tab
 * doing the same thing, and the id is deterministic so both tabs contend for one
 * document. `exists` is a success, not an error: the operator wanted a draft to
 * edit and there is one.
 *
 * **`'adicional'`** — the operator asked for another anúncio on an account that
 * already has one. There is nothing to check: a fresh auto-id cannot collide,
 * and a second draft is what was asked for, so a transaction would guard against
 * nothing. What it does NOT protect against is duplicated *intent* — two
 * operators clicking at once get two drafts. That is accepted rather than
 * prevented: a duplicate draft is inert (`estado 'r'`, `id: null`, so both
 * sweeps skip it and `integracoesComProduto` never counts it), the button is
 * single-flight while the write is in flight, and an unpublished draft can be
 * deleted from the tab.
 */
export async function createListingDraft(
  db: Firestore,
  produtoId: string,
  args: ListingDraftArgs,
): Promise<{ docId: string; outcome: DraftOutcome }> {
  // A converted write of a COMPLETE document — the converter full-parses it,
  // which is what we want here. (The rule against converted writes is about
  // partial `merge` patches, where that same full parse fills defaults the merge
  // mask then writes over stored siblings.)
  if (args.modo === 'adicional') {
    const ref = await addDoc(
      produtoMercadoLivreLinkCollection.ref(db, { produtoId }),
      buildListingDraft(args),
    );
    return { docId: ref.id, outcome: 'created' };
  }

  const docId = draftDocId(args.integracaoId);
  const ref = produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, docId);
  const outcome = await runTransaction<DraftOutcome>(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return 'exists';
    tx.set(ref, buildListingDraft(args));
    return 'created';
  });
  return { docId, outcome };
}

/** What {@link removeListing} found when it looked. */
export type RemoveListingOutcome = 'removed' | 'missing' | 'published';

/**
 * The two shapes a link doc may be removed or reset in.
 *
 * ⚠️ Both are decided from the `tx.get` snapshot, never from the `link` the
 * button was rendered with (root `CLAUDE.md` rule 7 — a predicate re-checked
 * against a binding read OUTSIDE the transaction is not a guard).
 *
 *  - **`'rascunho'`** — the listing has never reached ML (`id` absent or `''`,
 *    matching the backend's own `link.id !== ''` test; the schema permits `''`
 *    and the migrated corpus contains it).
 *  - **`'removido'`** — ML REMOVED the listing (`estado 'rm'`, #1226). The item
 *    id is dead, so the reason the published case is normally refused — that
 *    removing the doc would orphan a LIVE anúncio — does not apply: there is
 *    nothing live at the other end to orphan.
 */
function podeRemover(atual: Pick<ProdutoMercadoLivreLink, 'id' | 'estado'> | undefined): boolean {
  if ((atual?.id ?? '') === '') return true;
  return atual?.estado === ESTADO_PUBLICACAO_ML.removidoPorModeracao;
}

/**
 * Every `variacaoMercadoLivre` member link belonging to one parent listing.
 *
 * Read OUTSIDE the transaction, deliberately: the Web SDK's `runTransaction`
 * takes only document reads, so a query cannot go inside one. The cost is a
 * member created between this read and the commit, which is the same window
 * {@link removeListing} has always accepted — and its residue is inert, since
 * both ML sweeps filter `paiId == null` and never select a variation child.
 *
 * The ref is REBUILT rather than read off a member, matching
 * `VariacoesAnuncioTable`: every writer stores it through
 * `variacaoMercadoLivreLinkCollection.parse()` and `toOuterRef` normalises to
 * the `documents/…` form, so an exact `==` is safe and rides the declared
 * `produtoMercadoLivreOuterRef` COLLECTION_GROUP index.
 */
async function membrosDoAnuncio(db: Firestore, produtoId: string, linkDocId: string) {
  const snap = await getDocs(
    buildQuery(
      groupQuery(db, 'variacaoMercadoLivre', variacaoMercadoLivreLinkCollection.converter),
      [
        whereEqual(
          'produtoMercadoLivreOuterRef',
          toOuterRef(`produtos/${produtoId}/produtoMercadoLivre/${linkDocId}`),
        ),
      ],
    ),
  );
  return snap.docs.map((d) => d.ref);
}

/**
 * Delete a listing the ERP has no reason to keep — a draft, or one Mercado Livre
 * has removed.
 *
 * ## Why this exists at all
 *
 * Nothing could delete a link doc before, and nothing needed to: the doc set was
 * bounded at one per account and every one of them meant something. "Novo
 * anúncio" is the first way to make a link doc that is pure clutter — the
 * duplicated-intent case `createListingDraft` accepts rather than prevents — so
 * the way to remove one ships with it. #1226 added the second: a listing ML
 * removed keeps a dead item id for ever with no path out of the ERP.
 *
 * ## Why a transaction, for a delete
 *
 * The predicate can stop being true between the operator opening the confirm and
 * confirming it: a publish from another tab, or the `items` webhook, stamps `id`
 * on this same doc. Deleting then would orphan a LIVE Mercado Livre listing —
 * `itemsStatusSync`'s `resolveLink` would find nothing, both sweeps would stop
 * reaching it, and its child `variacaoMercadoLivre` docs would dangle with no
 * parent. So the check is re-derived inside (see {@link podeRemover});
 * `'published'` is the caller's cue to say so rather than to retry.
 *
 * ⚠️ It deletes the MEMBER links too, which the draft-only version never had to:
 * a draft has none (they are written at publish time). Leaving them would strand
 * a member pointing at a parent that no longer exists, which is the dangling the
 * old refusal existed to prevent, arriving from the other side.
 *
 * The `integracoesComProduto` denorm needs nothing here — the
 * `onProdutoMercadoLivreLinkChanged` trigger re-derives account membership from
 * the whole subcollection, so removing one listing cannot drop an account that
 * still holds a live one.
 */
export async function removeListing(
  db: Firestore,
  produtoId: string,
  linkDocId: string,
): Promise<RemoveListingOutcome> {
  const ref = produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId);
  const membros = await membrosDoAnuncio(db, produtoId, linkDocId);
  return runTransaction<RemoveListingOutcome>(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return 'missing';
    const atual = snap.data() as Pick<ProdutoMercadoLivreLink, 'id' | 'estado'> | undefined;
    if (!podeRemover(atual)) return 'published';
    for (const membro of membros) tx.delete(membro);
    tx.delete(ref);
    return 'removed';
  });
}

/** What {@link descartarAnuncioRemovido} found when it looked. */
export type DescartarOutcome = 'descartado' | 'missing' | 'nao-removido';

/**
 * Drop the dead Mercado Livre identity of a REMOVED listing, keeping everything
 * the operator wrote (#1226).
 *
 * ## Why this and not just the delete
 *
 * A removal is almost always fixable at the produto level — the case that
 * motivated the issue is `DOMAIN_WRONG_CATEG_V2`, a wrong category — while the
 * listing's título, categoria, atributos, descrição and tabela de medidas
 * binding are hours of operator work. Deleting the doc throws all of it away to
 * fix one field. This keeps the doc, drops only what belonged to the listing ML
 * deleted, and returns it to `rascunho` — so `assemblePublishInput` sees
 * `link.id == null`, takes the `POST /items` branch, and creates a genuinely new
 * anúncio instead of `PUT`ing a dead one.
 *
 * ## What it clears, and why each one
 *
 *  - `id` — the whole point: it is what makes a republish an update.
 *  - `status` / `sub_status` — they describe the removed listing. Left behind,
 *    `acaoStatusAnuncio` and both send gates would keep reading `under_review`.
 *  - `moderacoes` — ML's verdict ON THAT LISTING. `null` ("never asked"), not
 *    `[]`: the new listing has not been moderated, and `[]` would record a
 *    verdict nobody obtained.
 *  - `userProductId` — the removed item's stock identity (#706); it is
 *    self-healing, so a stale one would be written over anyway, but a dead id
 *    sent to `PUT /user-products/{id}/stock` before that heal is a 4xx.
 *  - `errors` / `causas` — our last failed write against a listing that no
 *    longer exists.
 *
 * ⚠️ It does NOT clear `attributes`, `title`, `category_id`, `descricao`,
 * `listing_type_id` or `condition`. That is the entire difference from
 * {@link removeListing}.
 *
 * ⚠️ Member links are MARKED, never deleted — `variacoesFantasma.ts`'s
 * precedent, for its reason: the member link carries the variation's `sku` and
 * `attribute_combinations`, which a republish would otherwise have to rebuild
 * from nothing. They lose exactly what the parent loses: the ML identity
 * (`itemId`, `id`), the status pair, and the moderation.
 *
 * ⚠️ Guarded the same way as the delete and refused the same way: `'nao-removido'`
 * when the tx-fresh doc is not in the removed state. Discarding the identity of a
 * listing that is merely paused would abandon a LIVE anúncio.
 */
export async function descartarAnuncioRemovido(
  db: Firestore,
  produtoId: string,
  linkDocId: string,
): Promise<DescartarOutcome> {
  const ref = produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, linkDocId);
  const membros = await membrosDoAnuncio(db, produtoId, linkDocId);
  return runTransaction<DescartarOutcome>(db, async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists()) return 'missing';
    const atual = snap.data() as Pick<ProdutoMercadoLivreLink, 'estado'> | undefined;
    if (atual?.estado !== ESTADO_PUBLICACAO_ML.removidoPorModeracao) return 'nao-removido';
    const nowMs = Date.now();
    for (const membro of membros) {
      tx.update(membro, {
        itemId: null,
        id: null,
        status: null,
        sub_status: null,
        moderacoes: null,
        ultimaModificacao: nowMs,
      });
    }
    tx.update(ref, {
      estado: ESTADO_PUBLICACAO_ML.rascunho,
      id: null,
      status: null,
      sub_status: null,
      moderacoes: null,
      userProductId: null,
      errors: [],
      causas: [],
      ultimaModificacao: nowMs,
    });
    return 'descartado';
  });
}
