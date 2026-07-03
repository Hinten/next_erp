/**
 * `infNFe.ide` group — the SEFAZ identification block.
 *
 * Maps the generator input + computed chave parts to a `TNFe_infNFe_ide`
 * value the XML serializer can emit. See
 * `.claude/skills/nfe/references/leiaute.md` for field-by-field meaning.
 */
import type { UF } from '@delfrance/schemas';

import type { TNFe_infNFe_ide } from '../types/nfe-schema';
import { sanitizeNFeText } from '../sanitize';
import type { Ambiente, GeneratorInput } from './types';

/** UF letter → IBGE 2-digit code. */
export const UF_TO_IBGE: Record<UF, string> = {
  AC: '12',
  AL: '27',
  AM: '13',
  AP: '16',
  BA: '29',
  CE: '23',
  DF: '53',
  ES: '32',
  GO: '52',
  MA: '21',
  MG: '31',
  MS: '50',
  MT: '51',
  PA: '15',
  PB: '25',
  PE: '26',
  PI: '22',
  PR: '41',
  RJ: '33',
  RN: '24',
  RO: '11',
  RR: '14',
  RS: '43',
  SC: '42',
  SE: '28',
  SP: '35',
  TO: '17',
  EX: '99',
};

export class NFeIdeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeIdeError';
  }
}

/** Resolve a UF (e.g. `'SP'`) to its 2-digit IBGE cUF code (`'35'`). */
export function cUFFromUF(uf: UF): string {
  const code = UF_TO_IBGE[uf];
  if (!code) throw new NFeIdeError(`No IBGE code for UF '${uf}'`);
  return code;
}

/**
 * Format a Date as the SEFAZ `dhEmi` lexical: ISO 8601 with local offset, e.g.
 * `2026-05-20T10:30:00-03:00`. Brazil has no DST since 2019, so the offset
 * derives from `getTimezoneOffset()` directly.
 */
export function formatDhEmi(dhEmi: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const yyyy = dhEmi.getFullYear();
  const mm = pad(dhEmi.getMonth() + 1);
  const dd = pad(dhEmi.getDate());
  const hh = pad(dhEmi.getHours());
  const min = pad(dhEmi.getMinutes());
  const ss = pad(dhEmi.getSeconds());
  const tz = dhEmi.getTimezoneOffset();
  const tzSign = tz <= 0 ? '+' : '-';
  const tzAbs = Math.abs(tz);
  const tzh = pad(Math.floor(tzAbs / 60));
  const tzm = pad(tzAbs % 60);
  return `${yyyy}-${mm}-${dd}T${hh}:${min}:${ss}${tzSign}${tzh}:${tzm}`;
}

/** `procEmi` value identifying our tooling. */
const PROC_EMI = '0';
// SEFAZ caps verProc at maxLength=20. Keep it short so future minor/patch
// bumps stay within budget.
const VER_PROC = 'erp-next 0.0.0';

interface IdeParts {
  readonly cNF: string;
  readonly cDV: string;
  readonly tpEmis: string;
  readonly ambiente: Ambiente;
}

export function buildIde(input: GeneratorInput, parts: IdeParts): TNFe_infNFe_ide {
  const filialUF = input.filial.sede.estado;
  const destUF = input.enderecoDest.estado;
  if (!input.filial.sede.codigoMunicipio) {
    throw new NFeIdeError('filial.sede.codigoMunicipio (IBGE) is required for cMunFG');
  }
  const cUF = cUFFromUF(filialUF) as TNFe_infNFe_ide['cUF'];

  const idDest: TNFe_infNFe_ide['idDest'] = input.operacao.ehExterior
    ? '3'
    : destUF === filialUF
      ? '1'
      : '2';

  const tpAmb: TNFe_infNFe_ide['tpAmb'] = parts.ambiente === 'producao' ? '1' : '2';
  const finNFe = (input.operacao.finNFe ?? 1).toString() as TNFe_infNFe_ide['finNFe'];

  // NFref (BA) — referenced NF-es (devolução finNFe=4 / complementar finNFe=2).
  // Each must be a 44-digit chave; a malformed one is an upstream data error we
  // surface here rather than letting SEFAZ reject the whole lote (rejection 269).
  const nfRefs = (input.chNFeReferenciadas ?? []).filter((c): c is string => !!c);
  for (const chave of nfRefs) {
    if (!/^\d{44}$/.test(chave)) {
      throw new NFeIdeError(`chNFeReferenciada inválida (esperado 44 dígitos): '${chave}'`);
    }
  }

  return {
    cUF,
    cNF: parts.cNF,
    natOp: sanitizeNFeText(input.operacao.naturezaDaOperacao) ?? '',
    mod: '55',
    serie: input.serie.toString(),
    nNF: input.numeracao.toString(),
    dhEmi: formatDhEmi(input.dhEmi),
    tpNF: input.operacao.tipo === 1 ? '1' : '0',
    idDest,
    cMunFG: input.filial.sede.codigoMunicipio,
    tpImp: '1',
    tpEmis: parts.tpEmis as TNFe_infNFe_ide['tpEmis'],
    cDV: parts.cDV,
    tpAmb,
    finNFe,
    indFinal: input.operacao.ehConsumidorFinal ? '1' : '0',
    indPres: input.operacao.indPres,
    indIntermed: input.operacao.indIntermed,
    procEmi: PROC_EMI as TNFe_infNFe_ide['procEmi'],
    verProc: VER_PROC,
    // BA — referenced NF-es (empty ⇒ omit; META serializer places it last in ide).
    ...(nfRefs.length > 0 ? { NFref: nfRefs.map((refNFe) => ({ refNFe })) } : {}),
    // B28/B29 — only emitted in contingency. validateInput already enforced
    // presence/length (so the sanitized value can't be null here), and the
    // bare spread keeps the normal-emission ide byte-identical to
    // pre-contingency builds.
    ...(parts.tpEmis !== '1' && input.dhCont && input.xJust
      ? { dhCont: formatDhEmi(input.dhCont), xJust: sanitizeNFeText(input.xJust) ?? '' }
      : {}),
  };
}
