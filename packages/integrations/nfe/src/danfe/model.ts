/**
 * `parseProcNFe` — turn an authorized **procNFe** XML (the
 * `pedidos/{id}/nfev4/{nfeId}.xml_nfe_proc` payload) into a flat, render-ready
 * `DanfeModel`. The DANFE is *rendered from this XML, never re-generated* — so
 * this module only reads.
 *
 * Parsing rides the same XSD-derived `parse`/`META` walker the generator and
 * eventos use (`../xml`), with `nfeProc` already a registered ROOT
 * (`TNfeProc = { NFe, protNFe }`). Values arrive as strings (leaf text), so no
 * numeric coercion happens here — money/qty/date formatting is the renderers'
 * job via `./format`.
 *
 * PR1 maps the groups the **simplificado** (PDF + ZPL) needs: ide header,
 * emitente, destinatário, totais (ICMSTot passthrough), dados adicionais and
 * the autorização protocolo. The full itens/transporte/duplicatas mapping for
 * the A4 retrato/paisagem layouts lands in PR2 and extends this same model.
 */
import { parse } from '../xml';
import type { TNfeProc, TNFe_infNFe, TNFe_infNFe_total_ICMSTot } from '../types/nfe-schema';
import { onlyDigits } from './format';

/** A structured address (raw values — the renderers format cep/fone). */
export interface DanfeEndereco {
  readonly logradouro: string;
  readonly numero: string;
  readonly complemento: string | null;
  readonly bairro: string;
  readonly municipio: string;
  readonly uf: string;
  /** Raw CEP digits (may be empty for a foreign address). */
  readonly cep: string;
  /** Raw phone digits, or null. */
  readonly fone: string | null;
}

export interface DanfeEmitente {
  readonly nome: string;
  /** Raw CNPJ digits, or null when the emitente is a CPF. */
  readonly cnpj: string | null;
  /** Raw CPF digits, or null when the emitente is a CNPJ. */
  readonly cpf: string | null;
  readonly ie: string;
  readonly endereco: DanfeEndereco;
}

export interface DanfeDestinatario {
  readonly nome: string;
  readonly cnpj: string | null;
  readonly cpf: string | null;
  /** Foreign buyer id (`idEstrangeiro`), when neither CNPJ nor CPF applies. */
  readonly idEstrangeiro: string | null;
  readonly ie: string | null;
  readonly endereco: DanfeEndereco | null;
}

export interface DanfeIde {
  readonly natOp: string;
  readonly nNF: string;
  readonly serie: string;
  /** ISO `dhEmi`. */
  readonly dhEmi: string;
  /** `0` = entrada, `1` = saída. */
  readonly tpNF: '0' | '1';
  readonly tpEmis: string;
}

/** The autorização protocolo (`protNFe.infProt`). */
export interface DanfeProtocolo {
  readonly nProt: string | null;
  /** ISO `dhRecbto`. */
  readonly dhRecbto: string;
  readonly tpAmb: '1' | '2';
}

export interface DanfeModel {
  /** 44-digit chave de acesso (no `NFe` prefix, no formatting). */
  readonly chave: string;
  /** `true` when `tpAmb === '2'` — drives the "SEM VALOR FISCAL" watermark. */
  readonly homologacao: boolean;
  readonly ide: DanfeIde;
  readonly emit: DanfeEmitente;
  readonly dest: DanfeDestinatario;
  /** ICMSTot passthrough (string values) — the renderers format what they show. */
  readonly total: TNFe_infNFe_total_ICMSTot;
  readonly infAdic: { readonly infCpl: string | null; readonly infAdFisco: string | null };
  /** Autorização protocolo, or null if the procNFe carries no protNFe. */
  readonly prot: DanfeProtocolo | null;
}

/** Shape shared by `TEnderEmi` and `TEndereco` — the fields the DANFE reads. */
interface RawEndereco {
  xLgr: string;
  nro: string;
  xCpl?: string;
  xBairro: string;
  xMun: string;
  UF: string;
  CEP?: string;
  fone?: string;
}

function mapEndereco(e: RawEndereco): DanfeEndereco {
  return {
    logradouro: e.xLgr,
    numero: e.nro,
    complemento: e.xCpl ?? null,
    bairro: e.xBairro,
    municipio: e.xMun,
    uf: e.UF,
    cep: e.CEP ?? '',
    fone: e.fone ?? null,
  };
}

function mapModel(infNFe: TNFe_infNFe, prot: DanfeProtocolo | null): DanfeModel {
  const { ide, emit, dest } = infNFe;
  return {
    chave: onlyDigits(infNFe.Id),
    homologacao: ide.tpAmb === '2',
    ide: {
      natOp: ide.natOp,
      nNF: ide.nNF,
      serie: ide.serie,
      dhEmi: ide.dhEmi,
      tpNF: ide.tpNF,
      tpEmis: ide.tpEmis,
    },
    emit: {
      nome: emit.xNome,
      cnpj: emit.CNPJ ?? null,
      cpf: emit.CPF ?? null,
      ie: emit.IE,
      endereco: mapEndereco(emit.enderEmit),
    },
    dest: {
      nome: dest?.xNome ?? '',
      cnpj: dest?.CNPJ ?? null,
      cpf: dest?.CPF ?? null,
      idEstrangeiro: dest?.idEstrangeiro ?? null,
      ie: dest?.IE ?? null,
      endereco: dest?.enderDest ? mapEndereco(dest.enderDest) : null,
    },
    total: infNFe.total.ICMSTot,
    infAdic: {
      infCpl: infNFe.infAdic?.infCpl ?? null,
      infAdFisco: infNFe.infAdic?.infAdFisco ?? null,
    },
    prot,
  };
}

/**
 * Parse a full **procNFe** XML (`<nfeProc>` with `<NFe>` + `<protNFe>`) into a
 * `DanfeModel`. Throws `NFeXmlError` if the root isn't `nfeProc`.
 */
export function parseProcNFe(xml: string): DanfeModel {
  const proc = parse<TNfeProc>('nfeProc', xml);
  const infProt = proc.protNFe?.infProt;
  const prot: DanfeProtocolo | null = infProt
    ? { nProt: infProt.nProt ?? null, dhRecbto: infProt.dhRecbto, tpAmb: infProt.tpAmb }
    : null;
  return mapModel(proc.NFe.infNFe, prot);
}
