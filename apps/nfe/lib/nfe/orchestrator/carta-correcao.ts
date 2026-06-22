import type { Firestore } from 'firebase-admin/firestore';

import {
  cartaCorrecaoNFe,
  MAX_RECONCILE_ATTEMPTS,
  nextConsultaDelayMs,
  RECONCILE_SWEEP_GRACE_MS,
  sanitizeNFeText,
  type SefazCall,
} from '@delfrance/integrations-nfe';
import { renderCartaCorrecao } from '@delfrance/integrations-nfe/danfe';
import { nowMicros } from '@delfrance/core/datetime';
import {
  type CartaCorrecao,
  ESTADO_ENVI_NFE_MSG,
  ESTADO_NFE,
  type NotaFiscalEletronica,
} from '@delfrance/schemas';

import { cartaCorrecaoCollection, nfev4Collection } from '@delfrance/data/admin/collections';

import type { NFeBaseRuntime, NFeRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { noopTaskScheduler, type CceVinculoTaskPayload, type TaskScheduler } from '../tasks';
import type { DanfeArtifact } from './danfe';
import {
  NFeCartaCorrecaoError,
  NFeDanfeError,
  NFeOrchestratorError,
  NFePedidoNotFoundError,
} from './errors';

/**
 * SEFAZ event cStat that means the CC-e was **accepted** — "evento registrado e
 * vinculado à NF-e". Only 135 is terminal-accepted. Mirrors the cancelamento
 * accept-set in `cancelar.ts`, but cancelamento also accepts 155/573 — CC-e
 * accepts only 135.
 */
export const CSTAT_CCE_ACEITA = '135';

/**
 * cStat 136 — "evento registrado, mas NÃO vinculado à NF-e". Non-terminal (#81):
 * SEFAZ recorded the event but hasn't attached it to the document yet (the NF-e
 * may still be propagating across SEFAZ environments). Instead of a hard
 * rejection we persist `aguardandoVinculo`, schedule an async re-send with the
 * SAME `nSeqEvento` (SEFAZ only increments the sequence on accept), and return a
 * **pending** result — the re-check resolves it to 135 (concluido) or, past the
 * attempt cap, to `error`.
 */
export const CSTAT_CCE_PENDENTE = '136';

/**
 * cStat 573 — "Duplicidade de evento". On a CC-e re-check this means the same
 * nSeqEvento was already registered AND linked: treat it as resolved (concluido),
 * not an error. #81.
 */
const CSTAT_CCE_DUPLICIDADE = '573';

/** The parsed outcome of one CC-e evento round-trip. */
interface CceSendOutcome {
  readonly signedEventoXml: string;
  readonly rawResponse: string;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly nProt: string | null;
}

/**
 * Build the `SefazCall` + send one CC-e evento, returning the parsed outcome.
 * The CC-e ALWAYS routes to the home SEFAZ `RecepcaoEvento` (even for
 * SVC-authorized notas, tpEmis 6/7: the SVC doesn't serve CC-e, but authorized
 * documents are shared with the normal environment, which registers the event —
 * MOC 7.0 Anexo III §2.1.3.4-d). Shared by the first send and the cStat-136
 * re-check so both build the request identically.
 */
async function sendCceEvento(
  rt: NFeRuntime,
  chave: string,
  xCorrecao: string,
  nSeqEvento: number,
): Promise<CceSendOutcome> {
  const cceCall: SefazCall = {
    cert: rt.cert,
    agent: rt.agent,
    tpAmb: rt.tpAmb,
    url: rt.endpoints.RecepcaoEvento,
  };
  const res = await cartaCorrecaoNFe(cceCall, {
    chNFe: chave,
    cOrgao: chave.slice(0, 2),
    cnpj: chave.slice(6, 20),
    xCorrecao,
    nSeqEvento,
  });
  const ev = res.ret.retEvento?.[0]?.infEvento;
  return {
    signedEventoXml: res.signedEventoXml,
    rawResponse: res.rawResponse,
    cStat: ev?.cStat ?? res.ret.cStat,
    xMotivo: ev?.xMotivo ?? res.ret.xMotivo,
    nProt: ev?.nProt || null,
  };
}

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
  /**
   * `true` when SEFAZ registrou mas NÃO vinculou (cStat 136) — the CC-e is
   * `aguardandoVinculo` and an async re-send was scheduled. Mutually exclusive
   * with `accepted`. Both `false` only on the rejected path, which throws. #81.
   */
  readonly pending: boolean;
  /** The persisted `cartacorrecao` record id (so callers can reference it). */
  readonly cceId: string;
}

