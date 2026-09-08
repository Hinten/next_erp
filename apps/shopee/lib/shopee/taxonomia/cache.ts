/**
 * The TTL caches in front of Shopee's taxonomy reads, and the per-request
 * context every reader takes.
 *
 * ⚠️ **None of the three forbidden cases applies** (see the exclusions at the
 * top of `@delfrance/data/admin/cache`'s `readCache.ts`):
 *
 *  - **No `tx.get`.** Nothing here runs inside a transaction; step 10 opens
 *    none and writes no Firestore document at all.
 *  - **No read-modify-write.** Every value below is reference data that is
 *    READ; nothing derives a patch from it.
 *  - **No token.** The access token is still fetched INSIDE each signed call,
 *    through the token store, uncached — `createShopClient` hands the package a
 *    function, not a string.
 *
 * ⚠️ The cached value is SHARED BY REFERENCE: N callers receive the identical
 * object. Nothing downstream may mutate what a getter hands back — the
 * projections in `dto.ts` only read, and every array they return is one they
 * built themselves.
 *
 * ## Every key starts with `integracaoId`
 *
 * This is the one deliberate difference from `apps/mercado-livre`'s
 * `mlMetadataCache`, where a category is keyed by its id ALONE. That is correct
 * there: ML's catalog metadata is global, so every seller shares one entry.
 * Shopee's is not. The tree is served per shop (and in the shop's region), and
 * the item bands are explicitly per shop AND per category — guide 209 §1.1 and
 * §6, and `get_item_limit`'s own page, whose every number is a sample. A key
 * without the integração would serve one conta's price ceiling, DTS band or
 * brand page to another conta: silently, with no error anywhere, and in the
 * direction that publishes.
 *
 * ## TTL, and the tier that does not exist yet
 *
 * `READ_CACHE_TTL.config` (15 min) everywhere, and **the TTL is the staleness
 * bound** — after Shopee changes a band, a warm instance can answer with the old
 * one for that long. ℹ️ Observed while planning: the legacy Flutter app never
 * persisted any taxonomy (per-session `AsyncMemoizer`s only), and Shopee's brand
 * API is slow enough that a longer tier for immutable-ish provider reference
 * data may be worth adding later. Step 10 does not invent one.
 *
 * `sampleEvery: 0` on all seven: the built-in sampler logs through
 * `console.warn` — the wrong severity for a metric — and at its default of 500
 * an instance serving fewer gets logs nothing at all.
 */
import { READ_CACHE_TTL, createReadCache } from '@delfrance/data/admin/cache';
import {
  SHOPEE_GET_VARIATIONS_PATH,
  type ShopeeAttributeTree,
  type ShopeeBrandList,
  type ShopeeClient,
  type ShopeeItemLimitRead,
  type ShopeeKitItemLimit,
  type ShopeeVariations,
  normalizeApiPath,
} from '@delfrance/integrations-shopee';

import type { ShopeeContext } from '../core/shopee';
import { type ShopeeCategoriaIndice, construirIndice } from './categorias';

/**
 * What every taxonomy reader takes: the conta it answers for, and a shop-signed
 * client for it.
 *
 * ⚠️ There is deliberately **no overload taking a bare client**. The
 * `integracaoId` is key element 0 of every cache below, so a reader that could
 * be called without one would be a reader whose answer could be cached under the
 * wrong shop.
 */
export interface ShopeeTaxonomiaCtx {
  readonly integracaoId: string;
  readonly client: ShopeeClient;
  /**
   * The API path `get_variations` is actually signed with — the default, or the
   * `SHOPEE_VARIATIONS_PATH` override. Echoed by the `variacoes` route as
   * `pathUsed`, because this is one of Shopee's four open contradictions and the
   * answer to "which path did we sign?" has to be observable in production.
   */
  readonly variationsPath: string;
}

/**
 * Build the per-request taxonomy context. One `createShopClient()` per request:
 * the token is fetched inside each signed call and is never cached.
 *
 * ⚠️ `variationsPath` is RE-DERIVED here, not decided here. `createShopeeClient`
 * above has already run the same override through the same
 * {@link normalizeApiPath}, and it throws `ShopeeConfigError` at CONSTRUCTION —
 * so a malformed value has failed before this line, and the two cannot disagree
 * about a value they both accepted. It is re-derived only because `ShopeeClient`
 * exposes no member carrying the path it resolved; if it ever gains one, read
 * THAT and delete this.
 */
