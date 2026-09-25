/**
 * Async lote reconciliation — the core shared by the Cloud Task endpoint
 * (`/api/nfe/reconciliar`, the primary trigger) and the backstop sweep
 * (`processar-pendentes`).
 *
 * Consults a lote **by receipt** (`consReciNFe(nRec)` — one call for the whole
 * lote, never a `consSit` per chave as a matter of course: that is the #77
 * consumo-indevido vector) and applies the per-chave outcome to every nfev4 doc
 * in the lote. Decides terminal vs still-pending; the re-enqueue (Cloud Task)
 * decision is left to the caller so this stays a SEFAZ + Firestore operation
 * with no scheduling of its own.
 *
 * The one per-chave exception (#513): a PROCESSED lote (104) whose reply lacks
 * a `protNFe` for a chave is final for that receipt, so that doc goes to
 * `reconcileLoteSemProtocolo` (`./lote-sem-protocolo`), which makes at most ONE
 * `consSitNFe` for that chave per round — counted against the same per-doc cap,
 * written through the guarded persist (persistPatchUnlessFinal, every write
 * guarded on the receipt, the `retries` it was decided from and an in-flight
 * estado) — behind a consSit breaker that stops further consSit calls after a
 * 656 or an unavailable service, for the rest of this lote and, when the
 * caller threads it (`bloqueioConsSit`), for the filial's next lotes too (an
 * outage only for those at the same authorizer).
 *
 * Every OTHER write of a lote reconcile (the 105 poll, a lote-level
 * non-answer, a 104 carrying our protNFe — with its proc/anchor swap — the
 * 539 outcome, a lote-level 656 and the attempt-cap terminal) goes through the
 * same guarded persist, under the premise it was decided on: this receipt,
 * the `retries` as the in-flight query read it, an in-flight estado (rule 7).
 * That query ran BEFORE the `consReciNFe` await, so a concurrent terminal (a
 * #513 consSit verdict, a 656) or another runner's counted write refuses the
 * write instead of being overwritten by it; the doc's live estado is tallied.
 *
 * Hard rules baked in here (NOT overridable by the caller):
 *   - **cStat 656 (consumo indevido) is terminal.** `consultarLote` returning
 *     656 maps (via `cStatToEstado`) to `estado='error'` — we persist that and
 *     stop. Re-querying after a 656 is a SEFAZ-ban precedent (#77); there is no
 *     backoff-and-retry path for it.
 *   - **Attempt cap.** 105 rounds and 104-without-our-protNFe rounds both count
 *     on the doc's `retries`; once it reaches `MAX_RECONCILE_ATTEMPTS` the doc
 *     is flipped to terminal `error` with a "verificar manualmente" motivo and
 *     a BLOCKING cStat (105, or 104 in the #513 branch), so it stops being
 *     scanned/re-enqueued. A lote-level non-answer
 *     (103/106/107/108/109/113/114) keeps the counter as read, without
 *     advancing it, and never trips the cap itself — that terminal would carry
 *     the non-answer's NON-blocking cStat — so a doc at MAX stays in flight AT
 *     MAX until the next counted sighting ends it past the cap (a 104 without
 *     our protNFe with no SEFAZ call, a 105 with cStat 105). Only our
 *     `protNFe` or a final answer clears the counter. Two chains are still
 *     uncapped (pre-existing, follow-ups): a pure lote-level 106/108 chain, and
 *     a 104 whose `protNFe` for our chave carries a duplicidade cStat other
 *     than 539 (204/205/218/635) — `applyOutcome` leaves it in flight with
 *     `retries` zeroed, and only 539 has a recovery (`recover539IfNeeded`).
 *
 * Residuals (follow-ups):
 *   - `recover539IfNeeded` still writes on its own: its chave swap is a plain
 *     merge, made (after its own `consReciNFe` of the earlier receipt) BEFORE
 *     the guarded persist here — so a guard that refuses the 539 outcome does
 *     not undo a swap that already landed. It is the one unguarded writer left
 *     in this path.
 *   - A consSit breaker tripped by a reconcile that then THROWS (a later doc
 *     of the same lote failing a Firestore write, or its 539 recovery's own
 *     `consReciNFe`) is lost with the result: it is not carried to the
 *     filial's next lote in the sweep, nor to the task's queue retry.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  consultarLote,
  MAX_RECONCILE_ATTEMPTS,
  type SefazCall,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type EstadoNFe, type NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { sefazCallFor } from './sefaz-call';
import { recover539IfNeeded } from './recover539';
import {
  type BloqueioConsSit,
  isLoteProcessadoSemProtocolo,
  loteSemRespostaParaAChave,
  reconcileLoteSemProtocolo,
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
   * Docs left `aguardandoResposta` — re-enqueue. A 105 or a 104 not yet
   * resolved for its chave (both under the attempt cap), or a lote-level
   * non-answer (103/106/107/108/109/113/114).
   */
  readonly stillPending: number;
  /** Docs that reached a terminal non-error state (aprovada / cancelada / …). */
  readonly recovered: number;
  /**
   * Docs flipped to terminal `error` (656 consumo-indevido, cap exceeded, a
   * 104 whose chave the consSit could not resolve). A rejeitada counts as
   * `recovered`.
   */
  readonly errored: number;
  /** Lote-level consult cStat, for the response/log line. */
  readonly cStat: string;
  /**
   * The consSit breaker as this reconcile left it — the given
   * `bloqueioConsSit`, or one a consSit of this lote tripped. A caller that
   * reconciles several lotes in a row (the backstop sweep) threads it into
   * the next call of the same scope: a 656 into the filial's next lotes, since
   * the 656 throttle is per CNPJ+IP, not per lote; an outage only into the
   * filial's next lotes at the same authorizer (`autorizadorDe` of the tpEmis).
   */
  readonly bloqueioConsSit: BloqueioConsSit | null;
}

