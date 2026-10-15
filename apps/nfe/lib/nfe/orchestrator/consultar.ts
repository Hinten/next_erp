import type { Firestore, Timestamp } from 'firebase-admin/firestore';

import { nowMicros } from '@delfrance/core/datetime';
import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  classifyCStat,
  consultarLote,
  consultarSituacaoNFe,
  esperaMinimaDoRecibo,
  isEstadoFinalNFe,
  nextConsultaDelayMs,
  outcomeFromRetConsSit,
  RECONCILE_SWEEP_GRACE_MS,
  type NFeStatePatch,
  type SefazCall,
  type SefazOutcome,
  type TpEmis,
  type TRetConsReciNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeBaseRuntime, NFeRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { safeLog } from '../log';
import { NFeOrchestratorError } from './errors';
import { loadPedidoBundle, type EmitResult } from './bundle';
import { sefazCallFor } from './sefaz-call';
import { extrasDaTrocaDeChave, recover539IfNeeded } from './recover539';
import {
  classificarConsSitDeRecuperacao,
  decidirRodadaDoRecibo,
  type MotivoConsultaPorChave,
  terminalBloqueante,
} from './lote-sem-protocolo';
import {
  buildEnviNFeMsgFromConsulta,
  buildProcForAuthorizedOutcome,
  enviNfeCollection,
  envioEmCurso,
  existingToEmitResult,
  findLatestEnviNFeMsgWithNRec,
  outcomeFromConsReci,
  persistPatchUnlessFinal,
  swapAnchorForProc,
} from './audit';

/** What one persisted-chave SEFAZ consulta produced. */
export interface ConsultaChaveResult {
  /** The persisted patch (already written to the nfev4 doc). */
  readonly patch: NFeStatePatch;
  /**
   * The doc's chave after a possible cStat=539 swap — the recovered one only
   * when the write carrying it landed; a refused write swapped nothing.
   */
  readonly chaveFinal: string;
  /** The lote receipt the consReci path used, when one existed in the audit log. */
  readonly nRecUsado: string | null;
  /**
   * True when any SEFAZ answer of this call classified as consumo indevido
   * (656) — the receipt, our protNFe in it, the consSit, or the patch this
   * call returns (a refused write reports the live doc's). A batch caller
   * stops consulting on it: the patch's own cStat no longer shows a 656 once
   * it is a blocking terminal (103/104).
   */
  readonly consumoIndevido: boolean;
  /**
   * True when the guarded write was REFUSED (#1675): the doc went final, changed
   * since the caller's read, or is under a live send — so nothing was written
   * and `patch` reports the doc's LIVE state, set by another run. `false` when
   * the outcome was written, and when there was deliberately nothing to write
   * (a stored `rejeitada` left alone).
   */
  readonly recusado: boolean;
}

