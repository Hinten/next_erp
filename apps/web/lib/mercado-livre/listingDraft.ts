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
import { runTransaction, type Firestore } from 'firebase/firestore';
import { ESTADO_PUBLICACAO_ML, type ProdutoMercadoLivreLink } from '@delfrance/schemas';

import { produtoMercadoLivreLinkCollection } from '@/lib/data/produtoMercadoLivreLinkCollection';

export interface ListingDraftArgs {
  integracaoId: string;
  /** Seeds the listing title; the operator edits it afterwards. */
  produtoNome: string;
  /** What the operator chose in the Tipo de anúncio select, if anything. */
  listingTypeId: string | null;
  nowMs: number;
}

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
 * The draft's document id is the **integração id**, not a fresh auto-id.
 *
 * That is tier 0 of the lost-update ladder — the race is made impossible rather
 * than detected. Two operators (or one impatient double-click) both land on the
 * same document, so the second attempt finds the first's draft instead of
 * creating a duplicate listing for the same account. Auto-id documents written
 * by Flutter or by an earlier publish keep their own ids and are found by the
 * `contaOuterRef` filter exactly as before; nothing downstream reads meaning
 * into a link doc's id.
 */
export function draftDocId(integracaoId: string): string {
  return integracaoId;
}

export type DraftOutcome = 'created' | 'exists';

/**
 * Create the draft unless one is already there.
 *
 * The read and the write share a transaction so "check then create" cannot
 * interleave with another tab doing the same thing. `exists` is a success, not
 * an error: the operator wanted a draft to edit and there is one.
 */
export async function createListingDraft(
  db: Firestore,
  produtoId: string,
  args: ListingDraftArgs,
): Promise<{ docId: string; outcome: DraftOutcome }> {
  const docId = draftDocId(args.integracaoId);
  const ref = produtoMercadoLivreLinkCollection.docRef(db, { produtoId }, docId);
  const outcome = await runTransaction<DraftOutcome>(db, async (tx) => {
    const snap = await tx.get(ref);
    if (snap.exists()) return 'exists';
    // A converted `set` of a COMPLETE document — the converter full-parses it,
    // which is what we want here. (The rule against converted writes is about
    // partial `merge` patches, where that same full parse fills defaults the
    // merge mask then writes over stored siblings.)
    tx.set(ref, buildListingDraft(args));
    return 'created';
  });
  return { docId, outcome };
}
