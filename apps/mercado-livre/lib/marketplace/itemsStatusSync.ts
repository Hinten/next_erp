/**
 * `items` webhook status-sync (ML→ERP) — issue #440. When Mercado Livre fires an
 * `items` notification, fetch the listing and sync its lifecycle status onto the
 * already-linked `produtoMercadoLivre` doc (NOT a full import — the legacy
 * auto-import call sites are disabled; a full import is the on-demand `import.ts`
 * flow). Ports the normal-status branch of the legacy
 * `_atualizarStatusProdutoMercadoLivre` (tasks.dart 1038–1148).
 *
 * Why it matters (Lucas): a future product-maintenance bot filters products by
 * ML `status` + `sub_status`, so this keeps the raw values on the link doc (added
 * to `produtoMercadoLivreLinkSchema` in 7a) alongside the derived `estado` code.
 *
 * Robustness contract (plugs into the Step 6 pipeline):
 *  - IDEMPOTENT: keyed by the ML item id; writes only when a value actually
 *    changed, so a duplicate delivery is a no-op.
 *  - THROWS on a transient failure (ML 5xx/429/network, Firestore) so the queue /
 *    sweep retry; a deleted listing (404) is deterministic → no-op.
 *  - Deviation from legacy (a robustness fix, per the port's licence): legacy only
 *    synced when the COARSE `estado` changed and could miss a `sub_status`-only
 *    change; we also sync when the raw `status`/`sub_status` change, so the bot
 *    never sees a stale sub_status.
 *  - RE-ARMS the stock sweep (#781): when ML reports a listing that could receive
 *    stock again, this clears the `errors` the stock sender latched it with. That
 *    makes stale `errors` a change in their own right — see `errorsToClear` below.
 *
 * `applyItemStatusToLink` (exported at the bottom) is the shared status-writeback
 * core: this sync and the stock sender's terminal 4xx branch refresh a listing
 * through the SAME code, so the sender can never again leave a stale
 * `status: 'active'` behind for the sweep's gate to trip over.
 *
 * Scope (7a): SIMPLE listings. User-Products links and a listing still
 * mid-migration (`estado === 'am'`) are DEFERRED — a UP link or an
 * awaiting-migration listing is driven by the Flutter app during dual-run;
 * syncing `estado` here would fight it. A cancel removes the PARENT produto's
 * denorm entry (`removeMarketplaceEntry` below) but does not walk down to the
 * variation-children produtos. That sweep was once deferred to #438; it is now
 * moot rather than pending — the whole denorm cluster is deleted at the cutover
 * (#992), and leaving stale entries behind is already the norm everywhere else
 * (canonical note on `produtoSchema`).
 *
 * #441 (UP migration takeover): a `variations_migration_source`-tagged listing
 * that has gone `closed` is the ML-side signal that a legacy `variations[]`
 * listing finished migrating to User-Products — `migrationRunner`, when
 * supplied, runs that takeover (see `importMigration.ts`'s `handleUptinMigration`,
 * wired as the default by `notificacao.ts`) INSTEAD of the normal estado merge.
 * Every other migration-tag case (the `variations_migration_uptin` tag, a
 * source-tagged item not yet `closed`, or no runner supplied) still defers.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  type MlItem,
  MercadoLivreHttpError,
  createMercadoLivreApi,
  estadoFromMlStatus,
} from '@delfrance/integrations-mercado-livre';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { loadMercadoLivreContext } from './mercadoLivre';
import { podeEnviarEstoque } from './bulkEstoquePlan';
import { refMatchesIntegracao } from './linkRefs';
import type { UptinSourceLink } from './importMigration';

/** The minimal ML API surface the status-sync needs (injectable for tests). */
export interface ItemsSyncApi {
  getItem(itemId: string): Promise<MlItem>;
}

/** Builds a seller-authenticated ML API for an integração (real vs test fake). */
export type ItemsApiResolver = (db: Firestore, integracaoId: string) => Promise<ItemsSyncApi>;

/**
 * The production resolver: the account's durable token (refreshed if near
 * expiry, concurrency-safe) → a `MercadoLivreApi`. Public reads bucket
 * `available_quantity`, but the status/sub_status this sync reads are unaffected;
 * we still use the seller token for consistency with the rest of the pipeline.
 */
