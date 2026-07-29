/**
 * User-Products (UPtin) migration handler — issue #441. When Mercado Livre
 * migrates a legacy `variations[]` listing to the User-Products model, the OLD
 * item is tagged `variations_migration_source` and closed; this module imports
 * every replacement UP member onto the SAME ERP produtos the old listing used
 * (parent + variation children), then prunes the now-obsolete legacy PML +
 * `variacaoMercadoLivre` links once every one of them has a replacement.
 *
 * Ports the migration branch of the legacy `_atualizarStatusProdutoMercadoLivre`
 * (`.old/packages/canais_de_venda/mercado_livre/lib/src/tasks.dart:871-1036`),
 * called out from the `items` status-sync (`itemsStatusSync.ts`) once it sees
 * the source tag + `status: 'closed'` (#441's sync-side seam).
 *
 * ---- The "old parent" — verified against `.old` (not just the migration
 * branch itself), because getting this wrong mints a duplicate family parent:
 *
 * `GET /items/{id}/migration_live_listing` returns `{ new_items: [{
 * new_item_id, variation_id }] }` — `variation_id` is the OLD, per-listing
 * numeric variation id (`VariacoesML.id`), NOT a produto id. Legacy resolves it
 * to a produto via `VariacoesML.documents.id__isEqualTo(oldVariationId)`
 * (tasks.dart:918-926) and passes `oldVariationMl.reference.parent!.docId!.id!`
 * — the produto OWNING that `VariacoesML` doc — as `produtoPaiUid` into
 * `cadastrarOuAtualizarProdutoMercadoLivre` (tasks.dart:930-944). Both legacy
 * `VariacoesML` write sites parent the doc under the VARIATION CHILD produto,
 * never the top-level listing parent (`produtos.dart:335-340` — legacy
 * `variations[]` import: `.copyWithParent(parent: produtoVariacaoInstace, ...)`;
 * `produtos.dart:770-774` — User-Products import: `.copyWithParent(parent:
 * produtoVariacaoInstace, ...)` again) — so `oldVariationMl.reference.parent` IS
 * that one variation's OWN child produto (call it `Ci`), NOT the shared parent.
 *
 * `cadastrarOuAtualizarProdutoMercadoLivre` forwards `produtoPaiUid` straight
 * into `_importarUserProductItem`'s `produtoArakeneId` (`produtos.dart:76-91`),
 * which does NOT use it as the family parent directly — it REDIRECTS
 * (`produtos.dart:517-527`):
 *   ```
 *   final produtoArakene = await Produto.documents.doc(produtoArakeneId);
 *   if (produtoArakene.paiId == null) {
 *     futuroPai = produtoArakene;               // Ci has no parent → Ci IS the family parent
 *   } else {
 *     oldProdutoVariacao = produtoArakene;       // Ci becomes the pre-resolved CHILD
 *     futuroPai = await Produto.documents.doc(produtoArakene.paiId!); // Ci's OWN parent → family parent
 *   }
 *   ```
 * Every `Ci` written by the legacy `variations[]` import has a non-null
 * `paiId` (`produtos.dart:280` / `toProdutoArakene`'s `paiId: oldProduto?.paiId
 * ?? paiUid`, first-write `paiUid` = the listing's shared top-level parent —
 * call it `TP`). So the redirect ALWAYS fires here: `futuroPai = TP` — the SAME
 * produto for every `Ci` of the same listing, because every `Ci` shares one
 * `paiId`. And `TP` is exactly `sourceLink.produtoId` — the produto that owns
 * the SOURCE `produtoMercadoLivre` doc this migration fires from (the whole
 * `variations[]` listing's link, per the identical parenting rule applied one
 * level up by the ORIGINAL, non-migration import).
 *
 * So the correct, dual-run-equivalent override is `sourceLink.produtoId`
 * (constant for the WHOLE migration run — every `new_items` entry belongs to
 * the same source listing) — never a per-entry `Ci`. This also matches the
 * observed convergence property that motivated `resolveUpParentOverride`
 * existing at all (A2): the first member of the family mints a fresh
 * `produtoMercadoLivre` link under the override produto; every SUBSEQUENT
 * member of the SAME run (or a later replay) finds that SAME link via
 * `id == canonicalId` and reuses it — which only converges onto ONE doc when
 * every member is overridden onto the SAME produto. Per-entry `Ci` would give
 * every member ITS OWN "family" produto instead, breaking that convergence.
 *
 * `Ci` (the resolved OLD `VariacoesML`/`variacaoMercadoLivre` link's owning
 * produto) is still resolved here — but only to (a) confirm the old variation
 * actually exists (mirrors the legacy `UnimplementedError` guard) and (b) queue
 * it for deletion once the whole source listing is migrated. Its `paiId ==
 * sourceLink.produtoId` is exactly what lets `resolveExistingChild`'s SKU
 * fallback (`importVariations.ts`) rediscover `Ci` itself as the new member's
 * child — the "CHILD continuity for free" this module relies on instead of
 * replicating legacy's `oldProdutoVariacao` short-circuit.
 *
 * ---- `applyMarketplaceDeletion` — ported from
 * `.old/packages/produtos/lib/src/models.dart:1132-1178`, pinned by
 * `produto_marketplace_delete_test.dart`. Quotes (produto_marketplace_delete_test.dart):
 *  - test 1: a `marketplace` entry `{integracaoUid: 'integracoes/ml123',
 *    externalId: 'MLB_PARENT'}` deleted by target `{integracaoUid: 'ml123',
 *    externalId: 'MLB_PARENT'}` (integração compared by LAST PATH SEGMENT only,
 *    tolerating an `integracoes/` prefix on either side) ends up empty, and
 *    `statusProdutosMarketplace['integracoes/ml123_MLB_PARENT'].deleted` is
 *    `true` — the status key uses the MATCHED ENTRY's own raw `integracaoUid`
 *    (prefix and all), not the target's.
 *  - test 2: a variant entry `{integracaoUid: 'ml123', externalParentId:
 *    'MLB_PARENT', externalId: 'MLB_VAR_1'}` matches a target whose
 *    `externalId` equals the variant's `externalParentId` (not its own
 *    `externalId`) — `matchExternalParentId`, defaulted `true` at every legacy
 *    call site including the migration one (`tasks.dart:981-988`) — and the
 *    status key is `'ml123_MLB_VAR_1'` (the MATCHED entry's own externalId).
 *  - test 3: no integração match ⇒ returns the produto UNCHANGED (`identical`)
 *    — ported here as returning `null` so the caller skips a no-op write.
 * `integracoesComProduto` is RECOMPUTED from the surviving `marketplace`
 * entries (not filtered from the old list); `marketplaceIds` is filtered
 * (last-segment-tolerant) then de-duplicated, insertion order preserved
 * (`.toSet().toList()`).
 *
 * ---- Prune gating — verified directly against `tasks.dart:960-1012` (NOT
 * just the summarized version): the denorm-cleanup + SOURCE PML deletion
 * (:975-999) are gated on "every `variacaoMercadoLivre` link that still points
 * at the source PML is one we're deleting this run" — but the final loop that
 * deletes each `Ci`'s OLD link (:1003-1006) sits OUTSIDE that gate, applied
 * UNCONDITIONALLY to every entry this run resolved. So a PARTIAL migration
 * (one sibling variation not yet covered by `new_items`) still deletes the
 * OLD links this run replaced — only the source PML doc + its denorm entry
 * survive when the source listing isn't fully migrated yet.
 *
 * ---- Error path — ported from `tasks.dart:1015-1027`, narrowed per this
 * repo's no-generic-catch rule: ANY throw during the migration stamps the
 * source PML `estado: 'E'` best-effort (a strict `.update()`, not `.merge()`,
 * so a doc that's ALREADY been pruned/deleted throws NOT_FOUND rather than
 * silently resurrecting a partial doc) and always rethrows the ORIGINAL error
 * — mirroring the existing `persistNotificationFailure` catch shape in
 * `notificacao.ts` (log-and-continue on an unexpected secondary failure,
 * never mask the original with it).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type MercadoLivreApi } from '@delfrance/integrations-mercado-livre';
import { toOuterRef } from '@delfrance/schemas';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { type ImportDeps, importProduto } from './import';
import { type ImportOptions, MercadoLivreImportError } from './importCore';
import { isNotFound } from '@delfrance/data/admin';
import { lastSegment, refMatchesIntegracao } from './linkRefs';

/** Every import side-effect OFF (#441) — the migration only converges existing
 * ERP data onto the new listing ids; it never (re)writes stock/price/photos/
 * category, and never fills the parent's null fields from the new item's data
 * (all fill-*, overwrite-* and atualizar* flags false, mirroring the legacy
 * migration call at `tasks.dart:930-944`). Family fan-out is ALSO off — THIS
 * loop already enumerates every family member via `migration_live_listing`.
 */
