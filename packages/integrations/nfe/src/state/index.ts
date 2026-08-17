/**
 * NF-e state machine.
 *
 * Two concerns live here:
 *
 *   1. **Classification** — turn a SEFAZ `cStat` into a typed category
 *      (`autorizada`, `duplicidade`, `lote-pendente`, …) so callers don't
 *      hard-code magic numbers.
 *   2. **Transition** — given a current `EstadoNFe` and a SEFAZ response,
 *      decide the next state and what the orchestrator should do next
 *      (`poll`, `recover-via-consulta`, `done`, `error`).
 *
 * Authoritative reference: `.claude/skills/nfe/references/cstat-rejeicoes.md`.
 * The transition table is the one Phase A leans on; cancelamento /
 * inutilização lifecycles are owned by Phase B and only enter this file
 * once those events are wired.
 */
import { ESTADO_NFE, type EstadoNFe, type UF } from '@delfrance/schemas';

import { svcAuthorizerForUF } from '../endpoints';
import type { TpEmis } from '../generator/types';

export {
  CONSUMO_INDEVIDO_MARKER,
  NFeConsumoIndevidoError,
  assertNotConsumoIndevido,
} from './consumo-indevido';

// Final-estado helpers live in @delfrance/schemas (browser-safe, shared with
// the UI); re-exported here so library consumers get them next to the state
// machine they gate.
export { ESTADOS_FINAIS_NFE, isEstadoFinalNFe } from '@delfrance/schemas';

/**
 * Bounded poll cap for `cStat=105` (lote still processing) and `cStat=635`
 * (lote queued). Matches the old Flutter code's 4-attempt ceiling.
 */
export const MAX_LOTE_POLL_RETRIES = 4;

/**
 * Async reconciler tuning (Cloud Tasks + backstop sweep). A lote stuck at
 * `cStat=105` is re-consulted at most `MAX_RECONCILE_ATTEMPTS` times; past
 * that it is marked terminal `error` for manual review (never re-queried
 * forever — that is the consumo-indevido / SEFAZ-ban vector behind #77).
 */
export const MAX_RECONCILE_ATTEMPTS = 10;
/** First-consult / floor backoff when SEFAZ returns no `tMed`. */
export const RECONCILE_BASE_DELAY_MS = 60_000;
/** Backoff ceiling — a single attempt never waits longer than this. */
export const RECONCILE_MAX_DELAY_MS = 15 * 60_000;
/**
 * Grace the backstop sweep adds on top of the task delay before a lote is
 * "due". The Cloud Task is the primary trigger (fires at `now + delay`); the
 * sweep only steps in when that task is overdue by this much (i.e. lost). Keeps
 * the sweep from consulting the same `nRec` a healthy task is about to consult —
 * which, with 656 now terminal, would risk a wrongful terminal error.
 */
export const RECONCILE_SWEEP_GRACE_MS = 60_000;

/**
 * How long to wait before the next consult of a still-processing lote — the
 * delay the Cloud Task is scheduled with.
 *
 *  - **attempt 0** (the first consult, scheduled at emit time): respect
 *    SEFAZ's own `tMed` estimate (seconds) when present — the polite first
 *    check — else `RECONCILE_BASE_DELAY_MS`.
 *  - **attempt ≥ 1**: exponential backoff (`base × 2^attempt`) capped at
 *    `RECONCILE_MAX_DELAY_MS`.
 *
 * **Deterministic** (no jitter): the queue's `rate_limits` already pace
 * dispatch, and the backstop sweep's due-gate (`proximaConsultaEm`) is derived
 * from this same value (+ `RECONCILE_SWEEP_GRACE_MS`), so a jittered delay here
 * would let the sweep drift ahead of the task and double-consult (#77 review).
 */
export function nextConsultaDelayMs(attempt: number, tMedSeconds?: string | number | null): number {
  if (attempt <= 0) {
    const tMed = typeof tMedSeconds === 'string' ? Number(tMedSeconds) : tMedSeconds;
    if (tMed != null && Number.isFinite(tMed) && tMed > 0) {
      return Math.min(Math.round(tMed * 1000), RECONCILE_MAX_DELAY_MS);
    }
    return RECONCILE_BASE_DELAY_MS;
  }
  return Math.min(RECONCILE_BASE_DELAY_MS * 2 ** attempt, RECONCILE_MAX_DELAY_MS);
}

/**
 * Coarse semantic category of a `cStat`. Drives the next action without
 * exposing every numeric code to callers.
 */
