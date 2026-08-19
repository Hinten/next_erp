/**
 * The public Mercado Livre URL of ONE listing, resolved on demand.
 *
 * The produto's ML tab offers a "ver no Mercado Livre" link, ported from the old
 * Flutter screen (`cadastroProdutoMLNew.dart:134-156`). For a LEGACY listing the
 * link doc's `id` is the MLB item and the URL is a pure string transform the
 * browser does itself — this module is never called. For a **User-Products**
 * listing the browser has nothing it can turn into a URL, so the answer comes
 * from ML.
 *
 * ⚠️ Under User Products `link.id` is `familyId ?? itemId` — NOT reliably a
 * family id. Three writers put an `MLB…` item id there under
 * `isUserProductModel: true`: `publish.ts` and `importUserProduct.ts` both fall
 * back to the item when ML omits `family_id`, and the UPtin takeover
 * (`importMigration.ts`) merges the flag onto an existing link WITHOUT touching
 * its id — so every migrated listing carries the old item id. Hence
 * {@link isFamilyId}: the two shapes address different endpoints, and sending an
 * item id to the families one is a 400 (`invalid value for id`), not a 404.
 *
 * ⚠️ The answer is deliberately NOT persisted on the link doc. The Flutter app is
 * a live concurrent writer during dual-run and its `Model.save()` is an UNMASKED
 * `set()` over a closed field list (`web_database/lib/src/types.dart:598,626`;
 * `_$ProdutoMercadoLivreToJson` has no catch-all bucket), so any field this app
 * adds is wiped by the next Flutter save, publish or import. A cached URL that
 * silently disappears is worse than one resolved when asked for.
 *
 * Cost: ONE ML request either way. The old app spent two — it read the first
 * variation's `itemId` from Firestore, then `GET /items/{id}` just to learn
 * `user_product_id`.
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

/** `mercadolivre.com.br/up/<user_product_id>` — the User Products Page. */
export function upProductUrl(userProductId: string): string {
  return `https://www.mercadolivre.com.br/up/${userProductId}`;
}

/**
 * Is this stored id a FAMILY id rather than an item id?
 *
 * The shapes do not overlap: a family id is ML's own numeric key
 * (`6264141844942250`), every item id is `MLB` + digits, and a UPtin id is
 * `MLBU` + digits. Dispatching on the shape is what keeps a malformed request off
 * the wire — `GET /sites/MLB/user-products-families/MLB4128712323` answers
 * **400**, and a 400 says nothing a caller can recover from, unlike the 404 a
 * genuinely missing family returns.
 *
 * This is the invariant every OTHER caller of the families endpoint already
 * enforces by construction: `import.ts` and `publishUserProduct.ts` only ever
 * pass a value derived from `item.family_id`, and refuse when it is null.
 */
function isFamilyId(id: string): boolean {
  return /^\d+$/.test(id);
}

/** ML's `user_product_id` when it is actually usable. */
function upIdOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * Where this listing lives on Mercado Livre, or null when there is nothing to
 * link to — never published, or gone from ML.
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

  return isFamilyId(id) ? familyUrl(deps.api, id) : upItemUrl(deps.api, id);
}

/** The first member's page — one family groups the sale conditions of one product. */
async function familyUrl(api: AnuncioUrlApi, familyId: string): Promise<string | null> {
  try {
    const family = await api.getUserProductFamily(familyId);
    const upId = family.user_products_ids.find((u) => u.length > 0);
    return upId != null ? upProductUrl(upId) : null;
  } catch (err) {
    if (err instanceof MercadoLivreHttpError && err.status === 404) return null;
    throw err;
  }
}

/**
 * The page for a UP listing whose stored id is an ITEM — the UPtin case above.
 *
 * `GET /items/{id}` carries `user_product_id` (ML's *User Products* guide: item →
 * `user_product_id` → the User Products Page), and that is the page to open: the
 * same one the family branch reaches and the old Flutter screen linked to, rather
 * than the single sale condition `permalink` names. `permalink` is the fallback
 * for an item ML reports without a UP id at all.
 */
async function upItemUrl(api: AnuncioUrlApi, id: string): Promise<string | null> {
  try {
    const item = await api.getItem(id);
    const upId = upIdOf(item.user_product_id);
    if (upId != null) return upProductUrl(upId);
    return item.permalink ?? mlbProductUrl(id);
  } catch (err) {
    // The listing is gone — there is no page to open, and saying so beats a
    // link that lands on a 404.
    if (err instanceof MercadoLivreHttpError && err.status === 404) return null;
    throw err;
  }
}