const MIGRATION_IMPORT_OPTIONS: ImportOptions = {
  importarEstoque: false,
  sobrescreverEstoque: false,
  importarPreco: false,
  sobrescreverPreco: false,
  atualizarProdutoPai: false,
  importarFotos: false,
  importarCategorias: false,
};

export interface UptinMigrationDeps {
  db: Firestore;
  api: MercadoLivreApi;
  integracaoId: string;
  sellerUserId: number | null;
  tabelaNormalOuterRef: string | null;
  tabelaPromocionalOuterRef: string | null;
  depositoOuterRef: string | null;
}

/** The SOURCE `produtoMercadoLivre` link the migration fires from — resolved
 * by the caller (`itemsStatusSync.ts`) before this module is invoked. */
export interface UptinSourceLink {
  produtoId: string;
  linkDocId: string;
  raw: Record<string, unknown>;
}

/**
 * Run the UPtin migration for one `items` notification whose tags + status
 * matched the migration guard (caller's job — see `itemsStatusSync.ts`).
 * Idempotent/replay-safe (every write below converges on retry); THROWS on any
 * failure so the caller's pipeline retries (after best-effort stamping the
 * source PML `estado: 'E'`).
 */
export async function handleUptinMigration(
  deps: UptinMigrationDeps,
  itemId: string,
  sourceLink: UptinSourceLink,
): Promise<void> {
  const { db, api, integracaoId } = deps;
  const now = Date.now();
  const sourcePmlOuterRef = toOuterRef(
    `produtos/${sourceLink.produtoId}/produtoMercadoLivre/${sourceLink.linkDocId}`,
  );

  try {
    const migrationData = await api.getMigrationLiveListing(itemId);

    // A family shares ONE new produtoMercadoLivre link (tasks.dart:890-893
    // comment) — dedup by its path so an already-fully-registered family only
    // gets ONE stamp write regardless of how many `new_items` resolve to it.
    const pmlsToStamp = new Map<string, { produtoId: string; linkDocId: string }>();
    const oldLinksToDelete: Array<{ produtoId: string; docId: string }> = [];

    for (const newItem of migrationData.new_items) {
      const newItemId = asStringId(newItem.new_item_id);
      if (newItemId == null) continue; // nothing usable to key on — skip

      // Idempotency FIRST (tasks.dart:901-914): a previous run may have
      // already imported this member — its own variacaoMercadoLivre link
      // (itemId == newItemId) already exists, pointing at the family's PML.
      const registered = await findRegisteredMember(db, newItemId, integracaoId);
      if (registered) {
        if (!pmlsToStamp.has(registered.pmlPath)) {
          pmlsToStamp.set(registered.pmlPath, {
            produtoId: registered.produtoId,
            linkDocId: registered.linkDocId,
          });
        }
        // Convergence after a mid-run crash: a previous attempt may have
        // imported this member but died BEFORE the prune batch, leaving its
        // OLD link alive — and this stamp-only path would then never enqueue
        // it again, so `fullyMigrated` could never become true. Best-effort
        // re-locate it (no throw — on a clean replay it's already deleted and
        // this finds nothing, keeping "successful replay is stamp-only").
        const staleVariationId = asNumericVariationId(newItem.variation_id);
        const staleOldLink =
          staleVariationId != null
            ? await findOldVariacaoLink(db, staleVariationId, sourcePmlOuterRef)
            : null;
        if (staleOldLink) {
          oldLinksToDelete.push({ produtoId: staleOldLink.produtoId, docId: staleOldLink.docId });
        }
        continue;
      }

      // Not yet imported: locate the OLD variation this new item replaces
      // (tasks.dart:916-926) — required to exist (legacy `UnimplementedError`;
      // ours `MercadoLivreImportError`), and queued for deletion once found.
      const variationId = asNumericVariationId(newItem.variation_id);
      const oldLink =
        variationId != null ? await findOldVariacaoLink(db, variationId, sourcePmlOuterRef) : null;
      if (!oldLink) {
        throw new MercadoLivreImportError([
          `não foi possível localizar a variação antiga (variation_id ${String(
            newItem.variation_id ?? 'null',
          )}) para o novo item ${newItemId} durante a migração UPtin do anúncio ${itemId}`,
        ]);
      }

      // Import the new item onto the SAME family produto as every sibling —
      // see the module doc for why this is `sourceLink.produtoId`, not `Ci`.
      const importDeps: ImportDeps = {
        db,
        api,
        integracaoId,
        sellerUserId: deps.sellerUserId,
        tabelaNormalOuterRef: deps.tabelaNormalOuterRef,
        tabelaPromocionalOuterRef: deps.tabelaPromocionalOuterRef,
        depositoOuterRef: deps.depositoOuterRef,
        options: MIGRATION_IMPORT_OPTIONS,
        familyFanOut: false,
        upParentOverride: { produtoId: sourceLink.produtoId },
      };
      await importProduto(importDeps, newItemId);

      oldLinksToDelete.push({ produtoId: oldLink.produtoId, docId: oldLink.docId });
    }

    // Already-registered members: bump their family PML to publicado
    // (tasks.dart:951-958) — freshly-imported members already land at the
    // correct estado via the import itself, so they're never stamped here.
    for (const pml of pmlsToStamp.values()) {
      await produtoMercadoLivreLinkCollection.merge(
        db,
        { produtoId: pml.produtoId },
        pml.linkDocId,
        {
          estado: 'p',
          isUserProductModel: true,
          ultimaModificacao: now,
        },
      );
    }

    if (oldLinksToDelete.length > 0) {
      await pruneMigratedSource(
        db,
        sourceLink,
        sourcePmlOuterRef,
        oldLinksToDelete,
        integracaoId,
        itemId,
      );
    }
  } catch (err) {
    try {
      await stampSourceError(db, sourceLink, now);
    } catch (stampErr) {
      if (!(stampErr instanceof Error)) throw stampErr;
      if (!isNotFound(stampErr)) {
        // Unexpected failure while recording the error state — never silently
        // dropped, but the ORIGINAL migration failure below still wins (mirrors
        // notificacao.ts's `persistNotificationFailure` catch shape).
        console.error(
          '[mercado-livre] falha ao marcar PML de origem como erro após falha na migração UPtin',
          {
            produtoId: sourceLink.produtoId,
            linkDocId: sourceLink.linkDocId,
            cause: stampErr.message,
          },
        );
      }
      // NOT_FOUND (the PML was already deleted, e.g. a prior attempt pruned it
      // before crashing) or a logged infra failure — either way, fall through.
    }
    throw err;
  }
}

