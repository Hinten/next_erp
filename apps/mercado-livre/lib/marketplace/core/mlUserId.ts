/**
 * The one rule for turning an ML user id off the wire into a value this app may
 * key an identity on.
 *
 * ⚠️ **`JSON.parse` silently ROUNDS past 2^53.** ML warns that user ids outgrew
 * Int32 and are now Int64, so an id beyond the safe range arrives already
 * damaged: two distinct buyers can land on the same number, and stringifying it
 * afterwards cannot recover the digits. `cliente.idMercadoLivre` is a STRONG
 * match key — `findOrCreateCliente` merges on it — so a rounded id does not
 * mildly mislabel a row, it MERGES TWO PEOPLE, which is the single failure that
 * key exists to prevent. Ids today are ~1e9, six orders of magnitude clear of
 * the limit; if that ever changes we want a loud skip and a warn, not a silent
 * merge.
 *
 * This lives in `core/` because three paths now resolve the same buyer and must
 * agree on the answer: `chat/questionMapping.ts` (the pre-sale asker),
 * `pedidos/orderImport.ts` (the order buyer) and, transitively,
 * `claims/claimCliente.ts`, which stamps the id those two resolved. A second
 * copy of the check would be a comment asserting what the other copy does — and
 * the copies drift toward plausible, so they would read correct while
 * disagreeing about which buyers exist.
 */

/**
 * The id, or `null` when it is unusable — never a throw. An unsafe id degrades
 * to "we have no ML id for this person": the caller proceeds without the key
 * rather than failing an import over it.
 *
 * `logScope` names the caller in the emitted message (`'pergunta'`, `'pedido'`)
 * and `logContext` carries whatever identifies the delivery. Both exist so the
 * warn says which import hit this, since the id itself is the thing we cannot
 * trust.
 */
export function safeMlUserId(
  raw: number | null | undefined,
  logScope: string,
  logContext: Record<string, unknown>,
): number | null {
  if (raw == null) return null;
  if (!Number.isSafeInteger(raw)) {
    console.warn(`[mercado-livre] ${logScope}: id de comprador fora do alcance seguro`, {
      ...logContext,
      buyerId: raw,
    });
    return null;
  }
  return raw;
}
