import type { Firestore } from 'firebase-admin/firestore';

import { nfev4Collection } from '@delfrance/data/admin/collections';
import {
  applyOutcome,
  consultarLote,
  consultarSituacaoNFe,
  outcomeFromRetConsSit,
  resolveTpEmis,
  type SefazCall,
  type SefazOutcome,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import type { NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { NFeOrchestratorError } from './errors';
import { loadNfeConfigForEmission, loadPedidoBundle, nfeDocId, type EmitResult } from './bundle';
import { sefazCallFor } from './sefaz-call';
import {
  buildEnviNFeMsgFromConsulta,
  enviNfeCollection,
  findLatestEnviNFeMsgWithNRec,
  outcomeFromConsReci,
  persistPatch,
} from './audit';

/**
 * Standalone SEFAZ consulta for an already-persisted nfev4 doc. Reads
 * the stable `s${tpEmis}` doc, queries SEFAZ via `consultarSituacaoNFe`,
 * applies the outcome, persists the patch, and returns the same shape
 * `emitirPedido` does (with `reused: false` — always a fresh SEFAZ call).
 *
 * Mirrors the `recover-via-consulta` branch inside `emitirPedido` but
 * starts from a persisted doc instead of a just-completed lote response.
 * Used by the `consult:dev-pedido` CLI for manual polling and (later)
 * by the `processar-pendentes` cron.
 */
export async function consultarPedido(
  fs: Firestore,
  rt: NFeRuntime,
  pedidoId: string,
): Promise<EmitResult> {
  console.debug(`[nfe/orchestrator] consultarPedido pedidoId='${pedidoId}'`);

  const bundle = await loadPedidoBundle(fs, pedidoId);
  // Target the doc slot the CURRENT config mode would emit into (`s1`
  // normally, `s6`/`s7` while SVC contingency is active) — consulting
  // mid-contingency must look at the contingency NF-e.
  const cfg = await loadNfeConfigForEmission(fs, bundle.filialId);
  const tpEmis = resolveTpEmis(bundle.filial.sede.estado, cfg.contingencia_modo);
  const nfeRef = nfev4Collection.docRef(fs, { pedidoId }, nfeDocId(tpEmis));

  const snap = await nfeRef.get();
  if (!snap.exists) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}': no nfev4 doc at ${nfeRef.path} — nothing to consult. ` +
        'Run `emit:dev-pedido` first.',
    );
  }
  const nota = snap.data() as NotaFiscalEletronica;
  if (!nota.chave) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}': persisted nfev4 doc has no chave — cannot consult.`,
    );
  }
  // SEFAZ routing follows the PERSISTED tpEmis (an SVC-emitted NF-e is
  // consulted at its SVC even after the mode is switched back).
  const notaTpEmis = (nota.tpEmis ?? 1) as TpEmis;

  // Prefer consReci(nRec) when an audit-log msg holds a receipt — it
  // works while the lote is still queued at SEFAZ (cStat=105) and
  // gives us the protocol once processed. Fall back to consSit(chave)
  // only when no msg with nRec exists (e.g. externally-recovered NFe).
  const msgWithNRec = await findLatestEnviNFeMsgWithNRec(fs, bundle.filialId, nota.chave);

  let outcome: SefazOutcome;
  if (msgWithNRec?.nRec) {
    const consReciCall: SefazCall = sefazCallFor(rt, notaTpEmis, 'NfeRetAutorizacao');
    const retRec = await consultarLote(consReciCall, { nRec: msgWithNRec.nRec });
    await enviNfeCollection(fs, bundle.filialId).add(
      buildEnviNFeMsgFromConsulta({
        chave: nota.chave,
        nRec: msgWithNRec.nRec,
        ret: retRec,
        tpEmis,
      }),
    );
    outcome = outcomeFromConsReci(retRec, nota.chave);
  } else {
    const consSitCall: SefazCall = sefazCallFor(rt, notaTpEmis, 'NfeConsultaProtocolo');
    const retSit = await consultarSituacaoNFe(consSitCall, { chave: nota.chave });
    await enviNfeCollection(fs, bundle.filialId).add(
      buildEnviNFeMsgFromConsulta({
        chave: nota.chave,
        nRec: null,
        ret: retSit,
        tpEmis,
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
    chave: nota.chave,
    nRec: patch.nRec ?? msgWithNRec?.nRec ?? nota.nRec,
    cStat: patch.cStat,
    xMotivo: patch.xMotivo,
    reused: false,
  };
}