/* -------------------------------------------------------------------------- */

/**
 * An already-imported family member for `newItemId` — a `variacaoMercadoLivre`
 * link with `itemId == newItemId`, scoped to THIS integração via its family
 * PML's `contaOuterRef` (tasks.dart's global `.first()` has no such scoping;
 * an MLB item id is globally unique so this is defense-in-depth, matching the
 * same pattern `import.ts`'s `resolveExistingUpParent` uses).
 */
async function findRegisteredMember(
  db: Firestore,
  newItemId: string,
  integracaoId: string,
): Promise<{ produtoId: string; linkDocId: string; pmlPath: string } | null> {
  const snap = await variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('itemId', '==', newItemId)
    .limit(10)
    .get();
  for (const d of snap.docs) {
    const raw = d.data() as Record<string, unknown>;
    const pmlOuterRef = raw.produtoMercadoLivreOuterRef;
    if (typeof pmlOuterRef !== 'string') continue;
    const parsed = parsePmlOuterRef(pmlOuterRef);
    if (!parsed) continue;
    const pmlSnap = await produtoMercadoLivreLinkCollection
      .docRef(db, { produtoId: parsed.produtoId }, parsed.linkId)
      .get();
    if (!pmlSnap.exists) continue;
    const pmlRaw = pmlSnap.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(pmlRaw.contaOuterRef, integracaoId)) continue;
    return { produtoId: parsed.produtoId, linkDocId: parsed.linkId, pmlPath: pmlOuterRef };
  }
  return null;
}

