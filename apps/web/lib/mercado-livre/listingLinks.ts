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
 * The two models address listings differently, and the legacy form is a pure
 * string transform — no round trip needed:
 *
 *  - **legacy** — `produto.mercadolivre.com.br/MLB-<digits>`; the stored id is
 *    `MLB123`, and the public URL wants the digits with a hyphen.
 *  - **User Products** — `mercadolivre.com.br/up/<user_product_id>`. That id is
 *    per-MEMBER and is not on the link doc (any field we add is dropped the next
 *    time Flutter saves), so it comes from the server. Until it does, linking a
 *    member's own MLB item resolves and redirects, which is why
 *    `firstMemberItemId` is accepted as a fallback.
 *
 * Returns null when there is nothing to link to yet.
 */
export function listingPermalink(
  link: { id?: string | null; isUserProductModel?: boolean | null },
  opts: { userProductId?: string | null; firstMemberItemId?: string | null } = {},
): string | null {
  if (listingModel(link) === 'user-products') {
    if (opts.userProductId) return `https://www.mercadolivre.com.br/up/${opts.userProductId}`;
    if (opts.firstMemberItemId) return mlbProductUrl(opts.firstMemberItemId);
    return null;
  }
  return link.id ? mlbProductUrl(link.id) : null;
}

function mlbProductUrl(itemId: string): string | null {
  const digits = itemId.replace(/\D/g, '');
  return digits ? `https://produto.mercadolivre.com.br/MLB-${digits}` : null;
}