export const resolveItemsApiFromContext: ItemsApiResolver = async (db, integracaoId) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  return createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken });
};

/** ML `tags` marking a listing that is part of an in-progress UP migration (#441). */
const MIGRATION_TAGS: ReadonlySet<string> = new Set([
  'variations_migration_source',
  'variations_migration_uptin',
]);
/** The specific tag that, combined with `status === 'closed'`, hands off to `migrationRunner`. */
const MIGRATION_SOURCE_TAG = 'variations_migration_source';

/**
 * Executes the #441 UP-migration takeover for a `variations_migration_source`
 * listing that has gone `closed`. Injectable for tests; the production impl
 * (wired as `syncItemStatus`'s default-free 5th param by `notificacao.ts`) loads
 * a live ML API for the account and calls `handleUptinMigration`. THROWS on any
 * failure (transient or a missing old variation) so the pipeline retries.
 */
export type MigrationRunner = (
  db: Firestore,
  integracaoId: string,
  itemId: string,
  sourceLink: UptinSourceLink,
) => Promise<void>;

export type ItemsSyncOutcome =
  | 'synced' // the link (and maybe parent denorm) was updated
  | 'unchanged' // estado/status/sub_status all already current (idempotent no-op)
  | 'no-link' // no linked produto for this item on this account
  | 'deferred-up' // a User-Products / migrating listing — deferred to #441
  | 'migrated' // a migration-source listing went closed → #441 takeover ran
  | 'item-gone'; // the listing 404s (deleted) — nothing to sync

/**
 * Sync one ML item's lifecycle status onto its linked `produtoMercadoLivre` doc.
 * Returns a deterministic outcome; a transient failure THROWS (pipeline retries).
 *
 * LINK-FIRST: the ML API (and its token refresh) is resolved LAZILY, only once a
 * syncable link is confirmed. `items` fires for every change to ANY of the
 * seller's listings, most of which this ERP hasn't linked — resolving the link
 * from Firestore first skips the external call entirely for `no-link` and the
 * UP/`am` deferrals, so a `no-link` notification never depends on ML availability
 * or burns a quota/token refresh.
 */