/**
 * The OLD `variacaoMercadoLivre` link for `variationId`, scoped to the SOURCE
 * PML (tasks.dart queries `VariacoesML` globally by numeric `id`; ours scopes
 * server-side to `produtoMercadoLivreOuterRef == sourcePmlOuterRef` — an
 * approved improvement, since a numeric variation id is only unique WITHIN its
 * own listing, not globally, mirroring `importVariations.ts`'s legacy
 * `variations[]` child resolve).
 */
async function findOldVariacaoLink(
  db: Firestore,
  variationId: number,
  sourcePmlOuterRef: string,
): Promise<{ produtoId: string; docId: string } | null> {
  const snap = await variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('id', '==', variationId)
    .where('produtoMercadoLivreOuterRef', '==', sourcePmlOuterRef)
    .limit(1)
    .get();
  const d = snap.docs[0];
  if (!d) return null;
  const produtoId = d.ref.parent?.parent?.id;
  if (!produtoId) return null;
  return { produtoId, docId: d.id };
}

/**
 * Prune the source listing once every one of its OLD variation links has a
 * replacement (tasks.dart:960-1012 — see the module doc for the exact gating
 * this ports, including the deliberately-UNCONDITIONAL final delete loop).
 */
async function pruneMigratedSource(
  db: Firestore,
  sourceLink: UptinSourceLink,
  sourcePmlOuterRef: string,
  oldLinksToDelete: ReadonlyArray<{ produtoId: string; docId: string }>,
  integracaoId: string,
  itemId: string,
): Promise<void> {
  const allLinksSnap = await variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('produtoMercadoLivreOuterRef', '==', sourcePmlOuterRef)
    .get();
  const deletedIds = new Set(oldLinksToDelete.map((l) => l.docId));
  const fullyMigrated =
    allLinksSnap.docs.length > 0 && allLinksSnap.docs.every((d) => deletedIds.has(d.id));

  // ONE atomic WriteBatch for the whole prune — legacy commits the denorm
  // update + source-PML delete + every old-link delete together
  // (tasks.dart:966-1009), so a mid-prune failure can't strand a half-pruned
  // state (e.g. the source PML gone but old links orphaned).
  const batch = db.batch();

  if (fullyMigrated) {
    const sourceProdutoRef = produtoCollection.docRef(db, {}, sourceLink.produtoId);
    const sourceProdutoSnap = await sourceProdutoRef.get();
    if (sourceProdutoSnap.exists) {
      const raw = (sourceProdutoSnap.data() ?? {}) as Record<string, unknown>;
      const sourceExternalId = asStringId(sourceLink.raw.id) ?? itemId;
      const patch = applyMarketplaceDeletion(raw, {
        integracaoUid: integracaoId,
        externalId: sourceExternalId,
      });
      // Same cast precedent as importTaxonomia's tx writes — WriteBatch.update
      // wants UpdateData's template-literal key type, which a concrete
      // interface can't satisfy structurally.
      if (patch) batch.update(sourceProdutoRef, patch as FirebaseFirestore.DocumentData);
    }
    batch.delete(
      produtoMercadoLivreLinkCollection.docRef(
        db,
        { produtoId: sourceLink.produtoId },
        sourceLink.linkDocId,
      ),
    );
  }

  // Unconditional (tasks.dart:1003-1006, OUTSIDE the fully-migrated gate above):
  // every old link THIS RUN just replaced is stale regardless of whether
  // SIBLING variations of the same source listing are still pending.
  for (const link of oldLinksToDelete) {
    batch.delete(
      variacaoMercadoLivreLinkCollection.docRef(db, { produtoId: link.produtoId }, link.docId),
    );
  }
  await batch.commit();
}

