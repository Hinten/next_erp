/**
 * Anti-loss recovery — the SEFAZ duplicidade / lost-response handler.
 *
 * The critical port from `.old/packages/pedido_nfe/lib/src/tasks.dart`
 * (`verificarRespostaEnviNFe...`). When a SOAP response is lost
 * mid-transit, or when SEFAZ replies with a duplicidade code
 * (204/205/218/539), the NF-e **may already be at SEFAZ** even though our
 * side thinks the send failed. Re-sending the same number would either
 * trip duplicidade again or, worse, generate a second authorization.
 *
 * Three layers:
 *   1. **Marker extraction** — parse `nRec` / `chNFe` from `xMotivo`.
 *   2. **SefazOutcome builders** — map raw `retXxx` responses into the
 *      shape the `src/state` machine consumes.
 *   3. **Stuck-detection** — flag NF-e docs that have been `enviando`
 *      past a timeout (the poller's input).
 *
 * Nothing here touches Firestore or SEFAZ directly. The orchestrator
 * (an `apps/nfe` route handler) wires these helpers up against persisted
 * NF-e documents and the typed operation calls in `src/operations`.
 */
import type { TRetConsReciNFe, TRetConsSitNFe, TRetEnviNFe } from '../types/nfe-schema';
import { ESTADO_NFE, type EstadoNFe } from '@delfrance/schemas';
import { classifyCStat, type SefazOutcome } from '../state';

// ---------------------------------------------------------------------------
// 1. Marker extraction
// ---------------------------------------------------------------------------

/** Match the `nRec` slug SEFAZ embeds in `xMotivo` on cStat 204/205/218/539. */
export const RE_NREC = /nRec:(\d+)/;

/** Match the `chNFe` slug SEFAZ embeds in `xMotivo` on cStat 539. */
export const RE_CHNFE = /chNFe:(\d+)/;

/**
 * Extract the `nRec` (lote receipt) and `chNFe` (server-truth chave)
 * markers from a SEFAZ `xMotivo` string.
 *
 * Example inputs SEFAZ has been seen to produce:
 *   - `'Rejeição: Duplicidade de NF-e [nRec:351000000000123]'`
 *   - `'Rejeição: Duplicidade NF-e com diferença na chave [chNFe:35200714200166000187550010000000071000000017][nRec:351000000000123]'`
 *
 * Both markers are optional — older NTs sometimes omit `nRec`.
 */
export function extractMarkers(xMotivo: string | null | undefined): {
  readonly nRec: string | null;
  readonly chNFe: string | null;
} {
  if (!xMotivo) return { nRec: null, chNFe: null };
  const nRecMatch = RE_NREC.exec(xMotivo);
  const chNFeMatch = RE_CHNFE.exec(xMotivo);
  return {
    nRec: nRecMatch?.[1] ?? null,
    chNFe: chNFeMatch?.[1] ?? null,
  };
}

// ---------------------------------------------------------------------------
// 2. SefazOutcome builders — raw response → state-machine input
// ---------------------------------------------------------------------------

/**
 * Build a `SefazOutcome` from a `retEnviNFe` response (the immediate
 * reply to `nfeAutorizacaoLote`).
 *
 * `cStat=103` carries `infRec.nRec` as a structured field; the
 * duplicidade codes embed it in `xMotivo`. We collect both into the same
 * `nRec` slot so `applyOutcome` has a single source of truth.
 *
 * Sync emission (`indSinc='1'`) returns the per-NF-e protocol inline on
 * `retEnviNFe.protNFe` (no `infRec` / `nRec`), with the lote-level cStat
 * staying at 104. When that's the case, the inner `infProt` is the
 * authoritative answer — same pattern as `outcomeFromRetConsSit`.
 */
export function outcomeFromRetEnviNFe(ret: TRetEnviNFe): SefazOutcome {
  if (ret.protNFe) {
    return outcomeFromInfProt(ret.protNFe.infProt);
  }
  const markers = extractMarkers(ret.xMotivo);
  return {
    cStat: ret.cStat,
    xMotivo: ret.xMotivo,
    nRec: ret.infRec?.nRec ?? markers.nRec,
    tMed: ret.infRec?.tMed ?? null,
    chNFeFromXMotivo: markers.chNFe,
  };
}

/**
 * Build a `SefazOutcome` from a `retConsReciNFe` response (the poll
 * reply to `consReciNFe`).
 *
 * `cStat=104` carries a `protNFe` array (one per NF-e in the lote); the
 * orchestrator must walk that array and call `outcomeFromInfProt` for
 * each. Reaching this builder with bare `104` means "look inside".
 */
export function outcomeFromRetConsRec(ret: TRetConsReciNFe): SefazOutcome {
  const markers = extractMarkers(ret.xMotivo);
  return {
    cStat: ret.cStat,
    xMotivo: ret.xMotivo,
    nRec: ret.nRec ?? markers.nRec,
    // `retConsReciNFe` carries no `tMed` (only the autorizarLote receipt does) —
    // subsequent consult backoff is attempt-based, so none is needed here.
    chNFeFromXMotivo: markers.chNFe,
  };
}

