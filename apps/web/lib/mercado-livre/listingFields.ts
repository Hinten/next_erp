/**
 * Pure form-domain helpers for the Mercado Livre listing editor: the option
 * lists the controls render, and the rules that decide whether a field may be
 * edited at all.
 *
 * Kept out of the components so the rules can be tested without a DOM — the
 * title rule in particular is one ML enforces server-side, and getting it wrong
 * either locks a field the operator may legitimately change or offers an edit
 * that comes back as a 400.
 */
import type { ProdutoMercadoLivreLink } from '@delfrance/schemas';
import type { OperatorOwnedKey } from './listingPatch';

/**
 * Operator-facing names for the keys this editor writes. Used by the conflict
 * modal, which has to say *which* field someone else changed — a raw
 * `listing_type_id` in that table tells nobody anything.
 */
export const LISTING_FIELD_LABELS: Record<OperatorOwnedKey, string> = {
  title: 'Título do anúncio',
  descricao: 'Descrição',
  condition: 'Condição',
  channels: 'Canais',
  category_id: 'Categoria',
  listing_type_id: 'Tipo de anúncio',
  tarifaFrete: 'Tarifa de frete',
  crossdocking: 'Crossdocking',
  video_id: 'Vídeo (YouTube)',
  attributes: 'Atributos',
};

/**
 * ML's `title` limit on MLB. Enforced as an input `maxLength` rather than a
 * validation rule: a title stored longer than this (Flutter wrote it, or ML
 * itself did) must not block an unrelated edit to `tarifaFrete` on the same
 * form — that listing already fails to publish, and blocking the form would
 * remove the only screen where it can be fixed.
 */
export const TITLE_MAX_LENGTH = 60;

/**
 * The three `channels` combinations the legacy screen offered.
 *
 * `channels` is stored as a plain string array, and ML accepts values we do not
 * model, so {@link channelsToPreset} returns null rather than guessing — see
 * {@link channelOptions}.
 */
export const CHANNEL_PRESETS = [
  { value: 'marketplace', label: 'Mercado Livre', channels: ['marketplace'] },
  { value: 'mshops', label: 'Mercado Shops', channels: ['mshops'] },
  { value: 'todos', label: 'Todos', channels: ['marketplace', 'mshops'] },
] as const;

export type ChannelPreset = (typeof CHANNEL_PRESETS)[number]['value'];

/** Which preset a stored `channels` array is, or null when it is none of them. */
export function channelsToPreset(channels: readonly string[] | null | undefined): string | null {
  const set = new Set(channels ?? []);
  if (set.size === 0) return null;
  for (const preset of CHANNEL_PRESETS) {
    if (preset.channels.length === set.size && preset.channels.every((c) => set.has(c))) {
      return preset.value;
    }
  }
  return null;
}

/** The array to store for a preset; unknown preset ⇒ null (caller keeps the stored value). */
export function presetToChannels(preset: string | null | undefined): string[] | null {
  const found = CHANNEL_PRESETS.find((p) => p.value === preset);
  return found ? [...found.channels] : null;
}

/** Human label for a stored `channels` array — the preset name, or the raw list. */
export function channelsLabel(channels: readonly string[] | null | undefined): string | null {
  const preset = channelsToPreset(channels);
  if (preset) return CHANNEL_PRESETS.find((p) => p.value === preset)!.label;
  const values = [...new Set(channels ?? [])];
  return values.length > 0 ? values.join(', ') : null;
}

/**
 * Select options for `channels`, including the CURRENT value when it matches no
 * preset.
 *
 * Without that extra entry a Select bound to an unmodelled array renders blank
 * and the first interaction silently rewrites a combination ML accepted and we
 * simply do not know about.
 */
