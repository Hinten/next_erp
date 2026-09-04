/**
 * Pure mapper: a resolved pedido + frete + filial + endereços → the Melhor
 * Envio `POST /api/v2/me/cart` request. Port of the legacy
 * `inserirFreteCarrinho` (`.old/.../melhor_envio/lib/src/api/api.dart:485-590`).
 *
 * The wire quirks (39-char address cap, 50-char product name, insurance floor
 * of 1, `non_commercial` ↔ NF-e key, reverse from/to swap) live in
 * `buildCartItem`; this file only resolves the primitives, exactly as the
 * `apps/integrations` comprar route expects them (it takes a client-built
 * `cartPayload`, mirroring the F4 `calculate` request).
 *
 * When the pedido has an authorized NF-e, the resolved `invoiceKey` is sent as
 * `invoice.key` and flips `non_commercial` off (#209); without one it sends
 * `non_commercial: true` (declaração de conteúdo).
 */
import { localTelefoneOrNull } from '@delfrance/core/phone';
import {
  type CartInsertRequest,
  type VolumeInput,
  buildCartItem,
  toVolumeInput,
} from '@delfrance/integrations-freight-br/http-client';
import type { Endereco, Filial, ItemDoPedido } from '@delfrance/schemas';

import type { FreteInicialFormState } from '../../types';

/** The recipient identity fields read off the pedido's cliente, as a fallback
 *  for the destination address party. Structural subset of `Cliente`. */
export interface ClienteDestinoLike {
  readonly nome?: string | null;
  readonly cpf_cnpj?: string | null;
  readonly ie?: string | null;
  readonly email?: string | null;
  readonly telefone?: string | null;
}

/*
 * Why `from.phone` / `to.phone` go out in the LOCAL BR shape (DDD + subscriber,
 * no country code), through `localTelefoneOrNull` below:
 *
 * That is what ME's own documented example uses, what every fixture in
 * `packages/integrations/freight-br` sends, and what the legacy Flutter app
 * demonstrably sent. This app, meanwhile, stores phones `55`-prefixed
 * (`normalizeTelefone`), so without the strip the shape on the wire would
 * change silently the moment a cliente or a freight origin is edited in this
 * UI — and whether ME accepts, normalizes or mangles a `55…` value is an OPEN
 * question (#868), answerable only against their sandbox. Stripping at the
 * boundary decouples the stored shape from the wire: correct whichever way
 * #868 lands, and a no-op on the legacy raw values already in the corpus.
 * `localTelefone` only ever strips a leading `55`, so a foreign number keeps
 * its own country code.
 */

export interface BuildPedidoCartInput {
  readonly frete: FreteInicialFormState;
  /** The integração's "Endereço de origem" (`integracao.enderecoDeOrigem`). */
  readonly enderecoOrigem: Endereco | null;
  /** The filial behind the integração — supplies razão social + CNPJ/IE/CNAE. */
  readonly filial: Filial | null;
  /** The frete's "Quem recebe" address (`enderecoFreteOuterReference`). */
  readonly enderecoDestino: Endereco | null;
  /** The pedido's cliente — name/document/phone/email fallback. */
  readonly clienteDestino: ClienteDestinoLike | null;
  readonly itens: ReadonlyArray<ItemDoPedido>;
  readonly pedidoNumero: string | number | null;
  /**
   * The pedido's authorized NF-e access key (modelo 55). When present it's sent
   * as `invoice.key` and flips `non_commercial` off — most carriers (Jadlog,
   * etc.) reject a commercial shipment without it. Null → `non_commercial: true`
   * (declaração de conteúdo), only accepted for non-commercial shipments.
   */
  readonly invoiceKey?: string | null;
}

/** 14 digits = CNPJ (PJ); anything else (typically 11 = CPF) is treated as PF. */
function isPessoaJuridica(document: string | null): boolean {
  return (document ?? '').replace(/\D/g, '').length === 14;
}

/**
 * ME's `country_id` is an ISO-2 code (`BR`). Our endereços store the NF-e
 * **numeric** country code (`cPais`, `1058` = Brasil) or null, so passing it
 * straight through makes ME reject "country id inválido". Pass through only a
 * genuine 2-letter code; everything else (numeric / null) defaults to `BR`.
 */
