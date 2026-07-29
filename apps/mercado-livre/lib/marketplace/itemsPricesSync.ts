/**
 * `items_prices` webhook price-sync (ML→ERP) — Step 11 PR-B. When Mercado
 * Livre fires an `items_prices` notification, fetch `GET /items/{id}/prices`,
 * pick the marketplace-applicable standard + promotion amounts, and write them
 * onto the linked produto's `precos` map for the conta's price tables (normal
 * + promotional), plus the link doc's `precoPublicado` denorm.
 *
 * Deviations from the legacy Flutter price handler (deliberate):
 *  - Legacy keyed the `precos` writes by the tabela's FULL outer-ref path — a
 *    bug that scattered `documents/listaDePrecos/<id>` keys through the map.
 *    We port the INTENT: keys are the BARE list doc ids, the shape every other
 *    `precos` writer (importCore's `buildPrecosOps`) uses.
 *  - Legacy derived the normal price from a lone promotion entry's
 *    `regular_amount` (single-entry payloads skipped its type check) and threw
 *    a `StateError` only for MULTI-entry payloads with no standard entry. Here
 *    the `regular_amount` fallback is kept (a promo-only payload still syncs
 *    both prices) but the no-price case is the deterministic
 *    `sem-preco-standard` skip (logged, acked) — it must not grind the queue.
 *
 * Echo-loop note: our own outbound price PUT makes ML fire `items_prices`
 * right back at us. The skip-if-equal comparison below makes that echo an
 * `unchanged` no-op instead of a write loop.
 *
 * Robustness contract (plugs into the Step 6 pipeline): IDEMPOTENT, keyed by
 * the ML item id (a redelivery compares-then-skips); deterministic outcomes
 * RETURN while a transient failure (ML 5xx/429/network, Firestore) THROWS so
 * the queue / sweep retry; a deleted listing (404) is deterministic →
 * `item-gone`.
 */
import { FieldValue, type DocumentData, type Firestore } from 'firebase-admin/firestore';
import { roundReais } from '@delfrance/core/money';
import {
  type MlItemPrices,
  type MlItemPricesEntry,
  MercadoLivreHttpError,
  createMercadoLivreApi,
} from '@delfrance/integrations-mercado-livre';
import {
  produtoCollection,
  produtoMercadoLivreLinkCollection,
  variacaoMercadoLivreLinkCollection,
} from '@delfrance/data/admin/collections';

import { loadMercadoLivreContext } from './mercadoLivre';
import { lastSegment, refMatchesIntegracao } from './linkRefs';

/** The minimal ML API surface the price-sync needs (injectable for tests). */
export interface ItemsPricesSyncApi {
  getPrices(itemId: string): Promise<MlItemPrices>;
}

/**
 * The lazily-resolved per-account slice the sync consumes: a
 * seller-authenticated ML API plus the conta's price-table refs
 * (`tabelaNormal/PromocionalOuterRef`, `documents/listaDePrecos/<id>` paths).
 */
export interface ItemsPricesSyncContext {
  api: ItemsPricesSyncApi;
  tabelaNormalOuterRef: string | null;
  tabelaPromocionalOuterRef: string | null;
}

/** Builds the per-account context for an integração (real vs test fake). */
export type ItemsPricesContextResolver = (
  db: Firestore,
  integracaoId: string,
) => Promise<ItemsPricesSyncContext>;

/**
 * The production resolver: the account's durable token (refreshed if near
 * expiry, concurrency-safe) → a `MercadoLivreApi`, plus the conta's tabela
 * refs (the same conta-field narrowing as massImport's
 * `defaultResolveImportDeps`).
 */
export const resolveItemsPricesContext: ItemsPricesContextResolver = async (db, integracaoId) => {
  const ctx = await loadMercadoLivreContext(db, integracaoId);
  const channelCtx = await ctx.resolveChannelContext();
  return {
    api: createMercadoLivreApi({ getAccessToken: async () => channelCtx.accessToken }),
    tabelaNormalOuterRef: asStringOrNull(ctx.conta.tabelaNormalOuterRef),
    tabelaPromocionalOuterRef: asStringOrNull(ctx.conta.tabelaPromocionalOuterRef),
  };
};

