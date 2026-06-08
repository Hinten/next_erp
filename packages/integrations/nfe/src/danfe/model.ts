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
 * The model maps every group the simplificado (PDF + ZPL) and the A4
 * retrato/paisagem layouts need: ide header, emitente, destinatário, totais,
 * itens (with the per-item ICMS/IPI extraction the old Flutter `getCST` /
 * `getVICMS` / … helpers did), transporte, duplicatas/fatura, ISSQN,
 * entrega/retirada and the autorização protocolo.
 */
import { parse } from '../xml';
import type {
  TNfeProc,
  TNFe_infNFe,
  TNFe_infNFe_det,
  TNFe_infNFe_transp,
  TNFe_infNFe_total_ICMSTot,
  TNFe_infNFe_total_ISSQNtot,
} from '../types/nfe-schema';
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
  /** Inscrição estadual do substituto tributário. */
  readonly iest: string | null;
  /** Inscrição municipal (ISSQN). */
  readonly im: string | null;
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

/** A local de entrega / retirada (`TLocal` — address fields are inline). */
export interface DanfeLocal {
  readonly nome: string | null;
  readonly cnpj: string | null;
  readonly cpf: string | null;
  readonly ie: string | null;
  readonly endereco: DanfeEndereco;
}

export interface DanfeIde {
  readonly natOp: string;
  readonly nNF: string;
  readonly serie: string;
  /** ISO `dhEmi`. */
  readonly dhEmi: string;
  /** ISO `dhSaiEnt` (data/hora de saída ou entrada), or null. */
  readonly dhSaiEnt: string | null;
  /** `0` = entrada, `1` = saída. */
  readonly tpNF: '0' | '1';
  readonly tpEmis: string;
  /** Referenced NF-e chaves (`ide.NFref[].refNFe`) — shown in infCpl. */
  readonly refNFes: ReadonlyArray<string>;
}

/** One item row (det → prod + the extracted ICMS/IPI columns). */
export interface DanfeItem {
  readonly cProd: string;
  /** GTIN/EAN or 'SEM GTIN'. */
  readonly cEAN: string;
  readonly xProd: string;
  readonly ncm: string;
  readonly cfop: string;
  /** CST (Regime Normal) or CSOSN (Simples Nacional). */
  readonly cstCsosn: string;
  readonly uCom: string;
  readonly qCom: string;
  readonly vUnCom: string;
  readonly vDesc: string;
  readonly vProd: string;
  readonly vBcIcms: string;
  readonly vIcms: string;
  readonly pIcms: string;
  readonly vIpi: string;
  readonly pIpi: string;
}

export interface DanfeVolume {
  readonly qVol: string | null;
  readonly esp: string | null;
  readonly marca: string | null;
  readonly nVol: string | null;
  readonly pesoL: string | null;
  readonly pesoB: string | null;
}

export interface DanfeTransporte {
  readonly modFrete: string;
  readonly transportadorNome: string | null;
  readonly transportadorDoc: string | null;
  readonly transportadorIe: string | null;
  readonly transportadorEndereco: string | null;
  readonly transportadorMunicipio: string | null;
  readonly transportadorUf: string | null;
  readonly veicPlaca: string | null;
  readonly veicUf: string | null;
  readonly veicRntc: string | null;
  readonly volumes: ReadonlyArray<DanfeVolume>;
}

export interface DanfeDuplicata {
  readonly nDup: string | null;
  /** ISO `dVenc`, or null. */
  readonly dVenc: string | null;
  readonly vDup: string;
}

export interface DanfeFatura {
  readonly nFat: string | null;
  readonly vOrig: string | null;
  readonly vDesc: string | null;
  readonly vLiq: string | null;
}

export interface DanfeIssqn {
  readonly vServ: string;
  readonly vBC: string;
  readonly vISS: string;
}

/** The autorização protocolo (`protNFe.infProt`). */
export interface DanfeProtocolo {
  readonly nProt: string | null;
  /** ISO `dhRecbto`. */
  readonly dhRecbto: string;
  readonly tpAmb: '1' | '2';
  readonly cStat: string;
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
  readonly itens: ReadonlyArray<DanfeItem>;
  readonly transp: DanfeTransporte;
  readonly fat: DanfeFatura | null;
  readonly dup: ReadonlyArray<DanfeDuplicata>;
  readonly issqn: DanfeIssqn | null;
  readonly entrega: DanfeLocal | null;
  readonly retirada: DanfeLocal | null;
  readonly infAdic: { readonly infCpl: string | null; readonly infAdFisco: string | null };
  /** Autorização protocolo, or null if the procNFe carries no protNFe. */
  readonly prot: DanfeProtocolo | null;
}

/** Shape shared by `TEnderEmi`, `TEndereco` and `TLocal` — the DANFE fields. */
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

// ---------------------------------------------------------------------------
// Per-item ICMS / IPI extraction (ports getCST / getVBCIcms / getVICMS /
// getPICMS / getVIPI / getPIPI from the legacy `base.dart`). The ICMS group is
// a choice: exactly one of ICMS00…ICMS90 / ICMSPart / ICMSST / ICMSSN101…900 is
// present. Rather than enumerate every variant, read the present one and pull
// the value via a fallback chain (CST→CSOSN, vBC→vBCST→…), which reproduces the
// old per-variant switch including the Simples Nacional `'0'` fallbacks.
// ---------------------------------------------------------------------------
type IcmsLeaf = Record<string, string | undefined>;

