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
import { offsetForCUF } from '../generator/tz';
import { sanitizeNFeText } from '../sanitize';
import type { TpAmb } from '../safety';
import type { TNFe } from '../types/nfe-schema';
import { parse, serializeFragment } from '../xml';

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
    dhEvento: formatDhEmi(input.dhEvento ?? new Date(), offsetForCUF(input.chNFe.slice(0, 2))),
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
    dhEvento: formatDhEmi(input.dhEvento ?? new Date(), offsetForCUF(input.chNFe.slice(0, 2))),
    tpEvento: TP_EVENTO_CCE,
    nSeqEvento: String(nSeq),
    verEvento: EVENTO_VERSAO,
    // `detEvento` is a #raw slot — injected verbatim in sequence order.
    detEvento: buildCCeDetEvento(input),
  });

  return `<evento xmlns="${EVENTO_NS}" versao="${EVENTO_VERSAO}">${infEvento}</evento>`;
}

// ---------------------------------------------------------------------------
// EPEC — Evento Prévio de Emissão em Contingência — tpEvento 110140
// ---------------------------------------------------------------------------
export const TP_EVENTO_EPEC = '110140';
/** EPEC eventos go to the Ambiente Nacional — `cOrgao` is fixed at 91. */
export const C_ORGAO_AMBIENTE_NACIONAL = '91';

/** The NF-e summary the EPEC detEvento carries (e110140 XSD). */
export interface EpecEventoInput {
  /** 44-digit chave de acesso of the contingency (tpEmis=4) NF-e. */
  readonly chNFe: string;
  readonly tpAmb: TpAmb;
  /** Emitter CNPJ (14 digits). */
  readonly cnpj: string;
  /** Emitter IE. */
  readonly ie: string;
  /** Author UF (IBGE cUF 2-digit) — the issuer's home UF, NOT cOrgao. */
  readonly cOrgaoAutor: string;
  /** `ide.verProc` of the NF-e. */
  readonly verAplic: string;
  /** `ide.dhEmi` of the NF-e — already in SEFAZ lexical form. */
  readonly dhEmi: string;
  /** `ide.tpNF` — '0' entrada, '1' saída. */
  readonly tpNF: string;
  readonly dest: {
    /** Destinatário UF — `'EX'` for a foreign buyer (idEstrangeiro). */
    readonly uf: string;
    readonly cnpj?: string;
    readonly cpf?: string;
    readonly idEstrangeiro?: string;
    readonly ie?: string;
    /** Totals from `total.ICMSTot`, verbatim decimal strings. */
    readonly vNF: string;
    readonly vICMS: string;
    readonly vST: string;
  };
  /** Sequence — 1 for the first EPEC of a chave. */
  readonly nSeqEvento?: number;
  /** Event timestamp — defaults to now (issuer-local with offset). */
  readonly dhEvento?: Date;
}

/**
 * Build the `<detEvento>` for an EPEC, serialized from the generated
 * `detEvento_e110140` META in XSD sequence order. The operation layer
 * validates it against the real e110140 XSD (`validateXsd('detEventoEpec',
 * …)`) before it is signed + sent.
 */
export function buildEpecDetEvento(input: EpecEventoInput): string {
  return serializeFragment('detEvento_e110140', 'detEvento', {
    versao: EVENTO_VERSAO,
    descEvento: 'EPEC',
    cOrgaoAutor: input.cOrgaoAutor,
    tpAutor: '1',
    verAplic: input.verAplic,
    dhEmi: input.dhEmi,
    tpNF: input.tpNF,
    IE: input.ie,
    dest: {
      UF: input.dest.uf,
      ...(input.dest.cnpj ? { CNPJ: input.dest.cnpj } : {}),
      ...(input.dest.cpf ? { CPF: input.dest.cpf } : {}),
      ...(input.dest.idEstrangeiro ? { idEstrangeiro: input.dest.idEstrangeiro } : {}),
      ...(input.dest.ie ? { IE: input.dest.ie } : {}),
      vNF: input.dest.vNF,
      vICMS: input.dest.vICMS,
      vST: input.dest.vST,
    },
  });
}

/**
 * Build the UNSIGNED `<evento>` for an EPEC. Pass the result to `signEvento`
 * then `buildEnvEvento`, exactly like cancelamento/CC-e — but `cOrgao` is
 * fixed at `91` (Ambiente Nacional, the only authorizer that receives EPEC).
 * `infEvento.Id` = `'ID' + tpEvento(6) + chNFe(44) + nSeqEvento(2)`.
 */