export async function syncItemStatus(
  db: Firestore,
  integracaoId: string,
  itemId: string,
  resolveApi: ItemsApiResolver,
  migrationRunner?: MigrationRunner,
): Promise<ItemsSyncOutcome> {
  const link = await resolveLink(db, itemId, integracaoId);
  if (!link) return 'no-link';

  // Cheap (link-only) User-Products / migration guard → #441: a UP link or a
  // listing still awaiting migration (`estado === 'am'`) is driven by the Flutter
  // app during dual-run; touching `estado` here would fight it. Skipped BEFORE any
  // ML call — the migration-TAG case (which needs the fetched item) is checked below.
  if (link.data.isUserProductModel === true || link.data.estado === 'am') {
    return 'deferred-up';
  }

  const api = await resolveApi(db, integracaoId);
  let item: MlItem;
  try {
    item = await api.getItem(itemId);
  } catch (err) {
    // A deleted listing (404) can't be synced and won't recover on retry.
    if (err instanceof MercadoLivreHttpError && err.status === 404) return 'item-gone';
    throw err; // transient (5xx/429/network) or reauth → the queue/sweep retry
  }

  // Migration-tagged item (needs the fetched item's `tags`). The ONE takeover
  // case — this listing's source tag + it just went `closed` + a runner was
  // supplied — hands off to the #441 UP-migration branch INSTEAD of the normal
  // estado merge below. Every other tag combination (the uptin tag, a
  // source-tagged item still open, or no runner supplied) keeps deferring, same
  // as before #441 existed.
  const tags = item.tags ?? [];
  if (tags.includes(MIGRATION_SOURCE_TAG) && item.status === 'closed' && migrationRunner) {
    const sourceLink: UptinSourceLink = {
      produtoId: link.produtoId,
      linkDocId: link.docId,
      raw: link.data,
    };
    await migrationRunner(db, integracaoId, itemId, sourceLink);
    return 'migrated';
  }
  if (tags.some((t) => MIGRATION_TAGS.has(t))) {
    return 'deferred-up';
  }

  const estado = estadoFromMlStatus(item.status);
  const status = item.status ?? null;
  const subStatus = item.sub_status ?? null;

  const currentEstado = typeof link.data.estado === 'string' ? link.data.estado : null;
  const currentStatus = typeof link.data.status === 'string' ? link.data.status : null;
  const currentSubStatus = Array.isArray(link.data.sub_status)
    ? (link.data.sub_status as string[])
    : null;
  const currentErrors = Array.isArray(link.data.errors) ? link.data.errors : [];

  // #781 RE-ARM: the stock sender latches a listing it cannot update by stamping
  // `errors` (plus `estado 'E'` when ML still reports the listing healthy), and
  // the sweep's gate then skips it. Clearing that latch is precisely this
  // webhook's job — but only once ML says the listing could receive stock again,
  // so a `closed`/`under_review` listing KEEPS its diagnosis on screen.
  //
  // `errorsToClear` therefore has to count as a change on its own: a link that is
  // already at the right estado/status would otherwise short-circuit on
  // `unchanged` below and stay latched forever. Gating it on `enviar` also keeps
  // this convergent — the flag can only be true while there is a write left to do.
  const errorsToClear = currentErrors.length > 0 && podeEnviarEstoque(status, subStatus).enviar;
  const estadoChanged = estado !== currentEstado;
  const linkChanged =
    estadoChanged ||
    status !== currentStatus ||
    !stringArraysEqual(subStatus, currentSubStatus) ||
    errorsToClear;

  if (!linkChanged) return 'unchanged';

  await applyItemStatusToLink(
    db,
    integracaoId,
    { produtoId: link.produtoId, linkDocId: link.docId, itemId },
    item,
    {
      nowMs: Date.now(),
      // The denorm is a COARSE-transition-only write (legacy gate) — skip it when
      // only status/sub_status/errors moved.
      skipDenorm: !estadoChanged,
      extra: errorsToClear ? { errors: [] } : {},
    },
  );

  return 'synced';
}

/** The link doc one status refresh targets, plus the ML item id the denorm keys on. */
export interface LinkStatusTarget {
  produtoId: string;
  /** The `produtoMercadoLivre` doc id under that produto. */
  linkDocId: string;
  /** ML item id — the parent denorm's array key. */
  itemId: string;
}

export interface ApplyItemStatusOpts {
  /** The ONE clock read of the calling dispatch (ms). */
  nowMs: number;
  /**
   * Merged ON TOP of the derived patch — an `estado` override (the stock
   * sender's "ML says healthy, our payload was refused" case writes `'E'` over
   * the derived `'p'`), `errors`, and so on.
   */
  extra?: Record<string, unknown>;
  /** Skip the parent denorm when the caller knows `estado` did not change. */
  skipDenorm?: boolean;
}

/**
 * Write one ML item's lifecycle status onto its link doc, plus the parent
 * produto's dual-run marketplace denorm. Extracted so the `items` webhook and
 * the stock sender's terminal 4xx branch (#781) refresh a listing IDENTICALLY —
 * the sender learns the listing's real state from ML instead of leaving a stale
 * `status: 'active'` behind, which is what made a rejected send retry forever.
 *
 * Callers that already hold the link's current values pass `skipDenorm` to keep
 * the legacy coarse-transition gate; callers that do not (the stock sender never
 * reads the link — its payload carries the writeback target) simply let the
 * denorm run, which is idempotent on replay.
 *
 * ORDER MATTERS: the two writes are not atomic and idempotency is keyed on the
 * link doc's estado/status/sub_status, so the link merge MUST be the LAST write.
 * If it ran first, a transient failure of the denorm write would leave the link
 * already at the new estado — a retry would then see `unchanged` and never
 * reconcile the parent, permanently stranding a cancelled listing in the arrays.
 * Denorm-first keeps both writes idempotent on replay (arrayUnion no-ops;
 * removeMarketplaceEntry returns null once the entry is gone), and the link only
 * advances once the denorm has succeeded.
 *
 * The denormalized arrays are DEPRECATED (the link subcollections resolve
 * linkage now) but kept in the exact shape publish/import stamp during dual-run
 * — see the canonical cluster note on `produtoSchema` and #992, which tracks
 * deleting all three fields in one piece after the cutover.
 *
 * This path does not write the third cluster member, the legacy
 * `statusProdutosMarketplace` inactive-map — and neither does publish. It is
 * NOT unwritten repo-wide, though: `importMigration.applyMarketplaceDeletion`
 * stamps a `deleted: true` entry when it prunes a fully-migrated legacy source
 * listing. Adding a write here would be a new divergence, not parity with it.
 */
