/**
 * "Is this `nfev4` write an NF-e a sales channel should receive?" — the shared
 * DECISION behind every marketplace's NF-e upload trigger.
 *
 * Pure and total: no clock, no network, no Firestore. It reads two fields of a
 * raw snapshot (`estado`, `xml_nfe_proc`) and the first `<tpAmb>` of the proc
 * XML, so both SDK worlds and every channel app can share it.
 *
 * Two readers, two semantics:
 *
 *  - **Mercado Livre — LEVEL.** `decideNfeUploadDispatch` answers "is `after`
 *    ready?" and ignores `before`. `apps/mercado-livre` drives it from
 *    `onNfeAprovada` and from its `enviar-nfe` re-drive route, and re-exports
 *    it from `lib/marketplace/nfe/nfeUpload.ts` under the same names, so its
 *    callers and tests never moved. Its dedup is the live shipment-status gate
 *    inside the task.
 *  - **Shopee — TRANSITION.** `decideNfeUploadTransition` enqueues only on the
 *    EDGE: `after` ready while `before` was not. A level trigger re-fires on
 *    every later write to an already-approved document, and those writes are
 *    not hypothetical: the `2026-09-nfe-totais` migration rewrites `totais` on
 *    every `nfev4` document, approved ones included, so a level trigger would
 *    turn one backfill into one task per historic NF-e. The edge still fires
 *    for the late-proc repair (`aprovada` without `xml_nfe_proc`, then with
 *    it), because "ready" is the whole predicate, not the `estado` alone.
 *
 * `'ja-pronta'` lives on its OWN type (`NfeUploadTransition`) and never joins
 * `NfeUploadDispatch`: Mercado Livre's route keys an exhaustive `Record` on the
 * dispatch reasons, and a new member there is a typecheck break in another app.
 *
 * `extractTpAmb` returns the LITERAL `'1' | '2' | null` on purpose, not the
 * ambiente enum of the NF-e config schema: the lint rule that prefers schema
 * enums identifies one by the declaration behind a position, so retyping this
 * return would turn every caller's raw `'1'` comparison into a lint error.
 *
 * `finalidadeDaNfeProc` is the SALE gate every channel applies before an
 * upload: only the note whose first `tpNF` is `1` (saída) and whose first
 * `finNFe` is `1` (normal) is the order's sale note. It was first written in
 * Shopee's NF-e folder (`finalidadeDoProc`) and is COPIED here unchanged, near
 * misses included, so the next channel (Amazon, step 14) reads the one shared
 * definition instead of a third copy. Shopee still holds its own until its
 * re-point (a follow-up of its own): until then the two must agree, and both
 * test files pin the same table.
 *
 * Why a file of its own and not a block inside `nfe.ts`: the NF-e lane's live
 * job selects its scope by LITERAL path prefix, and `nfe.ts` is on that list,
 * so any edit there emits test documents at the rate-limited SEFAZ homologação
 * endpoint. This predicate is about channels, not about emission, and must be
 * editable without that cost.
 */
import { ESTADO_NFE } from './nfe';

/* --------------------------------- tpAmb ------------------------------------ */

// First <tpAmb> wins: infNFe/ide precedes protNFe in a nfeProc document, so
// the emitter's declared ambiente is read, never the protocol echo.
const TPAMB_REGEX = /<tpAmb>\s*([12])\s*<\/tpAmb>/;

/** The first `<tpAmb>` in the XML — `'1'` produção, `'2'` homologação, else null. */
export function extractTpAmb(xml: string): '1' | '2' | null {
  const m = TPAMB_REGEX.exec(xml);
  return m == null ? null : (m[1] as '1' | '2');
}

/* ------------------------------ level dispatch ------------------------------ */

export type NfeUploadDispatch =
  | { action: 'enqueue' }
  | {
      action: 'skip';
      reason: 'apagada' | 'nao-aprovada' | 'xml-ausente' | 'tpamb-homologacao';
    };

/**
 * PURE enqueue-vs-skip decision for an `nfev4` onDocumentWritten trigger, with
 * LEVEL semantics. `before`/`after` are the RAW snapshot data (undefined on
 * create/delete).
 *
 * Only the four cheap doc guards live here — anything that survives them
 * enqueues. There is deliberately NO write-dedup at this layer: a doc write
 * simply re-runs this cheap ladder and, at worst, enqueues a redundant task
 * the channel's own task gate resolves. `before` stays in the signature for
 * the trigger call site; the decision reads `after` only.
 */
