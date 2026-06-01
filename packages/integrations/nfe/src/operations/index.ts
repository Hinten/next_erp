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
  buildEnvEvento,
  buildProcEventoNFe,
  type CancelamentoEventoInput,
} from '../eventos';
import { buildInutNFe, type InutilizacaoInput } from '../inutilizacao';
import { signEvento, signInutilizacao } from '../sign';
import { validateXsd } from '../xsd';
import {
  nfeAutorizacaoLote,
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
import { parse, serialize } from '../xml';

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

/** Result of a cancelamento round-trip. */
export interface CancelarNFeResult {
  /** Parsed `retEnvEvento` (lote-level cStat in `.cStat`, per-evento in `.retEvento[]`). */
  readonly ret: TRetEnvEvento;
  /** The signed `<evento>` we sent (opaque bytes — archive as-is). */
  readonly signedEventoXml: string;
  /** Archival `<procEventoNFe>` (signed evento + SEFAZ retEvento); null on lote rejection. */
  readonly procEventoNFe: string | null;
  /** Raw `retEnvEvento` XML, for the audit log. */
  readonly rawResponse: string;
}

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
  nfeConsultaProtocolo,
  nfeInutilizacao,
  nfeRecepcaoEvento,
  nfeRetAutorizacao,
  nfeStatusServico,
};
