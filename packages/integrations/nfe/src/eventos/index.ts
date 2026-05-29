/**
 * NF-e evento builder — `RecepcaoEvento4` lote (`<envEvento>`).
 *
 * Phase B implements **cancelamento** (`tpEvento=110111`); the same module
 * is the home for CC-e (110110) and other events later, since they differ
 * only in the `<detEvento>` payload + `nSeqEvento`.
 *
 * The `<infEvento>` is hand-built (not via `serialize`) for two reasons:
 *   1. the codegen models `detEvento` as opaque (`[k: string]: never`) —
 *      its content is a per-event substitution the XSD can't type;
 *   2. once signed, the `<evento>` is a byte stream that must NOT be
 *      re-serialized (any whitespace change breaks the digest), same rule
 *      as `autorizarLote` / `buildNFeProc`.
 *
 * Mirrors Flutter `nfe_client/lib/src/schemas/envEventoCancNFe.dart`.
 */
import { formatDhEmi } from '../generator/ide';
import { sanitizeNFeText } from '../sanitize';
import type { TpAmb } from '../safety';

const EVENTO_NS = 'http://www.portalfiscal.inf.br/nfe';
const EVENTO_VERSAO = '1.00';
export const TP_EVENTO_CANCELAMENTO = '110111';

export class NFeEventoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NFeEventoError';
  }
}

export interface CancelamentoEventoInput {
  /** 44-digit chave de acesso of the authorized NF-e. */
  readonly chNFe: string;
  /** Órgão (IBGE cUF 2-digit) — the autorizadora UF. */
  readonly cOrgao: string;
  readonly tpAmb: TpAmb;
  /** Emitter CNPJ (14 digits). */
  readonly cnpj: string;
  /** Authorization protocol from the original emission (`protNFe.infProt.nProt`). */
  readonly nProt: string;
  /** Justification — SEFAZ requires 15–255 chars (validated upstream). */
  readonly xJust: string;
  /** Sequence — always 1 for cancelamento (an NF-e is cancelled once). */
  readonly nSeqEvento?: number;
  /** Event timestamp — defaults to now (issuer-local with offset). */
  readonly dhEvento?: Date;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripXmlDeclaration(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
}

/**
 * Build the UNSIGNED `<evento>` for a cancelamento. Pass the result to
 * `signEvento` (signs `<infEvento>`, dropping `<Signature>` after it),
 * then to `buildEnvEvento`.
 *
 * `infEvento.Id` = `'ID' + tpEvento(6) + chNFe(44) + nSeqEvento(2)`.
 */
export function buildCancelamentoEvento(input: CancelamentoEventoInput): string {
  if (input.chNFe.length !== 44) {
    throw new NFeEventoError(`chNFe must be 44 digits, got ${input.chNFe.length}`);
  }
  const nSeq = input.nSeqEvento ?? 1;
  const id = `ID${TP_EVENTO_CANCELAMENTO}${input.chNFe}${String(nSeq).padStart(2, '0')}`;
  const dh = formatDhEmi(input.dhEvento ?? new Date());
  const xJust = xmlEscape(sanitizeNFeText(input.xJust) ?? '');

  const detEvento =
    `<detEvento versao="${EVENTO_VERSAO}">` +
    `<descEvento>Cancelamento</descEvento>` +
    `<nProt>${input.nProt}</nProt>` +
    `<xJust>${xJust}</xJust>` +
    `</detEvento>`;

  const infEvento =
    `<infEvento Id="${id}">` +
    `<cOrgao>${input.cOrgao}</cOrgao>` +
    `<tpAmb>${input.tpAmb}</tpAmb>` +
    `<CNPJ>${input.cnpj}</CNPJ>` +
    `<chNFe>${input.chNFe}</chNFe>` +
    `<dhEvento>${dh}</dhEvento>` +
    `<tpEvento>${TP_EVENTO_CANCELAMENTO}</tpEvento>` +
    `<nSeqEvento>${nSeq}</nSeqEvento>` +
    `<verEvento>${EVENTO_VERSAO}</verEvento>` +
    detEvento +
    `</infEvento>`;

  return `<evento xmlns="${EVENTO_NS}" versao="${EVENTO_VERSAO}">${infEvento}</evento>`;
}

/**
 * Wrap a signed `<evento>` in the `<envEvento>` lote sent to SEFAZ.
 * Hand-built by concatenation — the signed evento is an opaque byte
 * stream. Cancelamento lotes always carry a single evento.
 */
export function buildEnvEvento(signedEventoXml: string, idLote = '1'): string {
  const evento = stripXmlDeclaration(signedEventoXml).trim();
  return (
    `<envEvento xmlns="${EVENTO_NS}" versao="${EVENTO_VERSAO}">` +
    `<idLote>${idLote}</idLote>` +
    evento +
    `</envEvento>`
  );
}

const RE_RET_EVENTO = /<retEvento\b[\s\S]*?<\/retEvento>/i;

/**
 * Build the archival `<procEventoNFe>` (the authorized event document):
 * the signed `<evento>` we sent + SEFAZ's `<retEvento>`. The `retEvento`
 * is extracted verbatim from the raw response so SEFAZ's own signature on
 * it is preserved (never re-serialized). Returns null when the response
 * has no `<retEvento>` (a lote-level rejection). Mirrors `buildNFeProc`.
 */
export function buildProcEventoNFe(
  signedEventoXml: string,
  rawRetEnvEventoXml: string,
  versao: string = EVENTO_VERSAO,
): string | null {
  const m = RE_RET_EVENTO.exec(rawRetEnvEventoXml);
  if (!m) return null;
  const evento = stripXmlDeclaration(signedEventoXml).trim();
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<procEventoNFe xmlns="${EVENTO_NS}" versao="${versao}">${evento}${m[0]}</procEventoNFe>`
  );
}