/**
 * Register a carta de correção eletrônica (CC-e) for a specific authorized NF-e
 * (RecepcaoEvento, `tpEvento=110110`).
 *
 * Targets the `nfev4` doc by **id**. Reads the NF-e estado from the **DB** — a
 * CC-e is only allowed on an **aprovada** NF-e. Computes the next `nSeqEvento`
 * from the count of CC-e that already hold a sequence (concluido OR
 * aguardandoVinculo), so a rejected attempt does not advance the sequence (SEFAZ
 * only increments on accept). Sends the event, then **persists a durable
 * `cartacorrecao` record** as the single source of truth for the round-trip.
 * Three dispositions:
 *   - **cStat 135** (registrado e vinculado) → `estado='concluido'`,
 *     `accepted:true` (route 200).
 *   - **cStat 136** (registrado, NÃO vinculado) → `estado='aguardandoVinculo'`,
 *     `pending:true`, an async re-send is enqueued with the SAME `nSeqEvento`,
 *     and the call **returns** without throwing (route 200) — #81.
 *   - **any other cStat** → `estado='error'` and `NFeCartaCorrecaoError` is
 *     thrown (the route maps it to 422, carrying cStat/xMotivo).
 *
 * `scheduler` enqueues the cStat-136 re-check onto the `reconciliarNfe` queue;
 * it defaults to the no-op (the backstop sweep then resolves the pending CC-e).
 *
 * The chave carries cUF (cOrgao) + CNPJ for routing; the denormalized
 * `nota.filialId` resolves the filial's A1 cert that signs + transmits the CC-e.
 */