export type CStatCategory =
  /** 100, 150 — NF-e authorized. Adopt the `protNFe`. */
  | 'autorizada'
  /** 101 — cancelada via evento; 151 — cancelamento homologado fora de prazo. */
  | 'cancelada'
  /** 102 — número inutilizado. */
  | 'inutilizada'
  /** 110, 301, 302 — denegada (stored at SEFAZ but unusable). */
  | 'denegada'
  /** 103 — lote received async; we got an `nRec`, must poll. */
  | 'lote-recebido'
  /** 104 — lote processed; read the `protNFe` array. */
  | 'lote-processado'
  /** 105 — lote still being processed; poll again after a wait. */
  | 'lote-pendente'
  /** 106 — lote not found at SEFAZ; recover each NF-e via `consSitNFe`. */
  | 'lote-nao-localizado'
  /** 107 — service up. */
  | 'servico-em-operacao'
  /** 108, 109 — service down; 113, 114 — SVC em desativação / desabilitada. */
  | 'servico-paralisado'
  /** 204, 205, 218, 539, 635 — duplicidade: recover via `consSitNFe`. */
  | 'duplicidade'
  /** 215, 225 — schema/structure rejection (fix the XML, resend). */
  | 'rejeitada-schema'
  /** 280, 281, 286, 290–298 — certificate / signature problem. */
  | 'rejeitada-certificado'
  /** 252 — ambiente diverge (tpAmb mismatch). */
  | 'rejeitada-ambiente'
  /** 656 — Consumo Indevido: caller is hammering, back off. */
  | 'consumo-indevido'
  /** Anything else — generic business-rule rejection; fix and resend. */
  | 'rejeitada';

const DUPLICIDADE = new Set(['204', '205', '218', '539', '635']);
const CERT_REJECTION = new Set(['280', '281', '286']);

/** Classify a SEFAZ `cStat` into a coarse category. */
export function classifyCStat(cStat: string): CStatCategory {
  if (cStat === '100' || cStat === '150') return 'autorizada';
  // 151 = cancelamento homologado fora de prazo — same terminal cancelada as
  // 101 (already in STATUS_BLOQUEADORES).
  if (cStat === '101' || cStat === '151') return 'cancelada';
  if (cStat === '102') return 'inutilizada';
  if (cStat === '110' || cStat === '301' || cStat === '302') return 'denegada';
  if (cStat === '103') return 'lote-recebido';
  if (cStat === '104') return 'lote-processado';
  if (cStat === '105') return 'lote-pendente';
  if (cStat === '106') return 'lote-nao-localizado';
  if (cStat === '107') return 'servico-em-operacao';
  if (cStat === '108' || cStat === '109') return 'servico-paralisado';
  // SVC status codes (MOC Anexo III): 113 = SVC em desativação (stop using
  // it), 114 = SVC desabilitada para a UF. Both mean "this authorizer is not
  // usable right now" — same handling as a paralisado service.
  if (cStat === '113' || cStat === '114') return 'servico-paralisado';
  if (DUPLICIDADE.has(cStat)) return 'duplicidade';
  if (cStat === '215' || cStat === '225') return 'rejeitada-schema';
  if (cStat === '252') return 'rejeitada-ambiente';
  if (cStat === '656') return 'consumo-indevido';
  if (CERT_REJECTION.has(cStat)) return 'rejeitada-certificado';
  const n = Number(cStat);
  if (Number.isInteger(n) && n >= 290 && n <= 298) return 'rejeitada-certificado';
  return 'rejeitada';
}

/**
 * Map a SEFAZ `cStat` to the persisted `EstadoNFe` on the NF-e document.
 * Returns `null` when the cStat does not by itself imply a terminal estado
 * (e.g. `103` keeps the NF-e in `aguardandoResposta` because we now have an
 * `nRec` and must poll).
 */
export function cStatToEstado(cStat: string): EstadoNFe | null {
  switch (classifyCStat(cStat)) {
    case 'autorizada':
      return ESTADO_NFE.aprovada;
    case 'cancelada':
      return ESTADO_NFE.cancelada;
    case 'inutilizada':
      return ESTADO_NFE.numeracaoInutilizada;
    case 'denegada':
    case 'rejeitada-schema':
    case 'rejeitada-certificado':
    case 'rejeitada-ambiente':
    case 'rejeitada':
      return ESTADO_NFE.rejeitada;
    case 'consumo-indevido':
      return ESTADO_NFE.error;
    case 'lote-recebido':
    case 'lote-pendente':
    case 'lote-nao-localizado':
      return ESTADO_NFE.aguardandoResposta;
    case 'lote-processado':
    case 'duplicidade':
    case 'servico-em-operacao':
    case 'servico-paralisado':
      return null;
  }
}

