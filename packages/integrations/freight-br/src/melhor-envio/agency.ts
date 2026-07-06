/**
 * Drop-off agency resolution for the cart insert.
 *
 * Some carriers (Jadlog, service 3/4, and others) are *drop-off* carriers: ME
 * requires the `agency` (the unit where the package is posted) in the cart
 * body. Without it, `POST /me/cart` fails with an opaque 500
 * ("Houve um erro ao salvar o pedido no carrinho") — there's no validation
 * hint. Carriers that aren't agency-based (Correios) simply return no agencies
 * and are left untouched.
 *
 * The legacy app never sent `agency`; ME made it mandatory for these carriers
 * since. This resolves it automatically (port "auto-select"): find the carrier
 * behind the selected `service`, list its agencies near the sender, and inject
 * the first one. A caller that already chose an `agency` (the buy modal's
 * picker, #377) short-circuits this.
 */
import type { Agency, CartInsertRequest, ShipmentService } from './types';

/** The ME calls agency resolution needs (a subset of `MelhorEnvioApi`). */
export interface AgencyResolverApi {
  listServices(): Promise<ShipmentService[]>;
  listAgencies(params: {
    company: number | null;
    country: string;
    state: string;
    city: string;
  }): Promise<Agency[]>;
}

/** The cart fields agency resolution reads (all passthrough on `CartInsertRequest`). */
type CartWithAgency = CartInsertRequest & {
  agency?: number | null;
  from?: { state_abbr?: string | null; city?: string | null } | null;
};

/**
 * Pick the drop-off agency to use. ME returns agencies ordered by proximity to
 * the queried location, so the first is the nearest — good enough for
 * auto-select. (The buy modal's picker prefills this same choice, visibly.)
 */
export function pickAgency(agencies: readonly Agency[]): Agency | null {
  return agencies[0] ?? null;
}

/** The company (carrier) id behind a `service` id, or null if unknown. */
export async function companyForService(
  api: AgencyResolverApi,
  service: number,
): Promise<number | null> {
  const services = await api.listServices();
  return services.find((s) => s.id === service)?.company?.id ?? null;
}

/**
 * Return the cart with an `agency` injected when the carrier needs one. No-op
 * when an agency is already set (caller chose), when the sender location is
 * missing, when the carrier can't be resolved, or when the carrier has no
 * agencies (e.g. Correios). Best-effort: ME errors bubble to the caller, since
 * a drop-off carrier can't be bought without an agency anyway.
 */
export async function ensureCartAgency(
  api: AgencyResolverApi,
  cart: CartInsertRequest,
): Promise<CartInsertRequest> {
  const c = cart as CartWithAgency;
  if (c.agency != null) return cart; // caller (picker) already chose an agency.

  const state = c.from?.state_abbr ?? undefined;
  const city = c.from?.city ?? undefined;
  if (!state || !city) return cart; // can't query agencies without a location.

  const company = await companyForService(api, cart.service);
  if (company == null) return cart; // unknown carrier → don't guess an agency.

  const agencies = await api.listAgencies({ company, country: 'BR', state, city });
  const agency = pickAgency(agencies);
  return agency ? ({ ...cart, agency: agency.id } as CartInsertRequest) : cart;
}
