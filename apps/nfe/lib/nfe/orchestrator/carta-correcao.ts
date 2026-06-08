import type { Firestore } from 'firebase-admin/firestore';

import { cartaCorrecaoNFe, sanitizeNFeText, type SefazCall } from '@delfrance/integrations-nfe';
import { ESTADO_ENVI_NFE_MSG, ESTADO_NFE, type NotaFiscalEletronica } from '@delfrance/schemas';

import { cartaCorrecaoCollection, nfev4Collection } from '@delfrance/data/admin/collections';

import type { NFeRuntime } from '../runtime';
import { NFeCartaCorrecaoError, NFeOrchestratorError, NFePedidoNotFoundError } from './errors';

/**
 * SEFAZ event cStat that means the CC-e was **accepted** — "evento registrado e
 * vinculado à NF-e". Only 135 counts: 136 (registrado mas NÃO vinculado) means
 * the correction wasn't attached to the document, so we surface it as a failure
 * (not a silent success). Mirrors the cancelamento accept-set in `cancelar.ts`,
 * but cancelamento also accepts 155/573 — CC-e accepts only 135.
 *
 * TODO(#81): 136 is non-terminal — the event WAS registered, just not yet linked;
 * it should trigger an async linkage re-check (DistDFe / consulta) instead of a
 * hard rejection. Deferred to the async signals + GCloud/Firebase infra phase.
 */
export const CSTAT_CCE_ACEITA = '135';

/** Result of a carta de correção (CC-e) round-trip. */
export interface CartaCorrecaoServiceResult {
  readonly pedidoId: string;
  readonly nfeId: string;
  /** Event sequence number used for this CC-e (1, 2, 3, …). */
  readonly nSeqEvento: number;
  readonly cStat: string;
  readonly xMotivo: string;
  /** Event protocolo returned on cStat=135. */
  readonly nProt: string | null;
  /** `true` when SEFAZ registrou e vinculou (cStat 135). */
  readonly accepted: boolean;
}

/**
 * Register a carta de correção eletrônica (CC-e) for a specific authorized NF-e
 * (RecepcaoEvento, `tpEvento=110110`).
 *
 * Targets the `nfev4` doc by **id**. Reads the NF-e estado from the **DB** — a
 * CC-e is only allowed on an **aprovada** NF-e. Computes the next `nSeqEvento`
 * from the count of already-accepted (concluido) CC-e for this NF-e, so a
 * rejected attempt does not advance the sequence (SEFAZ only increments on
 * accept). Sends the event, then **persists a durable `cartacorrecao` record**
 * — registrada (cStat 135) OR rejeitada — as the single source of truth for the
 * round-trip (mirrors the inutilização record pattern). On any cStat ≠ 135 the
 * record is saved with `estado='error'` and `NFeCartaCorrecaoError` is thrown
 * (the route maps it to 422, carrying cStat/xMotivo for a clean UI message).
 *
 * No filialId is needed — the chave carries cUF (cOrgao) + CNPJ.
 */
export async function cartaCorrecaoService(
  fs: Firestore,
  rt: NFeRuntime,
  pedidoId: string,
  nfeId: string,
  xCorrecao: string,
): Promise<CartaCorrecaoServiceResult> {
  console.debug(`[nfe/orchestrator] cartaCorrecaoService pedidoId='${pedidoId}' nfeId='${nfeId}'`);

  const nfeRef = nfev4Collection.docRef(fs, { pedidoId }, nfeId);
  const snap = await nfeRef.get();
  if (!snap.exists) {
    // The NF-e to correct doesn't exist (no emission for this pedido/slot) — 404.
    throw new NFePedidoNotFoundError(pedidoId);
  }
  const nota = snap.data() as NotaFiscalEletronica;
  if (!nota.chave) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}' nfe '${nfeId}': persisted nfev4 doc has no chave — cannot emit CC-e.`,
    );
  }
  if (nota.estado !== ESTADO_NFE.aprovada) {
    throw new NFeCartaCorrecaoError(
      `pedido '${pedidoId}' nfe '${nfeId}': estado='${nota.estado}' — ` +
        'apenas NF-e autorizada (aprovada) pode receber carta de correção.',
    );
  }

  // Next sequence = (count of already-accepted CC-e) + 1. A single-field
  // equality query rides Firestore's automatic index — no composite index.
  const acceptedSnap = await cartaCorrecaoCollection
    .ref(fs, { pedidoId, nfeId })
    .where('estado', '==', ESTADO_ENVI_NFE_MSG.concluido)
    .get();
  const nSeqEvento = acceptedSnap.size + 1;

  // The wire <xCorrecao> is sanitized (the builder drops SEFAZ-restricted
  // chars); store that same value so the persisted record matches what SEFAZ
  // actually received (and the <xCorrecao> inside xml_enviado).
  const xCorrecaoWire = sanitizeNFeText(xCorrecao) ?? xCorrecao;

  // Send the CC-e evento (cOrgao + cnpj come from the chave).
  const cceCall: SefazCall = {
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
    url: rt.endpoints.RecepcaoEvento,
  };
  const res = await cartaCorrecaoNFe(cceCall, {
    chNFe: nota.chave,
    cOrgao: nota.chave.slice(0, 2),
    cnpj: nota.chave.slice(6, 20),
    xCorrecao: xCorrecaoWire,
    nSeqEvento,
  });
  const ev = res.ret.retEvento?.[0]?.infEvento;
  const cStat = ev?.cStat ?? res.ret.cStat;
  const xMotivo = ev?.xMotivo ?? res.ret.xMotivo;
  const nProt = ev?.nProt || null;
  const accepted = cStat === CSTAT_CCE_ACEITA;
  const now = (): string => new Date().toISOString();

  // Persist the durable CC-e record — registrada OR rejeitada. This is the
  // single source of truth for the round-trip (the dedicated screen reads it
  // directly); there is no separate enviNfe audit entry.
  await cartaCorrecaoCollection.add(
    fs,
    { pedidoId, nfeId },
    {
      xCorrecao: xCorrecaoWire,
      nSeqEvento,
      xml_enviado: res.signedEventoXml,
      xml_retorno: res.rawResponse,
      cStat,
      xMotivo,
      nProt,
      error: accepted ? null : `cStat ${cStat} — ${xMotivo}`,
      tpEmis: nota.tpEmis ?? null,
      estado: accepted ? ESTADO_ENVI_NFE_MSG.concluido : ESTADO_ENVI_NFE_MSG.error,
      timestamp: now(),
      ultima_modificacao: now(),
    },
  );

  if (!accepted) {
    throw new NFeCartaCorrecaoError(
      `pedido '${pedidoId}' nfe '${nfeId}': carta de correção rejeitada por SEFAZ — cStat=${cStat} ${xMotivo}`,
      cStat,
      xMotivo,
    );
  }

  return { pedidoId, nfeId, nSeqEvento, cStat, xMotivo, nProt, accepted: true };
}
