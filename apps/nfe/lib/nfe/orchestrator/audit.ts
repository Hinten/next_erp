import type { Firestore } from 'firebase-admin/firestore';

import { enviNfeMsgCollection, nfev4Collection } from '@delfrance/data/admin/collections';
import {
  autorizarLote,
  consultarLote,
  consultarSituacaoNFe,
  nextConsultaDelayMs,
  outcomeFromInfProt,
  outcomeFromRetConsRec,
  type NFeStatePatch,
  type SefazOutcome,
  type TpEmis,
} from '@delfrance/integrations-nfe';
import { nowMicros } from '@delfrance/core/datetime';
import {
  ESTADO_ENVI_NFE_MSG,
  ESTADO_NFE,
  type EnviNFeMsg,
  type NotaFiscalEletronica,
} from '@delfrance/schemas';

import type { EmitResult } from './bundle';

/** A filial's `enviNfe` audit-log subcollection, via the validated handle. */
export function enviNfeCollection(fs: Firestore, filialId: string) {
  return enviNfeMsgCollection.ref(fs, { filialId });
}

/**
 * Build a typed write payload for a SEFAZ `autorizarLote` round-trip
 * — to be persisted as a new doc under the filial's `enviNfe`
 * subcollection. Mirrors Flutter's
 * `EnviNFeMsg.fromRetEnviNFeSchema` at
 * `.old/packages/nfe_client/lib/src/models.dart:333`.
 *
 * The response is JSON-stringified into `xml_retorno` for Phase A —
 * preserves every field we use (nRec, cStat, protocols, errors). If
 * raw SEFAZ XML is ever needed for external audit, that's a library
 * change (return `{ parsed, raw }` from `autorizarLote`).
 */
export function buildEnviNFeMsgFromLote(params: {
  chave: string;
  idLote: number;
  tpEmis: TpEmis;
  signedXml: string;
  retEnvi: Awaited<ReturnType<typeof autorizarLote>>;
  /**
   * Pre-stringified `retEnvi`. Batch callers pass this once per chunk so
   * the same lote response isn't re-serialized once per chave (PR-δ);
   * defaults to stringifying `retEnvi` for the single-pedido path.
   */
  retEnviJson?: string;
  /** `'1'` (sync) for 1-NFe lotes; `'0'` (async) for N>1 batches. */
  indSinc: '0' | '1';
}): Record<string, unknown> {
  const now = new Date().toISOString();
  return enviNfeMsgCollection.parse({
    targetsChnfe: [params.chave],
    idLote: params.idLote,
    indSinc: params.indSinc,
    xml_enviado: params.signedXml,
    xml_retorno: params.retEnviJson ?? JSON.stringify(params.retEnvi),
    nRec: params.retEnvi.infRec?.nRec ?? null,
    cStat: params.retEnvi.cStat,
    xMotivo: params.retEnvi.xMotivo,
    error: null,
    tpEmis: params.tpEmis,
    estado: ESTADO_ENVI_NFE_MSG.respondido,
    timestamp: now,
    ultima_modificacao: now,
  });
}

/**
 * Build a typed write payload for a `consReciNFe` (preferred — has
 * the lote receipt) or `consSitNFe` (fallback — by chave) round-trip.
 * The `nRec` is carried forward from the originating lote message so
 * a single chave's audit chain stays linkable.
 */
export function buildEnviNFeMsgFromConsulta(params: {
  chave: string;
  nRec: string | null;
  ret: Awaited<ReturnType<typeof consultarLote>> | Awaited<ReturnType<typeof consultarSituacaoNFe>>;
  tpEmis: TpEmis;
}): Record<string, unknown> {
  const now = new Date().toISOString();
  return enviNfeMsgCollection.parse({
    targetsChnfe: [params.chave],
    idLote: null,
    indSinc: null,
    xml_enviado: null,
    xml_retorno: JSON.stringify(params.ret),
    nRec: params.nRec,
    cStat: params.ret.cStat,
    xMotivo: params.ret.xMotivo,
    error: null,
    tpEmis: params.tpEmis,
    estado: ESTADO_ENVI_NFE_MSG.concluido,
    timestamp: now,
    ultima_modificacao: now,
  });
}

/**
 * Project a `consultarLote` response onto a `SefazOutcome` for our
 * specific chave. The lote-level cStat is `104` (processado) — the
 * authoritative per-NFe status lives in `protNFe[i].infProt.cStat`.
 * When no matching protocol is in the response (lote still in
 * processing — cStat=105) fall back to the lote-level outcome so
 * `applyOutcome` polls again.
 */
export function outcomeFromConsReci(
  ret: Awaited<ReturnType<typeof consultarLote>>,
  chave: string,
): SefazOutcome {
  const ourProt = ret.protNFe?.find((p) => p.infProt.chNFe === chave);
  if (ourProt) return outcomeFromInfProt(ourProt.infProt);
  return outcomeFromRetConsRec(ret);
}