/** Injectable seams (tests); production call sites pass nothing. */
export interface ItemsPricesSyncDeps {
  resolveContext?: ItemsPricesContextResolver;
  /** Injectable clock — drives the promo-window check and the link stamp. */
  now?: () => number;
}

export type ItemsPricesSyncOutcome =
  | 'synced' // produto precos (and, link mode, precoPublicado) updated
  | 'unchanged' // stored prices already current (idempotent redelivery / own-PUT echo)
  | 'no-link' // no linked produto/variação for this item on this account
  | 'sem-tabela' // the conta has no tabelaNormalOuterRef configured
  | 'sem-preco-standard' // the payload has no marketplace-applicable standard entry
  | 'item-gone'; // the listing 404s (deleted) — nothing to sync

/** The channel context ML tags marketplace price entries with; mshops is dead. */
const CHANNEL_MARKETPLACE = 'channel_marketplace';

/**
 * Pick the marketplace-applicable prices from a `GET /items/{id}/prices`
 * payload — PURE. An entry participates iff its `context_restrictions` is
 * null/empty (unrestricted) or includes `channel_marketplace`; entries
 * restricted to the discontinued Mercado Shops (`channel_mshops`) are ignored.
 * `normal` = the first participating `standard` entry with a positive amount,
 * falling back to the first participating `promotion` entry's `regular_amount`
 * (the strikeout/original price — legacy parity: a promo-only payload still
 * yields the normal price); `promo` = the first participating `promotion`
 * entry with a positive amount whose window is active at `nowMs`. Non-positive
 * amounts are ignored — `precoSchema` forbids `valor <= 0`, the same guard
 * `importCore.buildPrecosOps` applies. Both come back `roundReais`'d; null
 * when absent.
 */
export function selectMarketplacePrices(
  prices: MlItemPricesEntry[],
  nowMs: number,
): { normal: number | null; promo: number | null } {
  let normal: number | null = null;
  let promo: number | null = null;
  let regularFallback: number | null = null;
  for (const entry of prices) {
    if (!participatesInMarketplace(entry)) continue;
    if (
      regularFallback == null &&
      entry.type === 'promotion' &&
      isPositiveFinite(entry.regular_amount)
    ) {
      regularFallback = roundReais(entry.regular_amount);
    }
    if (!isPositiveFinite(entry.amount)) continue;
    if (normal == null && entry.type === 'standard') {
      normal = roundReais(entry.amount);
    } else if (promo == null && entry.type === 'promotion' && isWindowActive(entry, nowMs)) {
      promo = roundReais(entry.amount);
    }
  }
  return { normal: normal ?? regularFallback, promo };
}

