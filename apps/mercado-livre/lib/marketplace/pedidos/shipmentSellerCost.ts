/**
 * "What does the SELLER pay for this shipment?" — the question the
 * `x-format-new` body stopped answering when it dropped `base_cost` (#957).
 *
 * `custoCalculado` had no source at all after that migration: `shipmentBaseCost`
 * returns `null` on every new-format payload, and `derivePedidoFreteTotals`
 * (`custoCalculado ?? custoFinal ?? 0`) fell through to `custoFinal` =
 * `lead_time.list_cost`, which is the GROSS list price rather than the seller's
 * share. On the shipment verified live on #957 that is 22.14 against a
 * buyer-paid 12.99 on a `partially_free` envio.
 *
 * `GET /shipments/{id}/costs` is ML's authoritative answer. Legacy declared the
 * call (`api.dart:1644-1650`) but never used it, so nothing here is a port.
 */
import {
  MercadoLivreError,
  type MercadoLivreApi,
  type MlShipmentCosts,
} from '@delfrance/integrations-mercado-livre';

/** Our seller's `cost` out of the response, or `null`. Never throws on an ML failure. */
function extrairCustoDoVendedor(costs: MlShipmentCosts, sellerId: number): number | null {
  // ⚠️ Matched on `user_id`, NEVER `senders[0]`. ML: "um só envio poderá conter
  // produtos de diferentes vendedores" — and on a single-seller shipment the
  // index version looks right every time, so the bug only ever surfaces on the
  // multi-seller envio where it books someone else's freight onto our pedido.
  const nosso = (costs.senders ?? []).find((s) => String(s?.user_id ?? '') === String(sellerId));
  const custo = nosso?.cost;
  // ⚠️ `0` is a REAL cost — a fully subsidised shipment costs the seller nothing —
  // so this is an explicit finite-number test and never a truthiness one. It is
  // the mirror of the `lead_time.cost` trap in `shipmentBaseCost`: there a real
  // `0` must not be READ as a cost, here a real `0` must not be DISCARDED as one.
  return typeof custo === 'number' && Number.isFinite(custo) ? custo : null;
}

/**
 * The seller's freight cost for a shipment, or `null` meaning **"ML did not
 * say"** — never a fabricated `0`.
 *
 * Every miss degrades to `null` and the caller's merge then preserves whatever
 * is stored (`mapped.custoCalculado ?? existing.custoCalculado ?? null`), so a
 * costs outage costs an update rather than corrupting a figure. Four ways to
 * miss, all silent by design:
 *
 *  - no seller id on the conta (nothing to match) — no call is made at all;
 *  - the endpoint failed. Narrowed to `MercadoLivreError` and swallowed, exactly
 *    as `resolvePrazoDespacho` tolerates a failed SLA read: this is one field of
 *    an import that must not be poisoned into a Cloud Tasks retry loop over a
 *    cost. Anything else rethrows (root `CLAUDE.md` rule 6);
 *  - `senders` carries no entry for us;
 *  - the entry has no numeric `cost`.
 */
export async function resolveShipmentSellerCost(
  api: MercadoLivreApi,
  shipmentId: number | string,
  sellerId: number | null,
): Promise<number | null> {
  if (sellerId == null || !Number.isFinite(sellerId) || sellerId === 0) return null;

  let costs: MlShipmentCosts;
  try {
    costs = await api.getShipmentCosts(shipmentId);
  } catch (err) {
    if (!(err instanceof MercadoLivreError)) throw err;
    console.warn('[mercado-livre] custos do envio indisponíveis — custoCalculado não atualizado', {
      shipmentId,
      motivo: err.message,
    });
    return null;
  }

  const custo = extrairCustoDoVendedor(costs, sellerId);
  if (custo == null) {
    // Loud on purpose: a systematic mismatch here (a wrong seller id on the
    // conta, or ML changing the shape) is otherwise indistinguishable from a
    // shipment that genuinely has no sender row, and both read as "cost never
    // updates" with nothing in the logs.
    console.warn('[mercado-livre] nenhum sender nosso em /shipments/{id}/costs', {
      shipmentId,
      sellerId,
      sendersUserIds: (costs.senders ?? []).map((s) => s?.user_id ?? null),
    });
  }
  return custo;
}