export async function cartaCorrecaoService(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  pedidoId: string,
  nfeId: string,
  xCorrecao: string,
  scheduler: TaskScheduler = noopTaskScheduler,
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
  if (nota.estado === ESTADO_NFE.epecAprovado) {
    // Issue #86: the NF-e is only registered as an EPEC summary at the AN —
    // events can't attach until the full NF-e is authorized at the SEFAZ.
    throw new NFeCartaCorrecaoError(
      `pedido '${pedidoId}' nfe '${nfeId}': NF-e em EPEC (estado='p') — ` +
        'transmita a NF-e completa à SEFAZ antes de emitir carta de correção.',
    );
  }
  if (nota.estado !== ESTADO_NFE.aprovada) {
    throw new NFeCartaCorrecaoError(
      `pedido '${pedidoId}' nfe '${nfeId}': estado='${nota.estado}' — ` +
        'apenas NF-e autorizada (aprovada) pode receber carta de correção.',
    );
  }

  // Next sequence = (count of CC-e that already hold a sequence) + 1 — both
  // accepted (concluido) AND still-pending (aguardandoVinculo, cStat 136): a 136
  // event IS registered at SEFAZ under its nSeqEvento, so a fresh CC-e must take
  // the next number, while the pending one is re-sent with its OWN (unchanged)
  // sequence by the re-check task. A rejected (error) attempt holds no sequence,
  // so it's excluded. Single-field `in` rides Firestore's automatic index.
  const sequencedSnap = await cartaCorrecaoCollection
    .ref(fs, { pedidoId, nfeId })
    .where('estado', 'in', [ESTADO_ENVI_NFE_MSG.concluido, ESTADO_ENVI_NFE_MSG.aguardandoVinculo])
    .get();
  const nSeqEvento = sequencedSnap.size + 1;

  // The wire <xCorrecao> is sanitized (the builder drops SEFAZ-restricted
  // chars); store that same value so the persisted record matches what SEFAZ
  // actually received (and the <xCorrecao> inside xml_enviado).
  const xCorrecaoWire = sanitizeNFeText(xCorrecao) ?? xCorrecao;

  if (!nota.filialId) {
    throw new NFeOrchestratorError(
      `pedido '${pedidoId}' nfe '${nfeId}': nfev4 doc sem filialId — ` +
        'não é possível resolver o certificado da filial.',
    );
  }
  // CC-e is signed + transmitted with the filial's own cert (or the env
  // fallback), even though it always routes to the home SEFAZ.
  const rt = await resolveFilialRuntime(fs, baseRt, nota.filialId);

  const { signedEventoXml, rawResponse, cStat, xMotivo, nProt } = await sendCceEvento(
    rt,
    nota.chave,
    xCorrecaoWire,
    nSeqEvento,
  );
  const accepted = cStat === CSTAT_CCE_ACEITA; // 135 — registrado e vinculado
  const pending = cStat === CSTAT_CCE_PENDENTE; // 136 — registrado, ainda não vinculado
  const now = (): string => new Date().toISOString();

  // A pending (136) CC-e is re-checked asynchronously: gate the earliest re-send
  // at now + backoff(0) + sweep grace (µs epoch), mirroring nfeSchema's
  // proximaConsultaEm. Terminal records (accepted/rejected) carry no gate.
  const proximaConsultaEm = pending
    ? nowMicros() + (nextConsultaDelayMs(0) + RECONCILE_SWEEP_GRACE_MS) * 1000
    : null;
  const estado = accepted
    ? ESTADO_ENVI_NFE_MSG.concluido
    : pending
      ? ESTADO_ENVI_NFE_MSG.aguardandoVinculo
      : ESTADO_ENVI_NFE_MSG.error;

  // Persist the durable CC-e record — registrada, aguardando vínculo, OR
  // rejeitada. Single source of truth for the round-trip (the dedicated screen
  // reads it directly); no separate enviNfe audit entry.
  const recordRef = await cartaCorrecaoCollection.add(
    fs,
    { pedidoId, nfeId },
    {
      xCorrecao: xCorrecaoWire,
      nSeqEvento,
      xml_enviado: signedEventoXml,
      xml_retorno: rawResponse,
      cStat,
      xMotivo,
      nProt,
      error: accepted || pending ? null : `cStat ${cStat} — ${xMotivo}`,
      tpEmis: nota.tpEmis ?? null,
      proximaConsultaEm,
      retries: pending ? 0 : null,
      estado,
      timestamp: now(),
      ultima_modificacao: now(),
    },
  );

  if (pending) {
    // cStat 136: registered but not yet linked. Schedule an async re-send with
    // the SAME nSeqEvento on the reconciliarNfe queue and return PENDING — this
    // is NOT a rejection (#81). The route surfaces 200 (aguardandoVinculo); the
    // re-check resolves it to 135 (concluido) or, past the cap, to error.
    await scheduler.enqueueCceVinculo({
      pedidoId,
      nfeId,
      cceId: recordRef.id,
      nSeqEvento,
      attempt: 0,
      scheduleAtMs: Date.now() + nextConsultaDelayMs(0),
    });
    return {
      pedidoId,
      nfeId,
      nSeqEvento,
      cStat,
      xMotivo,
      nProt,
      accepted: false,
      pending: true,
      cceId: recordRef.id,
    };
  }

  if (!accepted) {
    throw new NFeCartaCorrecaoError(
      `pedido '${pedidoId}' nfe '${nfeId}': carta de correção rejeitada por SEFAZ — cStat=${cStat} ${xMotivo}`,
      cStat,
      xMotivo,
    );
  }

  return {
    pedidoId,
    nfeId,
    nSeqEvento,
    cStat,
    xMotivo,
    nProt,
    accepted: true,
    pending: false,
    cceId: recordRef.id,
  };
}

/** Disposition of one cStat-136 CC-e re-check (#81). */
export interface ReconcileCceResult {
  /** The cStat SEFAZ returned on the re-send (null when it never sent). */
  readonly cStat: string | null;
  /**
   * `true` → still cStat 136 under the attempt cap: the record stays
   * `aguardandoVinculo` (retries++ / proximaConsultaEm advanced) and the caller
   * should re-enqueue the next re-check. `false` on every terminal disposition.
   */
  readonly stillPending: boolean;
  /** Set only when `stillPending`: the 0-based attempt to enqueue next. */
  readonly nextAttempt?: number;
  /** What happened, for logging. */
  readonly disposition:
    | 'resolved' // 135 / 573 → concluido
    | 'pending' // 136 under cap → re-enqueue
    | 'capped' // 136 past cap → error
    | 'rejected' // any other cStat → error
    | 'already-resolved' // record no longer aguardandoVinculo (idempotent no-op)
    | 'gone'; // cce / nfev4 doc missing, or NF-e no longer aprovada
}