export async function applyItemStatusToLink(
  db: Firestore,
  integracaoId: string,
  target: LinkStatusTarget,
  item: { status?: string | null; sub_status?: string[] | null },
  opts: ApplyItemStatusOpts,
): Promise<boolean> {
  const estado = estadoFromMlStatus(item.status);

  // THE LINK IS THE ANCHOR — check it before touching anything else. The denorm
  // has to run BEFORE the link write (see the ordering note above), which means
  // that without this guard a link deleted between planning and here would still
  // get its parent's `marketplace`/`marketplaceIds`/`integracoesComProduto`
  // arrays re-stamped by `arrayUnion` — advertising a listing whose link no
  // longer exists. `mergeIfExists` would then discard the link write and leave
  // exactly the half-applied state it was added to prevent.
  //
  // This is a guard, not an atomic gate: a delete landing between this read and
  // the writes below still half-applies. Closing that window entirely needs both
  // writes in one transaction — a bigger change than this one, and the residual
  // race is the same denorm drift the arrays already tolerate (they are
  // DEPRECATED, dual-run only). `mergeIfExists` still backstops the link half.
  const linkSnap = await produtoMercadoLivreLinkCollection
    .docRef(db, { produtoId: target.produtoId }, target.linkDocId)
    .get();
  if (!linkSnap.exists) {
    console.warn('[mercado-livre] link do anúncio já removido — writeback de status descartado', {
      integracaoId,
      produtoId: target.produtoId,
      linkDocId: target.linkDocId,
      itemId: target.itemId,
    });
    return false;
  }

  if (opts.skipDenorm !== true) {
    await updateParentDenorm(db, target.produtoId, integracaoId, target.itemId, estado);
  }

  // `mergeIfExists`, never `merge`: `target` was resolved earlier (a queued task
  // payload, a sweep row), so the link can have been deleted in between — by the
  // produto delete cascade, an operator unlinking, or the UP-migration prune. An
  // upsert would resurrect a ghost carrying only these keys and none of the
  // schema's required fields, under a possibly-deleted parent.
  const applied = await produtoMercadoLivreLinkCollection.mergeIfExists(
    db,
    { produtoId: target.produtoId },
    target.linkDocId,
    {
      estado,
      status: item.status ?? null,
      sub_status: item.sub_status ?? null,
      ultimaModificacao: opts.nowMs,
      ...(opts.extra ?? {}),
    },
  );
  if (!applied) {
    // The guard above saw the link; it was deleted while these writes ran. Rare
    // enough to deserve its own line — this is the residual race, not the
    // ordinary "already gone" case.
    console.warn(
      '[mercado-livre] link do anúncio removido DURANTE o writeback — denorm do pai pode ter sido aplicado',
      {
        integracaoId,
        produtoId: target.produtoId,
        linkDocId: target.linkDocId,
        itemId: target.itemId,
      },
    );
  }
  return applied;
}

/* -------------------------------------------------------------------------- */

interface ResolvedLink {
  produtoId: string;
  docId: string;
  data: Record<string, unknown>;
}

/**
 * Resolve the `produtoMercadoLivre` link for `itemId` on this account — the same
 * cross-app key the import + Flutter app match on: a collectionGroup query on the
 * `id` field, filtered to this integração's `contaOuterRef`.
 */
async function resolveLink(
  db: Firestore,
  itemId: string,
  integracaoId: string,
): Promise<ResolvedLink | null> {
  const snap = await produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('id', '==', itemId)
    .get();
  for (const d of snap.docs) {
    const data = d.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(data.contaOuterRef, integracaoId)) continue;
    const produtoId = d.ref.parent?.parent?.id;
    if (produtoId) return { produtoId, docId: d.id, data };
  }
  return null;
}