/**
 * Look up the latest `EnviNFeMsg` whose `targetsChnfe` includes `chave`
 * AND that carries a non-null `nRec` — the receipt we need to call
 * `consultarLote`. Returns null when no recoverable msg exists (e.g.
 * the pedido was never sent, or only `consSit` messages were persisted
 * for an externally-recovered chave).
 */
export async function findLatestEnviNFeMsgWithNRec(
  fs: Firestore,
  filialId: string,
  chave: string,
): Promise<EnviNFeMsg | null> {
  const snap = await enviNfeCollection(fs, filialId)
    .where('targetsChnfe', 'array-contains', chave)
    .orderBy('timestamp', 'desc')
    .limit(10)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as EnviNFeMsg;
    if (data.nRec) return data;
  }
  return null;
}

/**
 * Project a persisted `NotaFiscalEletronica` onto the route's `EmitResult`
 * shape — used by the dedup branch when an existing bloqueada nfe makes
 * a re-emission unnecessary.
 */
export function existingToEmitResult(
  pedidoId: string,
  nfeId: string,
  nota: NotaFiscalEletronica,
): EmitResult {
  return {
    nfeId,
    pedidoId,
    estado: nota.estado,
    chave: nota.chave ?? '',
    nRec: nota.nRec ?? null,
    cStat: nota.cStat ?? '',
    xMotivo: nota.xMotivo ?? '',
    reused: true,
  };
}

/**
 * Final-state patch when a duplicidade-class outcome can't be recovered:
 * keeps cStat + the SEFAZ-supplied xMotivo (with its [chNFe:...] /
 * [nRec:...] markers) visible to the operator, appends a short reason
 * tail, and flips estado to `error`. No SEFAZ calls happen after this.
 */
export function markAsLost(patch: NFeStatePatch, reason: string): NFeStatePatch {
  return {
    ...patch,
    estado: ESTADO_NFE.error,
    xMotivo: `${patch.xMotivo} | ${reason}`,
  };
}

/**
 * The ONLY legal way to clear the anti-loss anchor: in the same write that
 * persists the `nfeProc` embedding the very same signed XML (issue #128 —
 * keeping both roughly doubles the XML payload per authorized doc, and the
 * Firestore 1 MiB doc limit is the pressure point). Atomicity is the
 * guarantee that the signed XML is never lost: either the write fails and
 * `xml_assinado` stays, or it succeeds and `xml_nfe_proc` carries the XML.
 * `null` (not `FieldValue.delete()`) because the nfev4 schema requires the
 * field to be present (`.nullable()` without `.optional()`).
 */
export function procPersistExtras(nfeProcXml: string): {
  xml_nfe_proc: string;
  xml_assinado: null;
} {
  return { xml_nfe_proc: nfeProcXml, xml_assinado: null };
}

export async function persistPatch(
  nfeRef: FirebaseFirestore.DocumentReference,
  patch: NFeStatePatch,
  extras?: Record<string, unknown>,
): Promise<void> {
  // Preserve `nRec`: omit it from the merge when the new patch lacks
  // one (e.g. consSit responses don't carry an nRec), so we don't
  // overwrite the value the lote-receipt response (cStat=103) saved.
  // The authoritative receipt always lives in the enviNfe audit log
  // anyway; this copy is just for the NFCell.
  //
  // `extras` lets the caller stamp other fields in the same write —
  // currently used for `xml_nfe_proc` on cStat=100 (autorizada). Kept
  // generic so future fields (e.g. `data_autorizacao`, `nProt`) can
  // ride along without another method.
  //
  // `proximaConsultaEm` (µs epoch) is the async-reconciler gate: when the
  // patch leaves the doc still awaiting SEFAZ (`aguardandoResposta`), stamp
  // the next-allowed-consult time (`now + backoff`, seeded by `tMed` on the
  // first round) so the backstop sweep skips it until then and a re-enqueued
  // Cloud Task lands roughly on it. Any terminal/other estado clears it to
  // `null` so the doc stops being scanned. An explicit `extras` override
  // (rare) wins. Caller-provided `extras` are spread AFTER so they can force
  // a value if ever needed.
  const stampProxima =
    extras != null && Object.prototype.hasOwnProperty.call(extras, 'proximaConsultaEm');
  const proximaConsultaEm =
    patch.estado === ESTADO_NFE.aguardandoResposta
      ? nowMicros() + nextConsultaDelayMs(patch.retries, patch.tMed) * 1000
      : null;
  await nfeRef.set(
    nfev4Collection.parseMerge({
      estado: patch.estado,
      cStat: patch.cStat,
      xMotivo: patch.xMotivo,
      retries: patch.retries,
      ...(patch.nRec != null ? { nRec: patch.nRec } : {}),
      ...(stampProxima ? {} : { proximaConsultaEm }),
      ...(extras ?? {}),
      ultima_modificacao: new Date().toISOString(),
    }),
    { merge: true },
  );
}
