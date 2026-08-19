/**
 * The public Mercado Livre URL of ONE listing, resolved on demand.
 *
 * The produto's ML tab offers a "ver no Mercado Livre" link, ported from the old
 * Flutter screen (`cadastroProdutoMLNew.dart:134-156`). For a LEGACY listing the
 * link doc's `id` is the MLB item and the URL is a pure string transform the
 * browser does itself — this module is never called. For a **User-Products**
 * listing `id` is a FAMILY id, which addresses nothing public, so the URL has to
 * come from ML.
 *
 * ⚠️ The answer is deliberately NOT persisted on the link doc. The Flutter app is
 * a live concurrent writer during dual-run and its `Model.save()` is an UNMASKED
 * `set()` over a closed field list (`web_database/lib/src/types.dart:598,626`;
 * `_$ProdutoMercadoLivreToJson` has no catch-all bucket), so any field this app
 * adds is wiped by the next Flutter save, publish or import. A cached URL that
 * silently disappears is worse than one resolved when asked for.
 *
 * Cost: ONE ML request. The old app spent two — it read the first variation's
 * `itemId` from Firestore, then `GET /items/{id}` just to learn
 * `user_product_id`. The family endpoint hands those ids over directly.
 */
import {
  type MlItem,
  type MlUserProductFamily,
  MercadoLivreHttpError,
} from '@delfrance/integrations-mercado-livre';

/** The minimal ML surface a URL resolution needs (injectable for tests). */
export interface AnuncioUrlApi {
  getUserProductFamily(familyId: string): Promise<MlUserProductFamily>;
  getItem(id: string): Promise<MlItem>;
}

/** The link-doc fields this resolution reads — a raw Admin-SDK payload. */
export interface AnuncioUrlLink {
  id?: unknown;
  isUserProductModel?: unknown;
}

/**
 * `produto.mercadolivre.com.br/MLB-<digits>` — the legacy product page.
 *
 * ⚠️ Kept byte-identical to `mlbProductUrl` in
 * `apps/web/lib/mercado-livre/listingLinks.ts`, the browser-side copy: the two
 * surfaces must agree on the URL a given listing resolves to. Duplicated rather
 * than shared because the integrations package root is server-only (it holds the
 * OAuth client secret) and `apps/web` cannot import it — the same reason
 * `refMatchesIntegracao` exists twice.
 */
export function mlbProductUrl(itemId: string): string | null {
  const digits = itemId.replace(/\D/g, '');
  return digits ? `https://produto.mercadolivre.com.br/MLB-${digits}` : null;
}

/** `mercadolivre.com.br/up/<user_product_id>` — the User-Products page. */
export function upProductUrl(userProductId: string): string {
  return `https://www.mercadolivre.com.br/up/${userProductId}`;
}

/**
 * Where this listing lives on Mercado Livre, or null when there is nothing to
 * link to yet (never published).
 *
 * The User-Products branch has a fallback, and it is not defensive padding: a
 * link doc written by the Flutter app can carry an ITEM id under
 * `isUserProductModel: true` (the flag flips on the UPtin takeover, and rows
 * predating it were never rewritten), and a family ML knows but reports with no
 * members is indistinguishable from that here. Both land on `GET /items/{id}`,
 * which answers with ML's own `permalink` — the documented canonical URL.
 *
 * Anything other than a 404 propagates: a 5xx or a dead token is a failure to
 * ANSWER, and reporting it beats handing the operator a URL that 404s.
 */
export async function resolveAnuncioUrl(
  deps: { api: AnuncioUrlApi },
  link: AnuncioUrlLink,
): Promise<string | null> {
  const id = typeof link.id === 'string' && link.id !== '' ? link.id : null;
  if (id == null) return null;

  if (link.isUserProductModel !== true) return mlbProductUrl(id);

  try {
    const family = await deps.api.getUserProductFamily(id);
    const upId = family.user_products_ids.find((u) => u.length > 0);
    if (upId != null) return upProductUrl(upId);
  } catch (err) {
    // A 404 means `id` is not a family — fall through to the item reading.
    // Every other ML failure is a failure to answer, not a hint about the shape.
    if (!(err instanceof MercadoLivreHttpError) || err.status !== 404) throw err;
  }

  return itemUrl(deps.api, id);
}

/** ML's own `permalink` for `id`, falling back to the derived legacy URL. */
async function itemUrl(api: AnuncioUrlApi, id: string): Promise<string | null> {
  try {
    const item = await api.getItem(id);
    return item.permalink ?? mlbProductUrl(id);
  } catch (err) {
    // The listing is gone — there is no page to open, and saying so beats a
    // link that lands on a 404.
    if (err instanceof MercadoLivreHttpError && err.status === 404) return null;
    throw err;
  }
}
