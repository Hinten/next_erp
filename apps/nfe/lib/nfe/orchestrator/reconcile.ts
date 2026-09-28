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
 *     and, when the caller threads it (`bloqueioConsSit`), for the filial's
 *     next lotes too (an outage only for those at the same authorizer).
 *   - `aguardar` — nothing about the chave (103/105/107/108/109/113/114, or a
 *     cStat that is not TStat-shaped): counted, and consulted again.
 *   - `terminal` — a 656, or a rejection of the `consReciNFe` query itself.
 *
 * Hard rules baked in here (NOT overridable by the caller):
 *   - **Every round that leaves a doc in flight advances its `retries` by
 *     exactly one** — a 105, a lote-level non-answer, an `enviando` doc (now
 *     written `aguardandoResposta`), a recovered 539, a round resolved by
 *     chave — so a doc gets at most `MAX_RECONCILE_ATTEMPTS` receipt rounds
 *     and at most that many consSit calls between two operator actions. The
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
 * the doc's live estado is tallied.
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

import { nowMicros } from '@delfrance/core/datetime';
import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  consultarLote,
  esperaMinimaDoRecibo,
  MAX_RECONCILE_ATTEMPTS,
  nextConsultaDelayMs,
  RECONCILE_SWEEP_GRACE_MS,
  type SefazCall,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type EstadoNFe, type NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { sefazCallFor } from './sefaz-call';
import { recover539IfNeeded } from './recover539';
import {
  type BloqueioConsSit,
  CSTAT_LOTE_PENDENTE,
  decidirRodadaDoRecibo,
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
   * it is written `aguardandoResposta`).
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
 *   diagnostics; the authoritative cap is the per-doc `retries` counter, which
 *   every in-flight round advances by one (here, or in `reconcilePorChave`),
 *   so a re-delivered task can't escape the cap.
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
  // Per-run consSit breaker for the by-chave branch: once a consSit of this
  // run answers 656 or finds the service down, the remaining docs are not
  // consulted (#513).
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
        bloqueio: bloqueioConsSit,
      });
      bloqueioConsSit = r.bloqueio;
      tally(r.estado);
      continue;
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

    // cStat=539 (duplicidade com chave diferente) must NOT linger in
    // aguardandoResposta: recover the SEFAZ-asserted chave if it is one we
    // emitted, else flip to terminal `error` (#243). pedidoId comes from the
    // doc path `pedidos/{pedidoId}/nfev4/{nfeId}`. Its chave swap is its OWN
    // plain merge, outside the guard below (see the header's residuals). A
    // recovery that leaves the doc in flight is counted below like any other
    // round — on the doc's own `retries`, never restarted.
    let chaveSwapped = false;
    if (decisao.tipo === 'recuperar-539') {
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
      chaveSwapped = recovered539.chaveOverride != null;
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
          : `${patch.xMotivo} | sem resposta para a chave no recibo ${nRec} ` +
            `(consulta ${tentativa}/${MAX_RECONCILE_ATTEMPTS})`,
      };
      if (tentativa >= MAX_RECONCILE_ATTEMPTS) {
        patch = terminalBloqueante(
          patch,
          ret.cStat,
          pendente
            ? `lote não processado após ${MAX_RECONCILE_ATTEMPTS} consultas — verificar manualmente`
            : `sem resposta para a chave após ${MAX_RECONCILE_ATTEMPTS} consultas — ` +
                'verificar manualmente',
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
      chaveMatches: !chaveSwapped,
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
    const extras =
      nfeProcXml != null
        ? swapAnchorForProc(nfeProcXml)
        : espera != null
          ? {
              proximaConsultaEm:
                nowMicros() +
                (Math.max(nextConsultaDelayMs(tentativa), espera) + RECONCILE_SWEEP_GRACE_MS) *
                  1000,
            }
          : undefined;

    // Rule 7: `data` was read by the in-flight query BEFORE the consReciNFe
    // await (and before the earlier docs' consSit awaits), so this write
    // re-checks, on the doc as it is at write time, the premise it was decided
    // on: still this receipt, still the `retries` as read, still in flight. A
    // concurrent terminal (a consSit verdict, a 656) or another runner's
    // counted write refuses it instead of being overwritten by it.
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
