/**
 * Browser-safe reader of the three scalars that explain a cStat 805 rejection
 * (#852): `ide/idDest`, `dest/indIEDest` and `dest/enderDest/UF`.
 *
 * The source is the rejected nfev4 doc's `xml_assinado` — EXACTLY the NF-e the
 * SEFAZ judged, kept on `rejeitada` until the next emission resets it. Reading
 * the classification from there, rather than re-deriving it from today's
 * cliente cadastro, is what lets the guidance say what WAS sent even after the
 * operator already fixed the cadastro. (A server-side field would touch
 * `apps/nfe`, the http-provider and `packages/schemas/src/nfe.ts` — every one an
 * nfe-live path — without changing a byte of what the SEFAZ receives.)
 *
 * Returns `null` — never throws — on anything it cannot vouch for: an empty
 * input, a `parsererror` document (`DOMParser` reports malformed XML that way
 * instead of throwing), no `<infNFe>`, or an `idDest`/`indIEDest` outside the
 * XSD's enumerations. A `null` here degrades the UI to the generic toast.
 *
 * Reads are scoped step by step — `infNFe > ide > idDest`,
 * `infNFe > dest > indIEDest`, `infNFe > dest > enderDest > UF` — through
 * DIRECT children only, so an `<UF>` under `<enderEmit>` (the emitente's) can
 * never answer for the destinatário's. NF-e XML declares one default namespace
 * (`http://www.portalfiscal.inf.br/nfe`) and no prefixes, so matching on
 * `localName` works for both a bare signed `<NFe>` and an `<nfeProc>`.
 *
 * `dest/xNome` is deliberately NOT exposed: in homologação it is the fixed
 * placeholder the generator swaps in (`HOMOLOGACAO_XNOME`,
 * `packages/integrations/nfe/src/generator/parties.ts`), so the cliente's name
 * comes from the cadastro instead.
 *
 * Not built on `parseNfeReportRow` (`./export`): that one throws a plain
 * `Error` on a missing `<infNFe>`, and catching it here would need exactly the
 * generic `catch` the repo forbids.
 */

/** `ide/idDest` — Identificador de local de destino da operação (XSD enum 1|2|3). */
export const ID_DEST = {
  interna: '1',
  interestadual: '2',
  exterior: '3',
} as const;
export type IdDest = (typeof ID_DEST)[keyof typeof ID_DEST];

/** `dest/indIEDest` — Indicador da IE do destinatário (XSD enum 1|2|9). */
export const IND_IE_DEST = {
  contribuinte: '1',
  isento: '2',
  naoContribuinte: '9',
} as const;
export type IndIEDest = (typeof IND_IE_DEST)[keyof typeof IND_IE_DEST];

export interface DestinatarioNFe {
  readonly idDest: IdDest;
  readonly indIEDest: IndIEDest;
  /**
   * `dest/enderDest/UF` — the DESTINATÁRIO's UF, whose SEFAZ applies rule
   * E16a-30 (NT 2025.001, Obs. 1). `null` when `<enderDest>` is absent
   * (`minOccurs=0`) or the value is not two uppercase letters.
   */
  readonly uf: string | null;
}

const ID_DEST_VALIDOS: ReadonlySet<string> = new Set<string>(Object.values(ID_DEST));
const IND_IE_DEST_VALIDOS: ReadonlySet<string> = new Set<string>(Object.values(IND_IE_DEST));
const UF_RE = /^[A-Z]{2}$/;

function ehIdDest(valor: string): valor is IdDest {
  return ID_DEST_VALIDOS.has(valor);
}

function ehIndIEDest(valor: string): valor is IndIEDest {
  return IND_IE_DEST_VALIDOS.has(valor);
}

/** The `pai > nome` step: first DIRECT child with that local name, case-exact. */
function filho(pai: Element | null, nome: string): Element | null {
  if (pai == null) return null;
  for (const el of Array.from(pai.children)) {
    if (el.localName === nome) return el;
  }
  return null;
}

function texto(el: Element | null): string | null {
  const valor = el?.textContent?.trim() ?? '';
  return valor === '' ? null : valor;
}

/**
 * Read `{ idDest, indIEDest, uf }` from a signed `<NFe>` or an `<nfeProc>`.
 * `null` — never a throw — when the XML is absent, malformed or does not carry
 * a valid `idDest` + `indIEDest` pair.
 */
export function lerDestinatarioNFe(xml: string | null | undefined): DestinatarioNFe | null {
  if (xml == null || xml.trim() === '') return null;
  // Client-only surface; a server render has no DOMParser and simply degrades.
  if (typeof DOMParser === 'undefined') return null;

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  // jsdom/Firefox replace the root with <parsererror>; Chromium injects one
  // (XHTML namespace) into the partial tree — a namespace-wildcard lookup sees both.
  if (doc.getElementsByTagNameNS('*', 'parsererror').length > 0) return null;

  const infNFe = doc.getElementsByTagNameNS('*', 'infNFe')[0] ?? null;
  if (infNFe == null) return null;

  const idDest = texto(filho(filho(infNFe, 'ide'), 'idDest'));
  if (idDest == null || !ehIdDest(idDest)) return null;

  const dest = filho(infNFe, 'dest');
  const indIEDest = texto(filho(dest, 'indIEDest'));
  if (indIEDest == null || !ehIndIEDest(indIEDest)) return null;

  const uf = texto(filho(filho(dest, 'enderDest'), 'UF'));
  return { idDest, indIEDest, uf: uf != null && UF_RE.test(uf) ? uf : null };
}

/** The two nfev4 fields that can hold the NF-e itself — typed `unknown` on purpose. */
export interface XmlsDoNfev4 {
  readonly xml_assinado?: unknown;
  readonly xml_nfe_proc?: unknown;
}

/** A non-empty XML string, or `null`. */
function xmlOuNull(valor: unknown): string | null {
  return typeof valor === 'string' && valor.trim() !== '' ? valor : null;
}

/**
 * The destinatário of an nfev4 DOCUMENT: from `xml_assinado` (exactly what the
 * SEFAZ judged, kept on `rejeitada`), else `xml_nfe_proc`. Deliberately never
 * `xml_epec_proc` — that is an evento, not an NF-e, which is also why this does
 * not go through `selectNfeXml`.
 *
 * The ONE place that picks the XML, shared by the toast/dialog loader
 * (`./contextoRejeicao`) and the NF column's badge (`useLatestNfe`), so the two
 * surfaces can never disagree about which XML they read.
 *
 * ⚠️ Each field is type-checked rather than trusted: the collection converter
 * SOFT-parses (`parseSoftRead`), so a document that fails its schema arrives
 * RAW, and a non-string `xml_assinado` would otherwise throw out of
 * `lerDestinatarioNFe` — in the badge's case, during a table cell's render.
 */
export function lerDestinatarioDoNfev4(
  doc: XmlsDoNfev4 | null | undefined,
): DestinatarioNFe | null {
  if (doc == null) return null;
  return lerDestinatarioNFe(xmlOuNull(doc.xml_assinado) ?? xmlOuNull(doc.xml_nfe_proc));
}
