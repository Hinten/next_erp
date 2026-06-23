/**
 * Typed entry points for the SEFAZ operations.
 *
 * This is the **high-level API** most callers should use. Each helper:
 *   1. Accepts a minimal typed object (just the unique inputs).
 *   2. Builds the request XML via `serialize(...)` — Zod-validated at the
 *      object boundary (active once `src/types/nfe-schema-zod.ts` is wired
 *      into `serialize`; Task #16 in the validation plan).
 *   3. Hands the string to the low-level SOAP transport — XSD-validated
 *      against the canonical SEFAZ XSD before the POST.
 *   4. Parses the response XML back into a typed object so the caller
 *      never deals with raw XML on the read side either.
 *
 * The low-level string-based SOAP transport (`nfeStatusServico` and friends
 * in `../soap`) stays exported — recovery flows, replay of archived signed
 * NF-e, and any future SEFAZ NT that doesn't fit a typed shape go through
 * that. **`autorizarLote` is the exception**: each `<NFe>` it carries is a
 * signed byte stream (re-parsing invalidates the digest), so its NFe slice
 * stays string-based.
 */
import {
  buildCancelamentoDetEvento,
  buildCancelamentoEvento,
  buildCCeDetEvento,
  buildCCeEvento,
  buildEnvEvento,
  buildEpecDetEvento,
  buildEpecEvento,
  buildProcEventoNFe,
  type CancelamentoEventoInput,
  type CCeEventoInput,
  type EpecEventoInput,
} from '../eventos';
import { UF_TO_IBGE } from '../generator/ide';
import { buildInutNFe, type InutilizacaoInput } from '../inutilizacao';
import { signEvento, signInutilizacao } from '../sign';
import { validateConsCad, validateXsd } from '../xsd';
import {
  nfeAutorizacaoLote,
  nfeConsultaCadastro,
  nfeConsultaProtocolo,
  nfeInutilizacao,
  nfeRecepcaoEvento,
  nfeRetAutorizacao,
  nfeStatusServico,
  type PostResult,
  type SefazCall,
} from '../soap';
import {
  type TConsStatServ,
  type TRetConsStatServ,
  type TRetConsSitNFe,
  type TRetConsReciNFe,
  type TRetEnvEvento,
  type TRetEnviNFe,
  type TRetInutNFe,
} from '../types/nfe-schema';
import { NFeXmlError, parse, serialize } from '../xml';

const NFE_VERSAO = '4.00';
const NFE_NS = 'http://www.portalfiscal.inf.br/nfe';

/** SEFAZ `cUF` literal (IBGE 2-digit). Mirrors the codegen union. */
export type CUFCode = TConsStatServ['cUF'];

/**
 * `NFeStatusServico4` — query whether SEFAZ is up for a given UF.
 *
 * `args.cUF` is the only caller input — `tpAmb`, `xServ`, `versao` are
 * filled in from the call context.
 */
export async function consultarStatusServico(
  call: SefazCall,
  args: { readonly cUF: CUFCode },
): Promise<TRetConsStatServ> {
  const xml = serialize('consStatServ', {
    tpAmb: call.tpAmb,
    cUF: args.cUF,
    xServ: 'STATUS',
    versao: NFE_VERSAO,
  });
  const { resultXml } = await nfeStatusServico(call, xml);
  return parse<TRetConsStatServ>('retConsStatServ', resultXml);
}

// ---------------------------------------------------------------------------
// Consulta Cadastro (NFeConsultaCadastro4) — hand-built consCad, hand-parsed
// retConsCad. See `consultarCadastro` below for the XSD-bypass rationale.
// ---------------------------------------------------------------------------

/** One taxpayer's address as it appears in `retConsCad/infCons/infCad/ender`. */
export interface ConsultaCadastroEnder {
  readonly xLgr: string | null;
  readonly nro: string | null;
  readonly xCpl: string | null;
  readonly xBairro: string | null;
  readonly cMun: string | null;
  readonly xMun: string | null;
  readonly CEP: string | null;
}