/**
 * Best-effort `estado: 'E'` stamp on the source PML (tasks.dart:1017-1020). A
 * strict `.update()` (not `.merge()`/`.set(..., {merge:true})`, which would
 * silently CREATE a partial doc) so a doc pruned by an earlier attempt throws
 * NOT_FOUND instead of resurrecting.
 */
async function stampSourceError(
  db: Firestore,
  sourceLink: UptinSourceLink,
  now: number,
): Promise<void> {
  const patch = produtoMercadoLivreLinkCollection.parseMerge({
    estado: 'E',
    ultimaModificacao: now,
  });
  await produtoMercadoLivreLinkCollection
    .docRef(db, { produtoId: sourceLink.produtoId }, sourceLink.linkDocId)
    .update(patch);
}

/* --------------------------- applyMarketplaceDeletion --------------------- */

interface MarketplaceDeletionTarget {
  integracaoUid: string;
  externalId: string;
}

interface MarketplaceDeletionPatch {
  marketplace: Array<Record<string, unknown>>;
  integracoesComProduto: string[];
  marketplaceIds: string[];
  statusProdutosMarketplace: Record<string, unknown>;
}

/** `StatusProdMarketplace.deleted()`'s exact wire JSON — the generated Dart
 * `toJson` (models.g.dart `_$StatusProdMarketplaceToJson`) writes `error`,
 * `enviarEstoque`, `retries` and `autoImport` UNCONDITIONALLY (explicit nulls;
 * only `deleted` sits behind `writeNotNull`), so byte-parity keeps the nulls. */
