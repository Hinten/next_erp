/**
 * The outcome WATERMARK of the Amazon listings flows (step 13, PR 13-b), pure:
 * whether a new outcome replaces the one a link doc stores under its flow's
 * field (`CAMPO_ENVIO_LISTING_AMAZON`, `vinculoListing.ts`). ONE rule for every
 * flow; its reader and the preconditioned `update` are
 * `envioListingFirestore.ts`, and the stock flow binds both
 * (`estoque/envioEstoque.ts`, `estoque/envioEstoqueFirestore.ts`).
 *
 * ## Strictly newer wins
 *
 * {@link decidirGravacaoEnvioListing} writes iff nothing readable is stored or
 * the stored `emMs` is STRICTLY older than the new one; an EQUAL `emMs` keeps
 * the stored. `emMs` is OUR submission instant, in milliseconds, so a report
 * read hours after its submission never overwrites the outcome of a send
 * submitted after it, and the winner writes its own `emMs`: the watermark
 * always advances. A stored value whose `emMs` cannot be read (not an object,
 * or no non-negative safe integer there) is no watermark: the new outcome
 * replaces it.
 *
 * PURE: no Firestore, no clock, no network.
 */

/** What the decision reads of an outcome: its clock, in ms. */
export interface EnvioComRelogioListingAmazon {
  readonly emMs: number;
}

/** The stored `emMs`, when the stored value has a readable one (module header). */
function emMsArmazenado(armazenado: unknown): number | null {
  if (typeof armazenado !== 'object' || armazenado === null) return null;
  const emMs = (armazenado as { readonly emMs?: unknown }).emMs;
  return typeof emMs === 'number' && Number.isSafeInteger(emMs) && emMs >= 0 ? emMs : null;
}

/**
 * Whether `novo` replaces the stored outcome (module header): nothing readable
 * stored, or a STRICTLY older `emMs`. Equal keeps the stored.
 */
export function decidirGravacaoEnvioListing(
  armazenado: unknown,
  novo: EnvioComRelogioListingAmazon,
): boolean {
  const anterior = emMsArmazenado(armazenado);
  return anterior === null || anterior < novo.emMs;
}
