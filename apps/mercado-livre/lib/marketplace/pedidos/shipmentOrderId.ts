/**
 * "Which ML order does this shipment belong to?" — the one question that got
 * harder when ML discontinued `shipment.order_id` (#957).
 *
 * Two consumers depend on the answer and both degrade quietly without it: the
 * shipments-topic handler skips with `sem-order-id`, and a shipment-scoped claim
 * reports `pedido-nao-encontrado`. Neither raises, so losing the field would
 * have looked like "nothing to do" rather than a break.
 */
import {
  shipmentOrderIdLegado,
  type MercadoLivreApi,
  type MlShipment,
} from '@delfrance/integrations-mercado-livre';

/**
 * The shipment's order id, preferring the field ML still sometimes sends and
 * falling back to `GET /shipments/{id}/orders` — the documented replacement.
 *
 * The legacy field is tried FIRST purely to save a round-trip: it is exactly as
 * authoritative as the endpoint while it exists, and it costs nothing to read
 * from a payload already in hand.
 *
 * ⚠️ **The first row wins**, and that is a real narrowing worth naming. A pack
 * shipment covers several orders, so this returns "an order of this shipment",
 * not "the order". Both callers only need it to reach the pedido, and every
 * order of a pack resolves to the SAME pedido (`discoverPedidoMercadoLivre`
 * folds a pack into one document), so the choice is immaterial to them — but a
 * future caller that needs per-order attribution must read the rows itself.
 *
 * Returns `null` when ML knows of no orders for the shipment. Errors from the
 * endpoint PROPAGATE: a transient failure must not be recorded as "this shipment
 * has no order", which is a permanent-looking skip.
 */
export async function resolveShipmentOrderId(
  api: MercadoLivreApi,
  shipment: MlShipment,
): Promise<number | null> {
  const legado = shipmentOrderIdLegado(shipment);
  if (legado != null) {
    const n = Number(legado);
    if (Number.isFinite(n)) return n;
  }

  const linhas = await api.getShipmentOrders(shipment.id);
  for (const linha of linhas) {
    if (linha.order_id == null) continue;
    const n = Number(linha.order_id);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
