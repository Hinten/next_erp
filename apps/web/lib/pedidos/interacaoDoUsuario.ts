/**
 * `pedido.hasUserInteraction` — the "a human has edited this pedido" flag.
 *
 * Legacy stamped it on EVERY save from the pedido form, on both the full-save
 * and the update-only path (`.old/lib/pedido/providers/cadastroPedidoProvider.dart:573`
 * and `:1203`). This app did not, which left the flag permanently `null` on
 * anything created or edited here.
 *
 * That matters because the flag has exactly one reader: the Mercado Livre order
 * import's shipment↔pedido item cross-check
 * (`apps/mercado-livre/lib/marketplace/orderImport.ts`, #669). The check asks ML
 * what it is about to ship and refuses to price a pedido whose lines disagree —
 * and `hasUserInteraction` is the operator's override, the statement that a
 * human has taken ownership of this line-up so ML's own is no longer the
 * authority. With the flag never written, that override was dead and every
 * operator edit to an ML pedido would have tripped the check.
 */

/**
 * Stamp `hasUserInteraction: true` onto a pedido write originating from a human
 * action, returning a new object.
 *
 * **An empty patch is returned untouched.** `savePedido` treats an empty patch
 * as "nothing changed" and throws `PedidoNothingChangedError`; unconditionally
 * adding a field would make every no-op "Salvar" commit a write instead of
 * telling the operator there was nothing to save. That is also why the stamp
 * lives here and not inside `buildPedidoPatch`, which must stay a pure
 * projection of the dirty fields.
 */
export function marcarInteracaoDoUsuario<T extends Record<string, unknown>>(patch: T): T {
  if (Object.keys(patch).length === 0) return patch;
  return { ...patch, hasUserInteraction: true };
}
