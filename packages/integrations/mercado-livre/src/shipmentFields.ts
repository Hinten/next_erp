/**
 * Accessors for the shipment fields that MOVED when ML switched
 * `GET /shipments/{id}` to the `x-format-new` body (#957).
 *
 * Every one of them reads the new location first and falls back to the legacy
 * one. That is deliberate, and it is the whole reason this file exists as a
 * single unit:
 *
 *  - the new shape is taken from ML's documentation, not from a live call, and
 *    the failures it would cause are mostly SILENT — a moved field parses fine
 *    against `mlShipmentSchema` (`.passthrough()`, every field optional) and
 *    simply reads `null`, which downstream turns into a `0` cost, a `sem-cep`
 *    pedido, or a frete block that never refreshes again;
 *  - ML has been rolling these deprecations out per-resource over more than a
 *    year (`estimated_handling_limit` 2025-05-13, `order_id` + the mandatory
 *    header 2025-10-12), so "which shape arrives" is not something the caller
 *    can assume for a given account on a given day.
 *
 * Reading both is therefore not indecision, it is the only shape that is
 * correct before AND after the switch, on one account or on all of them.
 *
 * **Deletion trigger — BOTH halves, and neither is satisfied yet.**
 *
 *  1. A real `curl -H 'x-format-new: true'` against a production shipment
 *     confirms the new body. ✅ Settled 2026-08-27 on shipment `47868202073`
 *     (#957): every field arrived at its new location.
 *  2. The warning below stops appearing in the logs **for the account whose
 *     shipments actually matter**. ❌ Not settled. The query is
 *
 *     ```
 *     gcloud logging read 'textPayload:"formato LEGADO"' \
 *       --project <projeto> --freshness=30d
 *     ```
 *
 *     ⚠️ Grep for **`formato LEGADO`** — the exact string `registrarFormatoDoEnvio`
 *     emits. #957 once ran this query for `legacy-shape`, a phrase that appears
 *     only in prose and in no emitted output, so it returned zero results and
 *     proved nothing. A checker with no known-bad control is not evidence.
 *
 *     ⚠️ And it must be the PRODUCTION seller account. Today this backend only
 *     ever talks to ML through staging test users; the real account is still
 *     driven by the legacy Flutter app and does not reach this code until the
 *     cutover (root `CLAUDE.md` rule 8). A clean staging log says nothing about
 *     the body ML serves that account.
 *
 * When both hold, every `?? legacy…` branch here goes and this file shrinks to
 * plain property reads. That is one small PR — it is deliberately NOT tracked on
 * #957, which closed once the migration itself was verified.
 */
import type { MlShipment, MlShipmentLeadTime } from './types';

/** The legacy (pre-`x-format-new`) field names, none of which the schema types any more. */
interface LegacyShipmentShape {
  readonly base_cost?: number | null;
  readonly logistic_type?: string | null;
  readonly order_id?: number | string | null;
  readonly shipping_option?: {
    readonly list_cost?: number | null;
    readonly estimated_handling_limit?: { readonly date?: string | null } | null;
    readonly estimated_delivery_limit?: { readonly date?: string | null } | null;
    readonly estimated_delivery_time?: { readonly date?: string | null } | null;
  } | null;
  readonly receiver_address?: unknown;
}

const legacy = (shipment: MlShipment): LegacyShipmentShape =>
  shipment as unknown as LegacyShipmentShape;

/**
 * `lead_time` (new) or `shipping_option` (legacy) — the delivery-window/cost
 * block. Returns `null` when neither is present.
 */
export function shipmentLeadTime(shipment: MlShipment): MlShipmentLeadTime | null {
  if (shipment.lead_time != null) return shipment.lead_time;
  const antigo = legacy(shipment).shipping_option;
  return antigo != null ? (antigo as MlShipmentLeadTime) : null;
}

/** `logistic.type` (new) or `logistic_type` (legacy). */
export function shipmentLogisticType(shipment: MlShipment): string | null {
  return shipment.logistic?.type ?? legacy(shipment).logistic_type ?? null;
}