/** Next action the orchestrator should take after receiving a `cStat`. */
export type NextAction =
  /** Adopt the protocol; persist `xml_nfe_proc` and stop. */
  | 'done-authorized'
  /** Persist as cancelada/inutilizada; stop. */
  | 'done-terminal'
  /** Persist as rejeitada / error; stop. */
  | 'done-rejected'
  /** Poll `consReciNFe` again after a wait (bounded by retries). */
  | 'poll-lote'
  /** Query SEFAZ for the real protocol via `consSitNFe(chave)`. */
  | 'recover-via-consulta'
  /** Backoff and stop for this run; the poller will pick it up later. */
  | 'backoff';

/** Decide the next action for an NF-e given its latest `cStat` and retries. */
export function nextAction(cStat: string, retries: number): NextAction {
  const category = classifyCStat(cStat);
  switch (category) {
    case 'autorizada':
      return 'done-authorized';
    case 'cancelada':
    case 'inutilizada':
      return 'done-terminal';
    case 'denegada':
    case 'rejeitada-schema':
    case 'rejeitada-certificado':
    case 'rejeitada-ambiente':
    case 'rejeitada':
      return 'done-rejected';
    case 'duplicidade':
    case 'lote-nao-localizado':
      return 'recover-via-consulta';
    case 'lote-pendente':
      return retries < MAX_LOTE_POLL_RETRIES ? 'poll-lote' : 'backoff';
    case 'lote-recebido':
      return 'poll-lote';
    case 'lote-processado':
      // 104 wraps a protNFe array; the orchestrator inspects each protNFe's
      // cStat. Reaching this branch with a bare 104 means "look inside".
      return 'poll-lote';
    case 'consumo-indevido':
    case 'servico-paralisado':
      return 'backoff';
    case 'servico-em-operacao':
      return 'backoff';
  }
}

/**
 * Sefaz response carrier — the minimum every transport return value has to
 * expose for the state machine to make a decision.
 */
export interface SefazOutcome {
  /** SEFAZ `cStat`. */
  readonly cStat: string;
  /** Human-readable `xMotivo` (kept on the doc for the UI). */
  readonly xMotivo: string;
  /** Lote receipt number, when SEFAZ returned one (cStat 103 / duplicidade). */
  readonly nRec?: string | null;
  /**
   * SEFAZ's `tMed` — estimated lote-processing time in **seconds** (from
   * `retEnviNFe.infRec.tMed` / `retConsReciNFe.tMed`). Seeds the first
   * `proximaConsultaEm`; not persisted on the doc. Carried in-memory only.
   */
  readonly tMed?: string | null;
  /** The 44-char chave SEFAZ asserts in 539 responses, if present. */
  readonly chNFeFromXMotivo?: string | null;
}

/** Patch to apply to the NF-e document for a given outcome + retry count. */
export interface NFeStatePatch {
  readonly estado: EstadoNFe;
  readonly cStat: string;
  readonly xMotivo: string;
  readonly retries: number;
  readonly nRec: string | null;
  readonly action: NextAction;
  /**
   * SEFAZ's `tMed` estimate (seconds), carried so `persistPatch` can seed the
   * first `proximaConsultaEm`. Not a persisted field — see `SefazOutcome.tMed`.
   */
  readonly tMed: string | null;
}

/**
 * Compute the document patch for a SEFAZ outcome. The orchestrator persists
 * this patch on `pedidos/{pedidoId}/nfev4/{nfeId}` before performing
 * `action` — so a crash between SEFAZ-roundtrip and follow-up is recoverable
 * by the `processar-pendentes` poller.
 */