function toCountryId(cPais: string | null | undefined): string {
  const v = (cPais ?? '').trim();
  return /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : 'BR';
}

export function buildPedidoCartPayload(input: BuildPedidoCartInput): CartInsertRequest {
  const {
    frete,
    enderecoOrigem,
    filial,
    enderecoDestino,
    clienteDestino,
    itens,
    pedidoNumero,
    invoiceKey,
  } = input;

  // `Number(null)`/`Number('')` are both 0 (finite), so guard the raw value
  // first — an unselected option must throw, not silently become service 0.
  const optionId = frete.externalOptionId?.trim();
  const service = optionId ? Number(optionId) : Number.NaN;
  if (!Number.isFinite(service)) {
    throw new Error('Selecione uma opção de frete antes de comprar a etiqueta.');
  }
  const agencyRaw = frete.externalOptionData?.agency;
  const agency = typeof agencyRaw === 'number' ? agencyRaw : null;

  // Origin (store/filial): address from the integração, fiscal identity from
  // the filial doc.
  const from = {
    name: filial?.razaoSocial ?? '',
    // Some carriers (e.g. Jadlog, service 3) require the sender phone; fall back
    // to the filial's sede phone when the integração's origin address has none.
    phone: localTelefoneOrNull(enderecoOrigem?.telefone ?? filial?.sede?.telefone),
    email: enderecoOrigem?.email ?? filial?.sede?.email ?? null,
    companyDocument: filial?.cnpj ?? null,
    stateRegister: filial?.ie ?? null,
    economicActivityCode: filial?.cnae ?? null,
    address: enderecoOrigem?.logradouro ?? '',
    complement: enderecoOrigem?.complemento ?? null,
    number: enderecoOrigem?.numero ?? '',
    district: enderecoOrigem?.bairro ?? '',
    city: enderecoOrigem?.cidade ?? '',
    stateAbbr: enderecoOrigem?.estado ?? '',
    countryId: toCountryId(enderecoOrigem?.cPais),
    postalCode: enderecoOrigem?.cep ?? '',
  };

  // Recipient: address fields from the endereço, identity falling back to the
  // cliente. PF/PJ decides document vs company_document (+ IE).
  const destDocument = enderecoDestino?.cpf_cnpj ?? clienteDestino?.cpf_cnpj ?? null;
  const pj = isPessoaJuridica(destDocument);
  const to = {
    name: enderecoDestino?.nome ?? clienteDestino?.nome ?? '',
    phone: localTelefoneOrNull(enderecoDestino?.telefone ?? clienteDestino?.telefone),
    email: enderecoDestino?.email ?? clienteDestino?.email ?? null,
    document: pj ? null : destDocument,
    companyDocument: pj ? destDocument : null,
    stateRegister: pj ? (enderecoDestino?.ie ?? clienteDestino?.ie ?? null) : null,
    address: enderecoDestino?.logradouro ?? '',
    complement: enderecoDestino?.complemento ?? null,
    number: enderecoDestino?.numero ?? '',
    district: enderecoDestino?.bairro ?? '',
    city: enderecoDestino?.cidade ?? '',
    stateAbbr: enderecoDestino?.estado ?? '',
    countryId: toCountryId(enderecoDestino?.cPais),
    postalCode: enderecoDestino?.cep ?? '',
  };

  const products = itens.map((it) => ({
    name: it.nomeDeVenda ?? it.sku ?? 'Item',
    quantity: it.quantidade,
    unitaryValue: it.precoDeVenda - (it.descontoUnitario ?? 0),
  }));

  const volumes: VolumeInput[] = (frete.volumes ?? []).map(toVolumeInput);

  return buildCartItem({
    service,
    agency,
    reverse: frete.ehReverso,
    from,
    to,
    products,
    volumes,
    options: {
      insuranceValue: frete.valor_assegurado,
      receipt: frete.avisoRecebimento ?? false,
      ownHand: frete.maoPropria ?? false,
      // The pedido's authorized NF-e chave (when emitted) → `invoice.key` +
      // `non_commercial: false`; absent → non_commercial (buildCartItem handles
      // a blank/null key).
      invoiceKey: invoiceKey ?? null,
      pedidoNumero,
    },
  });
}