/**
 * Build a `SefazOutcome` from a `retConsSitNFe` response — the recovery
 * query result.
 *
 * The protocol, when present, is the **server-truth status** of the
 * NF-e. The orchestrator should:
 *   - If `ret.protNFe` is present, use `outcomeFromInfProt(ret.protNFe.infProt)`
 *     (the inner protocol is the authoritative answer).
 *   - Otherwise use the top-level `cStat` (e.g. `cStat=217` "NF-e não
 *     consta na base de dados" = the NF-e was never authorized).
 */
export function outcomeFromRetConsSit(ret: TRetConsSitNFe): SefazOutcome {
  if (ret.protNFe) {
    return outcomeFromInfProt(ret.protNFe.infProt);
  }
  return {
    cStat: ret.cStat,
    xMotivo: ret.xMotivo,
    nRec: null,
    chNFeFromXMotivo: extractMarkers(ret.xMotivo).chNFe,
  };
}

/**
 * Build a `SefazOutcome` from a single `infProt` block (inside a
 * `protNFe`). This is the **authoritative per-NF-e status** SEFAZ
 * returns inside `retConsReciNFe.protNFe[]` or `retConsSitNFe.protNFe`,
 * and also the inline protocol on `retEnviNFe` for sync-mode emission.
 *
 * `nProt` is the authorization protocol number, not the same as
 * `nRec` — the orchestrator surfaces `nProt` separately on the doc.
 * Duplicidade rejections (cStat=204/205/218/539/635) embed `[nRec:...]`
 * (and on 539 also `[chNFe:...]`) in the human-readable `xMotivo`, and
 * the orchestrator's recovery path needs both: the nRec to call
 * `consReci`, and the chNFe (on 539) to look up the *previously-emitted*
 * chave in the EnviNFeMsg audit log.
 */
export function outcomeFromInfProt(infProt: {
  readonly cStat: string;
  readonly xMotivo: string;
  readonly nProt?: string;
}): SefazOutcome {
  const markers = extractMarkers(infProt.xMotivo);
  return {
    cStat: infProt.cStat,
    xMotivo: infProt.xMotivo,
    nRec: markers.nRec,
    chNFeFromXMotivo: markers.chNFe,
  };
}

/**
 * Convenience: classify a recovery scenario for an orchestrator.
 *
 * Returns a tag the route handler can switch on without re-deriving the
 * cStat semantics. Calls into the state machine's classifier so the
 * source-of-truth stays in one place.
 */
export type RecoveryKind =
  /** No recovery needed — terminal happy path. */
  | 'authorized'
  /** Lote in flight — poll `consReciNFe`. */
  | 'poll-lote'
  /** Duplicidade or `lote-nao-localizado` — fetch via `consSitNFe`. */
  | 'consult-by-chave'
  /** Cancellation or inutilization — terminal, persist as-is. */
  | 'terminal-other'
  /** Rejected by SEFAZ — terminal failure, persist + alert. */
  | 'rejected'
  /** SEFAZ paralisado / 656 consumo-indevido — back off. */
  | 'backoff';

export function classifyRecovery(cStat: string): RecoveryKind {
  switch (classifyCStat(cStat)) {
    case 'autorizada':
      return 'authorized';
    case 'cancelada':
    case 'inutilizada':
      return 'terminal-other';
    case 'lote-recebido':
    case 'lote-pendente':
    case 'lote-processado':
      return 'poll-lote';
    case 'duplicidade':
    case 'lote-nao-localizado':
      return 'consult-by-chave';
    case 'denegada':
    case 'rejeitada-schema':
    case 'rejeitada-certificado':
    case 'rejeitada-ambiente':
    case 'rejeitada':
      return 'rejected';
    case 'consumo-indevido':
    case 'servico-paralisado':
    case 'servico-em-operacao':
      return 'backoff';
  }
}

// ---------------------------------------------------------------------------
// 3. Stuck-enviando detection — the poller's input filter
// ---------------------------------------------------------------------------

/** Default cutoff after which an NF-e stuck `enviando` is considered lost. */
export const DEFAULT_STUCK_TIMEOUT_MS = 5 * 60_000; // 5 minutes

/** Minimum NFe-doc shape needed to decide whether it's stuck. */
export interface MaybeStuckNFe {
  readonly estado: EstadoNFe;
  /** ISO 8601 timestamp of the last write. */
  readonly ultima_modificacao?: string | null | undefined;
}

/**
 * True when an NF-e is in `enviando` / `aguardandoResposta` and the
 * last write is older than `timeoutMs`. The `processar-pendentes`
 * route handler runs this against every NF-e doc it scans, then
 * invokes `consSitNFe(chave)` for the ones that come back true.
 *
 * SEFAZ commits to 95% of lotes within 3 minutes; the 5-minute default
 * is a small safety margin past that.
 */
export function isStuckEnviando(
  nfe: MaybeStuckNFe,
  now: Date = new Date(),
  timeoutMs: number = DEFAULT_STUCK_TIMEOUT_MS,
): boolean {
  if (nfe.estado !== ESTADO_NFE.enviando && nfe.estado !== ESTADO_NFE.aguardandoResposta) {
    return false;
  }
  if (!nfe.ultima_modificacao) {
    // No timestamp — treat as stuck (defensive: better to re-query than ignore).
    return true;
  }
  const last = Date.parse(nfe.ultima_modificacao);
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= timeoutMs;
}
