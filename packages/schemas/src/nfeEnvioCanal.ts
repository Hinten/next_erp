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