/**
 * Consult SEFAZ for ONE already-persisted nfev4 doc and persist the outcome —
 * the shared core of `consultarPedido` (CLI) and `verificarEnviNfeMsgs`
 * (the manual "Verificar novamente" action).
 *
 * Prefers `consReciNFe(nRec)` when an audit-log msg holds a receipt — it works
 * while the lote is still queued at SEFAZ (cStat=105) and yields the protocol
 * once processed. The receipt's answer is read through the SAME decision the
 * async reconcile makes (`decidirRodadaDoRecibo`, #1654): when it says "by
 * chave" — a processed lote (104) without our protNFe, a per-NF-e verdict at
 * lote level, 106 (e.g. an expired receipt), a duplicidade other than 539 —
 * the call falls through to ONE `consSitNFe(chave)` so a manual verification
 * is conclusive, and reads its answer through the same recovery table
 * (`classificarConsSitDeRecuperacao`): a final answer is applied; "still
 * queued" (635 + 217) or an unavailable service leaves the doc
 * `aguardandoResposta` with the stored receipt kept; anything else — and a
 * protNFe that names another chave — is a BLOCKING terminal `error`
 * (`terminalBloqueante`), as is a 656 or a refused receipt query. A receipt
 * that says nothing about the chave (`aguardar`) puts the doc back in flight
 * on that receipt, paced like the reconcile — never `error` with a
 * non-blocking cStat or `rejeitada`. A stored `rejeitada` is left as it is by
 * such a receipt, a 656 or a refused receipt query: SEFAZ's answer about the
 * chave stands and nothing is written. Unlike the reconcile nothing is
 * counted and a 106 is consulted at once: the call is operator-initiated, and
 * it still resets `retries` (`applyOutcome`). With no receipt at all it goes
 * straight to `consSitNFe`.
 *
 * Every SEFAZ round-trip appends an `enviNfe` audit doc. The final outcome
 * runs `applyOutcome` (with the doc's current estado/cStat/xMotivo, so the
 * cancelada/inutilizada anti-regression defense can fire), the shared 539
 * gate, the digest-safe `<nfeProc>` stitch on autorizada, and the
 * TOCTOU-guarded `persistPatchUnlessFinal` (a doc that reaches a final estado
 * during the SEFAZ round-trip is never overwritten; the returned patch then
 * reflects the doc's CURRENT estado/cStat/xMotivo). A recovered 539's chave
 * swap rides that same write (#1654 §2d), so a refused write swaps nothing and
 * `chaveFinal` stays the doc's own chave.
 *
 * That write is also owned by the caller's READ (#1675): `updateTimeLido` is
 * the doc's `updateTime` as read, and the write is refused when the doc changed
 * since (`expectedUpdateTime` — an emit claimed it and is sending, or the
 * owner's outcome landed) or while a send claimed before the read is still in
 * progress (`refuseWhileReserved`). A consult decided on a stale read must never
 * write `rejeitada` over a live send: the next emit would regenerate over the
 * bytes SEFAZ may be authorizing.
 *
 * NOT gated on `isEstadoFinalNFe` — callers own that guard (they decide
 * whether to skip or report).
 *
 * `consReciCache` (optional): a per-run `nRec → retConsReciNFe` cache. A batch
 * caller consulting N chaves of the SAME lote (e.g. `verificarEnviNfeMsgs` on
 * a legacy multi-chave msg) would otherwise fire N back-to-back `consReciNFe`
 * calls for one nRec — the SEFAZ cStat=656 (consumo indevido) vector. On a
 * cache hit the stored response is reused: no SEFAZ call and no duplicate
 * audit doc (the audit row was written on first fetch). Single-chave callers
 * (`consultarPedido`) simply pass none.
 */