export function decideNfeUploadDispatch(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): NfeUploadDispatch {
  // (1) Deleted doc — nothing to upload.
  if (after == null) return { action: 'skip', reason: 'apagada' };

  // (2) Only an aprovada NF-e has an authorized nfeProc worth sending.
  if (after.estado !== ESTADO_NFE.aprovada) return { action: 'skip', reason: 'nao-aprovada' };

  // (3) Aprovada with no proc XML happens (legacy docs, partial writes).
  const xml = after.xml_nfe_proc;
  if (xml == null || typeof xml !== 'string') return { action: 'skip', reason: 'xml-ausente' };

  // (4) Homologação (or unparseable) XML never reaches a channel from the
  // dispatch; the task re-checks and distinguishes '2' from unparseable.
  if (extractTpAmb(xml) !== '1') return { action: 'skip', reason: 'tpamb-homologacao' };

  return { action: 'enqueue' };
}

/* --------------------------- transition dispatch ---------------------------- */

/** The level verdict, plus the one skip only an EDGE can produce. */
export type NfeUploadTransition = NfeUploadDispatch | { action: 'skip'; reason: 'ja-pronta' };

/**
 * PURE enqueue-vs-skip decision with TRANSITION semantics: enqueue only when
 * `after` is ready (the level ladder above says `enqueue`) AND `before` was
 * not. A write that leaves an already-ready document ready — a backfill, a
 * poke, any later field — is `ja-pronta`. When `after` is not ready the answer
 * is the level verdict of `after`, reason included, so a skip still says why.
 *
 * "Ready" compares the whole level predicate, never the XML's identity: no
 * writer replaces the proc of an approved NF-e, and a channel's own read-back
 * converges a duplicate anyway.
 */
export function decideNfeUploadTransition(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): NfeUploadTransition {
  const depois = decideNfeUploadDispatch(undefined, after);
  if (depois.action !== 'enqueue') return depois;
  return decideNfeUploadDispatch(undefined, before).action === 'enqueue'
    ? { action: 'skip', reason: 'ja-pronta' }
    : depois;
}

/* ------------------------------ the sale gate ------------------------------- */

/** The first `tpNF` element's text (B11 — 0 entrada, 1 saída); any namespace prefix. */
const ELEMENTO_TP_NF = /<(?:[\w.-]+:)?tpNF\s*>([^<]*)<\/(?:[\w.-]+:)?tpNF\s*>/;

/** The first `finNFe` element's text (B25 — 1 normal … 6 débito since NT 2025.002). */
const ELEMENTO_FIN_NFE = /<(?:[\w.-]+:)?finNFe\s*>([^<]*)<\/(?:[\w.-]+:)?finNFe\s*>/;

/** A LEGIBLE code: exactly one decimal digit once trimmed. */
const CODIGO_DE_UM_DIGITO = /^[0-9]$/;

/** `tpNF` of an outgoing note, and `finNFe` of a normal one — the SALE, and only it. */
const SAIDA = '1';
const FINALIDADE_NORMAL = '1';

/** What the sale gate says about a proc. */
export type FinalidadeDaNfeProc = 'venda' | 'outra' | 'ilegivel';

/** The trimmed text of the first match of `elemento`, or `null` when it is absent. */
function textoDoPrimeiro(xml: string, elemento: RegExp): string | null {
  const achado = elemento.exec(xml);
  return achado === null ? null : (achado[1] ?? '').trim();
}

/**
 * Whether a proc is the order's SALE note (the shared sale gate; module
 * header). PURE and total:
 *
 * - first `tpNF` = `1` AND first `finNFe` = `1` ⇒ `venda`;
 * - both legible (one digit each, once trimmed) but anything else ⇒ `outra` —
 *   an entrada (`tpNF 0`), a complementar, an ajuste, a devolução
 *   (`finNFe 4`), or a crédito/débito note (`finNFe 5`/`6`, NT 2025.002). A
 *   channel DISCARDS it: uploading it would attach the wrong fiscal document to
 *   the order;
 * - either element missing, or not one digit ⇒ `ilegivel` — a channel judges
 *   it loudly (its own "invalid XML" reason), never as a sale.
 *
 * ⚠️ "Legible" is a SHAPE, not the XSD's value list: the note is authorized, so
 * its domain is SEFAZ's to enforce, and a digit a future layout adds lands on
 * `outra` — never a sale. Only the EXACT pair `1`/`1` is a sale: `01` is
 * illegible, never read as `1`. The FIRST element of each wins (the `ide`
 * group precedes everything else in an `nfeProc`).
 */
export function finalidadeDaNfeProc(xml: string): FinalidadeDaNfeProc {
  const tpNF = textoDoPrimeiro(xml, ELEMENTO_TP_NF);
  const finNFe = textoDoPrimeiro(xml, ELEMENTO_FIN_NFE);
  if (tpNF === null || finNFe === null) return 'ilegivel';
  if (!CODIGO_DE_UM_DIGITO.test(tpNF) || !CODIGO_DE_UM_DIGITO.test(finNFe)) return 'ilegivel';
  return tpNF === SAIDA && finNFe === FINALIDADE_NORMAL ? 'venda' : 'outra';
}
