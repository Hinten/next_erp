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
 *
 * Scope (7a): SIMPLE listings. User-Products links, a listing still mid-migration
 * (`estado === 'am'`), and migration-tagged items are DEFERRED to #441 (the
 * Flutter app owns the UP migration during dual-run; syncing `estado` here would
 * fight it). The variation-children denorm sweep on cancel is deferred to #438
 * (7a produtos are childless).
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
import { refMatchesIntegracao } from './linkRefs';

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

export type ItemsSyncOutcome =
  | 'synced' // the link (and maybe parent denorm) was updated
  | 'unchanged' // estado/status/sub_status all already current (idempotent no-op)
  | 'no-link' // no linked produto for this item on this account
  | 'deferred-up' // a User-Products / migrating listing — deferred to #441
  | 'item-gone'; // the listing 404s (deleted) — nothing to sync

/**
 * Sync one ML item's lifecycle status onto its linked `produtoMercadoLivre` doc.
 * Returns a deterministic outcome; a transient failure THROWS (pipeline retries).
 */
export async function syncItemStatus(
  db: Firestore,
  api: ItemsSyncApi,
  integracaoId: string,
  itemId: string,
): Promise<ItemsSyncOutcome> {
  let item: MlItem;
  try {
    item = await api.getItem(itemId);
  } catch (err) {
    // A deleted listing (404) can't be synced and won't recover on retry.
    if (err instanceof MercadoLivreHttpError && err.status === 404) return 'item-gone';
    throw err; // transient (5xx/429/network) or reauth → the queue/sweep retry
  }

  const link = await resolveLink(db, itemId, integracaoId);
  if (!link) return 'no-link';

  // User-Products / migration edge → #441. A UP link, a listing still awaiting
  // migration (`estado === 'am'`), or a migration-tagged item is driven by the
  // Flutter app during dual-run; touching `estado` here would fight the migration.
  const tags = item.tags ?? [];
  const isMigration = tags.some((t) => MIGRATION_TAGS.has(t));
  if (link.data.isUserProductModel === true || link.data.estado === 'am' || isMigration) {
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

  const estadoChanged = estado !== currentEstado;
  const linkChanged =
    estadoChanged || status !== currentStatus || !stringArraysEqual(subStatus, currentSubStatus);

  if (!linkChanged) return 'unchanged';

  // Parent marketplace denorm FIRST — only on a COARSE estado transition (legacy
  // gate). These arrays are DEPRECATED (Pipelines resolve linkage now, #431) but
  // kept in the exact shape publish/import stamp during dual-run. The legacy
  // `statusProdutosMarketplace` inactive-map is intentionally NOT written (neither
  // publish nor import writes it). Variation-children sweep on cancel → #438.
  //
  // ORDER MATTERS: the two writes are not atomic and idempotency is keyed on the
  // link doc's estado/status/sub_status, so the link merge MUST be the LAST write.
  // If it ran first, a transient failure of the denorm write would leave the link
  // already at the new estado — a retry would then see `unchanged` and never
  // reconcile the parent, permanently stranding a cancelled listing in the arrays.
  // Denorm-first keeps both writes idempotent on replay (arrayUnion no-ops;
  // removeMarketplaceEntry returns null once the entry is gone), and the link only
  // advances once the denorm has succeeded.
  if (estadoChanged) {
    await updateParentDenorm(db, link.produtoId, integracaoId, itemId, estado);
  }

  await produtoMercadoLivreLinkCollection.merge(db, { produtoId: link.produtoId }, link.docId, {
    estado,
    status,
    sub_status: subStatus,
    ultimaModificacao: Date.now(),
  });

  return 'synced';
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
 * on a cancel (a dead listing must stop being advertised). A missing parent doc
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
    integracoesComProduto: FieldValue.arrayUnion(integracaoId),
  });
}

/**
 * Remove this listing's denorm entry keyed by `(integracaoUid, externalId)` —
 * a read-modify-write (NOT `arrayRemove`, which needs an exact object match and
 * would miss a Flutter-written entry carrying extra fields). Drops the integração
 * from `integracoesComProduto` only when it has no OTHER listing on this produto.
 * Returns null when nothing matched (no write needed).
 */
function removeMarketplaceEntry(
  raw: Record<string, unknown>,
  integracaoId: string,
  itemId: string,
): Record<string, unknown> | null {
  const marketplace = asObjectArray(raw.marketplace);
  const marketplaceIds = asStringArray(raw.marketplaceIds);
  const integracoes = asStringArray(raw.integracoesComProduto);

  const nextMarketplace = marketplace.filter(
    (e) => !(e.integracaoUid === integracaoId && e.externalId === itemId),
  );
  const nextIds = marketplaceIds.filter((id) => id !== itemId);
  const stillHasIntegracao = nextMarketplace.some((e) => e.integracaoUid === integracaoId);
  const nextIntegracoes = stillHasIntegracao
    ? integracoes
    : integracoes.filter((i) => i !== integracaoId);

  const changed =
    nextMarketplace.length !== marketplace.length ||
    nextIds.length !== marketplaceIds.length ||
    nextIntegracoes.length !== integracoes.length;
  if (!changed) return null;

  return {
    marketplace: nextMarketplace,
    marketplaceIds: nextIds,
    integracoesComProduto: nextIntegracoes,
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