/**
 * Maintain the parent produto's dual-run marketplace arrays on an estado change:
 * ensure-present on a live transition (idempotent arrayUnion), key-based removal
 * on a cancel (a dead listing must stop being advertised).
 *
 * ⛔ Both arrays are DEAD WEIGHT — no query consumers, deleted at the
 * decommission (#992; audited in #961). Canonical note on `produtoSchema`.
 * `removeMarketplaceEntry` below does read them, but only to compute their own
 * next value — maintenance, not consumption. This cancel branch is the ONLY
 * thing that ever shrinks them; a link doc deleted any other way leaves them
 * stale forever, deliberately.
 *
 * A missing parent doc
 * is a no-op for BOTH branches (legacy `if (produtoPai == null) return`,
 * tasks.dart:1056-1059) — a link can outlive its produto during the delete
 * cascade window, and admin `update()` would otherwise throw NOT_FOUND (never
 * resurrect a deleted produto via a denorm write).
 */
async function updateParentDenorm(
  db: Firestore,
  produtoId: string,
  integracaoId: string,
  itemId: string,
  estado: string,
): Promise<void> {
  const ref = produtoCollection.docRef(db, {}, produtoId);
  const snap = await ref.get();
  if (!snap.exists) return;
  if (estado === 'c') {
    const patch = removeMarketplaceEntry(
      (snap.data() ?? {}) as Record<string, unknown>,
      integracaoId,
      itemId,
    );
    if (patch) await ref.update(patch);
    return;
  }
  await ref.update({
    marketplace: FieldValue.arrayUnion({ integracaoUid: integracaoId, externalId: itemId }),
    marketplaceIds: FieldValue.arrayUnion(itemId),
  });
}

/**
 * Remove this listing's denorm entry keyed by `(integracaoUid, externalId)` —
 * a read-modify-write (NOT `arrayRemove`, which needs an exact object match and
 * would miss a Flutter-written entry carrying extra fields).
 * Returns null when nothing matched (no write needed).
 *
 * ⚠️ This used to also drop the conta from `integracoesComProduto` when no other
 * listing survived, and THAT is what coupled the three arrays: the conta was
 * only ever removable by re-deriving it from `marketplace`, so `marketplace`
 * could not be retired without leaving the array append-only (#431 lock 2).
 * `onProdutoMercadoLivreLinkChanged` owns the conta now — the same cancel that
 * gets here also merges `estado: 'c'` onto the link doc, and the trigger
 * re-derives membership from the surviving links inside a transaction.
 *
 * Do not reintroduce the field here. Two writers deciding "no listing survives"
 * from different sources is how a conta gets dropped while one is still live,
 * and that failure is silent: the sweeps simply stop selecting the produto.
 *
 * ⛔ Nor should the two arrays it DOES still touch grow any new maintenance:
 * they are dead weight with no query consumers, deleted at the decommission
 * (#961). The read-modify-write here is the field maintaining itself, not a
 * consumer. Extending this to prune on link deletion would be machinery built
 * to be thrown away.
 */
function removeMarketplaceEntry(
  raw: Record<string, unknown>,
  integracaoId: string,
  itemId: string,
): Record<string, unknown> | null {
  const marketplace = asObjectArray(raw.marketplace);
  const marketplaceIds = asStringArray(raw.marketplaceIds);

  const nextMarketplace = marketplace.filter(
    (e) => !(e.integracaoUid === integracaoId && e.externalId === itemId),
  );
  const nextIds = marketplaceIds.filter((id) => id !== itemId);

  const changed =
    nextMarketplace.length !== marketplace.length || nextIds.length !== marketplaceIds.length;
  if (!changed) return null;

  return {
    marketplace: nextMarketplace,
    marketplaceIds: nextIds,
  };
}

function asObjectArray(v: unknown): Array<Record<string, unknown>> {
  return Array.isArray(v) ? v.filter((e): e is Record<string, unknown> => isPlainObject(e)) : [];
}
function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === 'string') : [];
}
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

function stringArraysEqual(a: string[] | null, b: string[] | null): boolean {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  for (let i = 0; i < aa.length; i += 1) if (aa[i] !== bb[i]) return false;
  return true;
}
