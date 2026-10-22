/**
 * The buyer and the delivery address of an Amazon order, as the shared cliente
 * and endereço resolvers take them (master plan step 5, PR 5-c; plan §3
 * decisions 17–19). PURE: PR 5-d calls `findOrCreateCliente` and the endereço
 * builder with what these return.
 *
 * ## The cliente comes only from the BUYER tax registration and the buyer's name
 *
 * - The FIRST `tax.taxRegistrations[]` entry with `entityType === 'BUYER'`, its
 *   number through the shared usable-document predicate (mask gate, check
 *   digits), decided by its DIGITS — 11 ⇒ CPF, 14 ⇒ CNPJ — and NEVER by
 *   `taxRegistrationType`: the BR sandbox buyer is labelled `VAT` over a 10-digit
 *   number (no identity at all).
 * - CNPJ ⇒ the registration's `legalName`, else `buyerCompanyName`, else
 *   `buyerName`; CPF ⇒ `buyerName`. Each through the usable-name predicate.
 * - Never the recipient's name, phone or document, and never `buyerEmail` (an
 *   anonymized relay address).
 *
 * ## The endereço prefers `extendedFields`
 *
 * `addressLine2` is never the número nor appended to the complemento (in both
 * BR examples it repeats the complement). No `codigoMunicipio`: the NF-e path
 * resolves the IBGE code for every channel, and the endereço id hashes it (an
 * operator override).
 */
import type { PedidoWireAmazon } from '@delfrance/integrations-amazon-sp-api';
import {
  TIPO_CLIENTE,
  cpfCnpjUtilizavel,
  nomeUtilizavel,
  normalizeDocumento,
  type ClienteResolveFields,
  type RawEnderecoInput,
} from '@delfrance/schemas';

/** Amazon's `entityType` values this module reads (exact). */
export const ENTIDADE_FISCAL_AMAZON = {
  comprador: 'BUYER',
  marketplace: 'MARKETPLACE',
} as const satisfies Record<string, string>;

/** Why an order yields no cliente. */
export const MOTIVO_SEM_IDENTIDADE_AMAZON = {
  /** No BUYER registration, or its number is not a usable CPF/CNPJ. */
  semDocumento: 'sem-documento',
  /** A usable document, but no usable name for it. */
  semNome: 'sem-nome',
} as const satisfies Record<string, string>;

export type MotivoSemIdentidadeAmazon =
  (typeof MOTIVO_SEM_IDENTIDADE_AMAZON)[keyof typeof MOTIVO_SEM_IDENTIDADE_AMAZON];

export type IdentidadeCompradorAmazon =
  | { readonly ok: true; readonly campos: ClienteResolveFields }
  | { readonly ok: false; readonly motivo: MotivoSemIdentidadeAmazon };

type RegistroFiscal = NonNullable<NonNullable<PedidoWireAmazon['tax']>['taxRegistrations']>[number];

function registroDe(order: PedidoWireAmazon, entidade: string): RegistroFiscal | null {
  return order.tax?.taxRegistrations?.find((r) => r.entityType === entidade) ?? null;
}

/** The buyer as `findOrCreateCliente` takes them, or why there is none (module header). */
export function identidadeCompradorAmazon(order: PedidoWireAmazon): IdentidadeCompradorAmazon {
  const registro = registroDe(order, ENTIDADE_FISCAL_AMAZON.comprador);
  const documento = cpfCnpjUtilizavel(registro?.taxRegistrationNumber);
  if (documento === null) return { ok: false, motivo: MOTIVO_SEM_IDENTIDADE_AMAZON.semDocumento };
  const ehCnpj = documento.length === 14;
  const nome = ehCnpj
    ? (nomeUtilizavel(registro?.legalName) ??
      nomeUtilizavel(order.buyer?.buyerCompanyName) ??
      nomeUtilizavel(order.buyer?.buyerName))
    : nomeUtilizavel(order.buyer?.buyerName);
  if (nome === null) return { ok: false, motivo: MOTIVO_SEM_IDENTIDADE_AMAZON.semNome };
  return {
    ok: true,
    campos: {
      tipo: ehCnpj ? TIPO_CLIENTE.pessoaJuridica : TIPO_CLIENTE.pessoaFisica,
      nome,
      cpf_cnpj: documento,
      idEstrangeiro: null,
      ie: null,
      telefone: null,
      email: null,
    },
  };
}

/** A wire text, or `null` when absent, blank or not a string ("absent" in every withheld form). */
function texto(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/** The raw endereço input and the recipient's name (the endereço's `nome`, never the cliente's). */
export interface EnderecoBrutoAmazon {
  readonly bruto: RawEnderecoInput;
  readonly nomeRecebedor: string | null;
}

/** `recipient.deliveryAddress` as the endereço builder takes it, or `null` when absent (module header). */
export function enderecoBrutoAmazon(order: PedidoWireAmazon): EnderecoBrutoAmazon | null {
  const endereco = order.recipient?.deliveryAddress;
  if (endereco == null) return null;
  const extras = endereco.extendedFields;
  return {
    bruto: {
      cepRaw: texto(endereco.postalCode),
      logradouro: texto(extras?.streetName) ?? texto(endereco.addressLine1),
      numero: texto(extras?.streetNumber),
      complemento: texto(extras?.complement),
      bairro: texto(extras?.neighborhood),
      cidade: texto(endereco.city),
      estadoRaw: texto(endereco.stateOrRegion),
      paisId: texto(endereco.countryCode),
    },
    nomeRecebedor: nomeUtilizavel(endereco.name),
  };
}

/** The intermediador check's verdict. */
export type VereditoIntermediadorAmazon = 'confere' | 'diverge' | 'sem-veredito';

/** The `MARKETPLACE` registration's number, or `null` (it disappears after shipping, by design). */
export function registroMarketplaceAmazon(order: PedidoWireAmazon): string | null {
  return texto(registroDe(order, ENTIDADE_FISCAL_AMAZON.marketplace)?.taxRegistrationNumber);
}

const RAIZ_CNPJ = /^[0-9A-Z]{8}$/;
const CNPJ_COMPLETO = /^[0-9A-Z]{12}[0-9]{2}$/;

/**
 * The marketplace's CNPJ on the order against the conta's `cpf_cnpj`,
 * ROOT-AWARE (plan §3 decision 19): an 8-character root on the wire ⇒ compared
 * with the conta's first 8; 14 ⇒ full equality; anything else, an absent
 * registration or an unusable conta document ⇒ no verdict. Absent is NEVER a
 * mismatch.
 */
export function intermediadorConfere(
  registroMarketplace: string | null,
  contaCpfCnpj: string | null,
): VereditoIntermediadorAmazon {
  if (registroMarketplace === null || contaCpfCnpj === null) return 'sem-veredito';
  const conta = normalizeDocumento(contaCpfCnpj);
  if (!CNPJ_COMPLETO.test(conta)) return 'sem-veredito';
  const wire = normalizeDocumento(registroMarketplace);
  if (RAIZ_CNPJ.test(wire)) return conta.slice(0, 8) === wire ? 'confere' : 'diverge';
  if (CNPJ_COMPLETO.test(wire)) return conta === wire ? 'confere' : 'diverge';
  return 'sem-veredito';
}
