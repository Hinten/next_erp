/**
 * The User-Products publish fan-out (#798) — the ERP→ML direction of the model
 * `importFamily.ts`/`importUserProduct.ts` already read.
 *
 * Under User Products a produto with variations is not one listing with a
 * `variations[]` array: **each variation is its own ML item**, the items share a
 * `family_name`, and ML derives the family (`family_id`) plus one
 * `user_product_id` per member from that name, the domain and the PARENT_PK
 * attributes. So publishing a family is N calls, not one, and the identifiers
 * land in two different places:
 *
 *  - each member's MLB item id → `variacaoMercadoLivre.itemId` on its child
 *    produto (the field `precoPlan` and `bulkEstoquePlan` already read, and
 *    which until now only the importer ever wrote);
 *  - the family id → the PARENT link's `id`, which is what the importer stamps
 *    too (`import.ts:193`). ⚠️ That field therefore holds a FAMILY id for a UP
 *    family and an ITEM id everywhere else — never `PUT /items/{link.id}` for
 *    one.
 *
 * Legacy source: `.old/lib/canaisDeVenda/mercadoLivre/exportarProdutos.dart:178-432`
 * plus `VariacoesML.toMercadoLivreUserProduct` (`models.dart:1750-1917`).
 *
 * ⚠️ **One deliberate divergence from `.old/`: link writes are per member, not
 * one batch at the end.** Legacy accumulated every member's `itemId` into a
 * `WriteBatch` committed after the loop (`:264-265`, `:373`), so a failure on
 * member 3 discarded members 1–2's ids while their ML items stayed live — and
 * the retry POSTed them AGAIN, duplicating items inside the family. Writing
 * each id the moment ML confirms it makes the retry a no-op update instead.
 * The residual window is one member wide (an ML create that lands and whose
 * Firestore write then fails); `seller_custom_field` carries the child produto
 * id, so an import can still recover that member.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  type BuildItemPayloadInput,
  type MercadoLivreApi,
  MercadoLivreError,
  type MlItem,
  buildUserProductItemPayload,
  userProductMemberInputs,
} from '@delfrance/integrations-mercado-livre';
import { toOuterRef } from '@delfrance/schemas';
import { variacaoMercadoLivreLinkCollection } from '@delfrance/data/admin/collections';

import { resolveFamilyItemIds } from './importFamily';

/** One family member's existing ERP state, resolved before the fan-out. */
export interface UserProductMember {
  /** The variation child produto id. */
  produtoId: string;
  /** Its `variacaoMercadoLivre` doc for THIS parent link; null ⇒ none yet. */
  varLinkDocId: string | null;
  /**
   * The member's ML item id. **This — not the parent link's `id` — decides
   * create vs update**, per member.
   */
  itemId: string | null;
  /**
   * The stored link body. Read for the two outer refs when a member has to be
   * created from scratch — never re-applied wholesale (see {@link writeMemberLink}:
   * this snapshot predates every ML call in the run).
   */
  raw: Record<string, unknown>;
  sku: string | null;
}

export interface PublishUserProductDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  /** The FAMILY parent produto. */
  produtoId: string;
  /** Its `produtoMercadoLivre` link doc id. */
  parentLinkDocId: string;
}

/** One member as ML left it. */
export interface PublishedMember {
  /** The variation child produto id. */
  produtoId: string;
  /** Its ML item id. */
  itemId: string;
  /** True when this run CREATED it — a description POSTs rather than PUTs. */
  created: boolean;
}

export interface PublishUserProductResult {
  /** Every member's ML response, in the order they were sent. */
  items: MlItem[];
  /**
   * Per-member outcomes, keyed by child produto id rather than by position —
   * the caller's own child array is built by a different code path, so pairing
   * the two by index would be a silent mis-stamp the day either order changes.
   */
  written: PublishedMember[];
  /** The item ids written this run — the orphan sweep's "keep" set. */
  itemIds: string[];
  /**
   * `family_id` off the first response that carried one. ML omits it from some
   * create responses, hence first-wins rather than last (legacy `:256`).
   */
  familyId: string | null;
}

/**
 * Publish every member of a family, sequentially. Any `MercadoLivreError`
 * propagates to the caller (which stamps `estado: 'E'` on the parent link),
 * with every member already confirmed left recorded.
 */
