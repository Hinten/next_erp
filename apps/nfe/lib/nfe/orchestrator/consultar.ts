import type { Firestore } from 'firebase-admin/firestore';

import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  consultarLote,
  consultarSituacaoNFe,
  outcomeFromRetConsSit,
  type SefazCall,
  type SefazOutcome,
  type TpEmis,
} from '@delfrance/integrations-nfe';

import type { NFeBaseRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { NFeOrchestratorError } from './errors';
import { loadPedidoBundle, type EmitResult } from './bundle';
import { sefazCallFor } from './sefaz-call';
import { recover539IfNeeded } from './recover539';
import {
  buildEnviNFeMsgFromConsulta,
  enviNfeCollection,
  findLatestEnviNFeMsgWithNRec,
  outcomeFromConsReci,
  persistPatch,
} from './audit';

/**
 * Standalone SEFAZ consulta for an already-persisted nfev4 doc. Picks the
 * pedido's most recently touched NF-e (a pedido can hold one doc per tpEmis
 * — `s1` plus `s6`/`s7` across contingency flips), queries SEFAZ via
 * `consultarSituacaoNFe`, applies the outcome, persists the patch, and
 * returns the same shape `emitirPedido` does (with `reused: false` — always
 * a fresh SEFAZ call).
 *
 * Mirrors the `recover-via-consulta` branch inside `emitirPedido` but
 * starts from a persisted doc instead of a just-completed lote response.
 * Used by the `consult:dev-pedido` CLI for manual polling and (later)
 * by the `processar-pendentes` cron.
 */
export async function consultarPedido(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  pedidoId: string,
): Promise<EmitResult> {
  console.debug(`[nfe/orchestrator] consultarPedido pedidoId='${pedidoId}'`);

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
    .map((d) => ({ id: d.id, nota: nfev4Collection.parseRead(d.data(), d.ref.path) }))
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
  // SEFAZ routing follows the PERSISTED tpEmis (an SVC-emitted NF-e is
  // consulted at its SVC even after the mode is switched back).
  const notaTpEmis = (nota.tpEmis ?? 1) as TpEmis;

  // Prefer consReci(nRec) when an audit-log msg holds a receipt — it
  // works while the lote is still queued at SEFAZ (cStat=105) and
  // gives us the protocol once processed. Fall back to consSit(chave)
  // only when no msg with nRec exists (e.g. externally-recovered NFe).
  const msgWithNRec = await findLatestEnviNFeMsgWithNRec(fs, bundle.filialId, chave);

  let outcome: SefazOutcome;
  if (msgWithNRec?.nRec) {
    const consReciCall: SefazCall = sefazCallFor(rt, notaTpEmis, 'NfeRetAutorizacao');
    const retRec = await consultarLote(consReciCall, { nRec: msgWithNRec.nRec });
    await enviNfeCollection(fs, bundle.filialId).add(
      buildEnviNFeMsgFromConsulta({
        chave,
        nRec: msgWithNRec.nRec,
        ret: retRec,
        tpEmis: notaTpEmis,
      }),
    );
    outcome = outcomeFromConsReci(retRec, chave);
  } else {
    const consSitCall: SefazCall = sefazCallFor(rt, notaTpEmis, 'NfeConsultaProtocolo');
    const retSit = await consultarSituacaoNFe(consSitCall, { chave });
    await enviNfeCollection(fs, bundle.filialId).add(
      buildEnviNFeMsgFromConsulta({
        chave,
        nRec: null,
        ret: retSit,
        tpEmis: notaTpEmis,
      }),
    );
    outcome = outcomeFromRetConsSit(retSit);
  }

  let patch = applyOutcome({ estado: nota.estado, retries: nota.retries ?? 0 }, outcome);

  // cStat=539 (duplicidade com chave diferente): recover the SEFAZ-asserted
  // chave if it is one we emitted, else flip to terminal `error` — never leave
  // the doc stuck aguardandoResposta (#243). No-op for every other outcome.
  const recovered539 = await recover539IfNeeded({
    fs,
    bundle,
    nfeRef,
    rt,
    tpEmis: notaTpEmis,
    outcome,
    patch,
  });
  patch = recovered539.patch;
  const finalChave = recovered539.chaveOverride ?? chave;

  await persistPatch(nfeRef, patch);

  return {
    nfeId: nfeRef.id,
    pedidoId,
    estado: patch.estado,
    chave: finalChave,
    nRec: patch.nRec ?? msgWithNRec?.nRec ?? nota.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    reused: false,
  };
}