/** One `<infCad>` entry — a single IE registration for the queried CNPJ/UF. */
export interface ConsultaCadastroInfCad {
  readonly IE: string;
  readonly CNPJ: string | null;
  readonly CPF: string | null;
  readonly UF: string;
  /** cSit — '0' não habilitado, '1' habilitado. */
  readonly cSit: string;
  readonly indCredNFe: string | null;
  readonly indCredNFCe: string | null;
  readonly xNome: string | null;
  readonly ender: ConsultaCadastroEnder | null;
}

/** Parsed `retConsCad/infCons` — raw-ish SEFAZ field names (the route maps to friendly keys). */
export interface ConsultaCadastroResult {
  readonly cStat: string | null;
  readonly xMotivo: string | null;
  readonly uf: string;
  readonly infCad: ReadonlyArray<ConsultaCadastroInfCad>;
}

// Minimal, namespace-tolerant XML node reader for the retConsCad payload. The
// repo's `xml.parse()` is driven by the codegen'd META/ROOTS and has no
// `retConsCad` complexType (the consCad XSDs aren't vendored — see
// `consultarCadastro`), so we read the few fields we need with a small
// regex-free DOM walk over the same minimal shape `xml.ts` produces.
interface ConsCadNode {
  readonly tag: string;
  readonly children: ConsCadNode[];
  text: string;
}

function localTag(tag: string): string {
  return tag.includes(':') ? tag.slice(tag.indexOf(':') + 1) : tag;
}

function parseConsCadXml(text: string): ConsCadNode {
  const root: ConsCadNode = { tag: '#root', children: [], text: '' };
  const stack: ConsCadNode[] = [root];
  const top = (): ConsCadNode => stack[stack.length - 1] as ConsCadNode;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt === -1) {
      top().text += text.slice(i);
      break;
    }
    if (lt > i) top().text += text.slice(i, lt);
    // Each of these branches scans for a terminator; a missing one (truncated /
    // malformed XML) returns -1, which would push `i` BACKWARDS and spin the
    // loop. Guard every `indexOf` and `break` on -1 so `i` only moves forward —
    // the partial parse then trips `consultarCadastro`'s `!infCons` check (500).
    if (text.startsWith('<?', lt)) {
      const close = text.indexOf('?>', lt);
      if (close === -1) break;
      i = close + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const close = text.indexOf('-->', lt);
      if (close === -1) break;
      i = close + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt);
      if (end === -1) break;
      top().text += text.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) {
      const close = text.indexOf('>', lt);
      if (close === -1) break;
      i = close + 1;
      continue;
    }
    const gt = text.indexOf('>', lt);
    if (gt === -1) break;
    let inner = text.slice(lt + 1, gt).trim();
    if (inner.startsWith('/')) {
      if (stack.length > 1) stack.pop();
      i = gt + 1;
      continue;
    }
    const selfClose = inner.endsWith('/');
    if (selfClose) inner = inner.slice(0, -1).trim();
    const sp = inner.search(/\s/);
    const tag = sp === -1 ? inner : inner.slice(0, sp);
    const node: ConsCadNode = { tag, children: [], text: '' };
    top().children.push(node);
    if (!selfClose) stack.push(node);
    i = gt + 1;
  }
  return root;
}

function findConsCadNode(node: ConsCadNode, name: string): ConsCadNode | undefined {
  for (const c of node.children) {
    if (localTag(c.tag) === name) return c;
    const deep = findConsCadNode(c, name);
    if (deep) return deep;
  }
  return undefined;
}

