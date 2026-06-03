import type { Firestore } from 'firebase-admin/firestore';

import {
  cancelarNFe,
  type SefazCall,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import {
  ESTADO_ENVI_NFE_MSG,
  ESTADO_NFE,
  type NotaFiscalEletronica,
} from '@delfrance/schemas';

import { enviNfeMsgCollection } from '@/lib/data/enviNfeMsgCollection';
import { nfev4Collection } from '@/lib/data/nfev4Collection';
import type { NFeRuntime } from '../runtime';
import { NFeCancelamentoError, NFeOrchestratorError } from './errors';
import { getField, refToPath, type EmitResult } from './bundle';
import { enviNfeCollection } from './audit';

/** Extract the authorization protocol (`nProt`) from a stored procNFe envelope. */
export const RE_NPROT = /<nProt>([^<]+)<\/nProt>/;
/**
 * SEFAZ event cStat for a duplicate cancelamento. A 573 means a cancelamento
 * event (same chNFe + tpEvento=110111 + nSeqEvento=1) is already registered —
 * i.e. the NF-e is already cancelled — so we reconcile the local estado.
 */
export const CSTAT_DUPLICIDADE_EVENTO = '573';

/**
 * Cancel a specific authorized NF-e (RecepcaoEvento, `tpEvento=110111`).
 *
 * Targets the `nfev4` doc by **id** (a pedido may hold more than one — e.g. a
 * normal + a contingency NF-e). Reads the NF-e estado from the **DB** — it never
 * consults SEFAZ (avoids Consumo Indevido), so it's idempotent: an
 * already-cancelada NF-e returns immediately without sending an event, and a
 * non-aprovada one is rejected upfront. The authorization protocol (`nProt`)
 * comes from the stored procNFe envelope (`xml_nfe_proc`). On cStat 135/155 —
 * or 573 (duplicidade de evento: the cancelamento is already registered at
 * SEFAZ) — `estado='c'` is persisted **in a transaction**. Any other cStat
 * throws `NFeCancelamentoError` (carrying cStat/xMotivo for a clean UI message).
 */
export async function cancelarNFeService(
  fs: Firestore,
  rt: NFeRuntime,
  pedidoId: string,
  nfeId: string,
  xJust: string,
): Promise<EmitResult> {
  console.debug(`[nfe/orchestrator] cancelarNFeService pedidoId='${pedidoId}' nfeId='${nfeId}'`);

  const nfeRef = nfev4Collection.docRef(fs, { pedidoId }, nfeId);
  const snap = await nfeRef.get();
  if (!snap.exists) {
    throw new NFeOrchestratorError(`pedido '${pedidoId}': nfev4 doc '${nfeId}' not found.`);
  }
  const nota = snap.data() as NotaFiscalEletronica;
  if (!nota.chave) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}' nfe '${nfeId}': persisted nfev4 doc has no chave — cannot cancel.`,
    );
  }

  // Idempotency + precondition straight from the DB (no SEFAZ).
  if (nota.estado === ESTADO_NFE.cancelada) {
    return {
      nfeId,
      pedidoId,
      estado: ESTADO_NFE.cancelada,
      chave: nota.chave,
      nRec: null,
      cStat: nota.cStat ?? '135',
      xMotivo: nota.xMotivo ?? 'NF-e já cancelada.',
      reused: true,
    };
  }
  if (nota.estado !== ESTADO_NFE.aprovada) {
    throw new NFeCancelamentoError(
      `pedido '${pedidoId}' nfe '${nfeId}': estado='${nota.estado}' — ` +
        'apenas NF-e autorizada (aprovada) pode ser cancelada.',
    );
  }

  // filialId for the audit log — from the pedido's filial outer-ref. No full
  // bundle: cancellation must not depend on cliente/operação/endereço loading.
  // eslint-disable-next-line no-restricted-syntax -- read-only; pedido docs are written by apps/web / apps/integrations handles, not here
  const pedidoSnap = await fs.collection('pedidos').doc(pedidoId).get();
  if (!pedidoSnap.exists) {
    throw new NFeOrchestratorError(`pedido '${pedidoId}' not found.`);
  }
  const filialPath = refToPath(getField(pedidoSnap.data(), 'filialPedidoOuterRef'));
  if (!filialPath) {
    throw new NFeOrchestratorError(`pedido '${pedidoId}': filialPedidoOuterRef missing.`);
  }
  const filialId = filialPath.split('/').pop()!;


  // nProt from the stored proc envelope — never from a SEFAZ consult.
  const nProt = nota.xml_nfe_proc ? RE_NPROT.exec(nota.xml_nfe_proc)?.[1] : undefined;
  if (!nProt) {
    throw new NFeCancelamentoError(
      `pedido '${pedidoId}' nfe '${nfeId}': protocolo (nProt) ausente em xml_nfe_proc — ` +
        'não é possível cancelar sem consultar a SEFAZ (DistDFe é Fase D).',
    );
  }

  const tpEmis = (nota.tpEmis ?? 1) as TpEmis;
  const now = (): string => new Date().toISOString();

  // Send the cancelamento evento (cOrgao + cnpj come from the chave).
  const cancelCall: SefazCall = {
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
    url: rt.endpoints.RecepcaoEvento,
  };
  const res = await cancelarNFe(cancelCall, {
    chNFe: nota.chave,
    cOrgao: nota.chave.slice(0, 2),
    cnpj: nota.chave.slice(6, 20),
    nProt,
    xJust,
  });
  const ev = res.ret.retEvento?.[0]?.infEvento;
  const cStat = ev?.cStat ?? res.ret.cStat;
  const xMotivo = ev?.xMotivo ?? res.ret.xMotivo;

  // Audit-log the cancelamento round-trip (both halves of procEventoNFe).
  await enviNfeCollection(fs, filialId).add(
    enviNfeMsgCollection.parse({
      targetsChnfe: [nota.chave],
      idLote: null,
      indSinc: null,
      xml_enviado: res.signedEventoXml,
      xml_retorno: res.rawResponse,
      nRec: null,
      cStat,
      xMotivo,
      error: null,
      tpEmis,
      estado: ESTADO_ENVI_NFE_MSG.concluido,
      timestamp: now(),
      ultima_modificacao: now(),
    }),
  );

  // 135 (registrado + vinculado) / 155 (homologado fora de prazo) = cancelled.
  // 573 (duplicidade de evento) = the cancelamento is already registered at
  // SEFAZ → reconcile the local estado. Anything else is a real rejection.
  const cancelled =
    cStat === '135' || cStat === '155' || cStat === CSTAT_DUPLICIDADE_EVENTO;
  if (!cancelled) {
    throw new NFeCancelamentoError(
      `pedido '${pedidoId}' nfe '${nfeId}': cancelamento rejeitado por SEFAZ — cStat=${cStat} ${xMotivo}`,
      cStat,
      xMotivo,
    );
  }

  // Persist estado='cancelada' transactionally (guard a concurrent cancel).
  await fs.runTransaction(async (tx) => {
    const cur = (await tx.get(nfeRef)).data() as NotaFiscalEletronica | undefined;
    if (cur?.estado === ESTADO_NFE.cancelada) return;
    tx.set(
      nfeRef,
      nfev4Collection.parseMerge({
        estado: ESTADO_NFE.cancelada,
        cStat,
        xMotivo,
        retries: 0,
        ultima_modificacao: now(),
      }),
      { merge: true },
    );
  });

  return {
    nfeId,
    pedidoId,
    estado: ESTADO_NFE.cancelada,
    chave: nota.chave,
    nRec: null,
    cStat,
    xMotivo,
    reused: false,
  };
}