/**
 * Re-check a cStat-136 CC-e (`aguardandoVinculo`): re-send it with its OWN
 * (unchanged) `nSeqEvento` and resolve the durable record. Idempotent — both the
 * `reconciliarNfe` queue (primary) and the backstop sweep can call it:
 *   - record gone / not `aguardandoVinculo` → no-op (`gone`/`already-resolved`).
 *   - 135 (vinculado) or 573 (duplicidade — já vinculado) → `concluido`.
 *   - 136 again, attempt+1 < cap → bump `retries` + `proximaConsultaEm`, stay
 *     pending; the caller re-enqueues.
 *   - 136 again, attempt+1 ≥ cap → `error` (não vinculada após N tentativas).
 *   - any other cStat → `error` (rejected).
 *
 * Persists the record patch itself; the caller only decides the re-enqueue
 * (mirrors `reconcileByRecibo` ↔ `runReconcile`).
 */
export async function reconcileCartaCorrecaoVinculo(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  input: CceVinculoTaskPayload,
): Promise<ReconcileCceResult> {
  const { pedidoId, nfeId, cceId, attempt } = input;
  const ctx = { pedidoId, nfeId };
  const now = (): string => new Date().toISOString();

  const cceSnap = await cartaCorrecaoCollection.docRef(fs, ctx, cceId).get();
  if (!cceSnap.exists) {
    // Record deleted between enqueue and dispatch — nothing to resolve.
    return { cStat: null, stillPending: false, disposition: 'gone' };
  }
  const cce = cceSnap.data() as CartaCorrecao;
  if (cce.estado !== ESTADO_ENVI_NFE_MSG.aguardandoVinculo) {
    // Already terminal (manual re-send, a prior re-check, or the sweep) —
    // idempotent no-op; DON'T re-enqueue.
    return { cStat: cce.cStat, stillPending: false, disposition: 'already-resolved' };
  }

  const nfeSnap = await nfev4Collection.docRef(fs, { pedidoId }, nfeId).get();
  const nota = nfeSnap.exists ? (nfeSnap.data() as NotaFiscalEletronica) : null;
  if (!nota || !nota.chave || !nota.filialId || nota.estado !== ESTADO_NFE.aprovada) {
    // The NF-e vanished or is no longer correctable (cancelada, lost chave, …) —
    // the linkage can never complete, so close the record as error.
    await cartaCorrecaoCollection.merge(fs, ctx, cceId, {
      estado: ESTADO_ENVI_NFE_MSG.error,
      error: `NF-e '${nfeId}' não está mais apta a vincular CC-e (estado='${nota?.estado ?? 'ausente'}').`,
      proximaConsultaEm: null,
      retries: null,
      ultima_modificacao: now(),
    });
    return { cStat: null, stillPending: false, disposition: 'gone' };
  }

  const rt = await resolveFilialRuntime(fs, baseRt, nota.filialId);
  const { rawResponse, cStat, xMotivo, nProt } = await sendCceEvento(
    rt,
    nota.chave,
    cce.xCorrecao,
    cce.nSeqEvento,
  );

  // 135 (vinculado) or 573 (duplicidade → já vinculado) → resolved.
  if (cStat === CSTAT_CCE_ACEITA || cStat === CSTAT_CCE_DUPLICIDADE) {
    await cartaCorrecaoCollection.merge(fs, ctx, cceId, {
      estado: ESTADO_ENVI_NFE_MSG.concluido,
      cStat,
      xMotivo,
      // 573 carries no fresh nProt — keep the original event protocolo.
      nProt: nProt ?? cce.nProt,
      xml_retorno: rawResponse,
      error: null,
      proximaConsultaEm: null,
      retries: null,
      ultima_modificacao: now(),
    });
    return { cStat, stillPending: false, disposition: 'resolved' };
  }

  // Still 136 → re-check again, unless the attempt cap is reached.
  if (cStat === CSTAT_CCE_PENDENTE) {
    const nextAttempt = attempt + 1;
    if (nextAttempt >= MAX_RECONCILE_ATTEMPTS) {
      await cartaCorrecaoCollection.merge(fs, ctx, cceId, {
        estado: ESTADO_ENVI_NFE_MSG.error,
        cStat,
        xMotivo,
        error: `CC-e não vinculada à NF-e após ${MAX_RECONCILE_ATTEMPTS} tentativas (cStat 136).`,
        proximaConsultaEm: null,
        retries: null,
        ultima_modificacao: now(),
      });
      return { cStat, stillPending: false, disposition: 'capped' };
    }
    await cartaCorrecaoCollection.merge(fs, ctx, cceId, {
      cStat,
      xMotivo,
      retries: nextAttempt,
      proximaConsultaEm:
        nowMicros() + (nextConsultaDelayMs(nextAttempt) + RECONCILE_SWEEP_GRACE_MS) * 1000,
      ultima_modificacao: now(),
    });
    return { cStat, stillPending: true, nextAttempt, disposition: 'pending' };
  }

  // Any other cStat → hard rejection; close the record as error.
  await cartaCorrecaoCollection.merge(fs, ctx, cceId, {
    estado: ESTADO_ENVI_NFE_MSG.error,
    cStat,
    xMotivo,
    error: `cStat ${cStat} — ${xMotivo}`,
    xml_retorno: rawResponse,
    proximaConsultaEm: null,
    retries: null,
    ultima_modificacao: now(),
  });
  return { cStat, stillPending: false, disposition: 'rejected' };
}