function isPositiveFinite(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function participatesInMarketplace(entry: MlItemPricesEntry): boolean {
  const restrictions = entry.conditions?.context_restrictions;
  if (restrictions == null || restrictions.length === 0) return true; // unrestricted
  return restrictions.includes(CHANNEL_MARKETPLACE);
}

/**
 * True when the entry's applicability window contains `nowMs`. A null bound is
 * unbounded; an UNPARSEABLE bound (`Date.parse` → NaN) FAILS its check — a
 * promo with a garbage window must never apply (the negated `!(NaN <= x)`
 * comparisons below are how NaN loses).
 */
function isWindowActive(entry: MlItemPricesEntry, nowMs: number): boolean {
  const { start_time: start, end_time: end } = entry.conditions ?? {};
  if (start != null && !(Date.parse(start) <= nowMs)) return false;
  if (end != null && !(Date.parse(end) >= nowMs)) return false;
  return true;
}

/**
 * Sync one ML item's marketplace prices onto its linked produto. Returns a
 * deterministic outcome; a transient failure THROWS (pipeline retries).
 *
 * LINK-FIRST: the ML API (and its token refresh) is resolved LAZILY, only once
 * a linked produto is confirmed — `items_prices` fires for every listing of
 * the seller, most of which this ERP hasn't linked, so a `no-link`
 * notification never depends on ML availability or burns a token refresh.
 */
export async function syncItemPrices(
  db: Firestore,
  integracaoId: string,
  itemId: string,
  deps: ItemsPricesSyncDeps = {},
): Promise<ItemsPricesSyncOutcome> {
  // (1) Link-first resolution: a simple/parent listing link, else a variation
  // child (whose ownership lives on the FAMILY PML doc it points at).
  const target = await resolvePriceTarget(db, itemId, integracaoId);
  if (!target) return 'no-link';

  // (2) Lazy per-account context → the BARE price-table doc ids (the legacy
  // handler keyed by the full outer-ref path — the bug this port drops).
  const resolveContext = deps.resolveContext ?? resolveItemsPricesContext;
  const ctx = await resolveContext(db, integracaoId);
  const tabelaNormalId = ctx.tabelaNormalOuterRef ? lastSegment(ctx.tabelaNormalOuterRef) : null;
  const tabelaPromoIdRaw = ctx.tabelaPromocionalOuterRef
    ? lastSegment(ctx.tabelaPromocionalOuterRef)
    : null;
  // A conta pointing both refs at the SAME lista would make the promo-clear
  // branch clobber the normal write in the single patch (delete the produto's
  // only price, then re-delete on every redelivery). The normal price owns its
  // key: a colliding promo table is treated as none configured.
  const tabelaPromoId = tabelaPromoIdRaw === tabelaNormalId ? null : tabelaPromoIdRaw;
  if (!tabelaNormalId) {
    console.warn('[mercado-livre] items_prices: integração sem tabela de preços normal', {
      integracaoId,
      itemId,
    });
    return 'sem-tabela';
  }

  // (3) Price fetch. A deleted listing (404) can't be synced and won't recover
  // on retry; anything else is transient → the queue/sweep retry.
  let body: MlItemPrices;
  try {
    body = await ctx.api.getPrices(itemId);
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) return 'item-gone';
    throw err;
  }

  // (4) Channel + window selection. No applicable standard price → NO write at
  // all (promo included): a promo without its anchor price would strand the
  // produto on a promo-only precos map. (Legacy threw a StateError here.)
  const nowMs = deps.now ? deps.now() : Date.now();
  const { normal, promo } = selectMarketplacePrices(body.prices ?? [], nowMs);
  if (normal == null) {
    console.warn('[mercado-livre] items_prices: listagem sem preço standard aplicável', {
      integracaoId,
      itemId,
    });
    return 'sem-preco-standard';
  }

  // (5) Skip-if-equal (idempotent redelivery + the echo-loop breaker). Stored
  // values compare `roundReais`'d, same as the incoming ones; an ended promo
  // counts as unchanged only when the stored entry is genuinely ABSENT, so a
  // present-but-stale (or malformed) entry still gets cleared below.
  const produtoRef = produtoCollection.docRef(db, {}, target.produtoId);
  const produtoSnap = await produtoRef.get();
  // A link can outlive its produto during the delete-cascade window — never
  // resurrect (or NOT_FOUND-retry-loop on) a deleted produto over a price echo.
  if (!produtoSnap.exists) return 'no-link';
  const precos = asPlainObject((produtoSnap.data() ?? {}).precos);
  const normalUnchanged = storedValor(precos, tabelaNormalId) === normal;
  const promoUnchanged =
    tabelaPromoId == null ||
    (promo == null
      ? precos[tabelaPromoId] === undefined
      : storedValor(precos, tabelaPromoId) === promo);
  if (normalUnchanged && promoUnchanged) return 'unchanged';

  // (6+7) One ATOMIC batch: the dotted-path produto update (the exact
  // application shape of import.ts's precosOps — never re-validates the
  // possibly-legacy-malformed precos map; an ended promo is actively CLEARED)
  // plus, link mode only, the link doc's advertised-price denorm (the same
  // firstNonEmpty(promo, normal) semantics importCore stamps on import;
  // variation links carry no precoPublicado). Atomicity matters because the
  // produto write is what the step-(5) skip-if-equal gate reads: were the two
  // writes separate and the denorm failed transiently, the queue retry would
  // short-circuit on 'unchanged' and strand a stale precoPublicado forever.
  const patch: Record<string, unknown> = { [`precos.${tabelaNormalId}`]: { valor: normal } };
  if (tabelaPromoId != null) {
    patch[`precos.${tabelaPromoId}`] = promo != null ? { valor: promo } : FieldValue.delete();
  }
  const batch = db.batch();
  batch.update(produtoRef, patch);
  if (target.linkDocId != null) {
    batch.set(
      produtoMercadoLivreLinkCollection.docRef(
        db,
        { produtoId: target.produtoId },
        target.linkDocId,
      ),
      produtoMercadoLivreLinkCollection.parseMerge({
        precoPublicado: promo ?? normal,
        ultimaModificacao: nowMs,
      }) as DocumentData,
      { merge: true },
    );
  }
  await batch.commit();

  return 'synced';
}

