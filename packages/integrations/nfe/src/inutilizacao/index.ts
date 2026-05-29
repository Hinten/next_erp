/**
 * Inutilização de numeração — `NfeInutilizacao4` (`<inutNFe>`).
 *
 * Burns a contiguous range of NF-e números that will never be used (e.g. a
 * gap left by NF-e pendentes de retorno that were never authorized).
 * Synchronous: SEFAZ replies `retInutNFe` with `infInut.cStat=102`
 * (homologado) + an `nProt`.
 *
 * The `<infInut>` is hand-built (then signed) so the element order matches
 * the XSD `xs:sequence` byte-for-byte and the signed payload is never
 * re-serialized — same rule as the generator / eventos.
 * Mirrors Flutter `.old/lib/nfe/pages/inutNFe.dart` + `nfe_client`.
 */
import { sanitizeNFeText } from '../sanitize';
import type { TpAmb } from '../safety';

const INUT_NS = 'http://www.portalfiscal.inf.br/nfe';
const INUT_VERSAO = '4.00';

export class NFeInutilizacaoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeInutilizacaoError';
  }
}

export interface InutilizacaoInput {
  /** Órgão / autorizadora UF (IBGE cUF 2-digit). */
  readonly cUF: string;
  /** Year as 2 digits (e.g. `'26'` for 2026). */
  readonly ano: string;
  /** Emitter CNPJ (14 digits). */
  readonly cnpj: string;
  readonly serie: number;
  readonly nNFIni: number;
  readonly nNFFin: number;
  /** Justification — SEFAZ requires 15–255 chars (validated upstream). */
  readonly xJust: string;
  readonly tpAmb: TpAmb;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Build the UNSIGNED `<inutNFe>`. Pass to `signInutilizacao` (signs
 * `<infInut>`), then straight to `nfeInutilizacao`.
 *
 * `infInut.Id` = `'ID' + cUF(2) + ano(2) + CNPJ(14) + mod(2) + serie(3) +
 * nNFIni(9) + nNFFin(9)` (53 chars). The Id pads serie/nNF; the element
 * values are the plain integers.
 */
export function buildInutNFe(input: InutilizacaoInput): string {
  if (input.nNFIni > input.nNFFin) {
    throw new NFeInutilizacaoError(
      `nNFIni (${input.nNFIni}) must be ≤ nNFFin (${input.nNFFin})`,
    );
  }
  const seriePad = String(input.serie).padStart(3, '0');
  const iniPad = String(input.nNFIni).padStart(9, '0');
  const finPad = String(input.nNFFin).padStart(9, '0');
  const id = `ID${input.cUF}${input.ano}${input.cnpj}55${seriePad}${iniPad}${finPad}`;
  const xJust = xmlEscape(sanitizeNFeText(input.xJust) ?? '');

  const infInut =
    `<infInut Id="${id}">` +
    `<tpAmb>${input.tpAmb}</tpAmb>` +
    `<xServ>INUTILIZAR</xServ>` +
    `<cUF>${input.cUF}</cUF>` +
    `<ano>${input.ano}</ano>` +
    `<CNPJ>${input.cnpj}</CNPJ>` +
    `<mod>55</mod>` +
    `<serie>${input.serie}</serie>` +
    `<nNFIni>${input.nNFIni}</nNFIni>` +
    `<nNFFin>${input.nNFFin}</nNFFin>` +
    `<xJust>${xJust}</xJust>` +
    `</infInut>`;

  return `<inutNFe xmlns="${INUT_NS}" versao="${INUT_VERSAO}">${infInut}</inutNFe>`;
}
