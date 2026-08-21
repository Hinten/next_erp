/**
 * Process-scoped caches for Mercado Livre's **catalog metadata** — the category
 * tree, a category's attribute definitions, and its listing types.
 *
 * The listing editor asks for these on every keystroke of the category cascade
 * and again whenever the operator switches account or scope, and the answers
 * change on the order of months. Firestore Enterprise bills data scanned and ML
 * rate-limits per token, so the uncached version is the expensive one twice
 * over — `GET /categories/{id}/attributes` alone is 50–300 KB per call.
 *
 * ⚠️ These wrap **plain HTTP reads of immutable-ish reference data**. None of
 * the three forbidden cases apply: no `tx.get`, no read-modify-write, and no
 * OAuth token (the access token still goes through `tokenStore` uncached on
 * every request — see the exclusions at the top of `readCache.ts`).
 *
 * ⚠️ `createReadCache` hands back the SAME object reference on every hit.
 * Callers must treat the result as frozen; `projectCategoriaAtributos` only
 * reads, and its `.sort()` runs on an array it built itself.
 */
import { READ_CACHE_TTL, createReadCache } from '@delfrance/data/admin/cache';
import type {
  MercadoLivreApi,
  MlCategory,
  MlCategoryAttribute,
  MlCategoryListingType,
  MlSiteCategory,
} from '@delfrance/integrations-mercado-livre';

/**
 * A single category node. Keyed by category id only — ML category metadata is
 * global, not per-seller, so every account shares one entry.
 */
const categoriaCache = createReadCache<readonly [string], MlCategory>({
  name: 'ml:categoria',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 500,
});

/** The tree roots. One list, identical for every caller, effectively static. */
const categoriasRaizCache = createReadCache<readonly ['MLB'], MlSiteCategory[]>({
  name: 'ml:categorias-raiz',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 4,
});

/** The heaviest metadata call, and the one the editor re-asks most often. */
const categoriaAtributosCache = createReadCache<readonly [string], MlCategoryAttribute[]>({
  name: 'ml:categoria-atributos',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 300,
});

/** Tiny and near-static, but it rides the same cascade as the attributes. */
const listingTypesCache = createReadCache<readonly [string], MlCategoryListingType[]>({
  name: 'ml:categoria-listing-types',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 300,
});

/**
 * Category suggestions for a free-text query.
 *
 * `negativeTtlMs: 0` — the key space is unbounded (every prefix an operator
 * types is its own key), so the LRU does the real work, and an empty answer for
 * a half-typed title must never stick around to greet the finished one.
 */
const sugestaoCache = createReadCache<readonly [string, number], unknown[]>({
  name: 'ml:categoria-sugestao',
  ttlMs: READ_CACHE_TTL.config,
  maxEntries: 200,
  negativeTtlMs: 0,
  isNegative: (value) => !Array.isArray(value) || value.length === 0,
});

export function getCategoriaCached(api: MercadoLivreApi, categoryId: string): Promise<MlCategory> {
  return categoriaCache.get([categoryId], () => api.getCategory(categoryId));
}

export function getCategoriasRaizCached(api: MercadoLivreApi): Promise<MlSiteCategory[]> {
  return categoriasRaizCache.get(['MLB'], () => api.listSiteCategories());
}

export function getCategoriaAtributosCached(
  api: MercadoLivreApi,
  categoryId: string,
): Promise<MlCategoryAttribute[]> {
  return categoriaAtributosCache.get([categoryId], () => api.getCategoryAttributes(categoryId));
}

export function getListingTypesCached(
  api: MercadoLivreApi,
  categoryId: string,
): Promise<MlCategoryListingType[]> {
  return listingTypesCache.get([categoryId], () => api.getCategoryListingTypes(categoryId));
}

export function getSugestaoCategoriasCached(
  api: MercadoLivreApi,
  query: string,
  limit: number,
): Promise<unknown[]> {
  return sugestaoCache.get([query, limit], () => api.suggestCategories(query, limit));
}