const DELETED_STATUS_PRODUTO_MARKETPLACE = {
  error: false,
  enviarEstoque: false,
  retries: null,
  autoImport: null,
  deleted: true,
};

/**
 * TS port of `Produto.applyMarketplaceDeletion`
 * (`.old/packages/produtos/lib/src/models.dart:1132-1178`) — see the module
 * doc for the pinned test-verified semantics. Returns null when nothing in
 * `marketplace` matches `target` (mirrors Dart's `identical(updated, produto)`
 * short-circuit), so the caller can skip a no-op write.
 */
function applyMarketplaceDeletion(
  produtoRaw: Record<string, unknown>,
  target: MarketplaceDeletionTarget,
): MarketplaceDeletionPatch | null {
  const marketplace = asObjectArray(produtoRaw.marketplace);
  if (marketplace.length === 0) return null;

  const targetIntegracao = lastSegment(target.integracaoUid);
  const shouldDelete = (entry: Record<string, unknown>): boolean => {
    const entryIntegracao =
      typeof entry.integracaoUid === 'string' ? lastSegment(entry.integracaoUid) : null;
    if (entryIntegracao == null || entryIntegracao !== targetIntegracao) return false;
    if (entry.externalId === target.externalId) return true;
    if (entry.externalParentId != null && entry.externalParentId === target.externalId) return true;
    return false;
  };

  const removed = marketplace.filter(shouldDelete);
  if (removed.length === 0) return null;

  const updatedMarketplace = marketplace.filter((e) => !shouldDelete(e));
  const removedExternalIds = new Set(removed.map((e) => String(e.externalId)));

  const marketplaceIds = uniqueFirstSeen(
    asStringArray(produtoRaw.marketplaceIds).filter(
      (id) => !removedExternalIds.has(lastSegment(id)),
    ),
  );
  const integracoesComProduto = uniqueFirstSeen(
    updatedMarketplace.map((e) => String(e.integracaoUid)),
  );

  const existingStatus = isPlainObject(produtoRaw.statusProdutosMarketplace)
    ? produtoRaw.statusProdutosMarketplace
    : {};
  const statusProdutosMarketplace: Record<string, unknown> = { ...existingStatus };
  for (const entry of removed) {
    const key = `${String(entry.integracaoUid)}_${String(entry.externalId)}`;
    statusProdutosMarketplace[key] = DELETED_STATUS_PRODUTO_MARKETPLACE;
  }

  return {
    marketplace: updatedMarketplace,
    integracoesComProduto,
    marketplaceIds,
    statusProdutosMarketplace,
  };
}

/* ------------------------------- small helpers ----------------------------- */

function asStringId(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function asNumericVariationId(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * Parse a canonical `documents/produtos/<produtoId>/produtoMercadoLivre/<linkId>`
 * outer-ref into its produto + link doc ids — a local copy of `import.ts`'s
 * private `parsePmlOuterRef` (same 6-liner; duplicated rather than exported to
 * avoid a cross-module coupling for one tiny parser, matching this folder's
 * existing convention of small local duplicates — e.g. `importVariations.ts`'s
 * own `sha256`).
 */
function parsePmlOuterRef(ref: string): { produtoId: string; linkId: string } | null {
  const segs = ref.split('/').filter(Boolean);
  const i = segs.indexOf('produtos');
  if (i === -1 || i + 3 >= segs.length) return null;
  if (segs[i + 2] !== 'produtoMercadoLivre') return null;
  return { produtoId: segs[i + 1]!, linkId: segs[i + 3]! };
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

/** Insertion-order de-dup (`Set` preserves first-seen order) — same shape as
 * `import.ts`'s private `uniqueFirstSeen`, duplicated for the same reason. */
function uniqueFirstSeen(values: readonly string[]): string[] {
  return [...new Set(values)];
}