export async function consultarChavePersistida(params: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  pedidoId: string;
  nfeRef: FirebaseFirestore.DocumentReference;
  nota: NotaFiscalEletronica;
  /** The doc's `updateTime` as the caller read `nota` — the write is owned by that read (#1675). */
  updateTimeLido: Timestamp;
  chave: string;
  consReciCache?: Map<string, TRetConsReciNFe>;
}): Promise<ConsultaChaveResult> {
  const { fs, rt, filialId, pedidoId, nfeRef, nota, chave, consReciCache } = params;
  // SEFAZ routing follows the PERSISTED tpEmis (an SVC-emitted NF-e is
  // consulted at its SVC even after the mode is switched back).
  const notaTpEmis = (nota.tpEmis ?? 1) as TpEmis;
  const current = {
    estado: nota.estado,
    retries: nota.retries ?? 0,
    cStat: nota.cStat,
    xMotivo: nota.xMotivo,
  };

  const msgWithNRec = await findLatestEnviNFeMsgWithNRec(fs, filialId, chave);

  // The authoritative SEFAZ protocol for our chave, when one surfaced —
  // needed for the `<nfeProc>` stitch on autorizada.
  let protNFeRaw: Awaited<ReturnType<typeof consultarSituacaoNFe>>['protNFe'] | null = null;

  // Set by any answer of this call that classifies as consumo indevido — see
  // `ConsultaChaveResult.consumoIndevido`.
  let consumoIndevido = false;
  const registrar = (cStat: string): void => {
    if (classifyCStat(cStat) === 'consumo-indevido') consumoIndevido = true;
  };

  async function consultarPorChave(): Promise<SefazOutcome> {
    const consSitCall: SefazCall = sefazCallFor(rt, notaTpEmis, 'NfeConsultaProtocolo');
    const retSit = await consultarSituacaoNFe(consSitCall, { chave });
    await enviNfeCollection(fs, filialId).add(
      buildEnviNFeMsgFromConsulta({ chave, nRec: null, ret: retSit, tpEmis: notaTpEmis }),
    );
    protNFeRaw = retSit.protNFe ?? null;
    const sit = outcomeFromRetConsSit(retSit);
    registrar(retSit.cStat);
    registrar(sit.cStat);
    return sit;
  }

  /**
   * The receipt said "by chave" for `motivo`: ONE consSit, read through the
   * reconcile's recovery table. `patch` is the receipt's; `loteCStat` picks the
   * blocking cStat of a terminal.
   */
  async function resolverPorChave(
    patch: NFeStatePatch,
    loteCStat: string,
    nRec: string,
    motivo: MotivoConsultaPorChave,
  ): Promise<NFeStatePatch> {
    // Never re-keyed: our protNFe's duplicidade xMotivo may carry an
    // `[nRec:X]` marker (`outcomeFromInfProt`), and writing it would move the
    // doc onto another lote's receipt. `nRec: null` leaves the stored receipt
    // untouched, as `reconcilePorChave` does by basing its patch on the lote.
    const base: NFeStatePatch = { ...patch, nRec: null };
    const sit = await consultarPorChave();
    const chNFeDoProt = protNFeRaw?.infProt.chNFe ?? null;
    if (chNFeDoProt != null && chNFeDoProt !== chave) {
      // Strict equality, as in the reconcile: never applied as ours.
      protNFeRaw = null;
      return terminalBloqueante(
        base,
        loteCStat,
        `recibo ${nRec}: consulta por chave devolveu protNFe de outra chave (${chNFeDoProt}) — ` +
          'verificar manualmente',
      );
    }
    const consSit = `consulta por chave: cStat ${sit.cStat} — ${sit.xMotivo}`;
    switch (classificarConsSitDeRecuperacao(sit.cStat, motivo)) {
      case 'resolvida':
        return applyOutcome(current, sit);
      case 'pendente':
      case 'indisponivel':
        // Nothing to apply: back in flight, the stored receipt kept and no
        // proc — the sweep consults it again.
        protNFeRaw = null;
        return {
          ...base,
          estado: ESTADO_NFE.aguardandoResposta,
          xMotivo: `${base.xMotivo} | ${consSit}`,
        };
      case 'sem-resolucao':
        protNFeRaw = null;
        return terminalBloqueante(
          base,
          loteCStat,
          `recibo ${nRec}: ${consSit} — verificar manualmente`,
        );
    }
  }

  let outcome: SefazOutcome;
  let patch: NFeStatePatch;
  // The minimum wait of a round that stays in flight on a paralisado receipt.
  let espera: number | null = null;
  // A stored `rejeitada` is SEFAZ's conclusive answer about this chave, and
  // the emit path keeps its fix-and-resend branch open (a rejection frees the
  // número). A receipt round that says nothing about the chave (`aguardar`:
  // 107/108/109/113/114 or not TStat-shaped) or is terminal on its own (a 656,
  // a refused query) leaves it as it is: back in flight or a blocking `error`
  // would shut that branch although nothing new was learned. A 103/105 is not
  // such a round — a lote holding the chave is still pending — and still takes
  // it back in flight (see the `aguardar` arm below).
  const rejeicaoConclusiva = current.estado === ESTADO_NFE.rejeitada;
  let rejeicaoMantida = false;
  if (msgWithNRec?.nRec) {
    const nRec = msgWithNRec.nRec;
    // Per-run dedupe: N chaves of the same lote share one consReciNFe
    // round-trip (and one audit doc) — see the `consReciCache` jsdoc.
    let retRec = consReciCache?.get(nRec);
    if (!retRec) {
      const consReciCall: SefazCall = sefazCallFor(rt, notaTpEmis, 'NfeRetAutorizacao');
      retRec = await consultarLote(consReciCall, { nRec });
      await enviNfeCollection(fs, filialId).add(
        buildEnviNFeMsgFromConsulta({
          chave,
          nRec,
          ret: retRec,
          tpEmis: notaTpEmis,
        }),
      );
      consReciCache?.set(nRec, retRec);
    }
    // Our protocol in the reply — STRICT chave equality.
    const ourProt = retRec.protNFe?.find((p) => p.infProt.chNFe === chave) ?? null;
    protNFeRaw = ourProt;
    outcome = outcomeFromConsReci(retRec, chave);
    registrar(retRec.cStat);
    registrar(outcome.cStat);
    patch = applyOutcome(current, outcome);

    // The reconcile's decision for this round (#1654). 539 stays with the
    // shared recover539 gate below; `aplicar-protocolo` keeps the receipt's
    // patch as is.
    const decisao = decidirRodadaDoRecibo(retRec.cStat, ourProt?.infProt.cStat ?? null);
    if (decisao.tipo === 'por-chave') {
      patch = await resolverPorChave(patch, retRec.cStat, nRec, decisao.motivo);
    } else if (decisao.tipo === 'terminal') {
      if (rejeicaoConclusiva) {
        rejeicaoMantida = true;
      } else {
        patch = terminalBloqueante(
          patch,
          retRec.cStat,
          `recibo ${nRec}: cStat ${outcome.cStat}, sem nova consulta — verificar manualmente`,
        );
      }
    } else if (decisao.tipo === 'aguardar') {
      // Nothing about the chave: never out of flight, as in the reconcile.
      // `applyOutcome` keeps the current estado for a null-mapped
      // 107/108/109/113/114 and maps a cStat that is not TStat-shaped to
      // rejeitada, so a doc the cap left `error` with a BLOCKING cStat would be
      // written `error` 108 or `rejeitada` — both re-emittable over a número
      // SEFAZ may hold. Back in flight on this receipt instead, as 103/105
      // already map: the emit path skips an in-flight doc with an nRec, and the
      // sweep consults it again, paced like the reconcile on a paralisado one.
      // A stored rejeitada is left as it is by such a SILENT receipt
      // (107/108/109/113/114, or not TStat-shaped — see `rejeicaoConclusiva`).
      // ⚠️ Deliberately NOT by a 103/105: `applyOutcome` maps those in flight
      // before this block, and they are not silent — a lote holding this chave
      // is still pending at SEFAZ, which may yet authorize it, so a rejeitada
      // that came from another send goes back in flight rather than leave its
      // número re-emittable (as before #1654; pinned by the 103/105 near-miss).
      if (
        !isEstadoFinalNFe(patch.estado) &&
        patch.estado !== ESTADO_NFE.enviando &&
        patch.estado !== ESTADO_NFE.aguardandoResposta
      ) {
        if (rejeicaoConclusiva) rejeicaoMantida = true;
        else patch = { ...patch, estado: ESTADO_NFE.aguardandoResposta };
      }
      if (patch.estado === ESTADO_NFE.aguardandoResposta) {
        espera = esperaMinimaDoRecibo(retRec.cStat);
      }
    }
  } else {
    // The no-nRec path already IS the consSit, so it never re-consults.
    outcome = await consultarPorChave();
    patch = applyOutcome(current, outcome);
  }

  if (rejeicaoMantida) {
    // Nothing learned about the chave, so nothing is written: the doc's own
    // cStat/xMotivo are reported (the receipt's answer is in the audit log),
    // and a 656 still raises `consumoIndevido` for the batch caller.
    return {
      patch: {
        estado: current.estado,
        cStat: current.cStat ?? outcome.cStat,
        xMotivo: current.xMotivo ?? outcome.xMotivo,
        retries: current.retries,
        nRec: null,
        action: 'done-rejected',
        tMed: null,
      },
      chaveFinal: chave,
      nRecUsado: msgWithNRec?.nRec ?? null,
      consumoIndevido,
      recusado: false,
    };
  }

  // cStat=539 (duplicidade com chave diferente): recover the SEFAZ-asserted
  // chave if it is one we emitted, else flip to terminal `error` — never leave
  // the doc stuck aguardandoResposta (#243). No-op for every other outcome —
  // `outcome` is the receipt's (or the direct consSit's), never 539 after a
  // round resolved by chave. It writes nothing to the nfev4 doc (only its consReciNFe
  // audit entry): its chave swap rides the
  // guarded write below (#1654 §2d).
  const recovered539 = await recover539IfNeeded({
    fs,
    bundle: { pedidoId, filialId },
    rt,
    tpEmis: notaTpEmis,
    outcome,
    patch,
  });
  patch = recovered539.patch;
  const chaveSwapped = recovered539.chaveOverride != null;

  // Build `<nfeProc>` when SEFAZ authorized this chave and we still hold the
  // matching signed XML — same atomic anchor-clear as the emit path (#128).
  // The digest-safe stitch (#396, via `buildProcForAuthorizedOutcome`) refuses
  // to pair the protocol with bytes it did not authorize; the doc then stays
  // aprovada WITHOUT proc for a DistDFe/manual fetch. A 539 chave-swap skips
  // the build (our local signed XML points at the old chave).
  const nfeProcXml = buildProcForAuthorizedOutcome({
    cStat: patch.cStat,
    chaveMatches: !chaveSwapped,
    signedXml: nota.xml_assinado,
    prot: protNFeRaw,
    logTag: 'nfe/consultar',
    chave,
  });

  // A proc and a chave swap never meet: a swap forces `chaveMatches: false`.
  const troca = extrasDaTrocaDeChave(recovered539.chaveOverride);
  const pacing =
    espera != null
      ? {
          proximaConsultaEm:
            nowMicros() +
            (Math.max(nextConsultaDelayMs(patch.retries, patch.tMed), espera) +
              RECONCILE_SWEEP_GRACE_MS) *
              1000,
        }
      : undefined;

  // TOCTOU guard: `applyOutcome`'s anti-regression defense ran against the
  // estado read BEFORE the SEFAZ round-trip — a doc that became final
  // (e.g. cancelada) mid-call must not be blindly merged over, and a refused
  // write swaps no chave either. Owned by the caller's read (#1675): a doc
  // changed since — an emit claimed it — or under a live send is left alone.
  const persisted = await persistPatchUnlessFinal(
    fs,
    nfeRef,
    patch,
    nfeProcXml != null
      ? swapAnchorForProc(nfeProcXml)
      : troca != null || pacing != null
        ? { ...troca, ...pacing }
        : undefined,
    { expectedUpdateTime: params.updateTimeLido, refuseWhileReserved: true },
  );
  // The doc's chave after this call: the recovered one only if the write
  // that carries the swap landed; on a refusal, the live doc's own.
  const chaveFinal = persisted.written
    ? (recovered539.chaveOverride ?? chave)
    : (persisted.chaveAtual ?? chave);
  if (!persisted.written) {
    // Nothing was written — report the doc's live truth, never a field of the
    // stale patch: a doc an emit claimed and is sending has NO cStat yet (a
    // fresh anchor), and falling back to this consult's answer (a 217, say)
    // would claim SEFAZ does not have an NF-e that is being sent (#1675).
    // `recusaToEmitResult`'s convention. This call's own answers were already
    // `registrar`ed above, so a 656 still reaches `consumoIndevido`.
    patch = {
      ...patch,
      estado: persisted.estadoAtual,
      cStat: persisted.cStatAtual ?? '',
      xMotivo: persisted.xMotivoAtual ?? '',
      retries: 0,
      action: 'done-terminal',
      tMed: null,
    };
  }

  registrar(patch.cStat);
  return {
    patch,
    chaveFinal,
    nRecUsado: msgWithNRec?.nRec ?? null,
    consumoIndevido,
    recusado: !persisted.written,
  };
}

