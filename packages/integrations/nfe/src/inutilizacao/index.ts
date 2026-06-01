/**
 * Inutilização de numeração — `NfeInutilizacao4` (`<inutNFe>`).
 *
 * Burns a contiguous range of NF-e números that will never be used (e.g. a
 * gap left by NF-e pendentes de retorno that were never authorized).
 * Synchronous: SEFAZ replies `retInutNFe` with `infInut.cStat=102`
 * (homologado) + an `nProt`.
 *
 * The `<infInut>` body is built by the metadata-driven serializer
 * (`serializeFragment` over the generated `TInutNFe_infInut` META) — field
 * order, escaping and element shapes all come from the SEFAZ XSD, never
 * hand-written strings. Only the thin `<inutNFe>` wrapper is hand-assembled
 * (like the generator's `<NFe>` wrapper), since it's signed next and a signed
 * payload must never be re-serialized.
 * Mirrors Flutter `.old/lib/nfe/pages/inutNFe.dart` + `nfe_client`.
 */
import { sanitizeNFeText } from '../sanitize';
import type { TpAmb } from '../safety';
import { serializeFragment } from '../xml';

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

/**
 * Build the UNSIGNED `<inutNFe>`. Pass to `signInutilizacao` (signs
 * `<infInut>`), then straight to `nfeInutilizacao`.
 *
 * `infInut.Id` = `'ID' + cUF(2) + ano(2) + CNPJ(14) + mod(2) + serie(3) +
 * nNFIni(9) + nNFFin(9)` (53 chars). The Id pads serie/nNF; the element
 * values are the plain integers. The serializer emits the elements in the
 * exact XSD `xs:sequence` order (from the generated META) and handles escaping.
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

  const infInut = serializeFragment('TInutNFe_infInut', 'infInut', {
    Id: id,
    tpAmb: input.tpAmb,
    xServ: 'INUTILIZAR',
    cUF: input.cUF,
    ano: input.ano,
    CNPJ: input.cnpj,
    mod: '55',
    serie: String(input.serie),
    nNFIni: String(input.nNFIni),
    nNFFin: String(input.nNFFin),
    // Pass sanitized-but-unescaped text — the serializer escapes & < >.
    xJust: sanitizeNFeText(input.xJust) ?? '',
  });

  return `<inutNFe xmlns="${INUT_NS}" versao="${INUT_VERSAO}">${infInut}</inutNFe>`;
}
