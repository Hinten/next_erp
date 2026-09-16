/**
 * The ONE Shopee `dimension` ⇄ produto axis map, **import direction** (#1517,
 * step 9). Pure: no clock, no Firestore, no wire call.
 *
 * ⚠️ Adopted from the legacy IMPORT, not the legacy EXPORT — the two disagreed
 * and a round trip TRANSPOSED two dimensions. The legacy import mapped
 * `package_width → larguraCm` and `package_length → profundidadeCm`, while the
 * legacy export mapped `larguraCm → package_length` and
 * `profundidadeCm → package_width`. The import direction wins because the
 * MIGRATED produto corpus was written by it: a stored `larguraCm` means
 * `package_width` today, and flipping the map would silently relabel every one
 * of those documents — no error, no failing test, just two axes swapped on a
 * catalogue nobody re-measures.
 *
 * ⚠️ The publish step (11) must derive its payload from
 * {@link EIXOS_PACOTE_SHOPEE_INVERSO}, never from a second hand-written table.
 * `eixos.test.ts` asserts BOTH directions field by field AND that the inverse is
 * a true bijection, so a transposition cannot ship: two wire axes landing on one
 * produto field would be a fold that silently drops a measurement.
 *
 * ⚠️ The UNIT is centimetres on both sides (Shopee's `dimension` members are
 * integers in cm and the produto's three fields are cm), so this map converts
 * nothing — it only renames. A unit conversion appearing here would be a
 * different change and belongs in the mapper, beside its own test.
 */

/** The produto's three package-dimension fields. Named so the map cannot widen silently. */
export type EixoDePacoteProduto = 'alturaCm' | 'larguraCm' | 'profundidadeCm';

/** Shopee `dimension` field → produto field. The import direction, verbatim from the legacy import. */
export const EIXOS_PACOTE_SHOPEE = {
  package_height: 'alturaCm',
  package_width: 'larguraCm',
  package_length: 'profundidadeCm',
} as const satisfies Record<string, EixoDePacoteProduto>;

/** Shopee's `dimension` field names, as the import reads them. */
export type EixoDePacoteShopee = keyof typeof EIXOS_PACOTE_SHOPEE;

/**
 * produto field → Shopee `dimension` field. DERIVED from
 * {@link EIXOS_PACOTE_SHOPEE} rather than written out, so the two can never
 * disagree — the whole defect this module exists to prevent was two hand-written
 * tables that disagreed.
 */
export const EIXOS_PACOTE_SHOPEE_INVERSO = Object.fromEntries(
  Object.entries(EIXOS_PACOTE_SHOPEE).map(([wire, erp]) => [erp, wire]),
) as {
  alturaCm: 'package_height';
  larguraCm: 'package_width';
  profundidadeCm: 'package_length';
};
