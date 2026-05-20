/**
 * `infNFe.emit` (from Filial) and `infNFe.dest` (from Cliente + Endereco).
 *
 * Sanitisation is owned here — callers hand raw domain strings; the generator
 * is the SEFAZ-safety boundary. Homologação override of `dest.xNome` lives
 * here too (see `.claude/skills/nfe/references/homologacao.md`).
 */
import type { Cliente, Endereco, Filial } from '@delfrance/schemas';

import { sanitizeNFeText } from '../sanitize';
import type {
  TEnderEmi,
  TEndereco,
  TNFe_infNFe_dest,
  TNFe_infNFe_emit,
} from '../types/nfe-schema';
import type { Ambiente } from './types';

export const HOMOLOGACAO_XNOME =
  'NF-E EMITIDA EM AMBIENTE DE HOMOLOGACAO - SEM VALOR FISCAL';

/** CRT default — Phase A assumes Regime Normal until a per-Filial field lands. */
const DEFAULT_CRT: TNFe_infNFe_emit['CRT'] = '3';

export class NFePartiesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFePartiesError';
  }
}

export function buildEmit(filial: Filial): TNFe_infNFe_emit {
  if (!filial.cnpj) throw new NFePartiesError('filial.cnpj is required');
  if (!filial.razaoSocial) throw new NFePartiesError('filial.razaoSocial is required');

  const enderEmit: TEnderEmi = {
    xLgr: requireSanitized('filial.sede.logradouro', filial.sede.logradouro),
    nro: filial.sede.numero,
    xCpl: sanitizeNFeText(filial.sede.complemento) ?? undefined,
    xBairro: requireSanitized('filial.sede.bairro', filial.sede.bairro),
    cMun: requireField('filial.sede.codigoMunicipio', filial.sede.codigoMunicipio),
    xMun: requireSanitized('filial.sede.cidade', filial.sede.cidade),
    UF: filial.sede.estado as TEnderEmi['UF'],
    CEP: filial.sede.cep,
    cPais: '1058',
    xPais: 'BRASIL',
  };

  return {
    CNPJ: filial.cnpj,
    xNome: requireSanitized('filial.razaoSocial', filial.razaoSocial),
    xFant: sanitizeNFeText(filial.fantasia) ?? undefined,
    enderEmit,
    IE: filial.ie,
    IEST: filial.iest ?? undefined,
    IM: filial.imun ?? undefined,
    CNAE: filial.cnae ?? undefined,
    CRT: DEFAULT_CRT,
  };
}

export function buildDest(
  cliente: Cliente,
  endereco: Endereco,
  ambiente: Ambiente,
): TNFe_infNFe_dest {
  const xNomeReal = sanitizeNFeText(cliente.nome) ?? '';
  const xNome = ambiente === 'homologacao' ? HOMOLOGACAO_XNOME : xNomeReal;

  // `indIEDest` — `'9'` Não Contribuinte when cliente.ie is null,
  // `'1'` Contribuinte ICMS otherwise. `'2'` Isento is Phase D.
  const indIEDest: TNFe_infNFe_dest['indIEDest'] = cliente.ie ? '1' : '9';

  const dest: TNFe_infNFe_dest = {
    xNome: xNome.length > 0 ? xNome : undefined,
    indIEDest,
    enderDest: buildEnderDest(endereco),
    IE: cliente.ie ?? undefined,
    IM: cliente.imun ?? undefined,
    email: sanitizeNFeText(cliente.email) ?? undefined,
  };

  // tipoCliente '0' = PF (CPF), '1' = PJ (CNPJ), '2' = Estrangeiro (idEstrangeiro)
  if (cliente.tipo === '1' && cliente.cpf_cnpj) {
    return { ...dest, CNPJ: cliente.cpf_cnpj };
  }
  if (cliente.tipo === '0' && cliente.cpf_cnpj) {
    return { ...dest, CPF: cliente.cpf_cnpj };
  }
  if (cliente.tipo === '2') {
    if (!cliente.idEstrangeiro) {
      throw new NFePartiesError(
        'cliente.tipo=2 (Estrangeiro) requires idEstrangeiro',
      );
    }
    return { ...dest, idEstrangeiro: cliente.idEstrangeiro };
  }
  throw new NFePartiesError(
    `cliente.tipo='${cliente.tipo}' missing cpf_cnpj / idEstrangeiro`,
  );
}

function buildEnderDest(endereco: Endereco): TEndereco {
  return {
    xLgr: requireSanitized('endereco.logradouro', endereco.logradouro),
    nro: endereco.numero,
    xCpl: sanitizeNFeText(endereco.complemento) ?? undefined,
    xBairro: requireSanitized('endereco.bairro', endereco.bairro),
    cMun: requireField('endereco.codigoMunicipio', endereco.codigoMunicipio),
    xMun: requireSanitized('endereco.cidade', endereco.cidade),
    UF: endereco.estado as TEndereco['UF'],
    CEP: endereco.cep,
    cPais: endereco.cPais ?? '1058',
    xPais: sanitizeNFeText(endereco.pais) ?? 'BRASIL',
  };
}

function requireField<T>(name: string, value: T | null | undefined): NonNullable<T> {
  if (value == null) throw new NFePartiesError(`${name} is required`);
  return value as NonNullable<T>;
}

function requireSanitized(name: string, value: string | null | undefined): string {
  const cleaned = sanitizeNFeText(value);
  if (!cleaned) throw new NFePartiesError(`${name} is required (got blank after sanitize)`);
  return cleaned;
}