export function channelOptions(
  current: readonly string[] | null | undefined,
): Array<{ value: string; label: string }> {
  const options: Array<{ value: string; label: string }> = CHANNEL_PRESETS.map((p) => ({
    value: p.value,
    label: p.label,
  }));
  if (channelsToPreset(current) === null && (current?.length ?? 0) > 0) {
    options.push({ value: rawChannelValue(current!), label: `${current!.join(', ')} (atual)` });
  }
  return options;
}

/** Sentinel Select value standing for "the stored array, unmodelled". */
export function rawChannelValue(channels: readonly string[]): string {
  return `__raw__:${[...channels].join(',')}`;
}

/** Reverses {@link rawChannelValue}; null when the value is a real preset. */
export function parseRawChannelValue(value: string | null | undefined): string[] | null {
  if (!value?.startsWith('__raw__:')) return null;
  return value.slice('__raw__:'.length).split(',').filter(Boolean);
}

export const CONDITION_OPTIONS = [
  { value: 'new', label: 'Novo' },
  { value: 'used', label: 'Usado' },
] as const;

/**
 * MLB listing types offered on a FIRST publish. After publishing, ML changes a
 * listing type only through its own upgrade endpoint, so the field stops being
 * an input — which is also what keeps the e2e assertion that a published card
 * has no labelled "Tipo de anúncio" control true.
 */
export const LISTING_TYPE_OPTIONS = [
  { value: 'gold_special', label: 'Clássico' },
  { value: 'gold_pro', label: 'Premium' },
] as const;

/** Label for a stored listing type id, falling back to the raw id. */
export function listingTypeLabel(id: string | null | undefined): string | null {
  if (!id) return null;
  return LISTING_TYPE_OPTIONS.find((o) => o.value === id)?.label ?? id;
}

/**
 * How many units this listing has sold, as cached on the link doc.
 *
 * Returns null when unknown, which is the normal state today: the field is
 * written by the server (publish + the `items` webhook) and the still-running
 * Flutter app drops any key it does not know the next time it saves the doc.
 * Both spellings are accepted — ours and ML's raw `sold_quantity` — so a doc
 * written by either side reads the same.
 */
export function linkSoldQuantity(link: ProdutoMercadoLivreLink): number | null {
  const raw = link as unknown as Record<string, unknown>;
  for (const key of ['soldQuantity', 'sold_quantity']) {
    const value = raw[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return null;
}

export interface FieldEditability {
  editable: boolean;
  /** Why not — shown as a tooltip. Null when editable. */
  reason: string | null;
}

const EDITABLE: FieldEditability = { editable: true, reason: null };

/**
 * May the operator edit this listing's title?
 *
 * ML accepts a `title` change while the item has **no sales**, and rejects it
 * afterwards. Two deliberate choices about the edges:
 *
 *  - **Unknown sold quantity ⇒ editable.** The count is a derived cache that
 *    Flutter strips, so "unknown" is the common case and treating it as "sold"
 *    would freeze the field on nearly every listing. When the guess is wrong ML
 *    rejects the publish and the message maps back to this field, which is a
 *    recoverable mistake; a permanently disabled input is not.
 *  - **Only `closed` blocks.** A paused listing can still be retitled. Guarding
 *    on `status === 'active'` instead would lock the field for every paused or
 *    under-review listing, which is exactly when an operator is trying to fix
 *    the title that caused the problem.
 *
 * ⚠️ A User-Products family stores its title as `family_name`, which ML freezes
 * on the same "no sales" rule; the UP publish path strips it rather than fail
 * the whole update, so a title saved here may legitimately not reach ML.
 */
export function titleEditability(link: ProdutoMercadoLivreLink): FieldEditability {
  if (link.id == null) return EDITABLE;
  const sold = linkSoldQuantity(link);
  if (sold != null && sold > 0) {
    return {
      editable: false,
      reason: 'O Mercado Livre não permite alterar o título de um anúncio que já teve vendas.',
    };
  }
  if (link.status === 'closed') {
    return {
      editable: false,
      reason: 'O anúncio está encerrado no Mercado Livre e não aceita alterações.',
    };
  }
  return EDITABLE;
}
