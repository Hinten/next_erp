/**
 * Async lote reconciliation — the core shared by the Cloud Task endpoint
 * (`/api/nfe/reconciliar`, the primary trigger) and the backstop sweep
 * (`processar-pendentes`).
 *
 * Consults a lote **by receipt** (`consReciNFe(nRec)`, never by hammering
 * `consSit` per chave — that is the #77 consumo-indevido vector) and applies the
 * per-chave outcome to every nfev4 doc in the lote. Decides terminal vs
 * still-pending; the re-enqueue (Cloud Task) decision is left to the caller so
 * this stays a pure Firestore-only operation.
 *
 * Hard rules baked in here (NOT overridable by the caller):
 *   - **cStat 656 (consumo indevido) is terminal.** `consultarLote` returning
 *     656 maps (via `cStatToEstado`) to `estado='error'` — we persist that and
 *     stop. Re-querying after a 656 is a SEFAZ-ban precedent (#77); there is no
 *     backoff-and-retry path for it.
 *   - **Attempt cap.** A doc still `cStat=105` once its `retries` reaches
 *     `MAX_RECONCILE_ATTEMPTS` is flipped to terminal `error` with a
 *     "verificar manualmente" motivo, so it stops being scanned/re-enqueued.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  buildNFeProc,
  classifyCStat,
  consultarLote,
  MAX_RECONCILE_ATTEMPTS,
  type SefazCall,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { sefazCallFor } from './sefaz-call';
import { recover539IfNeeded } from './recover539';
import {
  buildEnviNFeMsgFromConsulta,
  enviNfeCollection,
  outcomeFromConsReci,
  persistPatch,
  procPersistExtras,
} from './audit';

/** Summary of one lote reconcile — the caller re-enqueues iff `stillPending > 0`. */
export interface ReconcileLoteResult {
  /** nfev4 docs found for this `nRec` that were still in flight. */
  readonly scanned: number;
  /** Docs left `aguardandoResposta` (cStat 105, under the attempt cap) — re-enqueue. */
  readonly stillPending: number;
  /** Docs that reached a terminal non-error state (aprovada / cancelada / …). */
  readonly recovered: number;
  /** Docs flipped to terminal `error` (656 consumo-indevido, cap exceeded, rejeitada). */
  readonly errored: number;
  /** Lote-level consult cStat, for the response/log line. */
  readonly cStat: string;
}

/**
 * Reconcile every still-in-flight nfev4 doc of one lote against SEFAZ.
 *
 * @param attempt 0-based consult attempt from the task payload — used only for
 *   diagnostics; the authoritative cap is the per-doc `retries` counter that
 *   `applyOutcome` advances, so a re-delivered task can't escape the cap.
 */
export async function reconcileByRecibo(params: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  nRec: string;
  tpEmis: TpEmis;
  attempt: number;
}): Promise<ReconcileLoteResult> {
  const { fs, rt, filialId, nRec, tpEmis } = params;

  // Docs of this lote that are still in flight. Query by receipt only
  // (single-field, index-free on Firestore Enterprise) and filter estado in
  // memory so an already-terminal doc (idempotent re-delivery) is skipped.
  const snap = await nfev4Collection.groupQuery(fs).where('nRec', '==', nRec).get();
  const inFlight = snap.docs.filter((d) => {
    const estado = (d.data() as NotaFiscalEletronica).estado;
    return estado === ESTADO_NFE.aguardandoResposta || estado === ESTADO_NFE.enviando;
  });
  if (inFlight.length === 0) {
    return { scanned: 0, stillPending: 0, recovered: 0, errored: 0, cStat: 'noop' };
  }

  // One consult by receipt for the whole lote. `consReciNFe` returns every
  // protocol; we map each chave to its own outcome below.
  const call: SefazCall = sefazCallFor(rt, tpEmis, 'NfeRetAutorizacao');
  const ret = await consultarLote(call, { nRec });

  let stillPending = 0;
  let recovered = 0;
  let errored = 0;

  for (const doc of inFlight) {
    const data = doc.data() as NotaFiscalEletronica;
    const chave = data.chave;
    if (!chave) continue; // defensive — an in-flight doc always carries its chave

    // Audit the round-trip per chave (mirrors the emit path), keeping the
    // nRec→chave audit chain linkable for findLatestEnviNFeMsgWithNRec.
    await enviNfeCollection(fs, filialId).add(
      buildEnviNFeMsgFromConsulta({ chave, nRec, ret, tpEmis }),
    );

    const outcome = outcomeFromConsReci(ret, chave);
    let patch = applyOutcome({ estado: data.estado, retries: data.retries }, outcome);

    // cStat=539 (duplicidade com chave diferente) must NOT linger in
    // aguardandoResposta: recover the SEFAZ-asserted chave if it is one we
    // emitted, else flip to terminal `error` (#243). `recover539IfNeeded` is a
    // no-op for every other outcome. pedidoId comes from the doc path
    // `pedidos/{pedidoId}/nfev4/{nfeId}`.
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
    if (patch.estado === ESTADO_NFE.aguardandoResposta && patch.retries >= MAX_RECONCILE_ATTEMPTS) {
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
    const ourProt = ret.protNFe?.find((p) => p.infProt.chNFe === chave) ?? null;
    const nfeProcXml =
      !chaveSwapped &&
      classifyCStat(patch.cStat) === 'autorizada' &&
      ourProt != null &&
      data.xml_assinado != null
        ? buildNFeProc(data.xml_assinado, ourProt)
        : null;

    await persistPatch(
      doc.ref,
      patch,
      nfeProcXml != null ? procPersistExtras(nfeProcXml) : undefined,
    );

    if (patch.estado === ESTADO_NFE.aguardandoResposta) stillPending++;
    else if (patch.estado === ESTADO_NFE.error) errored++;
    else recovered++;
  }

  return { scanned: inFlight.length, stillPending, recovered, errored, cStat: ret.cStat };
}
