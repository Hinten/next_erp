/**
 * Pure helpers for reading a `produtoMercadoLivre` link doc — which account it
 * belongs to, which Mercado Livre model it uses, and where the live listing is.
 *
 * Extracted from `MercadoLivreManager` so the listing editor, the status strip
 * and their tests share one implementation instead of three copies.
 */
import {
  ESTADO_PUBLICACAO_ML,
  ESTADO_PUBLICACAO_ML_LABELS,
  type EstadoPublicacaoMl,
  estadoPublicacaoMlSchema,
} from '@delfrance/schemas';

/**
 * Does this link doc belong to `integracaoId`?
 *
 * The old app always STORES the `documents/`-prefixed form, which is what this
 * app writes too; the bare form is tolerated on READ only, defensively. Kept
 * byte-identical to the server-side matcher (`publish.ts`) — a mismatch here
 * shows the operator someone else's listing.
 */
export function refMatchesIntegracao(
  ref: string | null | undefined,
  integracaoId: string,
): boolean {
  if (!ref) return false;
  return ref === `integracao/${integracaoId}` || ref.endsWith(`/integracao/${integracaoId}`);
}

/**
 * Soft-parse the 1–2 character estado code. The Flutter app can hold values
 * this schema has never seen, and an unknown code must degrade to "unknown"
 * rather than crash the tab.
 */
export function parseEstado(value: string | null | undefined): EstadoPublicacaoMl | null {
  const parsed = estadoPublicacaoMlSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Human label for an estado code, falling back to the raw code. */
export function estadoLabel(estado: string | null | undefined): string {
  const parsed = parseEstado(estado);
  if (parsed) return ESTADO_PUBLICACAO_ML_LABELS[parsed];
  return estado ?? 'Desconhecido';
}

/** Which Mercado Livre listing model a link doc uses. */
export type ListingModel = 'user-products' | 'legacy';

/**
 * User Products is mandatory for NEW listings, but legacy multi-variation
 * listings stay editable and are never force-migrated, so both shapes coexist
 * indefinitely and the editor must render either.
 */
export function listingModel(link: { isUserProductModel?: boolean | null }): ListingModel {
  return link.isUserProductModel === true ? 'user-products' : 'legacy';
}

/** Is stock sync latched off for this listing (#781)? */
export function isStockLatched(link: { estado?: string | null; id?: string | null }): boolean {
  return parseEstado(link.estado) === ESTADO_PUBLICACAO_ML.erro && link.id != null;
}

/**
 * The public URL of a published listing.
 *
 * Both models resolve to an **item** page — the only ML level that carries a
 * sale condition, and therefore the only one a buyer can act on:
 *
 *  - **legacy** — `produto.mercadolivre.com.br/MLB-<digits>`; the stored id is
 *    `MLB123`, and the public URL wants the digits with a hyphen. A pure string
 *    transform, no round trip needed.
 *  - **User Products** — the stored id is `familyId ?? itemId`, and a família id
 *    addresses nothing public, so the answer comes from the backend
 *    (`/api/marketplace/mercado-livre/link-anuncio`). `firstMemberItemId` is
 *    accepted for the case where the caller already knows a member's own MLB
 *    item, which resolves and redirects with no round trip at all.
 *
 * ⚠️ This deliberately does NOT build `mercadolivre.com.br/up/<user_product_id>`,
 * and neither may anything else. A User Product is a *product*, not an offer, so
 * that page renders **indisponível** whenever the UP's items are paused or
 * closed — the bug this function used to have, on a listing that was live and
 * selling. The server-side ⚠️ in
 * `apps/mercado-livre/lib/marketplace/anuncios/anuncioUrl.ts` carries ML's own
 * wording. The temptation is real and now cheap: the link doc gained a
 * `userProductId` field the day after the original link shipped.
 *
 * Returns null when there is nothing to link to yet.
 */
export function listingPermalink(
  link: { id?: string | null; isUserProductModel?: boolean | null },
  opts: { firstMemberItemId?: string | null } = {},
): string | null {
  if (listingModel(link) === 'user-products') {
    if (opts.firstMemberItemId) return mlbProductUrl(opts.firstMemberItemId);
    return null;
  }
  return link.id ? mlbProductUrl(link.id) : null;
}

/**
 * `produto.mercadolivre.com.br/MLB-<digits>` for ONE item id.
 *
 * Exported for the per-variation table (#1142), where each row already holds a
 * member's own `MLB…` and needs no link-shaped wrapper to turn it into a URL —
 * a User-Products member IS its own item, which is exactly the case
 * {@link listingPermalink} cannot answer from a link doc alone.
 */
export function mlbProductUrl(itemId: string): string | null {
  const digits = itemId.replace(/\D/g, '');
  return digits ? `https://produto.mercadolivre.com.br/MLB-${digits}` : null;
}

/**
 * The success-toast line for a publish (#798).
 *
 * A User-Products family is N ML items, not one, and the operator has no other
 * way to learn how many went out or that a removed variação's listing was
 * closed — the parent link shows a single family id and the child links are not
 * on screen.
 *
 * ⚠️ `itemIds`/`orfaosEncerrados` are optional on the wire: this app calls the
 * DEPLOYED channel backend, so a revision predating #798 answers without them
 * and must still produce the old single-item sentence.
 */
export function publishSummary(result: {
  itemId: string;
  estado: string;
  itemIds?: string[];
  orfaosEncerrados?: string[];
}): string {
  const count = result.itemIds?.length ?? 1;
  const head =
    count > 1
      ? `${count} anúncios (1 por variação) — ${estadoLabel(result.estado)}.`
      : `Anúncio ${result.itemId} — ${estadoLabel(result.estado)}.`;
  const closed = result.orfaosEncerrados?.length ?? 0;
  if (closed === 0) return head;
  return `${head} ${closed} ${closed === 1 ? 'anúncio encerrado' : 'anúncios encerrados'} (variação removida).`;
}
