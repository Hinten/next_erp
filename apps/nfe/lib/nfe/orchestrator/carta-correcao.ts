import type { Firestore } from 'firebase-admin/firestore';

import {
  cartaCorrecaoNFe,
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

import type { NFeBaseRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { noopTaskScheduler, type TaskScheduler } from '../tasks';
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

  // Send the CC-e evento (cOrgao + cnpj come from the chave) — ALWAYS to the
  // home SEFAZ, including for SVC-authorized notas (tpEmis 6/7): the SVC does
  // not serve CC-e, but authorized documents are automatically shared between
  // the SVC and the normal environment, which registers the event (MOC 7.0
  // Anexo III §2.1.3.4-d).
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
      xml_enviado: res.signedEventoXml,
      xml_retorno: res.rawResponse,
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
