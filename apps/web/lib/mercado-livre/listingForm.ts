/**
 * The shape of the listing edit form, and the two conversions around it: link
 * doc → form values, form values → the values `buildListingPatch` writes.
 *
 * Pure and separate from the component so both directions are unit-tested —
 * every one of these fields ends up in a Mercado Livre payload, and a mapping
 * slip here is a rejected publish with no local symptom.
 *
 * ## What is deliberately NOT here
 *
 * The form holds only what the OPERATOR decides about the listing. Everything
 * that describes the product itself lives on the produto and is read from there
 * at publish time — editing a second copy here would only let the two diverge:
 *
 *  - **`crossdocking` and `video_id`** are produto fields
 *    (`produto.crossdocking`, `produto.videos`). ⚠️ Neither the link's
 *    `crossdocking` nor its `channels` ever reaches the ML payload at all —
 *    `buildItemPayload` does not read them — so they were editable and inert.
 *  - **`channels`** — Mercado Shops is discontinued, so a listing is always
 *    `['marketplace']` and there is nothing to choose.
 *  - **`tarifaFrete`** is an internal figure, not something ML is told.
 *  - **`condition`** is `produto.ehUsado`. Whether a product is used is a fact
 *    about the PRODUCT, not about one of its listings, and two editable copies
 *    could only disagree. ⚠️ It is also **create-only** at ML
 *    (`buildItemPayload`, inside `if (!input.isUpdate)`), so an edit here could
 *    never have reached an existing listing anyway — it only looked like it did.
 *  - **`fotos`** come from the produto's own Fotos tab; publish derives the
 *    listing pictures from `produto.fotos`.
 *
 * Their stored values are left untouched — nothing here deletes them — they
 * simply stop being editable from this screen.
 *
 * ⚠️ This schema is **UI-only** and must never be merged into
 * `produtoMercadoLivreLinkSchema`. A `.min()`/`.max()` on the stored schema
 * makes the whole document fail its soft read, which silently discards every
 * `.default()` on the doc rather than flagging the one bad field.
 */
import { z } from 'zod';

import type { OperatorOwnedKey } from './listingPatch';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

/** ML's own plain-text description ceiling. */
const DESCRICAO_MAX = 50000;

export const listingFormSchema = z.object({
  title: z.string().trim().min(1, 'Informe o título do anúncio.'),
  descricao: z.string().max(DESCRICAO_MAX, 'A descrição excede o limite do Mercado Livre.'),
  // Not `.min(1)`: a draft may legitimately be saved before its category is
  // chosen (an operator fixing the título first), and publish already refuses a
  // listing without one. Blocking the save would trap the other edits.
  category_id: z.string(),
  listing_type_id: z.string(),
});

export type ListingFormInput = z.input<typeof listingFormSchema>;
export type ListingFormValues = z.output<typeof listingFormSchema>;

/** Seed the form from the stored doc. */
export function toFormValues(link: ProdutoMercadoLivreLink): ListingFormInput {
  return {
    title: link.title ?? '',
    descricao: link.descricao ?? '',
    category_id: link.category_id ?? '',
    listing_type_id: link.listing_type_id ?? '',
  };
}

/**
 * Form values → the doc-shaped values the patch builder reads.
 *
 * A text input cleared to `''` becomes `null`, because ML treats an empty
 * string as a real value rather than as an absence.
 */
export function toPatchValues(
  values: ListingFormValues,
): Partial<Record<OperatorOwnedKey, unknown>> {
  return {
    title: values.title.trim(),
    descricao: blankToNull(values.descricao),
    category_id: blankToNull(values.category_id),
    listing_type_id: blankToNull(values.listing_type_id),
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}