function presentIcms(imposto: TNFe_infNFe_det['imposto']): IcmsLeaf | undefined {
  const icms = imposto.ICMS as Record<string, unknown> | undefined;
  if (!icms) return undefined;
  for (const value of Object.values(icms)) {
    if (value && typeof value === 'object') return value as IcmsLeaf;
  }
  return undefined;
}

function pick(leaf: IcmsLeaf | undefined, keys: string[], fallback: string): string {
  if (!leaf) return fallback;
  for (const k of keys) {
    const v = leaf[k];
    if (v != null && v !== '') return v;
  }
  return fallback;
}

function mapItem(det: TNFe_infNFe_det): DanfeItem {
  const { prod, imposto } = det;
  const icms = presentIcms(imposto);
  const ipiTrib = imposto.IPI?.IPITrib;
  return {
    cProd: prod.cProd,
    cEAN: prod.cEAN,
    xProd: prod.xProd,
    ncm: prod.NCM,
    cfop: prod.CFOP,
    cstCsosn: pick(icms, ['CST', 'CSOSN'], ''),
    uCom: prod.uCom,
    qCom: prod.qCom,
    vUnCom: prod.vUnCom,
    vDesc: prod.vDesc ?? '0',
    vProd: prod.vProd,
    vBcIcms: pick(icms, ['vBC', 'vBCST', 'vBCSTRet', 'vBCEfet'], '0'),
    vIcms: pick(icms, ['vICMS', 'vICMSST', 'vICMSSTRet', 'vICMSEfet'], '0'),
    pIcms: pick(icms, ['pICMS', 'pICMSST', 'pICMSEfet'], '0'),
    vIpi: ipiTrib?.vIPI ?? '0',
    pIpi: ipiTrib?.pIPI ?? '0',
  };
}

function mapTransporte(t: TNFe_infNFe_transp | undefined): DanfeTransporte {
  const tr = t?.transporta;
  const veic = t?.veicTransp;
  return {
    modFrete: t?.modFrete ?? '9',
    transportadorNome: tr?.xNome ?? null,
    transportadorDoc: tr?.CNPJ ?? tr?.CPF ?? null,
    transportadorIe: tr?.IE ?? null,
    transportadorEndereco: tr?.xEnder ?? null,
    transportadorMunicipio: tr?.xMun ?? null,
    transportadorUf: tr?.UF ?? null,
    veicPlaca: veic?.placa ?? null,
    veicUf: veic?.UF ?? null,
    veicRntc: veic?.RNTC ?? null,
    volumes: (t?.vol ?? []).map((v) => ({
      qVol: v.qVol ?? null,
      esp: v.esp ?? null,
      marca: v.marca ?? null,
      nVol: v.nVol ?? null,
      pesoL: v.pesoL ?? null,
      pesoB: v.pesoB ?? null,
    })),
  };
}

function mapLocal(l: RawEndereco & { xNome?: string; CNPJ?: string; CPF?: string; IE?: string }): DanfeLocal {
  return {
    nome: l.xNome ?? null,
    cnpj: l.CNPJ ?? null,
    cpf: l.CPF ?? null,
    ie: l.IE ?? null,
    endereco: mapEndereco(l),
  };
}

function mapIssqn(t: TNFe_infNFe_total_ISSQNtot | undefined): DanfeIssqn | null {
  if (!t) return null;
  return { vServ: t.vServ ?? '0', vBC: t.vBC ?? '0', vISS: t.vISS ?? '0' };
}

function mapModel(infNFe: TNFe_infNFe, prot: DanfeProtocolo | null): DanfeModel {
  const { ide, emit, dest, cobr } = infNFe;
  return {
    chave: onlyDigits(infNFe.Id),
    homologacao: ide.tpAmb === '2',
    ide: {
      natOp: ide.natOp,
      nNF: ide.nNF,
      serie: ide.serie,
      dhEmi: ide.dhEmi,
      dhSaiEnt: ide.dhSaiEnt ?? null,
      tpNF: ide.tpNF,
      tpEmis: ide.tpEmis,
      refNFes: (ide.NFref ?? [])
        .map((r) => r.refNFe)
        .filter((c): c is string => Boolean(c)),
    },
    emit: {
      nome: emit.xNome,
      cnpj: emit.CNPJ ?? null,
      cpf: emit.CPF ?? null,
      ie: emit.IE,
      iest: emit.IEST ?? null,
      im: emit.IM ?? null,
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
    itens: (infNFe.det ?? []).map(mapItem),
    transp: mapTransporte(infNFe.transp),
    fat: cobr?.fat
      ? {
          nFat: cobr.fat.nFat ?? null,
          vOrig: cobr.fat.vOrig ?? null,
          vDesc: cobr.fat.vDesc ?? null,
          vLiq: cobr.fat.vLiq ?? null,
        }
      : null,
    dup: (cobr?.dup ?? []).map((d) => ({
      nDup: d.nDup ?? null,
      dVenc: d.dVenc ?? null,
      vDup: d.vDup,
    })),
    issqn: mapIssqn(infNFe.total.ISSQNtot),
    entrega: infNFe.entrega ? mapLocal(infNFe.entrega) : null,
    retirada: infNFe.retirada ? mapLocal(infNFe.retirada) : null,
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
    ? {
        nProt: infProt.nProt ?? null,
        dhRecbto: infProt.dhRecbto,
        tpAmb: infProt.tpAmb,
        cStat: infProt.cStat,
      }
    : null;
  return mapModel(proc.NFe.infNFe, prot);
}
