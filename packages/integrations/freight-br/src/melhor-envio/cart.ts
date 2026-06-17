/**
 * Build a `POST /api/v2/me/cart` request — pure port of the legacy
 * `inserirFreteCarrinho` payload (`.old/.../melhor_envio/lib/src/api/api.dart:485-590`).
 *
 * Domain-neutral: callers (the apps/integrations comprar route / apps/web Frete
 * tab) resolve the pedido + frete + filial + cliente + endereços into the
 * primitive inputs here; this file has no Firestore / schema deps. Faithful
 * quirks kept from the legacy:
 *  - the address line is capped at **39 chars** (ME rejects 40, despite docs);
 *  - product names are capped at 50 chars;
 *  - `insurance_value` has a **floor of 1** (ME rejects 0);
 *  - `non_commercial` is `true` exactly when there is no NF-e key, and the
 *    `invoice` block is sent only with a key;
 *  - a **reverse** shipment swaps which physical address is `from` vs `to`.
 */
import { type VolumeInput, normalizeVolume } from './calculate';
import type { CartInsertRequest, DimensionsWeight } from './types';

/** One address party (origin or destination) of a cart shipment. */
export interface CartAddressInput {
  readonly name: string;
  readonly phone?: string | null;
  readonly email?: string | null;
  /** CPF — set for a Pessoa Física party. */
  readonly document?: string | null;
  /** CNPJ — set for a Pessoa Jurídica party (origin filial is always PJ). */
  readonly companyDocument?: string | null;
  /** Inscrição estadual. */
  readonly stateRegister?: string | null;
  /** CNAE — origin (filial) only. */
  readonly economicActivityCode?: string | null;
  readonly address: string;
  readonly complement?: string | null;
  readonly number: string;
  readonly district: string;
  readonly city: string;
  readonly stateAbbr: string;
  /** Defaults to `'BR'`. */
  readonly countryId?: string | null;
  readonly postalCode: string;
  readonly note?: string | null;
}

export interface CartProductInput {
  readonly name: string;
  readonly quantity: number;
  readonly unitaryValue: number;
}

export interface CartOptionsInput {
  readonly insuranceValue?: number | null;
  readonly receipt?: boolean;
  readonly ownHand?: boolean;
  /** The NF-e access key; its presence flips `non_commercial` off. */
  readonly invoiceKey?: string | null;
  /** Tagged onto the shipment as `Pedido <n>`. */
  readonly pedidoNumero?: string | number | null;
  /** Identifies the integrating platform to ME. */
  readonly platform?: string;
}

export interface BuildCartItemParams {
  readonly service: number;
  readonly agency?: number | null;
  readonly reverse?: boolean;
  /** The store/filial party. */
  readonly from: CartAddressInput;
  /** The recipient party. */
  readonly to: CartAddressInput;
  readonly products: ReadonlyArray<CartProductInput>;
  readonly volumes: ReadonlyArray<VolumeInput>;
  readonly options?: CartOptionsInput;
}

const ADDRESS_MAX = 39;
const PRODUCT_NAME_MAX = 50;
const DEFAULT_PLATFORM = 'Delfrance ERP';

function capLen(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** ME address map; optional identity fields are omitted when empty. */
function addressBlock(a: CartAddressInput): Record<string, unknown> {
  const block: Record<string, unknown> = {
    name: a.name,
    address: capLen(a.address, ADDRESS_MAX).trim(),
    number: a.number,
    district: a.district,
    city: a.city,
    state_abbr: a.stateAbbr,
    country_id: a.countryId ?? 'BR',
    postal_code: a.postalCode,
    note: a.note ?? '',
  };
  if (a.phone) block.phone = a.phone;
  if (a.email) block.email = a.email;
  if (a.document) block.document = a.document;
  if (a.companyDocument) block.company_document = a.companyDocument;
  if (a.stateRegister) block.state_register = a.stateRegister;
  if (a.economicActivityCode) block.economic_activity_code = a.economicActivityCode;
  if (a.complement && a.complement.trim()) block.complement = a.complement.trim();
  return block;
}

export function buildCartItem(p: BuildCartItemParams): CartInsertRequest {
  const reverse = p.reverse ?? false;
  const origin = addressBlock(p.from);
  const destination = addressBlock(p.to);

  const volumes: DimensionsWeight[] =
    p.volumes.length > 0 ? p.volumes.map(normalizeVolume) : [normalizeVolume({})];

  const insuranceValue = p.options?.insuranceValue ?? 0;
  const tags = p.options?.pedidoNumero != null ? [{ tag: `Pedido ${p.options.pedidoNumero}` }] : [];

  const options: Record<string, unknown> = {
    // Floor of 1 — ME rejects a 0 insurance value.
    insurance_value: insuranceValue >= 1 ? insuranceValue : 1,
    receipt: p.options?.receipt ?? false,
    own_hand: p.options?.ownHand ?? false,
    reverse,
    non_commercial: p.options?.invoiceKey == null,
    platform: p.options?.platform ?? DEFAULT_PLATFORM,
    tags,
  };
  if (p.options?.invoiceKey) options.invoice = { key: p.options.invoiceKey };

  const payload: Record<string, unknown> = {
    service: p.service,
    ...(p.agency != null ? { agency: p.agency } : {}),
    // A reverse shipment ships back FROM the recipient TO the store.
    ...(reverse ? { from: destination, to: origin } : { from: origin, to: destination }),
    products: p.products.map((e) => ({
      name: capLen(e.name, PRODUCT_NAME_MAX),
      quantity: String(e.quantity),
      unitary_value: e.unitaryValue.toFixed(2),
    })),
    volumes,
    options,
  };

  return payload as CartInsertRequest;
}
