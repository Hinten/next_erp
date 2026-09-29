/**
 * Async lote reconciliation — the core shared by the `reconciliarNfe` Cloud
 * Task (`runReconcile`, the primary trigger) and the backstop sweep
 * (`processar-pendentes`).
 *
 * Consults a lote **by receipt** (`consReciNFe(nRec)` — one call for the whole
 * lote, never a `consSit` per chave as a matter of course: that is the #77
 * consumo-indevido vector) and applies the per-chave outcome to every nfev4 doc
 * in the lote. Decides terminal vs still-pending; the re-enqueue (Cloud Task)
 * decision is left to the caller so this stays a SEFAZ + Firestore operation
 * with no scheduling of its own.
 *
 * **One decision per round** (#1654, `decidirRodadaDoRecibo` in
 * `./lote-sem-protocolo`), total over the cStat space, from our `protNFe` in
 * the reply (STRICT chave equality) or else the lote cStat:
 *   - `aplicar-protocolo` — our protNFe carries a final answer: applied, with
 *     the digest-safe `<nfeProc>` stitch on an authorization.
 *   - `recuperar-539` — `recover539IfNeeded`.
 *   - `por-chave` — a processed lote (104) without our protNFe, a per-NF-e
 *     verdict at LOTE level (never a final estado without a protocol), a 106,
 *     or a duplicidade other than 539 (204/205/218/635, in our protNFe or at
 *     lote level): `reconcilePorChave` counts the round, then makes at most ONE
 *     `consSitNFe` for the chave (none on a 106's first round), read through
 *     one recovery table — behind a consSit breaker that stops further consSit
 *     calls after a 656 or an unavailable service, for the rest of this lote
 *     and, when the caller owns the cell (`disjuntor`), for the filial's next
 *     lotes too (an outage only for those at the same authorizer).
 *   - `aguardar` — nothing about the chave (103/105/107/108/109/113/114, or a
 *     cStat that is not TStat-shaped): counted, and consulted again.
 *   - `terminal` — a 656, or a rejection of the `consReciNFe` query itself.
 *
 * Hard rules baked in here (NOT overridable by the caller):
 *   - **Every round that leaves a doc in flight advances its `retries` by
 *     exactly one** — a 105, a lote-level non-answer, an `enviando` doc (now
 *     written `aguardandoResposta`), a recovered 539, a round resolved by
 *     chave — so a doc gets at most `MAX_RECONCILE_ATTEMPTS` receipt rounds
 *     and at most that many consSit calls between two operator actions (a
 *     round a transient Firestore failure interrupted is the exception: it
 *     stays uncounted unless its by-chave count had already landed — below). The
 *     round that reaches the cap goes terminal `error` with a "verificar
 *     manualmente" motivo. The writers that still reset the counter are
 *     outside this module: the manual verify (`consultarChavePersistida`,
 *     operator-initiated), a new emit lote, and the sweep's consult-by-chave
 *     branch for docs without an `nRec`.
 *   - **Every terminal this decision makes blocks re-emission** — by chave,
 *     at the cap, a 656 or a refused receipt query. It carries the round's
 *     own 103/104/105, or 103 — SEFAZ issued this receipt, so the número may
 *     be held — with the real cStat in xMotivo (`terminalBloqueante`). A
 *     lote-level 656 is terminal and never retried: re-querying after a 656
 *     is a SEFAZ-ban precedent (#77). The exception is the 539 recovery, which
 *     keeps its #243 terminals: an unrecovered 539 is `error` with cStat 539,
 *     and a recovered lote's final answer is applied as it comes.
 *   - **A paralisado receipt (108/109/113/114) is paced**
 *     (`esperaMinimaDoRecibo`): the counted write's `proximaConsultaEm` waits
 *     `RECONCILE_INDISPONIVEL_DELAY_MS`, as does the task's re-enqueue, so the
 *     sweep never runs ahead of the task.
 *   - The 105 and 104-with-our-protNFe patches are byte-identical to the
 *     pre-#1654 ones.
 *
 * Every write of a lote reconcile goes through the guarded persist
 * (persistPatchUnlessFinal), under the premise it was decided on: this
 * receipt, the `retries` as the in-flight query read it (or, inside
 * `reconcilePorChave`, as just counted), an in-flight estado (rule 7). That
 * query ran BEFORE the `consReciNFe` await, so a concurrent terminal or another
 * runner's counted write refuses the write instead of being overwritten by it;
 * the doc's live estado is tallied. A recovered 539's chave swap rides that
 * same guarded write (`extrasDaTrocaDeChave`, #1654 §2d), so a refused write
 * swaps nothing either.
 *
 * **One failing doc does not abort the round** (#1654 §2c) — but only for the
 * causes named here, every other class is rethrown (rule 6):
 *   - a doc deleted since the in-flight query (`NFeDocAusenteError` from the
 *     guarded persist) is skipped, untallied — there is nothing to reconcile;
 *   - a TRANSIENT Firestore failure (`isTransientGrpcError`: gRPC 4, 8, 10, 13,
 *     14) leaves the doc pending — its live state is unknown, and the next round
 *     re-reads it. It is uncounted, except in a round resolved by chave:
 *     `reconcilePorChave` writes the count BEFORE its consSit, so a failure
 *     after that call keeps the count and loses that consSit's verdict (the
 *     next round consults again — on the cap round, the hard stop instead);
 *   - a SOAP failure of the 539 recovery's own `consReciNFe` (transport, XSD,
 *     XML — the set the by-chave consSit absorbs) counts the round like any
 *     other in flight, on THIS receipt (the 539's `[nRec:]` marker never
 *     re-keys the doc), so the doc goes terminal at the cap instead of the run
 *     throwing forever.
 * The consSit breaker lives in a cell the CALLER owns (`disjuntor`), written in
 * place at every trip, so a trip survives a round that throws anyway: the sweep
 * still carries it to the filial's next lote. On the task path a throw still
 * reaches the queue retry without it (the cell dies with the run); the causes
 * above no longer throw, so that is left to anything else thrown after a trip —
 * a bug, a non-transient Firestore error (gRPC 3, 7, 9, …), any other class.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { nowMicros } from '@delfrance/core/datetime';
import { nfev4Collection } from '@delfrance/data/admin/collections';
import { isTransientGrpcError } from '@delfrance/data/admin/grpcErrors';
import {
  applyOutcome,
  consultarLote,
  esperaMinimaDoRecibo,
  MAX_RECONCILE_ATTEMPTS,
  nextConsultaDelayMs,
  NFeTransportError,
  NFeXmlError,
  NFeXsdValidationError,
  RECONCILE_SWEEP_GRACE_MS,
  type SefazCall,
  type TpEmis,
  type TRetConsReciNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type EstadoNFe, type NotaFiscalEletronica } from '@delfrance/schemas';

import { safeErrorShape, safeLog } from '../log';
import type { NFeRuntime } from '../runtime';
import { NFeDocAusenteError } from './errors';
import { sefazCallFor } from './sefaz-call';
import { extrasDaTrocaDeChave, recover539IfNeeded } from './recover539';
import {
  type BloqueioConsSit,
  CSTAT_LOTE_PENDENTE,
  decidirRodadaDoRecibo,
  type DisjuntorConsSit,
  reconcilePorChave,
  terminalBloqueante,
} from './lote-sem-protocolo';
import {
  buildEnviNFeMsgFromConsulta,
  buildProcForAuthorizedOutcome,
  enviNfeCollection,
  outcomeFromConsReci,
  type PersistGuard,
  persistPatchUnlessFinal,
  swapAnchorForProc,
} from './audit';

/**
 * Summary of one lote reconcile — the caller re-enqueues iff `stillPending > 0`.
 * Each doc is tallied by the estado this reconcile wrote or — when the guard
 * refused the write because the doc changed concurrently — by its live estado.
 */