/**
 * Standalone SEFAZ consulta for an already-persisted nfev4 doc. Picks the
 * pedido's most recently touched NF-e (a pedido can hold one doc per tpEmis
 * — `s1` plus `s6`/`s7` across contingency flips), queries SEFAZ via the
 * shared `consultarChavePersistida` core, and returns the same shape
 * `emitirPedido` does.
 *
 * **Terminal guard**: a doc already in a SEFAZ-final estado (aprovada /
 * cancelada / numeração inutilizada) is returned as-is with `reused: true` —
 * no SEFAZ call, no writes. Another consulta can never legitimately change
 * those estados, and for cancelada/inutilizada it would even be harmful
 * (`consSitNFe` still returns the original authorization protNFe).
 *
 * Used by the `consult:dev-pedido` CLI for manual polling.
 */
export async function consultarPedido(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  pedidoId: string,
): Promise<EmitResult> {
  safeLog('debug', `[nfe/orchestrator] consultarPedido pedidoId='${pedidoId}'`);

  const bundle = await loadPedidoBundle(fs, pedidoId);
  // mTLS for the consulta must present this filial's cert (or the env
  // fallback) — SEFAZ identifies the transmitter by the handshake cert.
  const rt = await resolveFilialRuntime(fs, baseRt, bundle.filialId);
  // Scan the pedido's nfev4 slots (at most a handful) instead of deriving
  // one slot from the CURRENT config mode — after a contingency toggle the
  // live NF-e may sit in `s6`/`s7` while the mode is already back to none
  // (or vice-versa). The most recently modified doc with a chave is the one
  // the operator means.
  const slotsSnap = await nfev4Collection.ref(fs, { pedidoId }).get();
  const chosen = slotsSnap.docs
    // Admin reads bypass the converter — parse each doc so a legacy ISO
    // `ultima_modificacao` is coerced to ms (else the numeric sort below → NaN).
    .map((d) => ({
      id: d.id,
      nota: nfev4Collection.parseRead(d.data(), d.ref.path),
      updateTime: d.updateTime,
    }))
    .filter((c) => c.nota.chave)
    // `ultima_modificacao` is ms since epoch → numeric compare (newest first).
    .sort((a, b) => (b.nota.ultima_modificacao ?? 0) - (a.nota.ultima_modificacao ?? 0))[0];
  if (!chosen) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}': no nfev4 doc with a chave under pedidos/${pedidoId}/nfev4 — ` +
        'nothing to consult. Run `emit:dev-pedido` first.',
    );
  }
  const nfeRef = nfev4Collection.docRef(fs, { pedidoId }, chosen.id);
  const nota = chosen.nota;
  const chave = nota.chave;
  if (!chave) {
    // Unreachable (filtered above) — narrows `chave` to string for the calls below.
    throw new NFeOrchestratorError(`pedido '${pedidoId}': persisted nfev4 doc has no chave.`);
  }

  if (isEstadoFinalNFe(nota.estado)) {
    safeLog(
      'debug',
      `[nfe/orchestrator] pedido '${pedidoId}' nfev4 '${chosen.id}' is already final ` +
        `(estado=${nota.estado}) — returning persisted state without a SEFAZ call`,
    );
    return existingToEmitResult(pedidoId, nfeRef.id, nota);
  }

  // An EPEC-approved doc is never consulted (#1675): the home SEFAZ answers 217
  // until the Ambiente Nacional shares the EPEC, and a 217 would write
  // `rejeitada` over a registered EPEC. Its recovery is the pós-EPEC transmission.
  if (nota.estado === ESTADO_NFE.epecAprovado) {
    return existingToEmitResult(pedidoId, nfeRef.id, nota);
  }

  // A send is in progress on the doc (#1675) — a consult now would double up on
  // a live SOAP call (or a paced retry), and its write would be refused anyway:
  // report the doc as it is, with no SEFAZ call.
  if (envioEmCurso(nota, nowMicros())) {
    safeLog(
      'debug',
      `[nfe/orchestrator] pedido '${pedidoId}' nfev4 '${chosen.id}' has a send in progress ` +
        '— returning persisted state without a SEFAZ call',
    );
    return existingToEmitResult(pedidoId, nfeRef.id, nota);
  }

  const { patch, chaveFinal, nRecUsado, recusado } = await consultarChavePersistida({
    fs,
    rt,
    filialId: bundle.filialId,
    pedidoId,
    nfeRef,
    nota,
    updateTimeLido: chosen.updateTime,
    chave,
  });

  return {
    nfeId: nfeRef.id,
    pedidoId,
    estado: patch.estado,
    chave: chaveFinal,
    nRec: patch.nRec ?? nRecUsado ?? nota.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    // A refused write (#1675) reports a state another run wrote, not this call's.
    reused: recusado,
  };
}
