import type { ExpandSpec } from '@delfrance/core';

/**
 * Line-item identity for the pedido modification history.
 *
 * `pedido.itens` is a `Record<produtoUid, ItemDoPedido[]>`, and the history
 * trigger diffs it PER LINE rather than storing both whole maps. That needs a
 * key that survives an edit — and this domain has no field that reliably
 * provides one, so the fallback chain below is the design, not a shortcut:
 *
 *  - `ensureUniqueId` is a real, stable id — but ONLY on Mercado Livre lines
 *    (`apps/mercado-livre/lib/marketplace/orderIds.ts` derives it as a sha256 of
 *    `orderId`/`mktplaceId`/index, and the ML merge is keyed on it). Lines
 *    created in `apps/web` are written with `ensureUniqueId: null` and nothing
 *    ever fills it in.
 *  - `produtoUid` cannot serve: it is the map's GROUP key, and the value is an
 *    array precisely because one produto may occupy several lines.
 *  - `ordem` is neither unique nor stable — the ML mapper writes it 0-based per
 *    ML order, and a pack pedido folds several orders into one document, so two
 *    lines can both be `ordem: 0`. It is also reissued after a delete.
 *
 * So: `ensureUniqueId` when present, else `#<ordem>`, else `null` (the diff
 * engine then synthesizes a positional key). Duplicates are disambiguated by the
 * engine with an occurrence suffix over a deterministic scan, so a repeated
 * `#<ordem>` still pairs stably across a redelivery of the same CloudEvent.
 *
 * ⚠️ Unlike {@link flattenPedidoItens}, this deliberately does NOT backfill
 * `produtoUid` from the map key. History records what is on disk; deriving a
 * field here would make the stored diff disagree with the stored document.
 */

/** Marks a key derived from `ordem` rather than from a real id. */
export const PEDIDO_ITEM_POSITIONAL_PREFIX = '#';

/**
 * Stable-ish key for one RAW stored line item. `null` hands the decision back to
 * the diff engine, which falls back to a group+index positional key.
 *
 * Array POSITION is deliberately not part of the identity, so a pure reorder
 * inside a group produces no diff at all.
 *
 * ⚠️ The `#<ordem>` fallback is scoped to the GROUP (`<produtoUid>#<ordem>`),
 * and that scoping is a correctness fix, not tidiness. `#<ordem>` alone is not
 * unique across produtos — the schema default is `ordem: 1`, `devolucaoForm`
 * hardcodes `ordem: 1`, and the migrated corpus carries rows the legacy Flutter
 * app stamped `ordem: 1` (that writer is gone; its rows are not) — and the diff
 * engine assigns its duplicate-occurrence suffix in SORTED
 * GROUP-KEY order. So with an unscoped key, merely adding an unrelated produto
 * renumbers the occurrences after it and the engine pairs lines belonging to
 * different produtos: an untouched line reports as `added` while a quantity
 * change nobody made is attributed to another. In an audit trail that is worse
 * than a coarse whole-map entry, because it reads as a specific, credible edit.
 *
 * Mercado Livre lines are unaffected — they key on `ensureUniqueId` and stay
 * group-independent, so a produto rebind still reads as one `produtoUid`
 * change. A rebind of an ID-LESS line now reads as remove + add, which is the
 * accepted cost of never mispairing.
 *
 * The map key is used ONLY to namespace the synthesized key; nothing derived is
 * written into the stored diff (see the note above about `produtoUid`).
 */
export function pedidoItemKey(item: Record<string, unknown>, mapKey: string): string | null {
  const ensureUniqueId = item.ensureUniqueId;
  if (typeof ensureUniqueId === 'string' && ensureUniqueId !== '') return ensureUniqueId;

  const ordem = item.ordem;
  if (typeof ordem === 'number' && Number.isFinite(ordem)) {
    return `${mapKey}${PEDIDO_ITEM_POSITIONAL_PREFIX}${ordem}`;
  }
  return null;
}

/**
 * The `expand` entry the pedido history trigger passes for `itens`.
 *
 * `timestamp` is ignored per line: it is a creation stamp that the legacy
 * Flutter app round-trips on every wholesale `Pedido.save()`, so recording it
 * would turn one operator edit into one change per line.
 */
export const PEDIDO_ITENS_EXPAND: ExpandSpec = {
  kind: 'mapOfArrays',
  identify: pedidoItemKey,
  ignore: ['timestamp'],
};
