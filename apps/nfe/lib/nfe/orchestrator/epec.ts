/**
 * EPEC — Evento Prévio de Emissão em Contingência (tpEmis=4).
 *
 * Two halves of the MOC Anexo III flow:
 *
 *   1. `enviarEpecParaNota` — emission while the home SEFAZ is down: the
 *      NF-e is generated + signed + persisted as usual (anti-loss anchor),
 *      but instead of `autorizarLote` the orchestrator sends the EPEC
 *      summary evento (tpEvento 110140) to the **Ambiente Nacional**.
 *      cStat 135 **or** 136 = EPEC registrado → estado `'p'` (epecAprovado)
 *      + the archival `xml_epec_proc`; the DANFE may then be printed.
 *
 *   2. `transmitirPosEpec` — after the outage: the FULL NF-e (the stored
 *      `xml_assinado`, **same chave** — never regenerated) is transmitted to
 *      the home SEFAZ. 100/150 → aprovada + `xml_nfe_proc`; **468** (EPEC
 *      not yet synced from the AN) keeps estado `'p'` for a later retry;
 *      duplicidade rides the standard recovery branches.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { enviNfeMsgCollection, nfev4Collection } from '@delfrance/data/admin/collections';
import {
  CSTAT_EPEC_NAO_SINCRONIZADO,
  EPEC_EVENT_REGISTRADO,
  autorizarLote,
  enviarEpec,
  extractEpecInputFromNFe,
  nextIdLote,
  nfeConfigStoreFromFirestore,
  type SefazCall,
} from '@delfrance/integrations-nfe';
import { ESTADO_ENVI_NFE_MSG, ESTADO_NFE, type NotaFiscalEletronica } from '@delfrance/schemas';

import type { NFeRuntime } from '../runtime';
import { NFeOrchestratorError } from './errors';
import type { EmitResult } from './bundle';
import { applyAutorizadoOutcome } from './emitir';
import { enviNfeCollection, persistPatch } from './audit';
import { sefazCallFor } from './sefaz-call';

/**
 * Send the EPEC evento for a just-signed contingency NF-e and persist the
 * outcome on its nfev4 doc. Called by the emit cycle in place of
 * `autorizarLote` when the filial's modo is `'epec'`.
 */
export async function enviarEpecParaNota(args: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  pedidoId: string;
  nfeRef: FirebaseFirestore.DocumentReference;
  chave: string;
  signedXml: string;
}): Promise<EmitResult> {
  const { fs, rt, filialId, pedidoId, nfeRef, chave, signedXml } = args;

  const input = extractEpecInputFromNFe(signedXml, { tpAmb: rt.tpAmb });
  const anTarget = rt.an();
  const call: SefazCall = {
    url: anTarget.endpoints.RecepcaoEvento,
    cert: rt.cert,
    agent: anTarget.agent,
    tpAmb: rt.tpAmb,
  };
  const res = await enviarEpec(call, input);
  const ev = res.ret.retEvento?.[0]?.infEvento;
  const cStat = ev?.cStat ?? res.ret.cStat;
  const xMotivo = ev?.xMotivo ?? res.ret.xMotivo;
  const registrado = EPEC_EVENT_REGISTRADO.has(cStat);
  const now = (): string => new Date().toISOString();

  // Audit-log the AN round-trip (both halves) before touching the nfev4 doc.
  await enviNfeCollection(fs, filialId).add(
    enviNfeMsgCollection.parse({
      targetsChnfe: [chave],
      idLote: null,
      indSinc: null,
      xml_enviado: res.signedEventoXml,
      xml_retorno: res.rawResponse,
      nRec: null,
      cStat,
      xMotivo,
      error: null,
      tpEmis: 4,
      estado: ESTADO_ENVI_NFE_MSG.concluido,
      timestamp: now(),
      ultima_modificacao: now(),
    }),
  );

  // 135/136 = registrado (legacy parity — 136's linkage happens when the
  // full NF-e lands at the home SEFAZ). Anything else — including 485,
  // duplicidade de EPEC — is a rejection in v1 (auto-recovery is #81).
  await nfeRef.set(
    nfev4Collection.parseMerge({
      estado: registrado ? ESTADO_NFE.epecAprovado : ESTADO_NFE.rejeitada,
      cStat,
      xMotivo,
      retries: 0,
      ...(registrado && res.procEventoNFe ? { xml_epec_proc: res.procEventoNFe } : {}),
      ultima_modificacao: now(),
    }),
    { merge: true },
  );

  return {
    nfeId: nfeRef.id,
    pedidoId,
    estado: registrado ? ESTADO_NFE.epecAprovado : ESTADO_NFE.rejeitada,
    chave,
    nRec: null,
    cStat,
    xMotivo,
    reused: false,
  };
}

