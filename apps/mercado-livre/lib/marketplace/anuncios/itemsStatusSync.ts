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
 *  - EXPLAINS a moderated listing (#1087): when ML's status/sub_status says a
 *    moderation exists, this also reads `GET /moderations/last_moderation` and
 *    stores its REASON/REMEDY as `moderacoes`. Without it the operator saw a
 *    listing go `pausado` with no reason anywhere in the ERP, while ML had one
 *    the whole time. See `fetchModeracoes` below.
 *
 * ⚠️ There is NO `moderations` notification topic — checked against ML's own
 * topic list. A moderation arrives as an ordinary `items` delivery, which is why
 * it belongs here and not in a new receiver; ML's *Gerenciar moderações* even
 * derives the `moderation_reference_id` from this notification (`id` + `-ITM`).
 *
 * ⚠️ On THIS path `moderacoes` is written on every status write, value or `[]`,
 * in the SAME patch as the status it explains: a reason cannot outlive the state
 * it describes, because they are one write, and a stale moderation on a healthy
 * listing is indistinguishable from a real one. That is the invariant, and it is
 * stronger than the `errors`/`causas` clearing rule it deliberately does not
 * share.
 *
 * ⚠️ Repo-wide it carries one qualification this sync never exercises. The
 * IMPORTER can write a THIRD value — `null`, "never asked" — on its two skip
 * paths (the mass import, and a `/moderations` read that failed), which omits the
 * key so the stored reason stands instead of being overwritten with a
 * healthy-looking `[]`. The CLEARING half still holds on every path, because
 * `precisaConsultarModeracao` answers from the item already fetched. Do not
 * restate the rule as unconditional here — `produtoMercadoLivreLinkSchema` owns
 * the canonical wording.
 *
 * `applyItemStatusToLink` (exported at the bottom) is the shared status-writeback
 * core: this sync and the stock sender's terminal 4xx branch refresh a listing
 * through the SAME code, so the sender can never again leave a stale
 * `status: 'active'` behind for the sweep's gate to trip over.
 *
 * ⚠️ THE ERP OWNS `estado`. This used to stand down for two kinds of link — a
 * User-Products one (`isUserProductModel`) and one still awaiting ML's UP
 * migration (`estado === 'am'`) — on the grounds that the Flutter app drove them
 * "during dual-run" and syncing here would fight it. **There is no dual run and
 * there never will be one** (root `CLAUDE.md` rule 8): the two apps never share a
 * document, and the cutover turns Flutter off. So that guard deferred to a writer
 * that will not exist and left `estado` with no owner at all. Under the UP model
 * `isUserProductModel` is true for every listing a `user_product_seller`
 * publishes, so it silently skipped the entire future catalogue (#1087). `'am'`
 * had no writer here either — it only ever arrived from Flutter, and with that
 * guard in place such a link could never be corrected AND could never reach the
 * takeover below, which needs the fetched item's tags. The ONLY reason to defer
 * now is ML's own migration tags, which are ML's signal, not ours — and this sync
 * now WRITES `'am'` from them (`stampAguardandoMigracao`), so the value has a
 * producer again for the three rungs that still gate on it.
 *
 * A cancel removes the PARENT produto's denorm entry (`removeMarketplaceEntry`
 * below) but does not walk down to the variation-children produtos. That sweep
 * was once deferred to #438; it is now moot rather than pending — the whole
 * denorm cluster is deleted at the cutover (#992), and leaving stale entries
 * behind is already the norm everywhere else (canonical note on `produtoSchema`).
 *
 * #441 (UP migration takeover): a `variations_migration_source`-tagged listing
 * that has gone `closed` is the ML-side signal that a legacy `variations[]`
 * listing finished migrating to User-Products — `migrationRunner`, when
 * supplied, runs that takeover (see `importMigration.ts`'s `handleUptinMigration`,
 * wired as the default by `notificacao.ts`) INSTEAD of the normal estado merge.
 * Every other migration-tag case defers, each under its OWN outcome — see the
 * `ItemsSyncOutcome` note — and STAMPS `estado: 'am'`, since this sync is the
 * only component that reads ML's migration tags on its own schedule and three
 * other rungs gate on that value (`stampAguardandoMigracao` below).
 *
 * #1142 (User-Products FAMILIES): a family's parent link carries the FAMILY id,
 * so a member's `items` delivery matches no parent link by `id` — `resolveLink`
 * therefore has a SECOND stage that comes in through `variacaoMercadoLivre.itemId`
 * and hops up the parent ref. What arrives is one of N listings the parent link
 * summarises, so it is NOT written straight through: each member's raw status is
 * recorded on its OWN link and the parent takes a FOLD of all of them
 * (`upFamilyStatus.ts`).
 *
 * ⚠️ The fold exists for one transition. `estado` feeds `linkHasLiveListing`,
 * which drives `produtos.integracoesComProduto` — the anchor pre-filter BOTH ML
 * sweeps open with — so letting a single member's `closed` set the family to
 * `'c'` would drop a produto whose siblings are still selling out of the stock
 * and price sweeps, with nothing logged and nothing failing. `'c'` is written
 * only when every observed member is closed, and never while one was never
 * observed.
 */
import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import { ESTADO_PUBLICACAO_ML, type MlModeracao } from '@delfrance/schemas';
import {
  type MlItem,
  type MlModeration,
  MercadoLivreHttpError,
  createMercadoLivreApi,
  estadoFromMlStatus,
  itemStockLivesOnChildren,
} from '@delfrance/integrations-mercado-livre';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { loadMercadoLivreContext } from '../core/mercadoLivre';
import { podeEnviarEstoque } from '../estoque/bulkEstoquePlan';
import { refMatchesIntegracao } from '../core/linkRefs';
import { familyMemberQuery, resolveUpFamilyByMemberItemId } from './upMemberLink';
import { foldFamilyStatus } from './upFamilyStatus';
import type { UptinSourceLink } from '../importacao/importMigration';
import { clearFalha } from '../core/publishFalhas';
import { consultarModeracoes, moderacoesArmazenadas, moderacoesIguais } from './moderacoes';

/** The minimal ML API surface the status-sync needs (injectable for tests). */
export interface ItemsSyncApi {
  getItem(itemId: string): Promise<MlItem>;
  /**
   * `GET /moderations/last_moderation/{itemId}-ITM` (#1087). Called ONLY when
   * the fetched item's status/sub_status says there is a moderation to read —
   * see {@link precisaConsultarModeracao}.
   */
  getLastModeration(referenceId: string): Promise<MlModeration[]>;
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

/**
 * The two ML `tags` marking a listing in an in-progress UP migration (#441).
 * Kept as separate constants rather than one set: the pair is no longer
 * interchangeable, since each now reports its own outcome and only the SOURCE
 * one can trigger the takeover. `precoDraftSend.ts` matches the same pair by
 * its `variations_migration_` prefix.
 */
const MIGRATION_SOURCE_TAG = 'variations_migration_source';
const MIGRATION_UPTIN_TAG = 'variations_migration_uptin';

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
  | 'synced-family' // a UP family MEMBER moved and the family's summary changed with it
  | 'synced-member' // the member was recorded, but the family's summary did not move
  | 'unchanged' // estado/status/sub_status all already current (idempotent no-op)
  | 'no-link' // no linked produto for this item on this account
  | 'migrated' // a migration-source listing went closed → #441 takeover ran
  | 'deferred-migration-source' // ML is migrating this listing; it has not closed yet
  | 'deferred-migration-uptin' // the migration DESTINATION listing — never a takeover trigger
  | 'no-migration-runner' // the takeover was due and no runner was supplied (a WIRING defect)
  | 'item-gone' // the listing 404s (deleted) — nothing to sync
  | 'link-removido'; // the link doc was deleted mid-writeback — nothing was applied
//   ⚠️ `link-removido` exists because `applyItemStatusToLink` returns FALSE when
//   the doc vanished between the read and the write, and that boolean used to be
//   discarded — so a refused write reported 'synced'. Reporting success for work
//   that did not happen is the defect this whole outcome union guards against.
//
//   ⚠️ Which is why the three deferrals above are three values and not one. They
//   used to be a single `'deferred-up'` shared with the two Flutter-era guards
//   that are now gone, and that collapse is exactly what cost a day of debugging
//   in the first live run: the log said a skip happened but not WHICH, so a bug
//   (the UP guard) was indistinguishable from ML doing normal migration work.
//   `'no-migration-runner'` is not a listing state at all — it means the takeover
//   was due and nobody wired the runner. Today `notificacao.ts` always defaults
//   one in, so it should never appear in production; if it ever does, that is the
//   point of it having a name.
//
//   ⚠️ `'synced-family'` vs `'synced-member'` splits the same way, and for the
//   same reason (#1142): both mean the notified MEMBER's status was recorded, but
//   only the first also moved the family's summary. Collapsing them would make
//   "the fold declined to conclude" look identical to "the family updated", which
//   is the exact ambiguity that made the original bug invisible.

/**
 * Sync one ML item's lifecycle status onto its linked `produtoMercadoLivre` doc.
 * Returns a deterministic outcome; a transient failure THROWS (pipeline retries).
 *
 * LINK-FIRST: the ML API (and its token refresh) is resolved LAZILY, only once a
 * syncable link is confirmed. `items` fires for every change to ANY of the
 * seller's listings, most of which this ERP hasn't linked — resolving the link
 * from Firestore first skips the external call entirely for `no-link`, so such a
 * notification never depends on ML availability or burns a quota/token refresh.
 * Every REMAINING deferral costs one `GET /items/{id}`, and must: they turn on
 * the item's `tags`, which only ML can answer for.
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

  const api = await resolveApi(db, integracaoId);
  let item: MlItem;
  try {
    item = await api.getItem(itemId);
  } catch (err) {
    // A deleted listing (404) can't be synced and won't recover on retry.
    if (err instanceof MercadoLivreHttpError && err.status === 404) return 'item-gone';
    throw err; // transient (5xx/429/network) or reauth → the queue/sweep retry
  }

  // ⚠️ The FAMILY branch comes FIRST, above the migration-tag branches, and the
  // ordering is load-bearing. Under stage-2 resolution `link` is the family's
  // PARENT — so a tag branch here would let ONE member's tags speak for the whole
  // family un-folded: `stampAguardandoMigracao` would write `estado: 'am'` on the
  // parent, which blocks publish and makes both the price and stock planners skip
  // every sibling. Worse, the takeover branch would hand `migrationRunner` a
  // MEMBER item id together with the family's parent link as the migration
  // SOURCE, pointing a prune at a live family.
  //
  // Nothing is lost by skipping the tag branches here: a UPtin migration's source
  // is by definition a LEGACY `variations[]` listing, whose parent link carries an
  // item id and therefore resolves through stage 1, never stage 2. A stage-2
  // resolution is already User-Products, so it cannot be the source of a
  // migration INTO User Products.
  if (link.member) {
    // ⚠️ Fetched HERE, not inside the fold: that runs in a TRANSACTION, and a
    // network call in a transaction window is root `CLAUDE.md` rule 7's class C
    // — the callback re-runs on every OCC retry, so the fetch would be re-issued
    // per attempt against a rate-limited API. The transaction receives an
    // already-resolved value and stays free of I/O (#1087).
    return applyMemberStatusAndFold(
      db,
      integracaoId,
      {
        produtoId: link.produtoId,
        linkDocId: link.docId,
        memberProdutoId: link.member.produtoId,
        memberDocId: link.member.docId,
        pmlOuterRef: link.member.pmlOuterRef,
      },
      { status: item.status ?? null, subStatus: item.sub_status ?? null },
      await fetchModeracoes(api, itemId, item),
      // #706: this member's own stock identity, straight off the fetched item.
      // The family's parent link deliberately gets none — a User Product
      // describes a product at VARIATION level, so the members carry them.
      item.user_product_id ?? null,
    );
  }

  // Migration-tagged item (needs the fetched item's `tags`) — the only reason
  // left to skip a listing, and it is ML's reason, not ours. The ONE takeover
  // case is this listing's source tag + it just went `closed` + a runner was
  // supplied: it hands off to the #441 UP-migration branch INSTEAD of the normal
  // estado merge below. Every other combination defers, but each says which.
  const tags = item.tags ?? [];
  if (tags.includes(MIGRATION_SOURCE_TAG) && item.status === 'closed') {
    // Due — but only a supplied runner can actually take over. Reporting the
    // two apart is the difference between "ML is mid-migration" (normal) and
    // "the takeover never ran because nobody wired it" (a defect).
    if (!migrationRunner) {
      await stampAguardandoMigracao(db, link);
      return 'no-migration-runner';
    }
    const sourceLink: UptinSourceLink = {
      produtoId: link.produtoId,
      linkDocId: link.docId,
      raw: link.data,
    };
    await migrationRunner(db, integracaoId, itemId, sourceLink);
    return 'migrated';
  }
  // Of the two DEFERRALS the uptin one is tested first (the takeover above still
  // outranks both): that tag marks the migration's DESTINATION, so a listing
  // carrying both must not report as a source still waiting to close.
  if (tags.includes(MIGRATION_UPTIN_TAG)) {
    await stampAguardandoMigracao(db, link);
    return 'deferred-migration-uptin';
  }
  if (tags.includes(MIGRATION_SOURCE_TAG)) {
    await stampAguardandoMigracao(db, link);
    return 'deferred-migration-source';
  }

  // Below every deferral, so a listing ML is mid-migration never pays for a
  // moderation it has nowhere to put: those branches stamp `estado: 'am'` and
  // return without a status merge.
  return applyResolvedStatus(
    db,
    integracaoId,
    link,
    itemId,
    item.status ?? null,
    item.sub_status ?? null,
    // #706 multiorigem: the UP that backs this listing's stock — but ONLY when
    // the listing IS the stock unit. `itemStockLivesOnChildren` is the same gate
    // `importCore` applies (`args.hasVariations`), shared so the two cannot
    // drift: a legacy `variations[]` item and a User-Products family both keep
    // their quantities on CHILD produtos, and an item-level UP id on the parent
    // link would let one number be written for the whole family (#1142).
    itemStockLivesOnChildren(item) ? null : (item.user_product_id ?? null),
    await fetchModeracoes(api, itemId, item),
  );
}

/**
 * ML's active moderations for one fetched listing (#1087).
 *
 * A thin adapter over the shared {@link consultarModeracoes} — gating, the
 * `-ITM` reference, the 404-is-data narrow and the rethrow all live there, so
 * this sync, `reverificarAnuncio` and the importer cannot drift on any of them.
 */
function fetchModeracoes(api: ItemsSyncApi, itemId: string, item: MlItem): Promise<MlModeracao[]> {
  return consultarModeracoes(api, itemId, item.status, item.sub_status);
}

/**
 * Write one already-decided status onto a parent link, with the #781 re-arm and
 * the coarse-transition denorm gate.
 *
 * Shared by both paths so a family and a simple listing converge through
 * IDENTICAL rules — the two differ only in where the status came from (the
 * fetched item vs the fold) and in `denormItemId`, which must be the key the
 * denorm was originally stamped with.
 */
async function applyResolvedStatus(
  db: Firestore,
  integracaoId: string,
  link: ResolvedLink,
  denormItemId: string,
  status: string | null,
  subStatus: string[] | null,
  userProductId: string | null,
  moderacoes: MlModeracao[],
): Promise<ItemsSyncOutcome> {
  const estado = estadoFromMlStatus(status);

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
  // #706: counted as a change on its own, for the same reason `errorsToClear` is
  // — a listing already at the right status would short-circuit on `unchanged`
  // below and never gain the field. This sync is the catalogue-wide self-heal.
  const userProductIdChanged =
    userProductId != null &&
    userProductId !==
      (typeof link.data.userProductId === 'string' ? link.data.userProductId : null);
  // ⚠️ `moderacoes` counts as a change in its own right, for the SAME reason
  // `errorsToClear` does and with a sharper edge (#1087): a listing already at
  // the right estado/status/sub_status would short-circuit on `unchanged` below
  // and keep a moderation ML has since lifted. A stale reason on a healthy
  // listing is indistinguishable from a real one, which makes it worse than no
  // reason at all — so the field is compared BY VALUE, not by presence.
  //
  // Convergent, unlike a naive "moderations present ⇒ changed": this is false as
  // soon as the stored value matches what ML just said, moderated or not.
  const moderacoesChanged = !moderacoesIguais(moderacoes, moderacoesArmazenadas(link.data));
  const linkChanged =
    estadoChanged ||
    status !== currentStatus ||
    !stringArraysEqual(subStatus, currentSubStatus) ||
    userProductIdChanged ||
    errorsToClear ||
    moderacoesChanged;

  if (!linkChanged) return 'unchanged';

  const applied = await applyItemStatusToLink(
    db,
    integracaoId,
    { produtoId: link.produtoId, linkDocId: link.docId, itemId: denormItemId },
    { status, sub_status: subStatus },
    {
      nowMs: Date.now(),
      // The denorm is a COARSE-transition-only write (legacy gate) — skip it when
      // only status/sub_status/errors moved. Also skipped outright when the parent
      // carries no `id`: there would be no key to union or remove by, and inventing
      // one is how the arrays grow entries nothing can ever match.
      skipDenorm: !estadoChanged || denormItemId === '',
      // `userProductId` is fill-only: never write null over a stored id because
      // this particular response omitted it. The field is an identity, not an
      // observation — and it collides with neither of the other two keys.
      //
      // ⚠️ ORDER: `moderacoes` comes LAST, so it wins over the `[]` inside
      // `clearFalha()`. Both are "the listing is healthy" statements, but only
      // this one was read from ML — and they genuinely disagree in the case that
      // motivated a separate field, `active` + `poor_quality_thumbnail`, where
      // the listing is sendable (so the latch clears) AND moderated.
      extra: {
        ...(errorsToClear ? clearFalha() : {}),
        ...(userProductIdChanged ? { userProductId } : {}),
        moderacoes,
      },
    },
  );

  // It already warns; the point here is that the CALLER learns nothing was written.
  return applied ? 'synced' : 'link-removido';
}

/** The two ends of one User-Products family write: the parent, and the member. */
export interface MemberFoldTarget {
  /** The FAMILY anchor produto — where the parent link lives. */
  produtoId: string;
  /** The family's `produtoMercadoLivre` doc id. */
  linkDocId: string;
  /** The variation CHILD produto owning the member link. */
  memberProdutoId: string;
  /** The `variacaoMercadoLivre` doc id. */
  memberDocId: string;
  /** The parent's outer ref — the key the sibling fold reads by. */
  pmlOuterRef: string;
}

/**
 * The User-Products FAMILY path (#1142): record what ML said about THIS member,
 * then re-derive the family's summary from every member.
 *
 * ⚠️ The denorm key is the PARENT link's own `id`, never the notified member's.
 * Publish and import both stamped `produtos.marketplace` with the family id
 * (member ids go on the CHILD produtos, in a different shape), so keying on the
 * member would `arrayUnion` an entry nothing ever removes AND leave the cancel
 * arm's `externalId` filter matching nothing — a removal that silently no-ops.
 *
 * ⚠️ Exported because the `items` webhook is NOT the only surface that learns
 * one member's status: the stock sender's terminal 4xx branch (#781) fetches the
 * member item it could not update, and under User Products that fetch answers for
 * ONE member of N. Writing it straight to the parent — which is what the shared
 * `applyItemStatusToLink` does — lets a single member speak for the family, and
 * for `closed` that silently drops the produto out of both sweeps. Both callers
 * must therefore land on this same fold, exactly as they already share
 * `applyItemStatusToLink` for the non-family case.
 */
export async function applyMemberStatusAndFold(
  db: Firestore,
  integracaoId: string,
  target: MemberFoldTarget,
  observed: { status: string | null; subStatus: string[] | null },
  /**
   * ML's active moderations for the notified member (#1087), or `null` for a
   * caller that never asked `/moderations`.
   *
   * ⚠️ `null` is NOT `[]`. An empty array is ML saying "no moderation", which
   * legitimately clears a lifted one; `null` means the value was never read, and
   * writing either value from it would be a guess. The stock sender is that
   * caller — it verifies a listing's STATUS on a rejection and has no moderation
   * to report — so its member writes leave the field untouched and the notified
   * member contributes its STORED moderations to the fold, exactly like a
   * sibling. That keeps main's "a reason never outlives the state it describes"
   * invariant intact: the parent still takes the fold winner's value, it is just
   * assembled entirely from disk.
   */
  moderacoes: MlModeracao[] | null,
  /**
   * The notified member's own `user_product_id` (#706) — the stock identity on a
   * multiorigin conta — or `null` for a caller that has no fresh reading of it.
   *
   * Same `null` ≠ "empty" discipline as `moderacoes` above, and for the same
   * reason: this is an IDENTITY, so it is written fill-only and a caller that
   * did not learn it must not be able to erase a stored one. The stock sender is
   * that caller on its verification path, and it is also the component that
   * stamps this field itself on a SUCCESSFUL send — so it has nothing to add
   * here.
   */
  userProductId: string | null = null,
): Promise<ItemsSyncOutcome> {
  const status = observed.status;
  const subStatus = observed.subStatus;

  const parentRef = produtoMercadoLivreLinkCollection.docRef(
    db,
    { produtoId: target.produtoId },
    target.linkDocId,
  );
  const produtoRef = produtoCollection.docRef(db, {}, target.produtoId);
  const siblingQuery = familyMemberQuery(db, target.pmlOuterRef);

  return db.runTransaction(async (tx): Promise<ItemsSyncOutcome> => {
    // ---- READS. All of them, before any write (Firestore's rule), and every
    // input below is re-derived from THESE — never from `link.data` or
    // `member.raw`, which were captured before the ML fetch and are stale by
    // exactly the width of that round trip.
    const [members, parentSnap, produtoSnap] = await Promise.all([
      tx.get(siblingQuery),
      tx.get(parentRef),
      tx.get(produtoRef),
    ]);
    if (!parentSnap.exists) return 'link-removido';
    const parent = (parentSnap.data() ?? {}) as Record<string, unknown>;

    // ---- Re-derive the fold from the transaction's OWN view of every member.
    // Reading the siblings INSIDE the transaction is the whole guard: the read
    // set includes every member doc, so a concurrent task writing a DIFFERENT
    // member of this family aborts this callback and it retries against the
    // value that writer committed.
    let notified: (typeof members.docs)[number] | null = null;
    const foldable: Array<{
      status: string | null;
      subStatus: string[] | null;
      moderacoes: MlModeracao[];
    }> = [];
    for (const d of members.docs) {
      const raw = d.data() as Record<string, unknown>;
      const isNotified =
        d.id === target.memberDocId && (d.ref.parent?.parent?.id ?? '') === target.memberProdutoId;
      if (isNotified) notified = d;
      // ⚠️ A row with no `itemId` is not an ML listing at all — the legacy
      // `variations[]` branch leaves the field null (`importCore.ts`). Passing it
      // to the fold would count it as "never observed", and since no notification
      // can ever arrive for something that was never published, the family could
      // NEVER conclude `'c'`. Excluded outright: absent, not unknown.
      if (!isNotified && !(typeof raw.itemId === 'string' && raw.itemId.length > 0)) continue;
      foldable.push(
        isNotified
          ? {
              status,
              subStatus,
              // A caller that never read `/moderations` contributes what is
              // STORED on the member, exactly like a sibling below — so the fold
              // stays a statement about disk rather than a guess.
              moderacoes: moderacoes ?? moderacoesArmazenadas(raw),
            }
          : {
              status: typeof raw.status === 'string' ? raw.status : null,
              subStatus: Array.isArray(raw.sub_status) ? (raw.sub_status as string[]) : null,
              // ⚠️ The siblings' moderations come from what is STORED on each
              // member link — never a fetch. That is what keeps the fold free:
              // one notification reads one moderation, and the family's answer
              // is assembled from values already on disk.
              moderacoes: moderacoesArmazenadas(raw),
            },
      );
    }
    // The notified member should be among its own siblings (they share the parent
    // ref it was found by); if a delete removed it, its fresh reading still counts.
    if (!notified) foldable.push({ status, subStatus, moderacoes: moderacoes ?? [] });

    const notifiedRaw = (notified?.data() ?? {}) as Record<string, unknown>;
    // #706: counted as a CHANGE in its own right, which is what makes the `items`
    // sync the catalogue-wide self-heal — a listing whose status never moves
    // would otherwise never gain the field, and that sync is the only component
    // that sees a member's fresh ML item on its own schedule.
    const userProductIdChanged =
      userProductId != null &&
      userProductId !==
        (typeof notifiedRaw.userProductId === 'string' ? notifiedRaw.userProductId : null);
    const memberChanged =
      notified != null &&
      (status !== (typeof notifiedRaw.status === 'string' ? notifiedRaw.status : null) ||
        userProductIdChanged ||
        !stringArraysEqual(
          subStatus,
          Array.isArray(notifiedRaw.sub_status) ? (notifiedRaw.sub_status as string[]) : null,
        ) ||
        // Same rule the parent gets: the member's own moderation must be able to
        // move on its own, or a lifted one survives on a member whose raw status
        // never changed — and the fold would then hand it to the parent.
        (moderacoes != null && !moderacoesIguais(moderacoes, moderacoesArmazenadas(notifiedRaw))));

    const folded = foldFamilyStatus(foldable);

    // ---- Parent decision, re-derived from the tx-fresh parent snapshot.
    const estado = folded ? estadoFromMlStatus(folded.status) : null;
    const currentEstado = typeof parent.estado === 'string' ? parent.estado : null;
    const currentStatus = typeof parent.status === 'string' ? parent.status : null;
    const currentSubStatus = Array.isArray(parent.sub_status)
      ? (parent.sub_status as string[])
      : null;
    const currentErrors = Array.isArray(parent.errors) ? parent.errors : [];
    const errorsToClear =
      folded != null &&
      currentErrors.length > 0 &&
      podeEnviarEstoque(folded.status, folded.subStatus).enviar;
    const estadoChanged = folded != null && estado !== currentEstado;
    // ⚠️ Only a caller that actually READ `/moderations` may move this field.
    // With `moderacoes == null` the fold winner's value was assembled entirely
    // from disk, so writing it back would let the stock sender blank a reason
    // recorded on the PARENT (by publish, import, or a pre-UP status sync) using
    // members that simply never carried one.
    const moderacoesChanged =
      moderacoes != null &&
      folded != null &&
      !moderacoesIguais(folded.moderacoes, moderacoesArmazenadas(parent));
    const parentChanged =
      folded != null &&
      (estadoChanged ||
        folded.status !== currentStatus ||
        !stringArraysEqual(folded.subStatus, currentSubStatus) ||
        errorsToClear ||
        moderacoesChanged);

    // ---- WRITES.
    if (memberChanged && notified) {
      tx.set(
        notified.ref,
        {
          status,
          sub_status: subStatus,
          ...(moderacoes != null ? { moderacoes } : {}),
          // Also fill-only, and for a different reason than `moderacoes`:
          // `userProductId` is an IDENTITY, not an observation, so a response
          // that simply omitted it must never null a stored one (#706).
          ...(userProductId != null ? { userProductId } : {}),
        },
        { merge: true },
      );
    }

    if (!folded || !parentChanged) {
      // Either the members do not support a conclusion (every observed one closed,
      // some never observed — see `foldFamilyStatus`), or the summary already
      // matches. Saying which happened is the difference between "nothing to do"
      // and "recorded, cannot summarise yet".
      return memberChanged ? 'synced-member' : 'unchanged';
    }

    // ⚠️ The denorm key is the PARENT link's own `id`, never the notified member's.
    // Publish and import both stamped `produtos.marketplace` with the family id
    // (member ids go on the CHILD produtos, in a different shape), so keying on the
    // member would arrayUnion an entry nothing ever removes AND leave the cancel
    // arm's `externalId` filter matching nothing.
    const familyItemId = typeof parent.id === 'string' ? parent.id : '';
    if (estadoChanged && familyItemId !== '' && produtoSnap.exists) {
      // Same transaction as the link write, so the denorm-first ordering
      // `applyItemStatusToLink` needs does not apply here: there is no window in
      // which one landed and the other did not.
      const produtoRaw = (produtoSnap.data() ?? {}) as Record<string, unknown>;
      if (estado === ESTADO_PUBLICACAO_ML.cancelado) {
        const patch = removeMarketplaceEntry(produtoRaw, integracaoId, familyItemId);
        if (patch) tx.update(produtoRef, patch);
      } else {
        tx.update(produtoRef, {
          marketplace: FieldValue.arrayUnion({
            integracaoUid: integracaoId,
            externalId: familyItemId,
          }),
          marketplaceIds: FieldValue.arrayUnion(familyItemId),
        });
      }
    }

    tx.update(parentRef, {
      estado,
      status: folded.status,
      sub_status: folded.subStatus,
      ultimaModificacao: Date.now(),
      ...(errorsToClear ? clearFalha() : {}),
      // After the spread, same as the simple path: read-from-ML wins over the
      // healed `[]`, and the family's moderation is the FOLD WINNER's — the
      // member whose status this parent is reporting, never a union. Omitted
      // entirely when the caller never read `/moderations` (see above).
      ...(moderacoes != null ? { moderacoes: folded.moderacoes } : {}),
    });

    return 'synced-family';
  });
}

/**
 * Record ML's "this listing is mid-UP-migration" verdict on the link doc as
 * `estado: 'am'`.
 *
 * ⚠️ Without this, `'am'` has no PRODUCER at all. It never had one in this repo —
 * the value only ever arrived from the Flutter app — and the guard removed above
 * was the last thing keeping the Flutter-era values alive, since the normal merge
 * below now overwrites `'am'` the moment ML reports no migration tag. Three rungs
 * still gate on it: `publishCore.ts` (blocks publish), `precoPlan.ts`
 * (`AGUARDANDO_MIGRACAO`) and `bulkEstoquePlan.ts` (`aguardando-migracao`). Of the
 * send paths only the price one re-reads the tags itself
 * (`precoDraftSend.ts`'s `MIGRATION_TAG_PREFIX`); `estoqueSend.ts` and `publish.ts`
 * check NOTHING. So a listing ML is mid-flight rebuilding would be published to
 * and stock-pushed, earning the 404 `publishCore.ts` describes.
 *
 * This sync is the only component that observes those tags on its own schedule —
 * it is holding the fetched item right here — so it is the only one that can
 * answer, and discarding that into a return string would leave the three rungs
 * reading as live protection nothing can trigger.
 *
 * ⚠️ It clears the way every other field here does: the next delivery reporting no
 * migration tag runs the normal merge and overwrites `'am'` with the real status.
 * That is this module's ordinary staleness, not a new class of it — and unlike a
 * static listing, one mid-migration is by definition changing, with a terminal
 * event (`closed`) this module already depends on firing. `reverificarAnuncio` is
 * the manual escape if ML ever drops a tag without a notification.
 *
 * Idempotent: writes only when the value actually moves, so a redelivery is free.
 */
async function stampAguardandoMigracao(db: Firestore, link: ResolvedLink): Promise<void> {
  if (link.data.estado === ESTADO_PUBLICACAO_ML.aguardandoMigracao) return;
  // `mergeIfExists`, never `merge` — same reason as the writeback below: the link
  // was resolved earlier and an upsert would resurrect a ghost with no schema.
  await produtoMercadoLivreLinkCollection.mergeIfExists(
    db,
    { produtoId: link.produtoId },
    link.docId,
    {
      estado: ESTADO_PUBLICACAO_ML.aguardandoMigracao,
      ultimaModificacao: Date.now(),
    },
  );
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
 * produto's legacy marketplace denorm. Extracted so the `items` webhook and
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
 * linkage now) but kept in the exact shape publish/import stamp, which is also
 * the shape the migrated corpus carries — see the canonical cluster note on `produtoSchema` and #992, which tracks
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
  // DEPRECATED). `mergeIfExists` still backstops the link half.
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

/** The family member a notification came in through, when it did (#1142). */
interface ResolvedMember {
  /** The variation CHILD produto owning the member link. */
  produtoId: string;
  /** The `variacaoMercadoLivre` doc id. */
  docId: string;
  /** The member link's raw payload. */
  raw: Record<string, unknown>;
  /** The parent's outer ref — the key the sibling fold reads by. */
  pmlOuterRef: string;
}

interface ResolvedLink {
  produtoId: string;
  docId: string;
  data: Record<string, unknown>;
  /**
   * Set ONLY when the item resolved through a User-Products family member rather
   * than the parent link's own `id`. Its presence is what selects the fold path:
   * the notified item is one of N listings this link summarises, so its status
   * cannot be written straight through.
   */
  member?: ResolvedMember;
}

/**
 * Resolve the `produtoMercadoLivre` link for `itemId` on this account.
 *
 * TWO stages, and the order is the cost model. First the parent link's own `id`
 * — the cross-app key the import and the Flutter app match on, and the answer for
 * every simple listing and every UP single-item one. Only on a miss does it try
 * the User-Products FAMILY route, where the notified id belongs to a member and
 * the parent carries the FAMILY id instead (`publish.ts`: `familyId ?? itemIds[0]`),
 * so a member's delivery matches no parent link at all (#1142).
 *
 * The second stage costs one more indexed group query, paid only by items the
 * first stage could not place — which includes every genuinely unlinked item, the
 * bulk of the `items` stream. That is the deliberate trade: a family's status was
 * previously unreachable, and the alternative (querying members first) would tax
 * the common case instead.
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

  // Stage 2 — a UP family member. Ownership is proven through the PARENT's
  // `contaOuterRef` inside the resolver, never the member's own (which is null on
  // every pre-#920 row until the backfill runs).
  const member = await resolveUpFamilyByMemberItemId(db, itemId, integracaoId);
  if (member) {
    return {
      produtoId: member.produtoId,
      docId: member.linkDocId,
      data: member.linkRaw,
      member: {
        produtoId: member.childProdutoId ?? '',
        docId: member.memberDocId,
        raw: member.memberRaw,
        pmlOuterRef: member.pmlOuterRef,
      },
    };
  }

  // ⚠️ "no link exists" and "a link exists but belongs to another conta" are
  // very different problems with the same symptom, and both used to leave the
  // caller with a bare `no-link`. The candidate count separates them: 0 means the
  // item was never linked here, >0 means every match failed the contaOuterRef
  // check — a mis-scoped or legacy-shaped ref, not a missing listing.
  console.warn('[mercado-livre] items: nenhum link utilizável para o anúncio', {
    itemId,
    integracaoId,
    candidatos: snap.size,
  });
  return null;
}

/**
 * Maintain the parent produto's legacy marketplace arrays on an estado change:
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