/**
 * The legacy top-level `base_cost`, feeding `freteInicial.custoCalculado`.
 *
 * WARNING: there is deliberately NO substitute when it is absent, and
 * `lead_time.cost` is emphatically not one. The two captured ML shipment bodies
 * in `.old/` settle it — `base_cost` is a DISTINCT quantity, not a discount
 * variant of the others:
 *
 * | captured shipment | `base_cost` | `cost` | `list_cost` |
 * | --- | --- | --- | --- |
 * | free shipping (`models.dart:3128,3150,3154`) | 38.90 | **0** | 19.45 |
 * | paid, NO discount (`models.dart:5122,5142,5147`) | 16.20 | 8.91 | 8.91 |
 *
 * The second row is decisive: `cost === list_cost`, so nothing was discounted,
 * and `base_cost` is still nearly double — reading `cost` would understate that
 * shipment's cost by 45%. The first row is worse: free shipping is a 100%
 * discount, so `cost` is a genuine `0`, which `??` does NOT treat as missing. It
 * would flow through `mergeFreteInicial` and overwrite a correct stored value,
 * then win the `custoCalculado ?? custoFinal` precedence in
 * `derivePedidoFreteTotals` — wiping the freight cost from the pedido on exactly
 * the orders where it is largest.
 *
 * So when the `x-format-new` body drops `base_cost`, this returns `null`, which
 * means "ML did not say": the merge preserves whatever is stored and the totals
 * fall through to `custoFinal` (`list_cost`). Losing the field is acceptable;
 * silently replacing it with a different quantity is not.
 *
 * The authoritative source for what the SELLER actually pays is
 * `GET /shipments/{id}/costs` (`senders[].cost`). That is now implemented —
 * `getShipmentCosts` + `mlShipmentCostsSchema`, read by
 * `resolveShipmentSellerCost` in `apps/mercado-livre` — and it, not this
 * accessor, is what fills `custoCalculado`. This one remains only as the
 * second term of that `??` chain, for a payload still carrying the legacy
 * field. (Legacy declared `get_shipment_costs` at `api.dart:1644-1650` but
 * never called it, so there was no parity model to port.)
 */
export function shipmentBaseCost(shipment: MlShipment): number | null {
  return legacy(shipment).base_cost ?? null;
}

/** The buyer's shipping address: `destination.shipping_address` (new) or `receiver_address` (legacy). */
export function shipmentAddress(shipment: MlShipment): unknown {
  return shipment.destination?.shipping_address ?? legacy(shipment).receiver_address ?? null;
}

/**
 * The shipment's order id, while ML still sends it.
 *
 * **Discontinued as of 2025-10-12** — there is no new-format counterpart, so
 * this returns `null` on a migrated body by design. Callers must fall back to
 * `getShipmentOrders`, which is the documented replacement; this accessor only
 * exists so they can skip that extra round-trip while the field survives.
 */
export function shipmentOrderIdLegado(shipment: MlShipment): number | string | null {
  return legacy(shipment).order_id ?? null;
}

/**
 * Whether this payload still looks like the pre-`x-format-new` body — i.e. it
 * carries a legacy-only field and none of the new ones.
 */
export function ehFormatoLegado(shipment: MlShipment): boolean {
  const antigo = legacy(shipment);
  const temNovo = shipment.lead_time != null || shipment.logistic != null;
  const temAntigo = antigo.shipping_option != null || antigo.logistic_type != null;
  return !temNovo && temAntigo;
}

/** Module-scoped so the warning below is emitted at most once per process. */
let avisouFormatoLegado = false;

/**
 * Emit the deletion trigger, once per process.
 *
 * This is what makes the file header's claim true: the fallbacks above come out
 * when ML stops sending the legacy body, and that has to be an OBSERVATION. A
 * silent absence is ambiguous — "no legacy warnings" would otherwise be equally
 * consistent with "ML migrated us" and with "nothing was ever looking", and
 * acting on the second reading would delete a fallback that is still load-bearing.
 *
 * Called from `getShipment`, which is the single choke point every shipment
 * passes through. Once per process rather than once per shipment: this is a
 * one-bit fact about the account, and a per-shipment warn on a busy backend
 * would be noise nobody reads.
 *
 * ⚠️ **The literal string is the interface.** Whoever reads these logs greps for
 * `formato LEGADO`; the file header carries the exact `gcloud` query. Do not
 * reword the message — the history already written under it is the evidence, and
 * a rewrite silently invalidates every query anyone has run against it.
 */
export function registrarFormatoDoEnvio(shipment: MlShipment): void {
  if (avisouFormatoLegado || !ehFormatoLegado(shipment)) return;
  avisouFormatoLegado = true;
  console.warn(
    '[mercado-livre] shipment ainda no formato LEGADO apesar do header `x-format-new` — ' +
      'os fallbacks de `shipmentFields.ts` continuam necessários; não os remova enquanto ' +
      'este aviso aparecer (#957)',
    { shipmentId: shipment.id },
  );
}

/** Test seam — resets the one-shot latch above (mirrors `__resetAllReadCaches`). */
export function __resetAvisoFormatoLegado(): void {
  avisouFormatoLegado = false;
}
