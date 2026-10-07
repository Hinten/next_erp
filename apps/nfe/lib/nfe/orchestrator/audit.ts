import type { Firestore, Timestamp } from 'firebase-admin/firestore';

import { enviNfeMsgCollection, nfev4Collection } from '@delfrance/data/admin/collections';
import {
  type autorizarLote,
  buildNFeProcSafe,
  classifyCStat,
  type consultarLote,
  type consultarSituacaoNFe,
  extrairDataAutorizacao,
  extrairTotaisNFe,
  isBloqueada,
  isEstadoFinalNFe,
  nextConsultaDelayMs,
  outcomeFromInfProt,
  outcomeFromRetConsRec,
  RECONCILE_SWEEP_GRACE_MS,
  type NFeStatePatch,
  type SefazOutcome,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import {
  coerceToMicros,
  nowMicros,
  type MicrosSinceEpoch,
  type MillisSinceEpoch,
} from '@delfrance/core/datetime';
import {
  ESTADO_ENVI_NFE_MSG,
  ESTADO_NFE,
  type EnviNFeMsg,
  type EstadoNFe,
  type NFeTotais,
  type NotaFiscalEletronica,
} from '@delfrance/schemas';

import type { EmitResult } from './bundle';
import { NFeDocAusenteError, NFeOrchestratorError } from './errors';

/**
 * How long a claimed nfev4 doc counts as "send in progress" (#1675): App
 * Hosting's 300 s default request ceiling (`apps/nfe/apphosting.yaml` sets no
 * `timeoutSeconds`) plus the program's 60 s margin — the same `longo` rule as
 * the browser client's budget, so the window never closes before the platform
 * has given up on the request that opened it.
 *
 * ⚠️ A plain literal on purpose: `http-client-timeout-ceiling.test.js` reads it
 * by text scan and pins it at or above that ceiling.
 */
export const ENVIO_EM_CURSO_MS = 360_000;

/** The reservation a claim stamps as `proximaConsultaEm` (µs) — see {@link envioEmCurso}. */
export function envioEmCursoAte(agoraUs: MicrosSinceEpoch): MicrosSinceEpoch {
  return agoraUs + ENVIO_EM_CURSO_MS * 1000;
}

/**
 * True while an nfev4 doc must not be sent (nor written by anyone but its
 * owner) because a send — or a paced retry — is pending on it (#1675).
 *
 * `proximaConsultaEm` carries TWO meanings that this one predicate reads alike:
 *  - "send in progress until": every claim that is about to call SEFAZ stamps
 *    it at `now + ENVIO_EM_CURSO_MS` (the emit's allocation transactions, batch
 *    4b's anchor write, the pós-EPEC claim). During the SOAP call the doc is
 *    otherwise indistinguishable from a #396 crash-window anchor, which a
 *    second emit would retransmit over the live run. The run's own outcome
 *    write releases it (`buildPersistData` always rewrites the field);
 *  - the reconciler's pacing of a doc left in flight without a receipt
 *    (a paced #512 / #1654 §1 anchor, one hour after a 656): an emit inside it
 *    would only earn the answer the pacing is waiting out.
 *
 * Only a doc with no `nRec` and in flight (`enviando` / `aguardandoResposta`)
 * or EPEC-approved (`'p'`, the pós-EPEC transmission) qualifies: a doc with a
 * receipt is already skipped by the emit's in-flight gate, and a final or
 * rejected one is never sent over a live run. The stored value is read through
 * `coerceToMicros` and compared with µs only — `ultima_modificacao` and
 * `data_emissao` are ms (root `CLAUDE.md` rule 7, the cross-unit trap).
 */
export function envioEmCurso(
  nota: Pick<NotaFiscalEletronica, 'estado' | 'nRec' | 'proximaConsultaEm'>,
  agoraUs: MicrosSinceEpoch,
): boolean {
  if (
    nota.estado !== ESTADO_NFE.enviando &&
    nota.estado !== ESTADO_NFE.aguardandoResposta &&
    nota.estado !== ESTADO_NFE.epecAprovado
  ) {
    return false;
  }
  if (nota.nRec) return false;
  const ate = coerceToMicros(nota.proximaConsultaEm);
  return ate != null && ate > agoraUs;
}

/** A filial's `enviNfe` audit-log subcollection, via the validated handle. */
export function enviNfeCollection(fs: Firestore, filialId: string) {
  return enviNfeMsgCollection.ref(fs, { filialId });
}

/**
 * Build a typed write payload for a SEFAZ `autorizarLote` round-trip
 * — to be persisted as a new doc under the filial's `enviNfe`
 * subcollection. Mirrors Flutter's
 * `EnviNFeMsg.fromRetEnviNFeSchema` at
 * `.old/packages/nfe_client/lib/src/models.dart:333`.
 *
 * The response is JSON-stringified into `xml_retorno` for Phase A —
 * preserves every field we use (nRec, cStat, protocols, errors). If
 * raw SEFAZ XML is ever needed for external audit, that's a library
 * change (return `{ parsed, raw }` from `autorizarLote`).
 */
export function buildEnviNFeMsgFromLote(params: {
  chave: string;
  idLote: number;
  tpEmis: TpEmis;
  signedXml: string;
  retEnvi: Awaited<ReturnType<typeof autorizarLote>>;
  /**
   * Pre-stringified `retEnvi`. Batch callers pass this once per chunk so
   * the same lote response isn't re-serialized once per chave (PR-δ);
   * defaults to stringifying `retEnvi` for the single-pedido path.
   */
  retEnviJson?: string;
  /** `'1'` (sync) for 1-NFe lotes; `'0'` (async) for N>1 batches. */
  indSinc: '0' | '1';
}): Record<string, unknown> {
  const now = new Date().toISOString();
  return enviNfeMsgCollection.parse({
    targetsChnfe: [params.chave],
    idLote: params.idLote,
    indSinc: params.indSinc,
    xml_enviado: params.signedXml,
    xml_retorno: params.retEnviJson ?? JSON.stringify(params.retEnvi),
    nRec: params.retEnvi.infRec?.nRec ?? null,
    cStat: params.retEnvi.cStat,
    xMotivo: params.retEnvi.xMotivo,
    error: null,
    tpEmis: params.tpEmis,
    estado: ESTADO_ENVI_NFE_MSG.respondido,
    timestamp: now,
    ultima_modificacao: now,
  });
}

/**
 * Build a typed write payload for a `consReciNFe` (preferred — has
 * the lote receipt) or `consSitNFe` (fallback — by chave) round-trip.
 * The `nRec` is carried forward from the originating lote message so
 * a single chave's audit chain stays linkable.
 */
export function buildEnviNFeMsgFromConsulta(params: {
  chave: string;
  nRec: string | null;
  ret: Awaited<ReturnType<typeof consultarLote>> | Awaited<ReturnType<typeof consultarSituacaoNFe>>;
  tpEmis: TpEmis;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  return enviNfeMsgCollection.parse({
    targetsChnfe: [params.chave],
    idLote: null,
    indSinc: null,
    xml_enviado: null,
    xml_retorno: JSON.stringify(params.ret),
    nRec: params.nRec,
    cStat: params.ret.cStat,
    xMotivo: params.ret.xMotivo,
    error: null,
    tpEmis: params.tpEmis,
    estado: ESTADO_ENVI_NFE_MSG.concluido,
    timestamp: now,
    ultima_modificacao: now,
  });
}

/**
 * Project a `consultarLote` response onto a `SefazOutcome` for our
 * specific chave. The lote-level cStat is `104` (processado) — the
 * authoritative per-NFe status lives in `protNFe[i].infProt.cStat`.
 * When no matching protocol is in the response (lote still in
 * processing — cStat=105) fall back to the lote-level outcome so
 * `applyOutcome` polls again.
 */
export function outcomeFromConsReci(
  ret: Awaited<ReturnType<typeof consultarLote>>,
  chave: string,
): SefazOutcome {
  const ourProt = ret.protNFe?.find((p) => p.infProt.chNFe === chave);
  if (ourProt) return outcomeFromInfProt(ourProt.infProt);
  return outcomeFromRetConsRec(ret);
}

/**
 * Look up the latest `EnviNFeMsg` whose `targetsChnfe` includes `chave`
 * AND that carries a non-null `nRec` — the receipt we need to call
 * `consultarLote`. Returns null when no recoverable msg exists (e.g.
 * the pedido was never sent, or only `consSit` messages were persisted
 * for an externally-recovered chave).
 */
export async function findLatestEnviNFeMsgWithNRec(
  fs: Firestore,
  filialId: string,
  chave: string,
): Promise<EnviNFeMsg | null> {
  const snap = await enviNfeCollection(fs, filialId)
    .where('targetsChnfe', 'array-contains', chave)
    .orderBy('timestamp', 'desc')
    .limit(10)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as EnviNFeMsg;
    if (data.nRec) return data;
  }
  return null;
}

/**
 * Project a persisted `NotaFiscalEletronica` onto the route's `EmitResult`
 * shape (`reused: true`) — used whenever the emit sends nothing and reports the
 * doc as it is: an existing bloqueada nfe, one in flight on a receipt, one with
 * a send in progress (#1675), a pós-EPEC claim refused, a final doc the
 * `consultarPedido` CLI skips.
 */
export function existingToEmitResult(
  pedidoId: string,
  nfeId: string,
  nota: NotaFiscalEletronica,
): EmitResult {
  return {
    nfeId,
    pedidoId,
    estado: nota.estado,
    chave: nota.chave ?? '',
    nRec: nota.nRec ?? null,
    cStat: nota.cStat ?? '',
    xMotivo: nota.xMotivo ?? '',
    reused: true,
  };
}

/**
 * Project a guarded write that was REFUSED onto the route's `EmitResult` — the
 * doc's live truth, as `reused: true` (the {@link existingToEmitResult}
 * precedent): that state was written by ANOTHER run, so apps/web must never
 * count, say, a concurrent emit's `aprovada` as this run's success. `chave` is
 * reported only when the live doc carries none: the chave this run SENT (a
 * refused outcome write — those bytes did reach SEFAZ), or `''` when this run's
 * chave was never persisted nor sent (a refused batch 4b anchor).
 */
export function recusaToEmitResult(
  pedidoId: string,
  nfeId: string,
  chave: string,
  recusa: RecusaDeGravacao,
): EmitResult {
  return {
    nfeId,
    pedidoId,
    estado: recusa.estadoAtual,
    chave: recusa.chaveAtual ?? chave,
    nRec: recusa.nRecAtual,
    cStat: recusa.cStatAtual ?? '',
    xMotivo: recusa.xMotivoAtual ?? '',
    reused: true,
  };
}

/**
 * Final-state patch when a duplicidade-class outcome can't be recovered:
 * keeps cStat + the SEFAZ-supplied xMotivo (with its [chNFe:...] /
 * [nRec:...] markers) visible to the operator, appends a short reason
 * tail, and flips estado to `error`. No SEFAZ calls happen after this.
 */
export function markAsLost(patch: NFeStatePatch, reason: string): NFeStatePatch {
  return {
    ...patch,
    estado: ESTADO_NFE.error,
    xMotivo: `${patch.xMotivo} | ${reason}`,
  };
}

/**
 * The ONLY legal way to clear the anti-loss anchor: in the same write that
 * persists the `nfeProc` embedding the very same signed XML (issue #128 —
 * keeping both roughly doubles the XML payload per authorized doc, and the
 * Firestore 1 MiB doc limit is the pressure point). Atomicity is the
 * guarantee that the signed XML is never lost: either the write fails and
 * `xml_assinado` stays, or it succeeds and `xml_nfe_proc` carries the XML.
 * `null` (not `FieldValue.delete()`) because the nfev4 schema requires the
 * field to be present (`.nullable()` without `.optional()`).
 *
 * Every authorization path builds its persist extras here, so this is also the
 * one writer of what is derived from the proc: `totais` (#1491) and
 * `data_autorizacao` (#1743).
 */
export function swapAnchorForProc(nfeProcXml: string): {
  xml_nfe_proc: string;
  xml_assinado: null;
  totais?: NFeTotais;
  data_autorizacao?: MillisSinceEpoch;
} {
  // `totais` rides this same write on purpose (#1491): it is a pure function of
  // the very bytes being persisted, so there is no window in which the XML and
  // the numbers derived from it can disagree, and no second writer to race
  // (root `CLAUDE.md` rule 7 — class A, self-contained).
  //
  // ⚠️ OMITTED, never `null`, when the parse fails. A merge patch that carries
  // the key would overwrite a good stored block with `null`; omitting it leaves
  // whatever is there untouched. That absence is meant to stay legible to the
  // monthly apuração planned in #1491, which will count unreadable notes and
  // refuse to publish a rate while any exist — that consumer is NOT written
  // yet, so today the absence is simply preserved rather than acted on.
  const totais = extrairTotaisNFe(nfeProcXml);
  // `data_autorizacao` (#1743) follows the same rule for the same reasons: the
  // protocol's own `dhRecbto`, read from these bytes in ms (the schema's unit),
  // and OMITTED when it does not read as an absolute instant. Never the server
  // clock: the authorization instant is SEFAZ's, not ours.
  const dataAutorizacao = extrairDataAutorizacao(nfeProcXml);
  return {
    xml_nfe_proc: nfeProcXml,
    xml_assinado: null,
    ...(totais != null ? { totais } : {}),
    ...(dataAutorizacao != null ? { data_autorizacao: dataAutorizacao } : {}),
  };
}

/**
 * The SEFAZ protocol shape `buildNFeProcSafe` pairs with a signed `<NFe>` —
 * pulled from its own signature so this file needs no direct `TProtNFe`
 * import (mirrors how callers already derive it from a SOAP response type).
 */
type ProtNFe = Parameters<typeof buildNFeProcSafe>[1];

/**
 * Single guard + build + warn for the digest-safe `<nfeProc>` stitch (#396),
 * shared by every site that can reach an 'autorizada' outcome:
 * `applyAutorizadoOutcome` (emit), `reconcileByRecibo`, `consultarChavePersistida`
 * and the backstop sweep's consSit branch. Each of those differs only in HOW
 * it knows the protocol still belongs to the bytes it holds — a
 * `finalChave === chave` compare, a `!chaveSwapped` flag, or a `chNFe` field
 * match — so that check is the caller's `chaveMatches` argument; everything
 * else (the 'autorizada' gate, the presence checks, the digest guard via
 * `buildNFeProcSafe`, the mismatch warning) lives here exactly once.
 *
 * Returns the nfeProc XML on success, or `null` when the outcome isn't
 * authorized, the inputs are incomplete, `chaveMatches` is false, or the
 * digest guard refused the pairing. Callers feed a non-null result into
 * `swapAnchorForProc` to build the persist extras.
 */
export function buildProcForAuthorizedOutcome(params: {
  /** `applyOutcome`'s resulting cStat for this NF-e. */
  cStat: string;
  /** False whenever the local signed bytes no longer match `prot`'s chave. */
  chaveMatches: boolean;
  /** The signed `<NFe>` bytes this protocol would be paired with. */
  signedXml: string | null;
  /** The SEFAZ protocol for our chave, when the round-trip surfaced one. */
  prot: ProtNFe | null;
  /** Log-line source tag, e.g. `nfe/orchestrator`, `nfe/reconcile`. */
  logTag: string;
  chave: string;
}): string | null {
  if (
    !params.chaveMatches ||
    classifyCStat(params.cStat) !== 'autorizada' ||
    params.prot == null ||
    params.signedXml == null
  ) {
    return null;
  }
  const proc = buildNFeProcSafe(params.signedXml, params.prot);
  if (proc.digest === 'mismatch') {
    console.warn(
      `[${params.logTag}] chave ${params.chave}: local DigestValue differs from the ` +
        'protNFe digVal — skipping the <nfeProc> build; the doc stays aprovada WITHOUT ' +
        'xml_nfe_proc (xml_assinado kept; fetch the authorized XML via DistDFe/manual import)',
    );
  }
  return proc.xml;
}

/**
 * Shared patch → Firestore merge-data mapping used by BOTH `persistPatch` and
 * `persistPatchUnlessFinal` — the two must always write the same shape.
 *
 * Preserve `nRec`: omit it from the merge when the new patch lacks
 * one (e.g. consSit responses don't carry an nRec), so we don't
 * overwrite the value the lote-receipt response (cStat=103) saved.
 * The authoritative receipt always lives in the enviNfe audit log
 * anyway; this copy is just for the NFCell.
 *
 * `extras` lets the caller stamp other fields in the same write —
 * currently used for `xml_nfe_proc` on cStat=100 (autorizada, with the
 * `totais` and `data_autorizacao` `swapAnchorForProc` derives from it), a
 * recovered 539's `chave` (`extrasDaTrocaDeChave`) and the paced
 * `proximaConsultaEm`. Kept generic so future fields (e.g. `nProt`) can
 * ride along without another method.
 *
 * `proximaConsultaEm` (µs epoch) is the BACKSTOP sweep's due-gate: when the
 * patch leaves the doc still awaiting SEFAZ (`aguardandoResposta`), stamp the
 * task delay (deterministic — same value the Cloud Task is scheduled with)
 * PLUS `RECONCILE_SWEEP_GRACE_MS`, so the sweep only steps in once the task is
 * overdue (lost). Without the grace + determinism the sweep could drift ahead
 * of a healthy task and double-consult the same `nRec` — and with 656 now
 * terminal that risks a wrongful terminal error (#77 review). Any
 * terminal/other estado clears it to `null` so the doc stops being scanned.
 * An explicit `extras.proximaConsultaEm` override (rare) wins.
 */
function buildPersistData(
  patch: NFeStatePatch,
  extras?: Record<string, unknown>,
): Record<string, unknown> {
  const stampProxima =
    extras != null && Object.prototype.hasOwnProperty.call(extras, 'proximaConsultaEm');
  const proximaConsultaEm =
    patch.estado === ESTADO_NFE.aguardandoResposta
      ? nowMicros() +
        (nextConsultaDelayMs(patch.retries, patch.tMed) + RECONCILE_SWEEP_GRACE_MS) * 1000
      : null;
  return nfev4Collection.parseMerge({
    estado: patch.estado,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    retries: patch.retries,
    ...(patch.nRec != null ? { nRec: patch.nRec } : {}),
    ...(stampProxima ? {} : { proximaConsultaEm }),
    ...(extras ?? {}),
    ultima_modificacao: new Date().toISOString(),
  });
}

export async function persistPatch(
  nfeRef: FirebaseFirestore.DocumentReference,
  patch: NFeStatePatch,
  extras?: Record<string, unknown>,
): Promise<void> {
  await nfeRef.set(buildPersistData(patch, extras), { merge: true });
}

/**
 * The premise a `persistPatchUnlessFinal` write was decided on, re-checked on
 * the transaction's own `tx.get` snapshot: when ANY condition given does not
 * hold on the stored doc, nothing is written. Every field is optional and an
 * omitted one is not checked, so each caller states exactly its own premise.
 *
 *  - #512 / #1654 §1 (`persistirGuardadoPeloLote`, emitir.ts) ties the write
 *    to ONE lote — the reply answers the lote whose `idLote` the doc was
 *    stamped with before the send, and is stale for a doc a newer lote has
 *    re-stamped since. Two emit paths write through it: every member of an
 *    async lote reply without `infRec` (`persistLoteSemRecibo`), and a sync
 *    reply without our protNFe and without `infRec`, plus the anchor /
 *    blocking-terminal dispositions of its inline consult by chave
 *    (`applyAutorizadoOutcome`).
 *  - #513 / #1654 (`reconcileByRecibo`, and `reconcilePorChave` under it)
 *    ties each write to the receipt, the `retries` its decision was computed
 *    from, and an in-flight estado: its `data` was read before the
 *    `consReciNFe` await (and before the earlier docs' consSit calls), so a
 *    concurrent terminal `error`/`rejeitada` or a concurrent counted write by
 *    another runner must refuse the write rather than be overwritten by it.
 *    Every one of those writes that leaves the doc in flight is a COUNTED
 *    write (the `retries` as read + 1), so none of them ever lowers it.
 *  - #1675 extends the lote tie to EVERY write an emit run makes in answer to
 *    its SEFAZ round-trip (the main sync outcome, the async hand-off, the EPEC
 *    event, the pós-EPEC 468): the idLote is the run's claim token, so a run a
 *    newer claim superseded mid-SOAP can never overwrite that claim's doc.
 *  - #1675 also ties the writes decided on a doc read BEFORE a consult
 *    (`consultarChavePersistida`, the sweep's no-nRec branch) to that read
 *    (`expectedUpdateTime`) and to no live send (`refuseWhileReserved`).
 */
export interface PersistGuard {
  /** #512 — the lote this write answers, as stamped on the nfev4 doc (`String(idLote)`). */
  readonly expectedIdLote?: string;
  /** #513 — the receipt this write answers; refused when the stored `nRec` differs. */
  readonly expectedNRec?: string;
  /**
   * #513 — the `retries` this write was decided from; refused when the stored
   * `retries ?? 0` differs (another runner counted in between).
   */
  readonly expectedRetries?: number;
  /** #513 — refused unless the stored estado is in flight (`enviando` / `aguardandoResposta`). */
  readonly requireInFlight?: true;
  /**
   * #1675 — the doc's `updateTime` as the caller READ it before its SEFAZ
   * round-trip; refused when the snapshot's differs. Root `CLAUDE.md` rule 7,
   * tier 1, decided on the transaction's own snapshot: the patch was derived
   * from that read, so ANY write since — an emit claiming the doc, the owner's
   * outcome under the same idLote, the doc turning `'p'` — makes it stale.
   * Needs no field of the doc, so a legacy doc with no `idLote` is never
   * refused for that.
   */
  readonly expectedUpdateTime?: Timestamp;
  /**
   * #1675 — refused while {@link envioEmCurso} holds on the stored doc: a send
   * claimed BEFORE the caller's read is still live, and only its owner may
   * write (or release) the doc. `expectedUpdateTime` cannot see that one —
   * nothing changed since the read.
   */
  readonly refuseWhileReserved?: true;
}

/** True when every condition `guard` states holds on the stored doc. */
function guardHolds(
  guard: PersistGuard,
  current: NotaFiscalEletronica,
  updateTime: Timestamp | undefined,
): boolean {
  if (
    guard.expectedUpdateTime != null &&
    (updateTime == null || !updateTime.isEqual(guard.expectedUpdateTime))
  ) {
    return false;
  }
  if (guard.refuseWhileReserved === true && envioEmCurso(current, nowMicros())) {
    return false;
  }
  // `idLote` is stamped as `String(idLote)`; String() on both sides keeps a
  // read-tolerated legacy number comparable. A stored `null` never matches.
  if (
    guard.expectedIdLote != null &&
    (current.idLote == null || String(current.idLote) !== String(guard.expectedIdLote))
  ) {
    return false;
  }
  if (guard.expectedNRec != null && (current.nRec ?? null) !== guard.expectedNRec) {
    return false;
  }
  if (guard.expectedRetries != null && (current.retries ?? 0) !== guard.expectedRetries) {
    return false;
  }
  if (
    guard.requireInFlight === true &&
    current.estado !== ESTADO_NFE.enviando &&
    current.estado !== ESTADO_NFE.aguardandoResposta
  ) {
    return false;
  }
  return true;
}

/** What a refused write under a guard was answering — for the missing-doc error. */
function alvoDaGuarda(guard: PersistGuard): string {
  if (guard.expectedIdLote != null) return `o retorno do lote ${guard.expectedIdLote}`;
  if (guard.expectedNRec != null) return `o retorno do recibo ${guard.expectedNRec}`;
  if (guard.expectedUpdateTime != null) return 'a consulta de um documento lido antes dela';
  return 'a gravação guardada';
}

/** A write refused on the stored doc — the doc's live truth, for the caller to report. */
export interface RecusaDeGravacao {
  readonly written: false;
  /**
   * The doc's CURRENT estado that blocked the write — final, or one on
   * which a {@link PersistGuard} condition failed (re-stamped by a newer
   * lote, another receipt, counted by another runner, no longer in flight,
   * changed since the caller's read, a send still in progress).
   */
  readonly estadoAtual: EstadoNFe;
  readonly cStatAtual: string | null;
  readonly xMotivoAtual: string | null;
  /** The doc's CURRENT `nRec` — a newer lote's receipt when one re-stamped it. */
  readonly nRecAtual: string | null;
  /**
   * The doc's CURRENT chave — another run's when it regenerated the doc (a
   * batch placeholder claimed between 4a and 4b, #1675), `null` on a
   * chave-less placeholder.
   */
  readonly chaveAtual: string | null;
}

/** Outcome of `persistPatchUnlessFinal` — either written, or skipped with the doc's live truth. */
export type GuardedPersistResult = { readonly written: true } | RecusaDeGravacao;

/** The live truth of a doc a guarded write was refused on. */
function recusa(current: NotaFiscalEletronica): RecusaDeGravacao {
  return {
    written: false,
    estadoAtual: current.estado,
    cStatAtual: current.cStat ?? null,
    xMotivoAtual: current.xMotivo ?? null,
    nRecAtual: current.nRec ?? null,
    chaveAtual: current.chave ?? null,
  };
}

/**
 * TOCTOU-guarded variant of `persistPatch` for flows whose anti-regression
 * defense (`applyOutcome`'s cancelada/inutilizada check) runs against an
 * estado read BEFORE the SEFAZ round-trip: a doc that reaches a final estado
 * mid-flight (e.g. a concurrent cancelamento) must not be blindly overwritten.
 *
 * Runs a transaction that re-reads the doc; if its CURRENT estado is final
 * (`isEstadoFinalNFe`) and differs from `patch.estado`, the write is skipped
 * and `{ written: false, estadoAtual, ... }` returned so the caller can report
 * the doc's real state. Otherwise it writes exactly what `persistPatch` writes
 * (shared `buildPersistData` mapping).
 *
 * With a `guard` ({@link PersistGuard}) the write is ALSO skipped, with the
 * same `{ written: false, … }` result, when any condition it states fails on
 * the stored doc:
 *  - emitir.ts's `persistirGuardadoPeloLote` passes `expectedIdLote` — a
 *    stored `idLote` that differs (a stored `null` included) means a newer
 *    lote re-stamped the doc, so this reply is stale for it. Since #1675 it
 *    carries EVERY write an emit run makes in answer to its SEFAZ round-trip:
 *    #512's `persistLoteSemRecibo` (a lote reply without `infRec`, every
 *    member), the async 103 hand-off of a chunk, and `applyAutorizadoOutcome`
 *    — the main sync outcome (proc swap and a recovered 539's chave swap
 *    included) and the #1654 §1 no-receipt / anchor / blocking-terminal
 *    dispositions. The EPEC event write and the pós-EPEC 468 (epec.ts) pass
 *    it directly;
 *  - the writes decided on a doc read BEFORE a consult — `consultarChavePersistida`
 *    (the manual verify and the `consultarPedido` CLI) and the backstop
 *    sweep's consult-by-chave branch for docs without an `nRec` — pass
 *    `expectedUpdateTime` (the read's `updateTime`) + `refuseWhileReserved`
 *    (#1675): any write since the read, or a send claimed before it and still
 *    live, refuses the stale consult's write;
 *  - `reconcileByRecibo` (#513, #1654) uses it for EVERY write it makes, with
 *    `expectedNRec` + `expectedRetries` + `requireInFlight`: its in-flight
 *    query runs before the `consReciNFe` await, so an estado filter on that
 *    pre-read is no guard at write time. The counted in-flight writes (105,
 *    lote-level non-answer — paced by `proximaConsultaEm` on a paralisado
 *    receipt —, a recovered 539) and the 104-with-our-protNFe (proc swap
 *    included) / 539 / blocking-terminal / cap writes state the `retries` as
 *    read; the by-chave branch (`reconcilePorChave`) states it as read for
 *    its counted write and as just counted for every write after its consSit.
 *    A concurrent terminal (a 656 `error`, a 217 `rejeitada`) or a concurrent
 *    counted write by another runner therefore refuses the write instead of
 *    being overwritten by a decision taken on a pre-read.
 * Under a guard a MISSING doc throws `NFeDocAusenteError` (an
 * `NFeOrchestratorError`, carrying the doc's `path`) and nothing is written —
 * every guarded writer anchored the doc before its SEFAZ call, so a merge
 * would only mint a partial doc; `reconcileByRecibo` skips that one doc and
 * reconciles the rest of the lote (#1654). Without a guard it is written as
 * before. Every check is decided on the `tx.get` snapshot, never on a
 * pre-read.
 *
 * A recovered 539's chave swap rides the caller's own write as `extras`
 * (`extrasDaTrocaDeChave`, #1654 §2d), so a refused write swaps nothing
 * either — on every path that recovers one: the emit, `reconcileByRecibo`,
 * the manual verify and the sweep's consult-by-chave branch.
 */
export async function persistPatchUnlessFinal(
  fs: Firestore,
  nfeRef: FirebaseFirestore.DocumentReference,
  patch: NFeStatePatch,
  extras?: Record<string, unknown>,
  guard?: PersistGuard,
): Promise<GuardedPersistResult> {
  return await fs.runTransaction(async (tx): Promise<GuardedPersistResult> => {
    const snap = await tx.get(nfeRef);
    if (!snap.exists && guard != null) {
      // Thrown inside the callback: the transaction aborts (a non-Firestore
      // error is never retried) with no write.
      throw new NFeDocAusenteError(
        nfeRef.path,
        `nfev4 ${nfeRef.path} ausente ao gravar ${alvoDaGuarda(guard)} — nada gravado`,
      );
    }
    if (snap.exists) {
      const current = nfev4Collection.parseRead(snap.data(), nfeRef.path);
      const finalBlocks = isEstadoFinalNFe(current.estado) && current.estado !== patch.estado;
      const premiseFailed = guard != null && !guardHolds(guard, current, snap.updateTime);
      if (finalBlocks || premiseFailed) return recusa(current);
    }
    tx.set(nfeRef, buildPersistData(patch, extras), { merge: true });
    return { written: true };
  });
}

/**
 * Batch step 4b's anchor write (#1675): the generated + signed NF-e
 * (`docData`, a full doc carrying the send reservation) replaces the 4a
 * placeholder — or the reuse member's old doc — ONLY while that doc is still
 * stamped with THIS chunk's `idLote`. Between the chunk's allocation
 * transaction (4a) and this write, a concurrent single emit may have claimed
 * the same doc (its own idLote, its own chave for the same nNF, already sent);
 * a plain overwrite would then persist and send a SECOND chave for that número.
 *
 * Class A (root `CLAUDE.md` rule 7): 4a decided to (re)generate this member on
 * its own snapshot, and every premise of that decision is re-derived here from
 * the `tx.get` snapshot — not just the lote stamp. Refused, nothing written,
 * when the doc is final, carries another `idLote`, carries a
 * `STATUS_BLOQUEADORES` cStat (a consult between 4a and 4b wrote a blocking
 * terminal — the número may be held under another chave), is in flight on a
 * receipt (`nRec`), or is under a live send reservation (`envioEmCurso`). None
 * of those changes the idLote, so the stamp alone would let the regenerated
 * anchor overwrite them and the chunk send it. The caller drops the member from
 * the lote and reports the live doc. A missing doc throws `NFeDocAusenteError`
 * (4a anchored every member, so a merge would only mint a partial doc).
 */
export async function gravarAncoraDoLote(
  fs: Firestore,
  nfeRef: FirebaseFirestore.DocumentReference,
  docData: Record<string, unknown>,
  idLote: number,
): Promise<GuardedPersistResult> {
  return await fs.runTransaction(async (tx): Promise<GuardedPersistResult> => {
    const snap = await tx.get(nfeRef);
    if (!snap.exists) {
      throw new NFeDocAusenteError(
        nfeRef.path,
        `nfev4 ${nfeRef.path} ausente ao gravar a âncora do lote ${idLote} — nada gravado`,
      );
    }
    const current = nfev4Collection.parseRead(snap.data(), nfeRef.path);
    const emVooComRecibo =
      current.nRec != null &&
      (current.estado === ESTADO_NFE.enviando || current.estado === ESTADO_NFE.aguardandoResposta);
    if (
      isEstadoFinalNFe(current.estado) ||
      !guardHolds({ expectedIdLote: String(idLote) }, current, snap.updateTime) ||
      isBloqueada(current.cStat) ||
      emVooComRecibo ||
      envioEmCurso(current, nowMicros())
    ) {
      return recusa(current);
    }
    tx.set(nfeRef, docData);
    return { written: true };
  });
}

/** Outcome of {@link reivindicarEnvio}: the claimed doc, or the live one a claim was refused on. */
export type ReivindicacaoDeEnvio =
  | {
      readonly claimed: true;
      readonly nota: NotaFiscalEletronica & { chave: string; xml_assinado: string };
    }
  | { readonly claimed: false; readonly nota: NotaFiscalEletronica };

/**
 * The pós-EPEC transmission's claim (#1675): stamp `idLote` + the send
 * reservation on an EPEC-approved doc before its full NF-e goes to the home
 * SEFAZ. Without it an operator emit and the backstop sweep could both
 * transmit the same `'p'` doc, and — once every outcome write is owned by its
 * idLote — the transmission's own outcome could never be written.
 *
 * Class A (root `CLAUDE.md` rule 7): re-reads the doc and claims it only while
 * it is still `'p'` and no send is in progress on it ({@link envioEmCurso});
 * otherwise nothing is written and the live doc comes back for the caller to
 * report as `reused`. The returned nota is the snapshot the claim was decided
 * on — the caller sends ITS `xml_assinado`, never a pre-read. A claimed doc
 * with no chave or no signed XML cannot be transmitted, and throws.
 */
export async function reivindicarEnvio(
  fs: Firestore,
  nfeRef: FirebaseFirestore.DocumentReference,
  idLote: number,
): Promise<ReivindicacaoDeEnvio> {
  return await fs.runTransaction(async (tx): Promise<ReivindicacaoDeEnvio> => {
    const snap = await tx.get(nfeRef);
    if (!snap.exists) {
      throw new NFeDocAusenteError(
        nfeRef.path,
        `nfev4 ${nfeRef.path} ausente ao reivindicar a transmissão pós-EPEC — nada gravado`,
      );
    }
    const nota = nfev4Collection.parseRead(snap.data(), nfeRef.path);
    const agora = nowMicros();
    if (nota.estado !== ESTADO_NFE.epecAprovado || envioEmCurso(nota, agora)) {
      return { claimed: false, nota };
    }
    if (!nota.chave || !nota.xml_assinado) {
      throw new NFeOrchestratorError(
        `nfev4 ${nfeRef.path}: EPEC aprovado sem chave/xml_assinado persistidos — ` +
          'não é possível transmitir a NF-e completa.',
      );
    }
    const reserva = envioEmCursoAte(agora);
    tx.set(
      nfeRef,
      nfev4Collection.parseMerge({
        idLote: String(idLote),
        proximaConsultaEm: reserva,
        ultima_modificacao: new Date().toISOString(),
      }),
      { merge: true },
    );
    return {
      claimed: true,
      nota: {
        ...nota,
        chave: nota.chave,
        xml_assinado: nota.xml_assinado,
        idLote: String(idLote),
        proximaConsultaEm: reserva,
      },
    };
  });
}
