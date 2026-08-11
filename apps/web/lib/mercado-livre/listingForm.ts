/**
 * The shape of the listing edit form, and the two conversions around it: link
 * doc → form values, form values → the values `buildListingPatch` writes.
 *
 * Pure and separate from the component so both directions are unit-tested —
 * every one of these fields ends up in a Mercado Livre payload, and a mapping
 * slip here is a rejected publish with no local symptom.
 *
 * ⚠️ This schema is **UI-only** and must never be merged into
 * `produtoMercadoLivreLinkSchema`. A `.min()`/`.max()` on the stored schema
 * makes the whole document fail its soft read, which silently discards every
 * `.default()` on the doc rather than flagging the one bad field.
 */
import { z } from 'zod';

import {
  channelsToPreset,
  parseRawChannelValue,
  presetToChannels,
  rawChannelValue,
} from './listingFields';
import type { OperatorOwnedKey } from './listingPatch';
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';

/** ML's own plain-text description ceiling. */
const DESCRICAO_MAX = 50000;

export const listingFormSchema = z.object({
  title: z.string().trim().min(1, 'Informe o título do anúncio.'),
  descricao: z.string().max(DESCRICAO_MAX, 'A descrição excede o limite do Mercado Livre.'),
  condition: z.enum(['new', 'used']),
  channels: z.string().min(1, 'Escolha onde o anúncio aparece.'),
  listing_type_id: z.string(),
  tarifaFrete: z.number().min(0, 'A tarifa de frete não pode ser negativa.').nullable(),
  crossdocking: z
    .number()
    .int('Informe o prazo em dias inteiros.')
    .min(0, 'O prazo não pode ser negativo.')
    .nullable(),
  video_id: z.string().trim(),
});

export type ListingFormInput = z.input<typeof listingFormSchema>;
export type ListingFormValues = z.output<typeof listingFormSchema>;

/** Seed the form from the stored doc. */
export function toFormValues(link: ProdutoMercadoLivreLink): ListingFormInput {
  const preset = channelsToPreset(link.channels);
  return {
    title: link.title ?? '',
    descricao: link.descricao ?? '',
    condition: link.condition === 'used' ? 'used' : 'new',
    // An unmodelled `channels` array is carried through verbatim rather than
    // snapped to the nearest preset — see `channelOptions`.
    channels:
      preset ??
      ((link.channels?.length ?? 0) > 0 ? rawChannelValue(link.channels!) : 'marketplace'),
    listing_type_id: link.listing_type_id ?? '',
    tarifaFrete: link.tarifaFrete ?? null,
    crossdocking: link.crossdocking ?? null,
    video_id: link.video_id ?? '',
  };
}

/**
 * Form values → the doc-shaped values the patch builder reads.
 *
 * Two things happen here and nowhere else: the channels preset becomes the
 * stored array, and a text input cleared to `''` becomes `null`. The second
 * matters because ML treats an empty string as a real value — an empty
 * `video_id` is a request to attach a video with no id, not a request to remove
 * the video.
 */
export function toPatchValues(
  values: ListingFormValues,
): Partial<Record<OperatorOwnedKey, unknown>> {
  return {
    title: values.title.trim(),
    descricao: blankToNull(values.descricao),
    condition: values.condition,
    channels: parseRawChannelValue(values.channels) ??
      presetToChannels(values.channels) ?? ['marketplace'],
    listing_type_id: blankToNull(values.listing_type_id),
    tarifaFrete: values.tarifaFrete,
    crossdocking: values.crossdocking,
    video_id: blankToNull(values.video_id),
  };
}

function blankToNull(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}
