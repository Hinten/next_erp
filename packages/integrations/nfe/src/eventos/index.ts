/**
 * NF-e evento builder — `RecepcaoEvento4` lote (`<envEvento>`).
 *
 * Phase B implements **cancelamento** (`tpEvento=110111`); the same module
 * is the home for CC-e (110110) and other events later, since they differ
 * only in the `<detEvento>` payload + `nSeqEvento`.
 *
 * `<infEvento>` and its `<detEvento>` are built by the metadata-driven
 * serializer (`serializeFragment` over the generated `TEvento_infEvento` +
 * `detEvento` META) — field order + escaping come from the SEFAZ XSDs, not
 * hand-written strings. `detEvento` rides through `infEvento` as a `#raw`
 * slot (the generic event leiaute declares it `xs:any`; its real shape is the
 * tpEvento-specific `e110111` schema, which the codegen now types). Only the
 * thin `<evento>` wrapper + the post-signing `<envEvento>` / `<procEventoNFe>`
 * are hand-assembled — the latter wrap an already-signed byte stream that
 * must NOT be re-serialized (any change breaks the digest), the same rule
 * `autorizarLote` / `buildNFeProc` follow.
 *
 * Mirrors Flutter `nfe_client/lib/src/schemas/envEventoCancNFe.dart`.
 */
import { formatDhEmi } from '../generator/ide';
import { sanitizeNFeText } from '../sanitize';
import type { TpAmb } from '../safety';
import { serializeFragment } from '../xml';

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
  /**
   * Justification — SEFAZ requires 15–255 chars. The API route validates the
   * length AFTER `sanitizeNFeText` (which can shorten it), so the sanitized
   * `<xJust>` emitted below is guaranteed ≥ 15.
   */
  readonly xJust: string;
  /** Sequence — always 1 for cancelamento (an NF-e is cancelled once). */
  readonly nSeqEvento?: number;
  /** Event timestamp — defaults to now (issuer-local with offset). */
  readonly dhEvento?: Date;
}

function stripXmlDeclaration(xml: string): string {
  return xml.replace(/^\s*<\?xml[^?]*\?>\s*/, '');
}

/**
 * Build the `<detEvento>` for a cancelamento, serialized from the generated
 * `detEvento_e110111` META (the tpEvento-specific `e110111` schema). Exposed so
 * the operation layer can `validateXsd('detEvento', …)` it before send — the
 * generic envelope's `xs:any` never checks detEvento's inner structure.
 */
export function buildCancelamentoDetEvento(input: {
  readonly nProt: string;
  readonly xJust: string;
}): string {
  return serializeFragment('detEvento_e110111', 'detEvento', {
    versao: EVENTO_VERSAO,
    descEvento: 'Cancelamento',
    nProt: input.nProt,
    // Sanitized-but-unescaped — the serializer escapes & < >.
    xJust: sanitizeNFeText(input.xJust) ?? '',
  });
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

  const infEvento = serializeFragment('TEvento_infEvento', 'infEvento', {
    Id: id,
    cOrgao: input.cOrgao,
    tpAmb: input.tpAmb,
    CNPJ: input.cnpj,
    chNFe: input.chNFe,
    dhEvento: formatDhEmi(input.dhEvento ?? new Date()),
    tpEvento: TP_EVENTO_CANCELAMENTO,
    nSeqEvento: String(nSeq),
    verEvento: EVENTO_VERSAO,
    // `detEvento` is a #raw slot — injected verbatim in sequence order.
    detEvento: buildCancelamentoDetEvento(input),
  });

  return `<evento xmlns="${EVENTO_NS}" versao="${EVENTO_VERSAO}">${infEvento}</evento>`;
}

// ---------------------------------------------------------------------------
// Carta de Correção Eletrônica (CC-e) — tpEvento 110110
// ---------------------------------------------------------------------------
export const TP_EVENTO_CCE = '110110';