export async function publishUserProductMembers(
  deps: PublishUserProductDeps,
  input: BuildItemPayloadInput,
  members: ReadonlyArray<UserProductMember>,
): Promise<PublishUserProductResult> {
  const { db, api, integracaoId, produtoId, parentLinkDocId } = deps;
  const byProdutoId = new Map(members.map((m) => [m.produtoId, m]));

  const items: MlItem[] = [];
  const written: PublishedMember[] = [];
  let familyId: string | null = null;

  // Sequential, legacy parity. ML computes the family from each item's own
  // `family_name` + attributes, so ordering is not a correctness requirement —
  // but a family is a handful of items against a rate-limited API, and a
  // sequential loop is what makes "everything before the failure is recorded"
  // a property rather than a hope.
  for (const memberInput of userProductMemberInputs(input)) {
    const childId = memberInput.member.produtoId;
    const state = byProdutoId.get(childId) ?? null;
    const existingItemId = state?.itemId ?? null;
    const isUpdate = existingItemId != null;

    const payload = buildUserProductItemPayload({ ...memberInput, isUpdate });
    const item = isUpdate
      ? await api.updateItem(existingItemId, payload)
      : await api.createItem(payload);

    items.push(item);
    written.push({ produtoId: childId, itemId: item.id, created: !isUpdate });
    if (familyId == null && item.family_id != null) familyId = String(item.family_id);

    await writeMemberLink(db, {
      integracaoId,
      produtoId,
      parentLinkDocId,
      childId,
      itemId: item.id,
      state,
      sku: memberSku(memberInput.member.attributes) ?? state?.sku ?? null,
      // ML just told us this member's lifecycle state; recording it here is what
      // lets the family's `estado` be a FOLD of its members instead of whichever
      // one happened to be sent first (#1142). Without it a freshly published
      // family carries no member observations at all, and the fold would have to
      // decline to conclude until every member had fired an `items` notification.
      status: item.status ?? null,
      subStatus: item.sub_status ?? null,
      userProductId: item.user_product_id ?? null,
    });
  }

  return { items, written, itemIds: written.map((w) => w.itemId), familyId };
}

/** Outcome of the removed-variation sweep. */
export interface OrphanSweepResult {
  /** Item ids paused then closed. */
  closed: string[];
  /**
   * Why nothing was closed, when nothing was. Null means the sweep ran and
   * closed exactly `closed`.
   */
  skipped: string | null;
}

/**
 * Close the ML items of variations that no longer exist in the ERP.
 *
 * A variation deleted here leaves its ML item live and selling with no produto
 * behind it: the stock sweep never touches it again, and an order for it lands
 * with nothing to decrement. Legacy paused then closed those
 * (`exportarProdutos.dart:375-410`), which is what this does.
 *
 * ⚠️ Closing an ML item is effectively terminal, so every way of being unsure
 * is a refusal rather than a guess:
 *
 *  - no `familyId` → nothing to enumerate;
 *  - the family read FAILED → an error and an empty family are not the same
 *    fact, and treating them alike would close the whole family;
 *  - a member we just wrote is MISSING from the membership → our view of the
 *    family disagrees with ML's (indexing lag on a fresh create is the normal
 *    cause), so the set difference is not trustworthy;
 *  - the sweep would close EVERY member → that is never a legitimate outcome of
 *    "some variations were removed", and the caller keeps the produto anyway.
 *
 * Best-effort throughout: a failure here is reported, never fatal — the items
 * are already published and correct.
 */
export async function sweepRemovedMembers(
  deps: { api: MercadoLivreApi },
  args: {
    familyId: string | null;
    sellerUserId: number | null;
    keptItemIds: ReadonlyArray<string>;
  },
): Promise<OrphanSweepResult> {
  const { familyId, sellerUserId, keptItemIds } = args;
  if (familyId == null) return { closed: [], skipped: 'família sem id' };
  if (sellerUserId == null) return { closed: [], skipped: 'integração sem user_id' };

  const membership = await resolveFamilyItemIds(deps, familyId, sellerUserId);
  if (membership.resolutionError != null) {
    return { closed: [], skipped: `não foi possível ler a família: ${membership.resolutionError}` };
  }

  const kept = new Set(keptItemIds);
  if (!keptItemIds.every((id) => membership.ids.includes(id))) {
    return { closed: [], skipped: 'a família ainda não reflete os anúncios publicados agora' };
  }
  const orphans = membership.ids.filter((id) => !kept.has(id));
  if (orphans.length === 0) return { closed: [], skipped: null };
  if (orphans.length === membership.ids.length) {
    return { closed: [], skipped: 'nenhum anúncio publicado agora pertence à família' };
  }

  const closed: string[] = [];
  for (const itemId of orphans) {
    try {
      // Pause first, then close — legacy order (`api.dart:927-939`). ML rejects
      // closing some listing states directly, and pausing alone already stops
      // the sale, so the pair degrades safely if the second call fails.
      await deps.api.updateItem(itemId, { status: 'paused' });
      await deps.api.updateItem(itemId, { status: 'closed' });
      closed.push(itemId);
    } catch (err) {
      if (!(err instanceof MercadoLivreError)) throw err;
      console.warn('[mercado-livre] publish: falha ao encerrar variação removida', {
        itemId,
        familyId,
        message: err.message,
      });
    }
  }
  return { closed, skipped: null };
}