/* -------------------------------------------------------------------------- */

interface ResolvedPriceTarget {
  /** The produto whose `precos` map receives the write (variation → the CHILD). */
  produtoId: string;
  /** The `produtoMercadoLivre` doc for the precoPublicado writeback — null in variation mode. */
  linkDocId: string | null;
}

/**
 * Resolve the price-write target for `itemId` on this account. A simple/parent
 * listing matches a `produtoMercadoLivre` link directly (the same cross-app
 * key `itemsStatusSync` resolves); a variation child matches a
 * `variacaoMercadoLivre` link, whose ownership lives on the FAMILY PML doc its
 * `produtoMercadoLivreOuterRef` points at (the `findRegisteredMember` pattern
 * in `importMigration.ts`). The variation target is the CHILD produto — each
 * variation owns its own precos map.
 */
async function resolvePriceTarget(
  db: Firestore,
  itemId: string,
  integracaoId: string,
): Promise<ResolvedPriceTarget | null> {
  const linkSnap = await produtoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('id', '==', itemId)
    .get();
  for (const d of linkSnap.docs) {
    const data = d.data() as Record<string, unknown>;
    if (!refMatchesIntegracao(data.contaOuterRef, integracaoId)) continue;
    const produtoId = d.ref.parent?.parent?.id;
    if (produtoId) return { produtoId, linkDocId: d.id };
  }

  // An MLB item id is globally unique on ML, so >1 hit only means the same
  // listing imported under multiple integração accounts — a small set. The
  // limit bounds a pathological scan (the variacao link has no conta field to
  // filter server-side); same bound as importMigration's findRegisteredMember.
  const varSnap = await variacaoMercadoLivreLinkCollection
    .groupQuery(db)
    .where('itemId', '==', itemId)
    .limit(10)
    .get();
  for (const d of varSnap.docs) {
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
    const produtoId = d.ref.parent?.parent?.id;
    if (produtoId) return { produtoId, linkDocId: null };
  }
  return null;
}

/**
 * Parse a canonical `documents/produtos/<produtoId>/produtoMercadoLivre/<linkId>`
 * outer-ref into its produto + link doc ids — a local copy of `import.ts`'s
 * private `parsePmlOuterRef` (same 6-liner; duplicated per this folder's
 * small-local-duplicates convention, see `importMigration.ts`'s own copy).
 */
function parsePmlOuterRef(ref: string): { produtoId: string; linkId: string } | null {
  const segs = ref.split('/').filter(Boolean);
  const i = segs.indexOf('produtos');
  if (i === -1 || i + 3 >= segs.length) return null;
  if (segs[i + 2] !== 'produtoMercadoLivre') return null;
  return { produtoId: segs[i + 1]!, linkId: segs[i + 3]! };
}

/** The stored `{ valor }` for a price-table key, `roundReais`'d; null when absent/malformed. */
function storedValor(precos: Record<string, unknown>, tabelaId: string): number | null {
  const entry = precos[tabelaId];
  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const valor = (entry as Record<string, unknown>).valor;
  return typeof valor === 'number' && Number.isFinite(valor) ? roundReais(valor) : null;
}

function asPlainObject(v: unknown): Record<string, unknown> {
  return v != null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
