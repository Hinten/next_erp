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
import type { NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { NFeOrchestratorError } from './errors';
import { loadPedidoBundle, type EmitResult } from './bundle';
import { sefazCallFor } from './sefaz-call';
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
  baseRt: NFeRuntime,
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
    .map((d) => ({ id: d.id, nota: d.data() as NotaFiscalEletronica }))
    .filter((c) => c.nota.chave)
    .sort((a, b) =>
      String(b.nota.ultima_modificacao ?? '').localeCompare(
        String(a.nota.ultima_modificacao ?? ''),
      ),
    )[0];
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

  const patch = applyOutcome({ estado: nota.estado, retries: nota.retries ?? 0 }, outcome);
  await persistPatch(nfeRef, patch);

  return {
    nfeId: nfeRef.id,
    pedidoId,
    estado: patch.estado,
    chave,
    nRec: patch.nRec ?? msgWithNRec?.nRec ?? nota.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    reused: false,
  };
}