/* --------------------------------- helpers ---------------------------------- */

/**
 * Persist one member's `variacaoMercadoLivre` link — **patching only the fields
 * publish owns**, never re-applying the snapshot it read.
 *
 * ⚠️ This used to `set(parse({ ...state.raw, … }))`, and that is the
 * read-modify-write root `CLAUDE.md` rule 7 names. `state.raw` is captured in
 * `publish.ts`'s children loop, which runs BEFORE the grupo reads, the
 * size-chart binding (an ML call), every picture upload, `assemblePublishInput`
 * and all N create/update calls — so the snapshot is minutes old by the time it
 * lands, and `parse` fills defaults for whatever it lacks, making the write a
 * genuine clobber rather than a merge. Concurrent writers to these documents are
 * named in-repo: the live Flutter app, `importVariations.ts` and
 * `importMigration.ts` (the UPtin takeover — precisely what flips a listing into
 * this model).
 *
 * Patching makes the race impossible rather than unlikely (tier 0), the same
 * argument the PARENT link write already makes in `publish.ts`. `attributes` in
 * particular is never touched: Flutter regenerates the next publish's
 * non-SIZE/COLOR combinations from it.
 *
 * `mergeIfExists` rather than `merge`: the doc may have been deleted since we
 * read it, and `merge` is an UPSERT that would resurrect a GHOST holding only
 * the patch keys — `parseMerge` fills no defaults, so the two required outer
 * refs would be missing. On `false` we fall through to a full, schema-valid
 * `set`, which is also the genuine first-publish path.
 */
async function writeMemberLink(
  db: Firestore,
  args: {
    integracaoId: string;
    produtoId: string;
    parentLinkDocId: string;
    childId: string;
    itemId: string;
    state: UserProductMember | null;
    sku: string | null;
    status: string | null;
    subStatus: string[] | null;
    userProductId: string | null;
  },
): Promise<void> {
  const { integracaoId, produtoId, parentLinkDocId, childId, itemId, state, sku } = args;
  const docId =
    state?.varLinkDocId ?? variacaoMercadoLivreLinkCollection.newDocId(db, { produtoId: childId });

  // The three fields publish owns. ⚠️ `id` (the legacy numeric variation id) is
  // NOT among them: under User Products there is no variation object to carry
  // one, and an invented value would make `variacaoLinkHasListing` report a
  // legacy listing that does not exist. A member migrated by UPtin keeps
  // whatever its old link holds — patching leaves it alone by construction.
  const patch = {
    itemId,
    // #920: unconditional, so a re-publish self-heals a row predating the field.
    contaOuterRef: toOuterRef(`integracao/${integracaoId}`),
    sku,
    // #1142: this member's own lifecycle state, as ML just reported it. Raw, like
    // the parent link's pair — the derived `estado` stays parent-only, because it
    // is a FAMILY summary and a member has no business carrying one.
    status: args.status,
    sub_status: args.subStatus,
    // #706 multiorigem: this member's own `user_product_id`, straight off the
    // create/update response. It is the STOCK identity on a
    // `warehouse_management` conta, where `PUT /items` moves nothing. Recorded
    // per member for the same reason `status` is: a User Product describes a
    // product at VARIATION level, so the family's parent link has none.
    userProductId: args.userProductId,
  };

  if (state?.varLinkDocId != null) {
    const merged = await variacaoMercadoLivreLinkCollection.mergeIfExists(
      db,
      { produtoId: childId },
      docId,
      patch,
    );
    if (merged) return;
  }

  await variacaoMercadoLivreLinkCollection.set(
    db,
    { produtoId: childId },
    docId,
    variacaoMercadoLivreLinkCollection.parse({
      produtoVariacaoOuterRef:
        (state?.raw.produtoVariacaoOuterRef as string | undefined) ??
        toOuterRef(`produtos/${childId}`),
      produtoMercadoLivreOuterRef:
        (state?.raw.produtoMercadoLivreOuterRef as string | undefined) ??
        toOuterRef(`produtos/${produtoId}/produtoMercadoLivre/${parentLinkDocId}`),
      ...patch,
    }),
  );
}

/** The member's own `SELLER_SKU`, when the assembly gave it one. */
function memberSku(
  attributes: ReadonlyArray<{ id?: string | null; value_name?: string | null }> | undefined,
): string | null {
  const entry = (attributes ?? []).find((a) => a.id === 'SELLER_SKU');
  return entry?.value_name ?? null;
}