function findConsCadNodes(node: ConsCadNode, name: string): ConsCadNode[] {
  return node.children.filter((c) => localTag(c.tag) === name);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/** Read the trimmed text of a direct child element, or `null` when absent/empty. */
function childText(node: ConsCadNode, name: string): string | null {
  const child = findConsCadNodes(node, name)[0];
  if (!child) return null;
  const t = unescapeXml(child.text).trim();
  return t.length > 0 ? t : null;
}

function parseInfCad(node: ConsCadNode): ConsultaCadastroInfCad {
  const enderNode = findConsCadNodes(node, 'ender')[0];
  const ender: ConsultaCadastroEnder | null = enderNode
    ? {
        xLgr: childText(enderNode, 'xLgr'),
        nro: childText(enderNode, 'nro'),
        xCpl: childText(enderNode, 'xCpl'),
        xBairro: childText(enderNode, 'xBairro'),
        cMun: childText(enderNode, 'cMun'),
        xMun: childText(enderNode, 'xMun'),
        CEP: childText(enderNode, 'CEP'),
      }
    : null;
  return {
    IE: childText(node, 'IE') ?? '',
    CNPJ: childText(node, 'CNPJ'),
    CPF: childText(node, 'CPF'),
    UF: childText(node, 'UF') ?? '',
    cSit: childText(node, 'cSit') ?? '',
    indCredNFe: childText(node, 'indCredNFe'),
    indCredNFCe: childText(node, 'indCredNFCe'),
    xNome: childText(node, 'xNome'),
    ender,
  };
}

/**
 * `CadConsultaCadastro4` — query a taxpayer's IE registry for a CNPJ in a UF.
 *
 * The `consCad` v2.00 XSDs aren't in the codegen (adding them renumbers the
 * emission types — issue #251), so this operation doesn't use the typed
 * `serialize`/`parse` path: it (1) builds the fixed `consCad` request as a
 * literal string and (2) reads `retConsCad` with a small inline DOM walk. But
 * the request **IS XSD-validated before sending** via `validateConsCad`
 * (vendored consCad v2.00 schema) — SEFAZ rule: never POST schema-invalid XML,
 * since repeated `cStat=215/225` trips `cStat=656` (Consumo Indevido) →
 * throttling/ban. It then travels the existing SOAP transport
 * (`nfeConsultaCadastro` → `postSoap`): same mTLS agent, SOAP 1.2 envelope,
 * SOAPAction, and `assertSafeTpAmb` guard.
 *
 * SEFAZ returns `<infCad>` as a single object for one match and an array for
 * several; we normalize to an array. cStat 111/112 = found; 258/259/108/109/etc
 * = none/invalid/down, with an empty `infCad`.
 */
export async function consultarCadastro(
  call: SefazCall,
  args: { readonly uf: string; readonly cnpj: string },
): Promise<ConsultaCadastroResult> {
  const uf = args.uf.toUpperCase();
  const cnpj = args.cnpj.replace(/\D/g, '');
  // cUF (IBGE 2-digit) for the required `<nfeCabecMsg>` SOAP Header.
  const cUF = UF_TO_IBGE[uf as keyof typeof UF_TO_IBGE];
  if (!cUF) throw new NFeXmlError(`UF inválida para Consulta Cadastro: ${uf}`);
  const xml =
    `<consCad versao="2.00" xmlns="${NFE_NS}">` +
    `<infCons><xServ>CONS-CAD</xServ><UF>${uf}</UF><CNPJ>${cnpj}</CNPJ></infCons>` +
    `</consCad>`;
  // Pre-send XSD gate — SEFAZ rule: never POST schema-invalid XML. Repeated
  // cStat 215/225 trips cStat 656 (Consumo Indevido) → throttling/ban.
  await validateConsCad(xml);
  const { resultXml } = await nfeConsultaCadastro(call, xml, cUF);

  const doc = parseConsCadXml(resultXml);
  const infCons = findConsCadNode(doc, 'infCons');
  if (!infCons) {
    // A retConsCad with no infCons is malformed — surface it so the route maps
    // it to a 500 (our parse/SEFAZ-shape bug), not a misleading "no match".
    throw new NFeXmlError('retConsCad missing <infCons>');
  }
  const infCad = findConsCadNodes(infCons, 'infCad').map(parseInfCad);
  return {
    cStat: childText(infCons, 'cStat'),
    xMotivo: childText(infCons, 'xMotivo'),
    uf: childText(infCons, 'UF') ?? uf,
    infCad,
  };
}

/**
 * `NfeConsultaProtocolo4` — query the situation of one NF-e by chave.
 *
 * This is the **recovery query** — call it whenever a send/poll outcome is
 * uncertain (cStat 204/205/218/539). See
 * `.claude/skills/nfe/references/cstat-rejeicoes.md`.
 */
export async function consultarSituacaoNFe(
  call: SefazCall,
  args: { readonly chave: string },
): Promise<TRetConsSitNFe> {
  const xml = serialize('consSitNFe', {
    tpAmb: call.tpAmb,
    xServ: 'CONSULTAR',
    chNFe: args.chave,
    versao: NFE_VERSAO,
  });
  const { resultXml } = await nfeConsultaProtocolo(call, xml);
  return parse<TRetConsSitNFe>('retConsSitNFe', resultXml);
}

/**
 * `NFeRetAutorizacao4` — poll a lote by `nRec` (received from a 103 reply).
 */
export async function consultarLote(
  call: SefazCall,
  args: { readonly nRec: string },
): Promise<TRetConsReciNFe> {
  const xml = serialize('consReciNFe', {
    tpAmb: call.tpAmb,
    nRec: args.nRec,
    versao: NFE_VERSAO,
  });
  const { resultXml } = await nfeRetAutorizacao(call, xml);
  return parse<TRetConsReciNFe>('retConsReciNFe', resultXml);
}

/**
 * `NFeAutorizacao4` — send a lote of signed NF-e.
 *
 * Each `args.NFe` entry **must be the signed `<NFe>...</NFe>` byte stream**
 * straight from `signNFe()`. The helper builds the `<enviNFe>` wrapper by
 * concatenation (hand-rolled, not via `serialize`) because the NFe slot is
 * a signed payload — re-parsing it invalidates the digest.
 *
 * Phase A typically calls this with `args.NFe.length === 1` (one NF-e per
 * lote); batching up to 50 is a Phase B optimization.
 */
export async function autorizarLote(
  call: SefazCall,
  args: {
    readonly idLote: string;
    readonly NFe: ReadonlyArray<string>;
    readonly indSinc?: '0' | '1';
  },
): Promise<TRetEnviNFe> {
  if (args.NFe.length === 0) {
    throw new Error('autorizarLote: args.NFe must contain at least one signed NFe');
  }
  // SEFAZ requires `indSinc='1'` (sync) for single-NFe lotes and
  // `'0'` (async) for batches — submitting `'0'` for a 1-NFe lote
  // is rejected with "Solicitada resposta assíncrona para Lote com
  // somente 1 (uma) NF-e". Auto-derive from `NFe.length` when the
  // caller doesn't override, so the rule lives in one place.
  const indSinc: '0' | '1' = args.indSinc ?? (args.NFe.length === 1 ? '1' : '0');
  // Hand-built wrapper — see jsdoc.
  const xml =
    `<enviNFe xmlns="http://www.portalfiscal.inf.br/nfe" versao="${NFE_VERSAO}">` +
    `<idLote>${args.idLote}</idLote>` +
    `<indSinc>${indSinc}</indSinc>` +
    args.NFe.join('') +
    `</enviNFe>`;
  const { resultXml } = await nfeAutorizacaoLote(call, xml);
  return parse<TRetEnviNFe>('retEnviNFe', resultXml);
}

/**
 * Result of any `RecepcaoEvento` round-trip (cancelamento, CC-e, …) — they all
 * build + sign an `<evento>`, send the single-evento lote, and parse
 * `retEnvEvento`, so they share one shape.
 */
export interface RecepcaoEventoResult {
  /** Parsed `retEnvEvento` (lote-level cStat in `.cStat`, per-evento in `.retEvento[]`). */
  readonly ret: TRetEnvEvento;
  /** The signed `<evento>` we sent (opaque bytes — archive as-is). */
  readonly signedEventoXml: string;
  /** Archival `<procEventoNFe>` (signed evento + SEFAZ retEvento); null on lote rejection. */
  readonly procEventoNFe: string | null;
  /** Raw `retEnvEvento` XML, for the audit log. */
  readonly rawResponse: string;
}

/** Result of a cancelamento round-trip. */
export type CancelarNFeResult = RecepcaoEventoResult;

/**
 * `RecepcaoEvento4` — cancelamento (`tpEvento=110111`).
 *
 * Builds + signs the `<evento>`, wraps the single-evento `<envEvento>`
 * lote, sends, and parses `retEnvEvento`. The caller inspects
 * `ret.retEvento[0].infEvento.cStat`: **135** (registrado e vinculado) or
 * **155** (homologado fora de prazo) = success; anything else = rejected.
 * `tpAmb` is taken from the call context; the certificate that signs the
 * evento is `call.cert`.
 */
export async function cancelarNFe(
  call: SefazCall,
  args: Omit<CancelamentoEventoInput, 'tpAmb'>,
): Promise<CancelarNFeResult> {
  // Validate detEvento's inner structure against e110111 before send — the
  // generic envEvento envelope declares detEvento as xs:any (skip) and never
  // checks it, so this is the only gate on descEvento/nProt/xJust. detEvento
  // inherits the NFe namespace from <evento> on the wire; add it explicitly so
  // the standalone fragment validates (e110111 is elementFormDefault=qualified).
  const detEvento = buildCancelamentoDetEvento(args);
  await validateXsd('detEvento', detEvento.replace('<detEvento', `<detEvento xmlns="${NFE_NS}"`));
  const eventoXml = buildCancelamentoEvento({ ...args, tpAmb: call.tpAmb });
  const signedEventoXml = signEvento(eventoXml, call.cert);
  const envEventoXml = buildEnvEvento(signedEventoXml);
  const { resultXml } = await nfeRecepcaoEvento(call, envEventoXml);
  const ret = parse<TRetEnvEvento>('retEnvEvento', resultXml);
  const procEventoNFe = buildProcEventoNFe(signedEventoXml, resultXml);
  return { ret, signedEventoXml, procEventoNFe, rawResponse: resultXml };
}

/** Result of a carta de correção (CC-e) round-trip. Same shape as cancelamento. */
export type CartaCorrecaoResult = RecepcaoEventoResult;

/**
 * `RecepcaoEvento4` — carta de correção eletrônica (CC-e, `tpEvento=110110`).
 *
 * Builds + signs the `<evento>`, wraps the single-evento `<envEvento>` lote,
 * sends, and parses `retEnvEvento`. The caller inspects
 * `ret.retEvento[0].infEvento.cStat`: **135** (registrado e vinculado) =
 * accepted; anything else (incl. 136, registrado mas não vinculado) = rejected.
 * `tpAmb` is taken from the call context; the certificate that signs the evento
 * is `call.cert`. Unlike cancelamento, a CC-e carries no `nProt` in the request.
 */
export async function cartaCorrecaoNFe(
  call: SefazCall,
  args: Omit<CCeEventoInput, 'tpAmb'>,
): Promise<CartaCorrecaoResult> {
  // Validate detEvento against the real e110110 XSD before send — the generic
  // envEvento envelope declares detEvento as xs:any (skip), so this is the only
  // gate on descEvento/xCorrecao/xCondUso. detEvento inherits the NFe namespace
  // from <evento> on the wire; add it explicitly so the standalone fragment
  // validates (e110110 is elementFormDefault=qualified).
  const detEvento = buildCCeDetEvento(args);
  await validateXsd(
    'detEventoCCe',
    detEvento.replace('<detEvento', `<detEvento xmlns="${NFE_NS}"`),
  );
  const eventoXml = buildCCeEvento({ ...args, tpAmb: call.tpAmb });
  const signedEventoXml = signEvento(eventoXml, call.cert);
  const envEventoXml = buildEnvEvento(signedEventoXml);
  const { resultXml } = await nfeRecepcaoEvento(call, envEventoXml);
  const ret = parse<TRetEnvEvento>('retEnvEvento', resultXml);
  const procEventoNFe = buildProcEventoNFe(signedEventoXml, resultXml);
  return { ret, signedEventoXml, procEventoNFe, rawResponse: resultXml };
}

/** Result of an EPEC round-trip — same shape as the other eventos. */
export type EpecResult = RecepcaoEventoResult;

/**
 * EPEC — Evento Prévio de Emissão em Contingência (`RecepcaoEvento4`,
 * `tpEvento=110140`), sent to the **Ambiente Nacional** (`cOrgao=91`).
 *
 * Builds + signs the `<evento>`, wraps the single-evento `<envEvento>` lote,
 * sends, and parses `retEnvEvento`. The caller inspects
 * `ret.retEvento[0].infEvento.cStat`: **135 AND 136 both mean the EPEC is
 * registered** (unlike CC-e, where 136 rejects) — after the outage the full
 * NF-e (same chave, tpEmis=4) must still be transmitted to the home SEFAZ.
 * `tpAmb` is taken from the call context; `call.url` must be the AN
 * RecepcaoEvento (`getAnEndpoints(ambiente)`).
 */
export async function enviarEpec(
  call: SefazCall,
  args: Omit<EpecEventoInput, 'tpAmb'>,
): Promise<EpecResult> {
  // Validate detEvento against the real e110140 XSD before send — the generic
  // envEvento envelope declares detEvento as xs:any (skip), so this is the
  // only gate on the EPEC summary fields. detEvento inherits the NFe namespace
  // from <evento> on the wire; add it explicitly so the standalone fragment
  // validates (e110140 is elementFormDefault=qualified).
  const detEvento = buildEpecDetEvento({ ...args, tpAmb: call.tpAmb });
  await validateXsd(
    'detEventoEpec',
    detEvento.replace('<detEvento', `<detEvento xmlns="${NFE_NS}"`),
  );
  const eventoXml = buildEpecEvento({ ...args, tpAmb: call.tpAmb });
  const signedEventoXml = signEvento(eventoXml, call.cert);
  const envEventoXml = buildEnvEvento(signedEventoXml);
  const { resultXml } = await nfeRecepcaoEvento(call, envEventoXml);
  const ret = parse<TRetEnvEvento>('retEnvEvento', resultXml);
  const procEventoNFe = buildProcEventoNFe(signedEventoXml, resultXml);
  return { ret, signedEventoXml, procEventoNFe, rawResponse: resultXml };
}

/** Result of an inutilização round-trip. */
export interface InutilizarResult {
  /** Parsed `retInutNFe` — success when `infInut.cStat === '102'`. */
  readonly ret: TRetInutNFe;
  /** The signed `<inutNFe>` we sent. */
  readonly signedXml: string;
  /** Raw `retInutNFe` XML, for the audit log. */
  readonly rawResponse: string;
}

/**
 * `NfeInutilizacao4` — burn an unused número range. Synchronous: inspect
 * `ret.infInut.cStat` — **102** (Inutilização homologada) = success, with
 * `ret.infInut.nProt`. `tpAmb` comes from the call context; the certificate
 * that signs `<infInut>` is `call.cert`.
 */
export async function inutilizarNumeracao(
  call: SefazCall,
  args: Omit<InutilizacaoInput, 'tpAmb'>,
): Promise<InutilizarResult> {
  const inutXml = buildInutNFe({ ...args, tpAmb: call.tpAmb });
  const signedXml = signInutilizacao(inutXml, call.cert);
  const { resultXml } = await nfeInutilizacao(call, signedXml);
  const ret = parse<TRetInutNFe>('retInutNFe', resultXml);
  return { ret, signedXml, rawResponse: resultXml };
}

// Re-export the underlying transport — power users (recovery flows, replay
// of archived signed NF-e) still reach for the string-based API.
export type { PostResult, SefazCall };
export {
  nfeAutorizacaoLote,
  nfeConsultaCadastro,
  nfeConsultaProtocolo,
  nfeInutilizacao,
  nfeRecepcaoEvento,
  nfeRetAutorizacao,
  nfeStatusServico,
};