export interface ReconcileLoteResult {
  /** nfev4 docs found for this `nRec` that were still in flight. */
  readonly scanned: number;
  /**
   * Docs left `aguardandoResposta` — re-enqueue. Every round that leaves a doc
   * in flight under the attempt cap: a 105, a lote-level non-answer, a round
   * resolved by chave that is not settled yet (an `enviando` doc included —
   * it is written `aguardandoResposta`), and a doc whose round a transient
   * Firestore failure interrupted (its live state is unknown). A doc deleted
   * since the in-flight query is in no tally.
   */
  readonly stillPending: number;
  /** Docs that reached a terminal non-error state (aprovada / cancelada / …). */
  readonly recovered: number;
  /**
   * Docs flipped to terminal `error` (656 consumo-indevido, a refused receipt
   * query, cap exceeded, a chave the consSit could not resolve). A rejeitada
   * counts as `recovered`.
   */
  readonly errored: number;
  /** Lote-level consult cStat, for the response/log line. */
  readonly cStat: string;
  /**
   * The consSit breaker as this reconcile left it — the given cell's, or one a
   * consSit of this lote tripped. The cell the caller passed holds the same
   * value (and holds it even when the reconcile throws). A caller that
   * reconciles several lotes in a row (the backstop sweep) carries it into the
   * next call of the same scope: a 656 into the filial's next lotes, since the
   * 656 throttle is per CNPJ+IP, not per lote; an outage only into the
   * filial's next lotes at the same authorizer (`autorizadorDe` of the tpEmis).
   */
  readonly bloqueioConsSit: BloqueioConsSit | null;
}