export function taxonomiaCtx(ctx: ShopeeContext): ShopeeTaxonomiaCtx {
  const client = ctx.createShopClient();
  const override = ctx.config.variationsPath;
  return {
    integracaoId: ctx.integracaoId,
    client,
    variationsPath:
      override === null
        ? SHOPEE_GET_VARIATIONS_PATH
        : normalizeApiPath(override, 'SHOPEE_VARIATIONS_PATH'),
  };
}

/**
 * Injectable clock, its OWN and not `core/shopee.ts`'s.
 *
 * `createReadCache` captures `opts.now` ONCE at construction — import time for a
 * module-scope cache — so the caches read this binding through an arrow rather
 * than receiving the reference, which would freeze it.
 *
 * ⚠️ Separate from `__setShopeeCacheClockForTests` on purpose: the conta reader
 * and the taxonomy caches have no dependency on each other, and one shared
 * switch would make every taxonomy suite able to move the conta cache's clock
 * (and the reverse) — a blast radius nobody asked for. Production never moves
 * either.
 */
let relogio: () => number = Date.now;

/** Test-only. Pair it with `__resetAllReadCaches()`; restore with the no-arg call. */
export function __setShopeeTaxonomiaClockForTests(now: () => number = Date.now): void {
  relogio = now;
}

const opcoesComuns = {
  ttlMs: READ_CACHE_TTL.config,
  now: () => relogio(),
  sampleEvery: 0,
} as const;

/**
 * The whole category tree, already indexed.
 *
 * One entry per conta and nothing else: `get_category` takes no id and no
 * paging, so this is a single ~10⁴-node answer per shop. `maxEntries: 16` is
 * sized for the contas one backend serves, not for a key space.
 */
const categoriasCache = createReadCache<readonly [string], ShopeeCategoriaIndice>({
  name: 'shopee:taxonomia-categorias',
  maxEntries: 16,
  ...opcoesComuns,
});

/** One entry per (conta, category). The attribute tree is the heaviest read. */
const atributosCache = createReadCache<readonly [string, number], ShopeeAttributeTree>({
  name: 'shopee:taxonomia-atributos',
  maxEntries: 200,
  ...opcoesComuns,
});

/**
 * ONE page of brands per entry.
 *
 * ⚠️ The key carries all four request values. `offset` and `pageSize` decide
 * WHICH page came back and `status` decides which brand set — a key without them
 * would serve page 1 for a request for page 2, which reads as "the category has
 * 100 brands" no matter how many it has.
 */
const marcasCache = createReadCache<
  readonly [string, number, number, number, number],
  ShopeeBrandList
>({
  name: 'shopee:taxonomia-marcas',
  maxEntries: 200,
  ...opcoesComuns,
});

/** Per (conta, category-or-shop). `null` is the shop-wide read — a distinct key. */
const limitesItemCache = createReadCache<readonly [string, number | null], ShopeeItemLimitRead>({
  name: 'shopee:taxonomia-limites-item',
  maxEntries: 200,
  ...opcoesComuns,
});

/** The KIT bands, which are their own numbers and never the item's. */
const limitesKitCache = createReadCache<readonly [string, number | null], ShopeeKitItemLimit>({
  name: 'shopee:taxonomia-limites-kit',
  maxEntries: 100,
  ...opcoesComuns,
});

/** The standardised variation tree of one leaf category. */
const variacoesCache = createReadCache<readonly [string, number], ShopeeVariations>({
  name: 'shopee:taxonomia-variacoes',
  maxEntries: 200,
  ...opcoesComuns,
});

/**
 * Category ids suggested for a free-text product name.
 *
 * `negativeTtlMs: 0` — the key space is unbounded (every title an operator types
 * is its own key), and an empty answer for a half-typed name must never stick
 * around to greet the finished one. Same reasoning as ML's `sugestaoCache`.
 */
const recomendacaoCache = createReadCache<
  readonly [string, string, string | null],
  readonly number[]
>({
  name: 'shopee:taxonomia-recomendacao',
  maxEntries: 200,
  negativeTtlMs: 0,
  isNegative: (ids) => ids.length === 0,
  ...opcoesComuns,
});

/** The whole tree, indexed once per TTL window. */
export function lerIndiceDeCategorias(ctx: ShopeeTaxonomiaCtx): Promise<ShopeeCategoriaIndice> {
  return categoriasCache.get([ctx.integracaoId], async () => {
    const payload = await ctx.client.getCategory();
    return construirIndice(payload.category_list);
  });
}