export function buildEpecEvento(input: EpecEventoInput): string {
  if (input.chNFe.length !== 44) {
    throw new NFeEventoError(`chNFe must be 44 digits, got ${input.chNFe.length}`);
  }
  const nSeq = input.nSeqEvento ?? 1;
  const id = `ID${TP_EVENTO_EPEC}${input.chNFe}${String(nSeq).padStart(2, '0')}`;

  const infEvento = serializeFragment('TEvento_infEvento', 'infEvento', {
    Id: id,
    cOrgao: C_ORGAO_AMBIENTE_NACIONAL,
    tpAmb: input.tpAmb,
    CNPJ: input.cnpj,
    chNFe: input.chNFe,
    dhEvento: formatDhEmi(input.dhEvento ?? new Date(), offsetForCUF(input.chNFe.slice(0, 2))),
    tpEvento: TP_EVENTO_EPEC,
    nSeqEvento: String(nSeq),
    verEvento: EVENTO_VERSAO,
    // `detEvento` is a #raw slot — injected verbatim in sequence order.
    detEvento: buildEpecDetEvento(input),
  });

  return `<evento xmlns="${EVENTO_NS}" versao="${EVENTO_VERSAO}">${infEvento}</evento>`;
}

/**
 * The e110140 `IE` element only accepts a numeric inscrição estadual —
 * narrower than the NF-e leiaute, whose `TIe`/`TIeDest` also admit `ISENTO`
 * (and an empty dest IE).
 */
const RE_IE_EPEC = /^[0-9]{2,14}$/;

/**
 * Project a signed (or unsigned) `<NFe>` into the EPEC summary the detEvento
 * carries. Mirrors Flutter's `makeEPEC` field-for-field
 * (`.old/packages/nfe_client/lib/src/schemas/envEPEc.dart:30`): emitter
 * CNPJ/IE, ide dhEmi/tpNF/verProc, dest identification (UF `'EX'` for a
 * foreign buyer) and the ICMSTot totals. Throws `NFeEventoError` when the
 * NF-e lacks a dest, the dest identification, or a numeric emitter IE — an
 * EPEC without them is unrepresentable in the e110140 schema, and a clear
 * typed error here beats the generic XSD failure downstream. A non-numeric
 * dest IE (`ISENTO`) is simply omitted — it is optional in the e110140.
 */
export function extractEpecInputFromNFe(
  nfeXml: string,
  args: { readonly tpAmb: TpAmb; readonly nSeqEvento?: number; readonly dhEvento?: Date },
): EpecEventoInput {
  const nfe = parse<TNFe>('NFe', nfeXml);
  const inf = nfe.infNFe;
  const chNFe = inf.Id.replace(/^NFe/, '');
  const dest = inf.dest;
  if (!dest) {
    throw new NFeEventoError('EPEC requires a destinatário — the NF-e has no <dest>.');
  }
  if (!inf.emit.CNPJ || !inf.emit.IE) {
    throw new NFeEventoError('EPEC requires the emitter CNPJ and IE.');
  }
  if (!RE_IE_EPEC.test(inf.emit.IE)) {
    throw new NFeEventoError(
      `EPEC requires a numeric emitter IE (the e110140 schema accepts [0-9]{2,14}) — ` +
        `got '${inf.emit.IE}'.`,
    );
  }
  if (!dest.CNPJ && !dest.CPF && dest.idEstrangeiro == null) {
    throw new NFeEventoError(
      'EPEC requires the destinatário identification — the NF-e <dest> carries no CNPJ, ' +
        'CPF or idEstrangeiro.',
    );
  }
  const uf = dest.idEstrangeiro != null ? 'EX' : dest.enderDest?.UF;
  if (!uf) {
    throw new NFeEventoError('EPEC requires the destinatário UF (enderDest.UF or idEstrangeiro).');
  }
  return {
    chNFe,
    tpAmb: args.tpAmb,
    cnpj: inf.emit.CNPJ,
    ie: inf.emit.IE,
    cOrgaoAutor: inf.ide.cUF,
    verAplic: inf.ide.verProc,
    dhEmi: inf.ide.dhEmi,
    tpNF: inf.ide.tpNF,
    dest: {
      uf,
      cnpj: dest.CNPJ,
      cpf: dest.CPF,
      idEstrangeiro: dest.idEstrangeiro,
      ie: dest.IE && RE_IE_EPEC.test(dest.IE) ? dest.IE : undefined,
      vNF: inf.total.ICMSTot.vNF,
      vICMS: inf.total.ICMSTot.vICMS,
      vST: inf.total.ICMSTot.vST,
    },
    nSeqEvento: args.nSeqEvento,
    dhEvento: args.dhEvento,
  };
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