/**
 * Reconcile every still-in-flight nfev4 doc of one lote against SEFAZ.
 *
 * @param attempt 0-based consult attempt from the task payload — used only for
 *   diagnostics; the authoritative cap is the per-doc `retries` counter, which
 *   every in-flight round advances by one (here, or in `reconcilePorChave`),
 *   so a re-delivered task can't escape the cap. The one round left uncounted
 *   is one a transient Firestore failure interrupted before its count landed (the doc stays pending,
 *   its live state unknown): a doc whose Firestore failure persists is
 *   re-enqueued with no cap, one `consReciNFe` per round.
 * @param disjuntor the consSit breaker CELL, owned by the caller and written in
 *   place at every trip (see {@link DisjuntorConsSit}): a sweep hands in the
 *   breaker a previous lote of this run tripped for the same scope — the SAME
 *   filial for a 656, the same filial + authorizer for an outage — and reads
 *   the cell back after the call, whether it returned or threw. Omitted (the
 *   task path — one lote per run) = a fresh cell of this run's own.
 */
export async function reconcileByRecibo(params: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  nRec: string;
  tpEmis: TpEmis;
  attempt: number;
  disjuntor?: DisjuntorConsSit;
}): Promise<ReconcileLoteResult> {
  const { fs, rt, filialId, nRec, tpEmis } = params;
  // Per-run consSit breaker for the by-chave branch: once a consSit of this
  // run answers 656 or finds the service down, the remaining docs are not
  // consulted (#513) — and the caller's cell keeps the trip (#1654).
  const disjuntor: DisjuntorConsSit = params.disjuntor ?? { bloqueio: null };

  // Docs of this lote that are still in flight. Query by receipt only
  // (single-field, index-free on Firestore Enterprise) and filter estado in
  // memory so an already-terminal doc (idempotent re-delivery) is skipped.
  const snap = await nfev4Collection.groupQuery(fs).where('nRec', '==', nRec).get();
  const inFlight = snap.docs.filter((d) => {
    const estado = (d.data() as NotaFiscalEletronica).estado;
    return estado === ESTADO_NFE.aguardandoResposta || estado === ESTADO_NFE.enviando;
  });
  if (inFlight.length === 0) {
    return {
      scanned: 0,
      stillPending: 0,
      recovered: 0,
      errored: 0,
      cStat: 'noop',
      bloqueioConsSit: disjuntor.bloqueio,
    };
  }

  // One consult by receipt for the whole lote. `consReciNFe` returns every
  // protocol; we map each chave to its own outcome below.
  const call: SefazCall = sefazCallFor(rt, tpEmis, 'NfeRetAutorizacao');
  const ret = await consultarLote(call, { nRec });

  let stillPending = 0;
  let recovered = 0;
  let errored = 0;
  const tally = (estado: EstadoNFe): void => {
    if (estado === ESTADO_NFE.aguardandoResposta) stillPending++;
    else if (estado === ESTADO_NFE.error) errored++;
    else recovered++;
  };

  const rodada: RodadaDoRecibo = { fs, rt, filialId, nRec, tpEmis, ret, disjuntor };
  for (const doc of inFlight) {
    const data = doc.data() as NotaFiscalEletronica;
    const chave = data.chave;
    if (!chave) continue; // defensive — an in-flight doc always carries its chave

    // One doc's failure is isolated only for the causes named in the header;
    // everything else — a bug, a deterministic Firestore error — is rethrown
    // (rule 6).
    try {
      tally(await reconciliarDoc(rodada, { ref: doc.ref, data, chave }));
    } catch (e) {
      if (e instanceof NFeDocAusenteError) {
        console.warn(
          `[nfe/reconcile] ${e.path} sumiu na rodada do recibo ${nRec} — ignorado, nada gravado`,
        );
        continue;
      }
      if (!isTransientGrpcError(e)) throw e;
      // name + message + code only (rule 9).
      safeLog(
        'error',
        `[nfe/reconcile] chave ${chave}: rodada do recibo ${nRec} falhou no Firestore — ` +
          'fica pendente para a próxima rodada',
        safeErrorShape(e),
      );
      stillPending++;
    }
  }

  return {
    scanned: inFlight.length,
    stillPending,
    recovered,
    errored,
    cStat: ret.cStat,
    bloqueioConsSit: disjuntor.bloqueio,
  };
}