/**
 * Produce the Carta de Correção PDF for a specific **registrada** CC-e, rendered
 * from the NF-e's persisted procNFe (`nfev4.xml_nfe_proc`) + the CC-e record
 * (`cartacorrecao/{cceId}`) — never re-generated. Only a registrada CC-e (estado
 * `concluido`, cStat 135) has a valid printout; a rejeitada one is a 422.
 *
 * Errors: `NFePedidoNotFoundError` (404 — no such nfev4 / cce doc), `NFeDanfeError`
 * (422 — no procNFe persisted, or the CC-e is not registrada).
 */
export async function cartaCorrecaoArtifactService(
  fs: Firestore,
  pedidoId: string,
  nfeId: string,
  cceId: string,
): Promise<DanfeArtifact> {
  const nfeSnap = await nfev4Collection.docRef(fs, { pedidoId }, nfeId).get();
  if (!nfeSnap.exists) {
    throw new NFePedidoNotFoundError(pedidoId);
  }
  const nota = nfeSnap.data() as NotaFiscalEletronica;
  if (!nota.xml_nfe_proc) {
    throw new NFeDanfeError(
      `pedido '${pedidoId}' nfe '${nfeId}': sem procNFe (xml_nfe_proc) persistido — ` +
        'não é possível gerar a carta de correção.',
    );
  }

  const cceSnap = await cartaCorrecaoCollection.docRef(fs, { pedidoId, nfeId }, cceId).get();
  if (!cceSnap.exists) {
    throw new NFePedidoNotFoundError(pedidoId);
  }
  const cce = cceSnap.data() as CartaCorrecao;
  if (cce.estado !== ESTADO_ENVI_NFE_MSG.concluido || !cce.xml_retorno) {
    throw new NFeDanfeError(
      `pedido '${pedidoId}' nfe '${nfeId}' cce '${cceId}': carta de correção não registrada ` +
        `(estado='${cce.estado}') — sem PDF.`,
    );
  }

  const cancelada = nota.estado === ESTADO_NFE.cancelada;
  const pdf = await renderCartaCorrecao(
    {
      procNFeXml: nota.xml_nfe_proc,
      xmlRetorno: cce.xml_retorno,
      xCorrecao: cce.xCorrecao,
      nProt: cce.nProt,
      nSeqEvento: cce.nSeqEvento,
    },
    { cancelada },
  );
  return {
    contentType: 'application/pdf',
    filename: `carta-correcao-${nota.numeracao}-seq${cce.nSeqEvento}.pdf`,
    body: pdf,
  };
}