/**
 * Fixed `<xCondUso>` legal text for a CC-e. Must match the e110110 detEvento
 * XSD enumeration **exactly** (the accented variant) — SEFAZ rejects any
 * deviation. Contains no `& < >`, so it is emitted verbatim (no escaping).
 */
export const XCONDUSO_CCE =
  'A Carta de Correção é disciplinada pelo § 1º-A do art. 7º do Convênio S/N, de 15 de ' +
  'dezembro de 1970 e pode ser utilizada para regularização de erro ocorrido na emissão de ' +
  'documento fiscal, desde que o erro não esteja relacionado com: I - as variáveis que ' +
  'determinam o valor do imposto tais como: base de cálculo, alíquota, diferença de preço, ' +
  'quantidade, valor da operação ou da prestação; II - a correção de dados cadastrais que ' +
  'implique mudança do remetente ou do destinatário; III - a data de emissão ou de saída.';

export interface CCeEventoInput {
  /** 44-digit chave de acesso of the authorized NF-e. */
  readonly chNFe: string;
  /** Órgão (IBGE cUF 2-digit) — the autorizadora UF. */
  readonly cOrgao: string;
  readonly tpAmb: TpAmb;
  /** Emitter CNPJ (14 digits). */
  readonly cnpj: string;
  /**
   * Correction text. SEFAZ requires 15–1000 chars. The API route validates the
   * length AFTER `sanitizeNFeText` (which can shorten it), so the sanitized
   * `<xCorrecao>` emitted below is guaranteed ≥ 15.
   */
  readonly xCorrecao: string;
  /** Sequence — 1 for the first CC-e, incremented per subsequent correction. */
  readonly nSeqEvento?: number;
  /** Event timestamp — defaults to now (issuer-local with offset). */
  readonly dhEvento?: Date;
}

/**
 * Build the `<detEvento>` for a CC-e, serialized from the generated
 * `detEvento_e110110` META (the e110110 schema) in the XSD sequence order
 * (descEvento, xCorrecao, xCondUso) with attribute `versao`. The operation
 * layer validates it against the real e110110 XSD (`validateXsd('detEventoCCe',
 * …)`) before it is signed + sent — the generic envelope's `xs:any` never
 * checks detEvento's inner structure.
 */
export function buildCCeDetEvento(input: { readonly xCorrecao: string }): string {
  return serializeFragment('detEvento_e110110', 'detEvento', {
    versao: EVENTO_VERSAO,
    descEvento: 'Carta de Correção',
    // Sanitized-but-unescaped — the serializer escapes & < >.
    xCorrecao: sanitizeNFeText(input.xCorrecao) ?? '',
    xCondUso: XCONDUSO_CCE,
  });
}

/**
 * Build the UNSIGNED `<evento>` for a CC-e. Pass the result to `signEvento`
 * then `buildEnvEvento`, exactly like cancelamento — only `tpEvento` (110110),
 * `nSeqEvento` and the detEvento payload differ. `infEvento.Id` =
 * `'ID' + tpEvento(6) + chNFe(44) + nSeqEvento(2)`. CC-e carries no `nProt`.
 */
export function buildCCeEvento(input: CCeEventoInput): string {
  if (input.chNFe.length !== 44) {
    throw new NFeEventoError(`chNFe must be 44 digits, got ${input.chNFe.length}`);
  }
  const nSeq = input.nSeqEvento ?? 1;
  const id = `ID${TP_EVENTO_CCE}${input.chNFe}${String(nSeq).padStart(2, '0')}`;

  const infEvento = serializeFragment('TEvento_infEvento', 'infEvento', {
    Id: id,
    cOrgao: input.cOrgao,
    tpAmb: input.tpAmb,
    CNPJ: input.cnpj,
    chNFe: input.chNFe,
    dhEvento: formatDhEmi(input.dhEvento ?? new Date()),
    tpEvento: TP_EVENTO_CCE,
    nSeqEvento: String(nSeq),
    verEvento: EVENTO_VERSAO,
    // `detEvento` is a #raw slot — injected verbatim in sequence order.
    detEvento: buildCCeDetEvento(input),
  });

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