/** What every doc of one receipt round shares. */
interface RodadaDoRecibo {
  readonly fs: Firestore;
  readonly rt: NFeRuntime;
  readonly filialId: string;
  readonly nRec: string;
  readonly tpEmis: TpEmis;
  /** The round's `consReciNFe` reply. */
  readonly ret: TRetConsReciNFe;
  readonly disjuntor: DisjuntorConsSit;
}

/**
 * One in-flight doc of a receipt round: decide, write under the guard, and
 * return the estado to tally — what was written, or the doc's live estado when
 * the guard refused the write. Throws what the caller isolates (a vanished doc,
 * a transient Firestore failure) and everything it does not.
 */
async function reconciliarDoc(
  rodada: RodadaDoRecibo,
  doc: {
    readonly ref: FirebaseFirestore.DocumentReference;
    readonly data: NotaFiscalEletronica;
    readonly chave: string;
  },
): Promise<EstadoNFe> {
  const { fs, rt, filialId, nRec, tpEmis, ret, disjuntor } = rodada;
  const { data, chave } = doc;

  // Audit the round-trip per chave (mirrors the emit path), keeping the
  // nRec→chave audit chain linkable for findLatestEnviNFeMsgWithNRec.
  await enviNfeCollection(fs, filialId).add(
    buildEnviNFeMsgFromConsulta({ chave, nRec, ret, tpEmis }),
  );

  // Our protocol in the lote reply — STRICT chave equality; a near-miss is
  // missing, never ours.
  const ourProt = ret.protNFe?.find((p) => p.infProt.chNFe === chave) ?? null;
  const decisao = decidirRodadaDoRecibo(ret.cStat, ourProt?.infProt.cStat ?? null);

  // Resolved by chave (#513, #1654): counted, then at most one consSit.
  if (decisao.tipo === 'por-chave') {
    const r = await reconcilePorChave({
      fs,
      rt,
      filialId,
      tpEmis,
      nRec,
      ret,
      chave,
      data,
      nfeRef: doc.ref,
      motivo: decisao.motivo,
      disjuntor,
    });
    return r.estado;
  }

  const tentativa = (data.retries ?? 0) + 1;
  const outcome = outcomeFromConsReci(ret, chave);
  let patch = applyOutcome({ estado: data.estado, retries: data.retries }, outcome);

  // Nothing about the chave: it never leaves flight here, even when
  // `applyOutcome` maps a cStat that is not TStat-shaped to rejeitada — that
  // would free a número SEFAZ may hold.
  if (
    decisao.tipo === 'aguardar' &&
    patch.estado !== ESTADO_NFE.enviando &&
    patch.estado !== ESTADO_NFE.aguardandoResposta
  ) {
    patch = { ...patch, estado: ESTADO_NFE.aguardandoResposta };
  }

  // A 656, or a refused consReci query: no further SEFAZ call can help, and
  // SEFAZ issued this receipt — a BLOCKING terminal, never a número-freeing
  // rejeitada or a non-blocking 656.
  if (decisao.tipo === 'terminal') {
    patch = terminalBloqueante(
      patch,
      ret.cStat,
      `recibo ${nRec}: cStat ${outcome.cStat}, sem nova consulta — verificar manualmente`,
    );
  }

  // What a counted round says it lacks — the receipt's silence, unless the
  // 539 recovery below failed on its own SOAP call.
  let semResposta = 'sem resposta para a chave';

  // cStat=539 (duplicidade com chave diferente) must NOT linger in
  // aguardandoResposta: recover the SEFAZ-asserted chave if it is one we
  // emitted, else flip to terminal `error` (#243). pedidoId comes from the
  // doc path `pedidos/{pedidoId}/nfev4/{nfeId}`. The recovery writes nothing
  // to the nfev4 doc (only its consReciNFe audit entry): its chave swap rides the guarded write below (#1654 §2d). A recovery that
  // leaves the doc in flight is counted below like any other round — on the
  // doc's own `retries`, never restarted — and so is one whose OWN SOAP call
  // failed: the doc goes terminal at the cap instead of the run throwing.
  let chaveOverride: string | undefined;
  if (decisao.tipo === 'recuperar-539') {
    try {
      const recovered539 = await recover539IfNeeded({
        fs,
        bundle: { pedidoId: doc.ref.parent?.parent?.id ?? doc.ref.path, filialId },
        rt,
        tpEmis,
        outcome,
        patch,
      });
      patch = recovered539.patch;
      // A 539 chave-swap leaves our local signed XML pointing at the old chave —
      // skip the <nfeProc> build for it (mirrors the emit path).
      chaveOverride = recovered539.chaveOverride;
    } catch (e) {
      if (
        !(
          e instanceof NFeTransportError ||
          e instanceof NFeXsdValidationError ||
          e instanceof NFeXmlError
        )
      ) {
        throw e;
      }
      // name + message only — `NFeTransportError.responseBody` stays server-side.
      safeLog(
        'error',
        `[nfe/reconcile] chave ${chave}: recuperação do 539 falhou no recibo ${nRec}`,
        safeErrorShape(e),
      );
      // `patch` is still the 539 as read — null-mapped, so in flight — and is
      // counted below. Its `nRec` is our protNFe's `[nRec:]` marker, the
      // receipt of the OTHER chave's lote: counted as it is, the write would
      // re-key the doc onto it, the task's next round would find nothing on
      // this receipt, and the sweep would resolve our chave by chave against a
      // lote that never held it (a 217 there frees a número SEFAZ holds). So
      // the doc stays on THIS receipt — a marker never re-keys a doc, as in
      // `reconcilePorChave`.
      patch = { ...patch, nRec };
      semResposta = `recuperação do 539 falhou (${e.name})`;
    }
  }

  // Every round that leaves the doc in flight counts, by exactly one — an
  // `enviando` doc is written `aguardandoResposta` — and the round that
  // reaches MAX_RECONCILE_ATTEMPTS goes terminal with a BLOCKING cStat and a
  // manual-review motivo (never re-queried forever — #77). A 105 keeps its
  // own xMotivo and its "lote não processado" terminal, byte for byte.
  if (patch.estado === ESTADO_NFE.enviando || patch.estado === ESTADO_NFE.aguardandoResposta) {
    const pendente = patch.cStat === CSTAT_LOTE_PENDENTE;
    patch = {
      ...patch,
      estado: ESTADO_NFE.aguardandoResposta,
      retries: tentativa,
      xMotivo: pendente
        ? patch.xMotivo
        : `${patch.xMotivo} | ${semResposta} no recibo ${nRec} ` +
          `(consulta ${tentativa}/${MAX_RECONCILE_ATTEMPTS})`,
    };
    if (tentativa >= MAX_RECONCILE_ATTEMPTS) {
      patch = terminalBloqueante(
        patch,
        ret.cStat,
        pendente
          ? `lote não processado após ${MAX_RECONCILE_ATTEMPTS} consultas — verificar manualmente`
          : `${semResposta} após ${MAX_RECONCILE_ATTEMPTS} consultas — verificar manualmente`,
      );
    }
  }

  // Build <nfeProc> when SEFAZ authorized this chave and we still hold the
  // matching signed XML — same atomic anchor-clear as the emit path (#128).
  // The digest-safe stitch (#396, via `buildProcForAuthorizedOutcome`)
  // refuses to pair the protocol with bytes it did not authorize (e.g. a
  // pre-fix retry overwrote the anchor with a regenerated XML); the doc
  // then stays aprovada WITHOUT proc for a DistDFe/manual fetch.
  const nfeProcXml = buildProcForAuthorizedOutcome({
    cStat: patch.cStat,
    chaveMatches: chaveOverride == null,
    signedXml: data.xml_assinado,
    prot: ourProt,
    logTag: 'nfe/reconcile',
    chave,
  });

  // A paralisado receipt paces the doc's due-gate like the task's re-enqueue
  // (`runReconcile`): decided from the LOTE cStat, before any write, so every
  // doc of the round agrees and the sweep never runs ahead of the task.
  const espera =
    patch.estado === ESTADO_NFE.aguardandoResposta ? esperaMinimaDoRecibo(ret.cStat) : null;
  // A proc and a chave swap never meet: a swap forces `chaveMatches: false`.
  const troca = extrasDaTrocaDeChave(chaveOverride);
  const pacing =
    espera != null
      ? {
          proximaConsultaEm:
            nowMicros() +
            (Math.max(nextConsultaDelayMs(tentativa), espera) + RECONCILE_SWEEP_GRACE_MS) * 1000,
        }
      : undefined;
  const extras =
    nfeProcXml != null
      ? swapAnchorForProc(nfeProcXml)
      : troca != null || pacing != null
        ? { ...troca, ...pacing }
        : undefined;

  // Rule 7: `data` was read by the in-flight query BEFORE the consReciNFe
  // await (and before the earlier docs' consSit awaits), so this write
  // re-checks, on the doc as it is at write time, the premise it was decided
  // on: still this receipt, still the `retries` as read, still in flight. A
  // concurrent terminal (a consSit verdict, a 656) or another runner's
  // counted write refuses it instead of being overwritten by it — and a
  // refused write carries a 539 chave swap with it, so nothing is swapped.
  const guarda: PersistGuard = {
    expectedNRec: nRec,
    expectedRetries: data.retries ?? 0,
    requireInFlight: true,
  };
  const gravado = await persistPatchUnlessFinal(fs, doc.ref, patch, extras, guarda);
  if (!gravado.written) {
    // The doc changed under us: report its LIVE estado, never the patch
    // this round decided on a stale read.
    console.warn(
      `[nfe/reconcile] chave ${chave}: gravação do recibo ${nRec} recusada — o doc mudou ` +
        `em paralelo (estado=${gravado.estadoAtual}, nRec=${gravado.nRecAtual ?? 'null'}); ` +
        'reportando o estado vivo',
    );
    return gravado.estadoAtual;
  }

  return patch.estado;
}
