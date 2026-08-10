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
 * **Deletion trigger:** once a real `curl -H 'x-format-new: true'` against a
 * production shipment confirms the new body — and the `legacy-shape` warnings
 * below stop appearing in the logs — every `?? legacy…` branch here goes, and
 * this file shrinks to plain property reads. That is one small PR, and #957
 * tracks it.
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
 * What the shipment costs, feeding `freteInicial.custoCalculado`.
 *
 * ⚠️ **This is a semantic shift, not a rename.** ML's own cost vocabulary
 * (docs, *Custos de envio*) defines the three sibling fields as:
 *
 * | field | ML's definition |
 * | --- | --- |
 * | `base_cost` | "Custo base do envio" |
 * | `cost` | "Custo total do envio **aplicando descontos**" |
 * | `list_cost` | "Custo real do envio **antes de aplicar descontos**" |
 *
 * The legacy body's top-level `base_cost` has no counterpart in the
 * `x-format-new` shape, so this falls back to `lead_time.cost` — which is the
 * POST-discount figure, where `base_cost` was the pre-discount base. For a
 * shipment carrying no discount the two agree; where a discount applies, this
 * now reports what was actually charged rather than the list basis. That is
 * arguably the better number for a cost field, but it IS a change and a reader
 * comparing historical `custoCalculado` values across the migration should know
 * it.
 *
 * `null` — never a fabricated `0` — when neither is present, so a caller can
 * tell "ML did not say" from "ML said zero".
 *
 * The authoritative source for what the SELLER pays is `GET /shipments/{id}/costs`
 * (`senders[].cost`), which the plugin does not implement; legacy did
 * (`api.dart:1645-1650`). Adding it would remove this guess entirely — tracked
 * as a follow-up on #957.
 */
export function shipmentBaseCost(shipment: MlShipment): number | null {
  return shipment.lead_time?.cost ?? legacy(shipment).base_cost ?? null;
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
 * carries a legacy-only field and none of the new ones. Callers log it once so
 * the deletion trigger above is an observation rather than a guess.
 */
export function ehFormatoLegado(shipment: MlShipment): boolean {
  const antigo = legacy(shipment);
  const temNovo = shipment.lead_time != null || shipment.logistic != null;
  const temAntigo = antigo.shipping_option != null || antigo.logistic_type != null;
  return !temNovo && temAntigo;
}