/**
 * Transmit the FULL NF-e of an EPEC-approved doc (estado `'p'`) to the home
 * SEFAZ — the mandatory post-outage step. Sends the **stored** `xml_assinado`
 * (same chave; regenerating would orphan the registered EPEC) as a fresh
 * single-NFe sync lote, then applies the standard outcome machine:
 * 100/150 → aprovada + `xml_nfe_proc`; 468 (EPEC não sincronizado no
 * destino) keeps `'p'` and backs off; duplicidade recovers via consulta.
 */
export async function transmitirPosEpec(args: {
  fs: Firestore;
  rt: NFeRuntime;
  filialId: string;
  pedidoId: string;
  nfeRef: FirebaseFirestore.DocumentReference;
  nota: NotaFiscalEletronica;
}): Promise<EmitResult> {
  const { fs, rt, filialId, pedidoId, nfeRef, nota } = args;
  if (nota.estado !== ESTADO_NFE.epecAprovado) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}' nfe '${nfeRef.id}': estado='${nota.estado}' — ` +
        'transmissão pós-EPEC exige estado epecAprovado.',
    );
  }
  if (!nota.chave || !nota.xml_assinado) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}' nfe '${nfeRef.id}': EPEC aprovado sem chave/xml_assinado ` +
        'persistidos — não é possível transmitir a NF-e completa.',
    );
  }

  // Fresh lote per attempt (the emission invariant), allocated transactionally
  // via the library's contention-hardened counter adapter.
  const idLote = await nextIdLote(nfeConfigStoreFromFirestore(fs), filialId);
  // tpEmis=4 authorizes at the HOME SEFAZ (sefaz-call routes 4 → normal).
  const call: SefazCall = sefazCallFor(rt, 4, 'NfeAutorizacao');
  const retEnvi = await autorizarLote(call, {
    idLote: String(idLote),
    NFe: [nota.xml_assinado],
  });

  // 468 — the home SEFAZ hasn't received the EPEC from the AN yet. Keep
  // estado 'p' (epecAprovado) and let the pendentes poller retry later; the
  // generic outcome machine would mis-map 468 to rejeitada.
  const protCStat = retEnvi.protNFe?.infProt.cStat;
  if (protCStat === CSTAT_EPEC_NAO_SINCRONIZADO) {
    await persistPatch(nfeRef, {
      estado: ESTADO_NFE.epecAprovado,
      cStat: protCStat,
      xMotivo: retEnvi.protNFe?.infProt.xMotivo ?? retEnvi.xMotivo,
      retries: (nota.retries ?? 0) + 1,
      nRec: null,
      action: 'backoff',
    });
    return {
      nfeId: nfeRef.id,
      pedidoId,
      estado: ESTADO_NFE.epecAprovado,
      chave: nota.chave,
      nRec: null,
      cStat: protCStat,
      xMotivo: retEnvi.protNFe?.infProt.xMotivo ?? retEnvi.xMotivo,
      reused: false,
    };
  }

  // Everything else (100/150, rejections, duplicidade recovery, nfeProc
  // assembly + audit log) is the standard emission outcome flow.
  return applyAutorizadoOutcome({
    fs,
    rt,
    bundle: { pedidoId, filialId },
    nfeRef,
    chave: nota.chave,
    signedXml: nota.xml_assinado,
    idLote,
    tpEmis: 4,
    retEnvi,
    protNFeForChave: null,
    indSinc: '1',
  });
}