/**
 * The attribute tree of ONE category.
 *
 * ⚠️ One id per call, deliberately, although Shopee accepts up to twenty
 * (`SHOPEE_ATTRIBUTE_TREE_MAX_CATEGORIES`). The page's parameter table says
 * `category_id_list` while its own cURL sample says `category_ids`, and a single
 * id serialises identically under both spellings — so this is also the shape
 * that keeps the open contradiction cheap to settle. A batched call would also
 * cache twenty categories under one key, which the reader cannot then invalidate
 * one at a time.
 */
export function lerAtributosCached(
  ctx: ShopeeTaxonomiaCtx,
  categoryId: number,
): Promise<ShopeeAttributeTree> {
  return atributosCache.get([ctx.integracaoId, categoryId], () =>
    ctx.client.getAttributeTree({ categoryIds: [categoryId] }),
  );
}

/** The four values that identify ONE page of `get_brand_list`. */
export interface PaginaDeMarcasParams {
  readonly categoryId: number;
  readonly status: number;
  readonly offset: number;
  readonly pageSize: number;
}

/** ONE page of brands. No loop here and none in the package: the caller pages. */
export function lerMarcasCached(
  ctx: ShopeeTaxonomiaCtx,
  p: PaginaDeMarcasParams,
): Promise<ShopeeBrandList> {
  return marcasCache.get([ctx.integracaoId, p.categoryId, p.status, p.offset, p.pageSize], () =>
    ctx.client.getBrandList({
      categoryId: p.categoryId,
      offset: p.offset,
      pageSize: p.pageSize,
      status: p.status,
    }),
  );
}

/**
 * The item bands, per category or for the whole shop.
 *
 * ⚠️ `null` means the documented shop-wide read, and it is its OWN key: `null`
 * and `0` encode differently (`z:null` vs `n:0`), so the shop-wide answer can
 * never be served for a category or the other way round.
 */
export function lerLimitesItemCached(
  ctx: ShopeeTaxonomiaCtx,
  categoryId: number | null,
): Promise<ShopeeItemLimitRead> {
  return limitesItemCache.get([ctx.integracaoId, categoryId], () =>
    ctx.client.getItemLimit(categoryId === null ? {} : { categoryId }),
  );
}

/** The KIT bands. A separate cache because it is a separate provider read. */
export function lerLimitesKitCached(
  ctx: ShopeeTaxonomiaCtx,
  categoryId: number | null,
): Promise<ShopeeKitItemLimit> {
  return limitesKitCache.get([ctx.integracaoId, categoryId], () =>
    ctx.client.getKitItemLimit(categoryId === null ? {} : { categoryId }),
  );
}

/** The standardised variation tree of a leaf category. */
export function lerVariacoesCached(
  ctx: ShopeeTaxonomiaCtx,
  categoryId: number,
): Promise<ShopeeVariations> {
  return variacoesCache.get([ctx.integracaoId, categoryId], () =>
    ctx.client.getVariations({ categoryId }),
  );
}

/** The suggested category ids for a product name. Offered, never applied. */
export function lerRecomendacaoCached(
  ctx: ShopeeTaxonomiaCtx,
  nome: string,
  imagemCapa: string | null,
): Promise<readonly number[]> {
  return recomendacaoCache.get([ctx.integracaoId, nome, imagemCapa], async () => {
    const payload = await ctx.client.categoryRecommend(
      imagemCapa === null ? { itemName: nome } : { itemName: nome, productCoverImage: imagemCapa },
    );
    return payload.category_id;
  });
}

/**
 * Drop every cached taxonomy answer, for every conta.
 *
 * ⚠️ Coarse ON PURPOSE. The primitive has no prefix scan, so a per-conta clear
 * would mean tracking every key this module ever wrote — state that can only
 * drift out of step with the caches themselves. The whole set is cheap to
 * rebuild (one call each, on demand), and step 3's `push 13` — Shopee telling us
 * a brand was approved — is where granularity earns its keep.
 */
export function limparTaxonomiaShopee(): void {
  categoriasCache.clear();
  atributosCache.clear();
  marcasCache.clear();
  limitesItemCache.clear();
  limitesKitCache.clear();
  variacoesCache.clear();
  recomendacaoCache.clear();
}