export function applyOutcome(
  current: {
    estado: EstadoNFe;
    retries: number | null;
    /** Persisted cStat/xMotivo — kept on the doc when the terminal defense fires. */
    cStat?: string | null;
    xMotivo?: string | null;
  },
  outcome: SefazOutcome,
): NFeStatePatch {
  // Defense-in-depth: a cancelada/inutilizada doc is TERMINAL — no later
  // SEFAZ outcome can legitimately move it anywhere else. The classic trap is
  // a consSitNFe for a cancelada NF-e still returning the ORIGINAL
  // authorization protNFe (cStat 100), but the same applies to any other
  // mapped estado (105 → aguardandoResposta, a rejection → rejeitada,
  // 656 → error) and to mapped-null outcomes that would otherwise schedule a
  // retry/recovery on a doc that is already done. Only an outcome that maps
  // to the SAME terminal estado (e.g. 'c' + 101) flows through normally.
  if (
    (current.estado === ESTADO_NFE.cancelada ||
      current.estado === ESTADO_NFE.numeracaoInutilizada) &&
    cStatToEstado(outcome.cStat) !== current.estado
  ) {
    return {
      estado: current.estado,
      cStat: current.cStat ?? outcome.cStat,
      xMotivo: current.xMotivo ?? outcome.xMotivo,
      retries: 0,
      nRec: outcome.nRec ?? null,
      action: 'done-terminal',
      tMed: null,
    };
  }
  const action = nextAction(outcome.cStat, current.retries ?? 0);
  const mappedEstado = cStatToEstado(outcome.cStat);
  const estado = mappedEstado ?? current.estado;
  // `lote-pendente` keeps the NF-e in aguardandoResposta and increments
  // retries. Any other action either stays put or transitions to a terminal /
  // recovery state — retries reset there to keep the counter scoped to the
  // 105-poll loop.
  const isPollIncrement = classifyCStat(outcome.cStat) === 'lote-pendente';
  const retries = isPollIncrement ? (current.retries ?? 0) + 1 : 0;
  return {
    estado,
    cStat: outcome.cStat,
    xMotivo: outcome.xMotivo,
    retries,
    nRec: outcome.nRec ?? null,
    action,
    tMed: outcome.tMed ?? null,
  };
}

/**
 * SEFAZ `cStat` values that mark an NFe as terminal or in-flight at SEFAZ
 * and must NOT be re-emitted. Mirror of Flutter's
 * `NotaFiscalEletronica.statusBloqueadores` in
 * `.old/packages/pedido_nfe/lib/src/models.dart:280-291`. Sealing this
 * list keeps `podeGerar` consistent between the two ports during the
 * migration.
 */
export const STATUS_BLOQUEADORES = new Set<string>([
  '100', // Autorizado o uso da NF-e
  '101', // Cancelamento homologado
  '102', // Inutilização homologada
  '103', // Lote recebido com sucesso
  '104', // Lote processado
  '105', // Lote em processamento
  '128', // Lote de Evento processado
  '150', // Autorizado fora de prazo
  '151', // Cancelamento fora de prazo
  '468',
]);

/** Mirror of Flutter's `NotaFiscalEletronica.bloqueada` predicate. */
export function isBloqueada(cStat: string | null | undefined): boolean {
  return cStat != null && STATUS_BLOQUEADORES.has(cStat);
}

/** Contingência mode for SEFAZ `tpEmis` resolution. */
export type ContingenciaMode = 'none' | 'svc' | 'epec';

/**
 * Resolve SEFAZ `tpEmis` from (UF, contingência mode). Mirrors Flutter's
 * `filial.sede.estado.{tpEmis,tpEmisSVC,tpEmisEPEC}` selector
 * (`.old/packages/pedido_nfe/lib/src/tasks.dart:136-140`).
 *
 * `'svc'` resolves per-UF: SVC-AN UFs → 6, SVC-RS UFs → 7 (Ato COTEPE
 * 39/2012 mapping in `svcAuthorizerForUF`). `'epec'` → 4, UF-independent —
 * the EPEC evento goes to the Ambiente Nacional.
 *
 * Production-traffic safety (`NFE_ALLOW_PRODUCAO` opt-in) is enforced
 * by `assertSafeTpAmbForTransport` at the SOAP layer — not duplicated here.
 */
export function resolveTpEmis(uf: UF, mode: ContingenciaMode = 'none'): TpEmis {
  switch (mode) {
    case 'none':
      return 1;
    case 'svc':
      return svcAuthorizerForUF(uf) === 'svc-an' ? 6 : 7;
    case 'epec':
      return 4;
  }
}

/**
 * Event cStat values that mean the EPEC is REGISTERED at the Ambiente
 * Nacional. Unlike CC-e (where 136 = "registrado mas não vinculado" is a
 * rejection), the legacy flow treats **both 135 and 136 as EPEC aprovado**
 * (`.old/packages/pedido_nfe/lib/src/tasks.dart` `statusEpecAprovado`) — the
 * linkage happens when the full NF-e reaches the home SEFAZ afterwards.
 */
export const EPEC_EVENT_REGISTRADO: ReadonlySet<string> = new Set(['135', '136']);

/**
 * Full-NF-e cStat after an EPEC: the home SEFAZ has not yet received the
 * EPEC from the Ambiente Nacional — keep estado 'p' and retry later
 * (legacy `statusEpecNaoSincronizado`).
 */
export const CSTAT_EPEC_NAO_SINCRONIZADO = '468';

/** Event cStat for a duplicate EPEC (the chave already has one registered). */
export const CSTAT_EPEC_DUPLICIDADE = '485';