/**
 * Reconcile every still-in-flight nfev4 doc of one lote against SEFAZ.
 *
 * @param attempt 0-based consult attempt from the task payload — used only for
 *   diagnostics; the authoritative cap is the per-doc `retries` counter (105
 *   rounds via `applyOutcome`, 104-without-our-protNFe rounds via
 *   `reconcileLoteSemProtocolo`), so a re-delivered task can't escape the cap.
 * @param bloqueioConsSit the consSit breaker a previous reconcile in this run
 *   tripped for the same scope — the SAME filial for a 656, the same filial +
 *   authorizer for an outage (see {@link ReconcileLoteResult.bloqueioConsSit});
 *   omitted (the task path — one lote per run) = none yet.
 */
export async function reconcileByRecibo(params: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  nRec: string;
  tpEmis: TpEmis;
  attempt: number;
  bloqueioConsSit?: BloqueioConsSit | null;
}): Promise<ReconcileLoteResult> {
  const { fs, rt, filialId, nRec, tpEmis } = params;
  // Per-run consSit breaker for the 104-without-our-protNFe branch: once a
  // consSit of this run answers 656 or finds the service down, the remaining
  // missing docs are not consulted (#513).
  let bloqueioConsSit: BloqueioConsSit | null = params.bloqueioConsSit ?? null;

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
      bloqueioConsSit,
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

  for (const doc of inFlight) {
    const data = doc.data() as NotaFiscalEletronica;
    const chave = data.chave;
    if (!chave) continue; // defensive — an in-flight doc always carries its chave

    // Audit the round-trip per chave (mirrors the emit path), keeping the
    // nRec→chave audit chain linkable for findLatestEnviNFeMsgWithNRec.
    await enviNfeCollection(fs, filialId).add(
      buildEnviNFeMsgFromConsulta({ chave, nRec, ret, tpEmis }),
    );

    // Our protocol in the lote reply — STRICT chave equality; a near-miss is
    // missing, never ours.
    const ourProt = ret.protNFe?.find((p) => p.infProt.chNFe === chave) ?? null;

    // A processed lote (104) with no protNFe for this chave is final for this
    // receipt: re-reading it cannot help, so the doc is resolved by chave —
    // counted, at most one consSit per round (#513).
    if (isLoteProcessadoSemProtocolo(ret, ourProt)) {
      const r = await reconcileLoteSemProtocolo({
        fs,
        rt,
        filialId,
        tpEmis,
        nRec,
        ret,
        chave,
        data,
        nfeRef: doc.ref,
        bloqueio: bloqueioConsSit,
      });
      bloqueioConsSit = r.bloqueio;
      tally(r.estado);
      continue;
    }

    const outcome = outcomeFromConsReci(ret, chave);
    let patch = applyOutcome({ estado: data.estado, retries: data.retries }, outcome);
    // A lote-level non-answer (103/106/107/108/109/113/114) says nothing about
    // this chave, so it must not reset the counter `applyOutcome` zeroes for
    // it — else an outage between two 104 rounds restarts the 104 count
    // (#513). Only our protNFe or a final answer clears it. Kept EXACTLY as
    // read — never lowered, never advanced (see the cap below).
    const naoResposta = loteSemRespostaParaAChave(ret.cStat);
    if (naoResposta) {
      patch = { ...patch, retries: data.retries ?? 0 };
    }

    // Rule 7: `data` was read by the in-flight query BEFORE the consReciNFe
    // await (and before the earlier docs' consSit awaits), so this write
    // re-checks, on the doc as it is at write time, the premise it was decided
    // on: still this receipt, still the `retries` as read, still in flight. A
    // concurrent terminal (a #513 consSit verdict, a 656) or another runner's
    // counted write refuses it instead of being overwritten by it.
    const guarda: PersistGuard = {
      expectedNRec: nRec,
      expectedRetries: data.retries ?? 0,
      requireInFlight: true,
    };

    // cStat=539 (duplicidade com chave diferente) must NOT linger in
    // aguardandoResposta: recover the SEFAZ-asserted chave if it is one we
    // emitted, else flip to terminal `error` (#243). `recover539IfNeeded` is a
    // no-op for every other outcome. pedidoId comes from the doc path
    // `pedidos/{pedidoId}/nfev4/{nfeId}`. Its chave swap is its OWN plain
    // merge, outside the guard below (see the header's residuals).
    const recovered539 = await recover539IfNeeded({
      fs,
      bundle: { pedidoId: doc.ref.parent?.parent?.id ?? doc.ref.path, filialId },
      nfeRef: doc.ref,
      rt,
      tpEmis,
      outcome,
      patch,
    });
    patch = recovered539.patch;
    // A 539 chave-swap leaves our local signed XML pointing at the old chave —
    // skip the <nfeProc> build for it (mirrors the emit path).
    const chaveSwapped = recovered539.chaveOverride != null;

    // Attempt cap: a lote still processing after MAX_RECONCILE_ATTEMPTS consults
    // stops auto-reconciling and surfaces for manual review (never re-queried
    // forever — #77).
    //
    // A non-answer is EXEMPT: this terminal keeps the patch's cStat, and
    // 103/106/107/108/109/113/114 are not in STATUS_BLOQUEADORES — the pedido
    // would become re-emittable over a número SEFAZ may already have
    // processed. A doc meets a non-answer AT the cap when an at-cap 104 round
    // was interrupted after its counted write (a rethrown consSit failure, a
    // timeout); it stays in flight at MAX, and the next counted sighting ends
    // it: a 104 without our protNFe computes tentativa MAX+1 and goes terminal
    // with the blocking cStat 104 and NO consSit (`reconcileLoteSemProtocolo`'s
    // hard stop), a 105 counts to MAX+1 and trips this cap with cStat 105. So
    // the 104 ceiling stays hard: never more than MAX consSit calls per doc.
    if (
      patch.estado === ESTADO_NFE.aguardandoResposta &&
      patch.retries >= MAX_RECONCILE_ATTEMPTS &&
      !naoResposta
    ) {
      patch = {
        ...patch,
        estado: ESTADO_NFE.error,
        xMotivo:
          `${patch.xMotivo} | lote não processado após ${MAX_RECONCILE_ATTEMPTS} ` +
          `consultas — verificar manualmente`,
      };
    }

    // Build <nfeProc> when SEFAZ authorized this chave and we still hold the
    // matching signed XML — same atomic anchor-clear as the emit path (#128).
    // The digest-safe stitch (#396, via `buildProcForAuthorizedOutcome`)
    // refuses to pair the protocol with bytes it did not authorize (e.g. a
    // pre-fix retry overwrote the anchor with a regenerated XML); the doc
    // then stays aprovada WITHOUT proc for a DistDFe/manual fetch.
    const nfeProcXml = buildProcForAuthorizedOutcome({
      cStat: patch.cStat,
      chaveMatches: !chaveSwapped,
      signedXml: data.xml_assinado,
      prot: ourProt,
      logTag: 'nfe/reconcile',
      chave,
    });

    const gravado = await persistPatchUnlessFinal(
      fs,
      doc.ref,
      patch,
      nfeProcXml != null ? swapAnchorForProc(nfeProcXml) : undefined,
      guarda,
    );
    if (!gravado.written) {
      // The doc changed under us: report its LIVE estado, never the patch
      // this round decided on a stale read.
      console.warn(
        `[nfe/reconcile] chave ${chave}: gravação do recibo ${nRec} recusada — o doc mudou ` +
          `em paralelo (estado=${gravado.estadoAtual}, nRec=${gravado.nRecAtual ?? 'null'}); ` +
          'reportando o estado vivo',
      );
      tally(gravado.estadoAtual);
      continue;
    }

    tally(patch.estado);
  }

  return {
    scanned: inFlight.length,
    stillPending,
    recovered,
    errored,
    cStat: ret.cStat,
    bloqueioConsSit,
  };
}
