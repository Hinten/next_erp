/**
 * One decision per `consReciNFe` round of `reconcileByRecibo` (#513, #1654) —
 * its pure classifiers, and the per-doc recovery by chave `reconcilePorChave`.
 *
 * {@link decidirRodadaDoRecibo} turns a receipt's answer for ONE chave into one
 * of five decisions: apply our protocol, recover a 539, resolve by chave, wait
 * (the next round), or go terminal. It is total over the cStat space — the
 * reconcile loop and the manual verify (`consultar.ts`) both switch on it, so
 * no answer can fall through to a reset or an unbounded re-read.
 *
 * Resolving by chave is the `consSitNFe` recovery query
 * (`.claude/skills/nfe/references/webservices.md` lines 139-143,
 * "NfeConsultaProtocolo"; MOC 7.0 p.78 §5.2.5 and p.84 J03–J06 for its
 * answers). A receipt's answer is final for that `nRec`, so re-reading it
 * cannot change anything, and re-fetching an already-delivered result is the
 * Consumo Indevido pattern (MOC 7.0 p.58 §4.3(c)(3), p.63 Tabela 4-9). It is
 * taken for four reasons ({@link MotivoConsultaPorChave}):
 *  - a processed lote (104) with no `protNFe` for our chave — it carries the
 *    result of EVERY NF-e it held (MOC 7.0 p.75 §5.1, p.76 BR07;
 *    `TRetConsReciNFe/protNFe` is 0..50) — or a per-NF-e verdict given at LOTE
 *    level, which never lands without a protocol;
 *  - 106, lote não localizado (an expired receipt);
 *  - a duplicidade other than 539 (204/205/218);
 *  - 635, "NF-e com mesmo número/série já transmitida, aguardando
 *    processamento" — wait and poll (cstat-rejeicoes.md, "Recovery procedure").
 * The answer is read through ONE table, {@link classificarConsSitDeRecuperacao},
 * which depends on that reason.
 *
 * A terminal this module decides always carries a BLOCKING cStat
 * ({@link terminalBloqueante}): the round's own 103/104/105, or 103 — SEFAZ
 * issued this receipt, so the número may be held — with the real cStat in
 * xMotivo. A non-blocking one would make the pedido re-emittable over it.
 *
 * Every switch here is EXHAUSTIVE over `CStatCategory` with no `default`: a
 * category added to the library fails typecheck here instead of silently
 * landing in whichever arm a fallthrough happened to pick.
 *
 * Kept OUT of `audit.ts` on purpose: calls between functions of one module
 * bypass a test's module mock, and every SEFAZ binding and persist this branch
 * uses must stay mockable from `reconcile.test.ts`.
 */
import type { Firestore } from 'firebase-admin/firestore';

import {
  applyOutcome,
  classifyCStat,
  consultarSituacaoNFe,
  MAX_RECONCILE_ATTEMPTS,
  NFeConsumoIndevidoError,
  NFeTransportError,
  NFeXmlError,
  NFeXsdValidationError,
  outcomeFromRetConsRec,
  outcomeFromRetConsSit,
  type NFeStatePatch,
  type SefazOutcome,
  type TpEmis,
  type TRetConsReciNFe,
  type TRetConsSitNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type EstadoNFe, type NotaFiscalEletronica } from '@delfrance/schemas';

import { safeErrorShape, safeLog } from '../log';
import type { NFeRuntime } from '../runtime';
import { sefazCallFor } from './sefaz-call';
import {
  buildEnviNFeMsgFromConsulta,
  buildProcForAuthorizedOutcome,
  enviNfeCollection,
  markAsLost,
  type PersistGuard,
  persistPatchUnlessFinal,
  swapAnchorForProc,
} from './audit';

/**
 * `TStat` — `^\d{3,4}$` since NT 2025.002. A lote cStat of any other shape
 * (an empty `<cStat/>`) is an anomaly that says nothing about any chave.
 */
const CSTAT_TSTAT = /^\d{3,4}$/;
/** 103 — lote recebido: SEFAZ issued the receipt. The blocking fallback of {@link cStatBloqueanteDaRodada}. */
const CSTAT_LOTE_RECEBIDO = '103';
/** 104 — lote processado. */
const CSTAT_LOTE_PROCESSADO = '104';
/**
 * 105 — lote em processamento: the one counted round whose xMotivo carries no
 * extra tail (its patch is byte-identical to the pre-#1654 one).
 */
export const CSTAT_LOTE_PENDENTE = '105';
/** 106 — lote não localizado. */
const CSTAT_LOTE_NAO_LOCALIZADO = '106';
/** 539 — duplicidade com diferença na chave: `recover539IfNeeded`, never by chave. */
const CSTAT_DUPLICIDADE_CHAVE_DIFERENTE = '539';
/** 635 — NF-e com mesmo número/série já transmitida, aguardando processamento. */
const CSTAT_AGUARDANDO_PROCESSAMENTO = '635';
/**
 * 217 — "NF-e não consta na base de dados da SEFAZ" (MOC 7.0 p.84 Tabela 5-16,
 * J03): SEFAZ holds no NF-e for this chave.
 */
const CSTAT_NFE_NAO_CONSTA_NA_BASE = '217';

/** One `protNFe` element of a `retConsReciNFe`. */
type ProtNFeDoLote = NonNullable<TRetConsReciNFe['protNFe']>[number];

/** Why a round resolves a doc by chave — it decides how the consSit answer is read. */
export type MotivoConsultaPorChave =
  /** A processed lote (104) or a lote-level verdict carries no protocol for the chave. */
  | 'protocolo-ausente'
  /** 106 — the receipt is not found (expired, or not indexed yet). */
  | 'lote-nao-localizado'
  /** 204/205/218 — an NF-e with this número already reached SEFAZ. */
  | 'duplicidade'
  /** 635 — the NF-e is still queued at SEFAZ. */
  | 'aguardando-processamento';

/**
 * The by-chave reason a cStat itself names: 106 → `lote-nao-localizado`,
 * 204/205/218 → `duplicidade`, 635 → `aguardando-processamento`. `null` for
 * everything else — 539 included, which keeps its own recovery.
 */
export function motivoPorChave(cStat: string): MotivoConsultaPorChave | null {
  switch (classifyCStat(cStat)) {
    case 'lote-nao-localizado':
      return 'lote-nao-localizado';
    case 'duplicidade':
      if (cStat === CSTAT_DUPLICIDADE_CHAVE_DIFERENTE) return null;
      return cStat === CSTAT_AGUARDANDO_PROCESSAMENTO ? 'aguardando-processamento' : 'duplicidade';
    case 'autorizada':
    case 'cancelada':
    case 'inutilizada':
    case 'denegada':
    case 'lote-recebido':
    case 'lote-processado':
    case 'lote-pendente':
    case 'servico-em-operacao':
    case 'servico-paralisado':
    case 'rejeitada-schema':
    case 'rejeitada-certificado':
    case 'rejeitada-ambiente':
    case 'consumo-indevido':
    case 'rejeitada':
      return null;
  }
}

/** What one `consReciNFe` round does with one doc. */
export type DecisaoDaRodada =
  /** Our protNFe carries a final answer — apply it (today's path). */
  | { readonly tipo: 'aplicar-protocolo' }
  /** A 539 — `recover539IfNeeded`. */
  | { readonly tipo: 'recuperar-539' }
  /** Resolve by chave: counted, then at most ONE `consSitNFe` ({@link reconcilePorChave}). */
  | { readonly tipo: 'por-chave'; readonly motivo: MotivoConsultaPorChave }
  /** Nothing about the chave — counted, and consulted again next round. */
  | { readonly tipo: 'aguardar' }
  /** No further SEFAZ call can help — blocking terminal, verificar manualmente. */
  | { readonly tipo: 'terminal' };

const APLICAR: DecisaoDaRodada = { tipo: 'aplicar-protocolo' };
const RECUPERAR_539: DecisaoDaRodada = { tipo: 'recuperar-539' };
const AGUARDAR: DecisaoDaRodada = { tipo: 'aguardar' };
const TERMINAL: DecisaoDaRodada = { tipo: 'terminal' };
const porChave = (motivo: MotivoConsultaPorChave): DecisaoDaRodada => ({
  tipo: 'por-chave',
  motivo,
});

/**
 * A duplicidade cStat's decision: 539 recovers, the others go by chave. Within
 * the duplicidade category {@link motivoPorChave} is `null` for 539 alone.
 */
function decisaoDaDuplicidade(cStat: string): DecisaoDaRodada {
  const motivo = motivoPorChave(cStat);
  return motivo == null ? RECUPERAR_539 : porChave(motivo);
}

/**
 * The decision for one doc of a `consReciNFe` round. `protCStat` is the cStat
 * of OUR `protNFe` in the reply — the caller resolves it by STRICT equality on
 * `infProt.chNFe` (a near-miss chave is missing, never ours) — or `null`.
 *
 * With our protNFe:
 *  - a final answer (autorizada / cancelada / inutilizada / denegada / any
 *    rejection) → `aplicar-protocolo`;
 *  - 539 → `recuperar-539`; 204/205/218 → by chave (`duplicidade`); 635 → by
 *    chave (`aguardando-processamento`);
 *  - 656 → `terminal`;
 *  - a lote-state or service code inside a protNFe → by chave
 *    (`protocolo-ausente`).
 * A protNFe cStat that is not TStat-shaped (an empty `<cStat/>`) is read as
 * absent, like a near-miss chave: `classifyCStat` would call it a rejection
 * and free the número on an anomaly.
 *
 * Without it, from the LOTE cStat:
 *  - not TStat-shaped, 103/105/107/108/109/113/114 → `aguardar`;
 *  - 104, and a per-NF-e verdict given at lote level (100/150/101/151/102/
 *    110/301/302) → by chave (`protocolo-ausente`): a final estado never
 *    lands without a protocol, the same rule #512 applies to a lote reply
 *    without a receipt;
 *  - 106 → by chave (`lote-nao-localizado`);
 *  - the duplicidades as above;
 *  - 656, and a rejection of the `consReciNFe` query itself (252, 215/225,
 *    28x/29x, any other) → `terminal`.
 */
export function decidirRodadaDoRecibo(
  loteCStat: string,
  protCStat: string | null,
): DecisaoDaRodada {
  if (protCStat != null && CSTAT_TSTAT.test(protCStat)) {
    switch (classifyCStat(protCStat)) {
      case 'autorizada':
      case 'cancelada':
      case 'inutilizada':
      case 'denegada':
      case 'rejeitada-schema':
      case 'rejeitada-certificado':
      case 'rejeitada-ambiente':
      case 'rejeitada':
        return APLICAR;
      case 'duplicidade':
        return decisaoDaDuplicidade(protCStat);
      case 'consumo-indevido':
        return TERMINAL;
      case 'lote-recebido':
      case 'lote-processado':
      case 'lote-pendente':
      case 'lote-nao-localizado':
      case 'servico-em-operacao':
      case 'servico-paralisado':
        return porChave('protocolo-ausente');
    }
  }
  if (!CSTAT_TSTAT.test(loteCStat)) return AGUARDAR;
  switch (classifyCStat(loteCStat)) {
    case 'lote-recebido':
    case 'lote-pendente':
    case 'servico-em-operacao':
    case 'servico-paralisado':
      return AGUARDAR;
    case 'lote-processado':
    case 'autorizada':
    case 'cancelada':
    case 'inutilizada':
    case 'denegada':
      return porChave('protocolo-ausente');
    case 'lote-nao-localizado':
      return porChave('lote-nao-localizado');
    case 'duplicidade':
      return decisaoDaDuplicidade(loteCStat);
    case 'consumo-indevido':
    case 'rejeitada-schema':
    case 'rejeitada-certificado':
    case 'rejeitada-ambiente':
    case 'rejeitada':
      return TERMINAL;
  }
}

/** What the recovery `consSitNFe` told us about a chave a round resolves by chave. */
export type RecuperacaoConsSit =
  /** SEFAZ gave the chave a final answer — apply it. */
  | 'resolvida'
  /** The NF-e is still queued at SEFAZ (635 + 217) — stays counted, no breaker. */
  | 'pendente'
  /** The service is down — nothing learned; the doc stays counted. */
  | 'indisponivel'
  /** No usable answer — blocking terminal `error`, verificar manualmente. */
  | 'sem-resolucao';

/**
 * Classify `outcomeFromRetConsSit(retSit).cStat` — the inner `infProt.cStat`,
 * except for a top-level cancelada/inutilizada or an absent `protNFe` — for a
 * round resolved by chave for `motivo`. The one table the reconcile, the
 * manual verify and the sync emit path's inline consult
 * (`applyAutorizadoOutcome`, #1654 §1) share:
 *
 *  - autorizada / cancelada / inutilizada → `resolvida`.
 *  - denegada → `resolvida` for `protocolo-ausente` (it lands as rejeitada,
 *    same as every other consSit path — pinned since #513); `sem-resolucao`
 *    for the other motivos, since a denegada número is consumed
 *    (cstat-rejeicoes.md, "Denial").
 *  - 217 (NF-e não consta na base) → `resolvida` (rejeitada: the número is
 *    free) for `protocolo-ausente` and `lote-nao-localizado`;
 *    `sem-resolucao` for `duplicidade` — 539 is facultative, so the número
 *    may exist under ANOTHER chave and re-emitting would collide; `pendente`
 *    for `aguardando-processamento` — the NF-e has not landed yet.
 *  - every other rejection — 561/562/613 (MOC 7.0 p.84 J04–J06: the número
 *    exists under another chave) included → `sem-resolucao`.
 *  - servico-paralisado (108/109/113/114) → `indisponivel`.
 *  - everything else, 656 included → `sem-resolucao` (on 656 the caller also
 *    stops consulting for the rest of the run — cstat-rejeicoes.md §656).
 */
export function classificarConsSitDeRecuperacao(
  cStat: string,
  motivo: MotivoConsultaPorChave,
): RecuperacaoConsSit {
  switch (classifyCStat(cStat)) {
    case 'autorizada':
    case 'cancelada':
    case 'inutilizada':
      return 'resolvida';
    case 'denegada':
      return motivo === 'protocolo-ausente' ? 'resolvida' : 'sem-resolucao';
    case 'rejeitada':
      return cStat === CSTAT_NFE_NAO_CONSTA_NA_BASE ? naoConstaNaBase(motivo) : 'sem-resolucao';
    case 'servico-paralisado':
      return 'indisponivel';
    case 'lote-recebido':
    case 'lote-processado':
    case 'lote-pendente':
    case 'lote-nao-localizado':
    case 'servico-em-operacao':
    case 'duplicidade':
    case 'rejeitada-schema':
    case 'rejeitada-certificado':
    case 'rejeitada-ambiente':
    case 'consumo-indevido':
      return 'sem-resolucao';
  }
}

/** A consSit 217 (NF-e não consta na base), read for `motivo` — see {@link classificarConsSitDeRecuperacao}. */
function naoConstaNaBase(motivo: MotivoConsultaPorChave): RecuperacaoConsSit {
  switch (motivo) {
    case 'protocolo-ausente':
    case 'lote-nao-localizado':
      return 'resolvida';
    case 'duplicidade':
      return 'sem-resolucao';
    case 'aguardando-processamento':
      return 'pendente';
  }
}

/**
 * The cStat a terminal decided in a round of lote `loteCStat` carries: the
 * round's own 103/104/105 (all in `STATUS_BLOQUEADORES`), and 103 for anything
 * else — SEFAZ issued this receipt, so the número may be held, and a
 * non-blocking cStat (106, 108, 656, a rejection…) would let the pedido be
 * re-emitted over it.
 */
export function cStatBloqueanteDaRodada(loteCStat: string): string {
  return loteCStat === CSTAT_LOTE_RECEBIDO ||
    loteCStat === CSTAT_LOTE_PROCESSADO ||
    loteCStat === CSTAT_LOTE_PENDENTE
    ? loteCStat
    : CSTAT_LOTE_RECEBIDO;
}

/**
 * `markAsLost` with the BLOCKING cStat of the round
 * ({@link cStatBloqueanteDaRodada}). When that differs from the patch's own
 * cStat, xMotivo keeps the original as a `cStat <orig>: ` prefix, so the real
 * cause stays visible. Byte-identical to the pre-#1654 105-cap and #513
 * terminals, whose patch already carried the round's 105 / 104.
 */
export function terminalBloqueante(
  patch: NFeStatePatch,
  loteCStat: string,
  motivo: string,
): NFeStatePatch {
  const cStat = cStatBloqueanteDaRodada(loteCStat);
  const xMotivo = cStat !== patch.cStat ? `cStat ${patch.cStat}: ${patch.xMotivo}` : patch.xMotivo;
  return markAsLost({ ...patch, cStat, xMotivo }, motivo);
}

/**
 * Per-run consSit circuit breaker, held in a {@link DisjuntorConsSit} cell
 * across the docs of one lote reconcile and read by this branch — and, in the
 * backstop sweep (`runProcessarPendentes`), across the later lotes of that run
 * at each type's own scope:
 *
 *  - `consumo-indevido` — a consSit answered 656 (or threw
 *    `NFeConsumoIndevidoError`): every remaining doc of the run resolved by
 *    chave goes terminal WITHOUT a call (cstat-rejeicoes.md §656, "Stop
 *    immediately"; the same abort `verificar.ts` applies). Sweep scope: the
 *    whole FILIAL, since the 656 throttle is per CNPJ+IP.
 *  - `indisponivel` — the service is down (a consSit answered
 *    108/109/113/114, or threw `NFeTransportError`): the remaining docs are
 *    counted without a call, so an outage costs one consSit per round, not one
 *    per chave. An XSD / XML failure does NOT trip it — it can be
 *    deterministic for one chave, and must not starve the others. Sweep scope:
 *    the filial's lotes at the SAME authorizer (`autorizadorDe`) — the home
 *    SEFAZ being down says nothing about SVC-AN / SVC-RS.
 */
export type BloqueioConsSit =
  | { readonly tipo: 'consumo-indevido'; readonly chave: string; readonly xMotivo: string }
  | { readonly tipo: 'indisponivel'; readonly detalhe: string };

/**
 * The cell a {@link BloqueioConsSit} lives in, OWNED BY THE CALLER and mutated
 * in place (#1654 §2c): `reconcilePorChave` writes every trip into it BEFORE
 * the await of the write that follows, so a trip survives a reconcile that
 * then throws — a later doc's failing Firestore write, a bug — with no result
 * to carry it. The sweep builds one per lote before its `try` and registers
 * whatever it holds after the `catch`, on success and on a recorded failure
 * alike; `reconcileByRecibo` makes its own when given none (the task path).
 */
export interface DisjuntorConsSit {
  bloqueio: BloqueioConsSit | null;
}

/** One in-flight doc of a receipt round that resolves it by chave. */
export interface ReconcilePorChaveParams {
  readonly fs: Firestore;
  /** The filial's runtime — the consSit is built from it via `sefazCallFor`. */
  readonly rt: NFeRuntime;
  readonly filialId: string;
  readonly tpEmis: TpEmis;
  /** The receipt of this round. */
  readonly nRec: string;
  /** That `consReciNFe` reply. */
  readonly ret: TRetConsReciNFe;
  readonly chave: string;
  /** The doc as `reconcileByRecibo`'s in-flight query read it. */
  readonly data: NotaFiscalEletronica;
  readonly nfeRef: FirebaseFirestore.DocumentReference;
  /** Why this round resolves the doc by chave ({@link decidirRodadaDoRecibo}). */
  readonly motivo: MotivoConsultaPorChave;
  /**
   * The run's breaker cell — read before any consSit, and written in place at
   * every trip (a `null` bloqueio until a consSit of this run trips it).
   */
  readonly disjuntor: DisjuntorConsSit;
}

export interface ReconcilePorChaveResult {
  /**
   * The doc's estado after this round: what was written, or — when the guard
   * refused the write because the doc changed concurrently — that live estado.
   */
  readonly estado: EstadoNFe;
}

/** `cStat <c> — <xMotivo>` of a consSit answer, for a terminal motivo. */
function descreverConsSit(outcome: SefazOutcome): string {
  return `cStat ${outcome.cStat} — ${outcome.xMotivo}`;
}

/**
 * The breaker a consSit ANSWER for `chave` trips, if any: an unavailable
 * service (`indisponivel`), or a 656 among the unresolvable answers
 * (`consumo-indevido`). A final answer or "still queued" trips nothing.
 */
function disparoDaResposta(
  chave: string,
  outcome: SefazOutcome,
  recuperacao: RecuperacaoConsSit,
): BloqueioConsSit | null {
  switch (recuperacao) {
    case 'indisponivel':
      return { tipo: 'indisponivel', detalhe: `consSit cStat ${outcome.cStat}` };
    case 'sem-resolucao':
      return classifyCStat(outcome.cStat) === 'consumo-indevido'
        ? { tipo: 'consumo-indevido', chave, xMotivo: outcome.xMotivo }
        : null;
    case 'resolvida':
    case 'pendente':
      return null;
  }
}

/**
 * What this round knows about the chave, for the counted write's xMotivo and
 * every terminal motivo. The 104-without-our-protNFe text is the one #513
 * wrote, byte for byte. Our own protNFe (a duplicidade, a 635, a lote-state
 * code) is quoted with its cStat and xMotivo — the doc keeps the RECEIPT's
 * cStat, so this is where the operator sees what the protocol said.
 */
function descreverRodada(
  ret: TRetConsReciNFe,
  nRec: string,
  nosso: ProtNFeDoLote['infProt'] | null,
): string {
  if (nosso != null) {
    return `protNFe desta chave no recibo ${nRec}: cStat ${nosso.cStat} — ${nosso.xMotivo}`;
  }
  switch (ret.cStat) {
    case CSTAT_LOTE_PROCESSADO:
      return `protNFe desta chave ausente no lote processado nRec ${nRec}`;
    case CSTAT_LOTE_NAO_LOCALIZADO:
      return `lote não localizado para o recibo ${nRec}`;
    default:
      return `protNFe desta chave ausente no recibo ${nRec}`;
  }
}

/**
 * Resolve one doc of a receipt round by chave — the branch `reconcileByRecibo`
 * takes when {@link decidirRodadaDoRecibo} says `por-chave` (#513, #1654).
 *
 * **Its base is the LOTE outcome** (`outcomeFromRetConsRec`): the doc keeps
 * the receipt's cStat and `nRec`, so an `[nRec:X]` marker in our protNFe's
 * duplicidade xMotivo never re-keys the doc onto another receipt. For a 104
 * without our protNFe that is exactly what #513 wrote.
 *
 * **Every round counts.** `tentativa = (retries ?? 0) + 1`, on the same
 * per-doc counter every other in-flight round advances, so the chain is capped
 * by `MAX_RECONCILE_ATTEMPTS` whatever the lote keeps answering. Past the cap
 * (`tentativa > MAX`) the doc goes terminal with NO SEFAZ call.
 *
 * **A 106 on the doc's first round is only counted**, with no consSit: at
 * `tMed` a receipt may simply not be indexed yet, and a consSit then would
 * answer 217 for an NF-e that is about to land.
 *
 * **The count is durable before any further SEFAZ call.** The counted patch
 * (`aguardandoResposta`, `retries: tentativa`, "(consulta k/N)" in xMotivo) is
 * written first — which also stamps `proximaConsultaEm` from the same backoff
 * the task uses — so a consSit that throws, or a function that times out,
 * still leaves the attempt recorded.
 *
 * **Then ONE `consSitNFe` for the chave**, classified by
 * {@link classificarConsSitDeRecuperacao} for `motivo`:
 *  - `resolvida` → SEFAZ's own estado, with the digest-safe `<nfeProc>` stitch
 *    when it is an authorization;
 *  - `pendente` → stays counted, no breaker (terminal once the count reaches
 *    the cap: "ainda aguardando processamento");
 *  - `indisponivel` → stays counted and trips the outage breaker (terminal
 *    once the count reaches the cap);
 *  - `sem-resolucao` → terminal `error` with the round's BLOCKING cStat
 *    ({@link terminalBloqueante}: 104 for a 104, else 103), with the consSit
 *    cStat/xMotivo and "verificar manualmente" in the motivo.
 * A consSit whose `protNFe` names ANOTHER chave is terminal too — never
 * applied as ours.
 *
 * **The per-run breaker** ({@link BloqueioConsSit}) is read from the caller's
 * {@link DisjuntorConsSit} cell before any call, and every trip is written into
 * that cell at once — before the await of the write that follows it, so the
 * trip is the caller's even when that write, or a later doc, throws (#1654):
 * after a 656 (answered or thrown) the remaining docs go terminal with no call
 * (cstat-rejeicoes.md lines 98-121: stop immediately; gargalos-e-problemas.md
 * lines 63-91), and after an unavailable service the remaining ones are
 * counted with no call — an outage costs one consSit per round, not one per
 * chave, and never turns into the "transient → retry → 656" pattern
 * (gargalos-e-problemas.md line 203).
 *
 * **Every write goes through the guarded persist (`persistPatchUnlessFinal`),
 * never the plain `persistPatch`, under a {@link PersistGuard} (rule 7):**
 * `data` was read before the `consReciNFe` await and this branch makes a SEFAZ
 * round-trip AFTER its first write, so a concurrent task, sweep or manual
 * verify that changed the doc in either window must win. Inside the
 * transaction every write re-checks, on the doc as it is at write time, that
 * it is not final, still carries this `nRec`, is still in flight, and still
 * holds the `retries` the write was decided from — `data.retries` for a write
 * with no counted write before it this round, `tentativa` for every write
 * after it. A concurrent terminal (a 656 `error`, a 217 `rejeitada`) or
 * another runner's counted write therefore refuses the write instead of being
 * overwritten; the doc's live estado is reported, and a refused COUNTED write
 * skips the consSit altogether.
 *
 * Only a narrowed set of consSit failures is absorbed — consumo indevido
 * (656 breaker), transport failures (indisponível breaker) and XSD / XML
 * failures (this doc counted; no breaker). Anything else (a cert or endpoint
 * error, a bug) is rethrown; the count is already persisted.
 */
export async function reconcilePorChave(
  params: ReconcilePorChaveParams,
): Promise<ReconcilePorChaveResult> {
  const { fs, rt, filialId, tpEmis, nRec, ret, chave, data, nfeRef, motivo, disjuntor } = params;

  // The LOTE outcome for this doc: the receipt's cStat + xMotivo, never our
  // protNFe's — so its [nRec:] marker cannot re-key the doc.
  const base = applyOutcome(
    { estado: data.estado, retries: data.retries },
    outcomeFromRetConsRec(ret),
  );
  const tentativa = (data.retries ?? 0) + 1;
  const noLimite = tentativa >= MAX_RECONCILE_ATTEMPTS;
  // Strict equality: a near-miss chave is never ours.
  const nosso = ret.protNFe?.find((p) => p.infProt.chNFe === chave)?.infProt ?? null;
  const ausente = descreverRodada(ret, nRec, nosso);

  // Rule 7: `data` was read by the in-flight query BEFORE the consReciNFe await
  // (and the earlier docs' consSit awaits), so every write re-derives its
  // premise inside the transaction. A write with no counted write before it
  // in this round assumes the doc as read (`data.retries`); every write after
  // the counted one assumes the state this round just wrote (`tentativa`).
  // Either way: still this receipt, still in flight — a concurrent terminal
  // (656 `error`, 217 `rejeitada`) or another runner's counted write refuses
  // the write instead of being overwritten by it.
  const guardaContagem: PersistGuard = {
    expectedNRec: nRec,
    expectedRetries: data.retries ?? 0,
    requireInFlight: true,
  };
  const guardaRodada: PersistGuard = {
    expectedNRec: nRec,
    expectedRetries: tentativa,
    requireInFlight: true,
  };

  /** The guarded persist; reports the doc's live estado when the guard refused it. */
  async function gravar(
    patch: NFeStatePatch,
    guarda: PersistGuard,
    extras?: Record<string, unknown>,
  ): Promise<{ readonly written: boolean; readonly estado: EstadoNFe }> {
    const r = await persistPatchUnlessFinal(fs, nfeRef, patch, extras, guarda);
    if (r.written) return { written: true, estado: patch.estado };
    console.warn(
      `[nfe/reconcile] chave ${chave}: gravação recusada — o doc mudou em paralelo ` +
        `(estado=${r.estadoAtual}, nRec=${r.nRecAtual ?? 'null'}); reportando o estado vivo`,
    );
    return { written: false, estado: r.estadoAtual };
  }

  /** Terminal `error` with the round's BLOCKING cStat — the reason goes in xMotivo. */
  async function terminal(reason: string, guarda: PersistGuard): Promise<ReconcilePorChaveResult> {
    const { estado } = await gravar(
      terminalBloqueante({ ...base, retries: tentativa }, ret.cStat, reason),
      guarda,
    );
    return { estado };
  }

  // Hard stop: the cap was already reached (a previous at-cap round was
  // interrupted after its count) — no further SEFAZ call.
  if (tentativa > MAX_RECONCILE_ATTEMPTS) {
    return terminal(
      `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas — verificar manualmente`,
      guardaContagem,
    );
  }

  const contada: NFeStatePatch = {
    ...base,
    estado: ESTADO_NFE.aguardandoResposta,
    retries: tentativa,
    xMotivo: `${base.xMotivo} | ${ausente} (consulta ${tentativa}/${MAX_RECONCILE_ATTEMPTS})`,
  };

  // A 106 on the doc's first round may be a receipt not indexed yet: count
  // it, and consult by chave only from the next round on.
  if (motivo === 'lote-nao-localizado' && tentativa === 1) {
    if (!noLimite) return { estado: (await gravar(contada, guardaContagem)).estado };
    return terminal(
      `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas — verificar manualmente`,
      guardaContagem,
    );
  }

  // The breaker as an earlier consSit of this run (or the caller) left it.
  const bloqueio = disjuntor.bloqueio;

  // A 656 earlier in this run: consulting again deepens the throttle hole.
  if (bloqueio?.tipo === 'consumo-indevido') {
    return terminal(
      `${ausente}; consulta por chave suspensa nesta rodada após cStat 656 ` +
        `na chave ${bloqueio.chave} — verificar manualmente`,
      guardaContagem,
    );
  }

  // The service was unavailable earlier in this run: count, don't call.
  if (bloqueio?.tipo === 'indisponivel') {
    if (!noLimite) return { estado: (await gravar(contada, guardaContagem)).estado };
    return terminal(
      `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas; consulta por chave ` +
        `indisponível nesta rodada (${bloqueio.detalhe}) — verificar manualmente`,
      guardaContagem,
    );
  }

  // The durable count, BEFORE the SEFAZ call. Refused → the doc changed
  // concurrently (went terminal, or another runner counted it): report it,
  // and do not consult.
  const contagem = await gravar(contada, guardaContagem);
  if (!contagem.written) return { estado: contagem.estado };

  let retSit: TRetConsSitNFe;
  try {
    retSit = await consultarSituacaoNFe(sefazCallFor(rt, tpEmis, 'NfeConsultaProtocolo'), {
      chave,
    });
  } catch (e) {
    if (e instanceof NFeConsumoIndevidoError) {
      disjuntor.bloqueio = { tipo: 'consumo-indevido', chave, xMotivo: e.xMotivo };
      safeLog(
        'error',
        `[nfe/reconcile] chave ${chave}: consSitNFe recusada com cStat ${e.cStat} — ` +
          'consulta por chave suspensa no resto desta rodada',
      );
      return terminal(
        `${ausente}; consulta por chave recusada: cStat ${e.cStat} — ${e.xMotivo} — ` +
          'verificar manualmente',
        guardaRodada,
      );
    }
    if (e instanceof NFeTransportError) {
      // name + message only — `NFeTransportError.responseBody` stays server-side.
      safeLog('error', `[nfe/reconcile] chave ${chave}: consSitNFe falhou`, safeErrorShape(e));
      // The SERVICE is unreachable: the remaining docs are counted without a
      // call.
      disjuntor.bloqueio = { tipo: 'indisponivel', detalhe: e.name };
      if (!noLimite) return { estado: contada.estado };
      return terminal(
        `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas; consulta por chave ` +
          `indisponível (${e.name}) — verificar manualmente`,
        guardaRodada,
      );
    }
    if (e instanceof NFeXsdValidationError || e instanceof NFeXmlError) {
      safeLog('error', `[nfe/reconcile] chave ${chave}: consSitNFe falhou`, safeErrorShape(e));
      // A request or reply that fails XSD / XML parsing can be deterministic
      // for THIS chave, so it says nothing about the service: this doc is
      // counted (terminal at the cap), the breaker is left as it was, and the
      // other docs of the run are still consulted.
      if (!noLimite) return { estado: contada.estado };
      return terminal(
        `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas; consulta por chave ` +
          `falhou (${e.name}) — verificar manualmente`,
        guardaRodada,
      );
    }
    throw e;
  }

  const outcome = outcomeFromRetConsSit(retSit);
  const chNFeDoProt = retSit.protNFe?.infProt.chNFe ?? null;
  const outraChave = chNFeDoProt != null && chNFeDoProt !== chave;
  const recuperacao = classificarConsSitDeRecuperacao(outcome.cStat, motivo);
  // The ANSWER trips the breaker at once, before the audit add and the
  // verdict's write below: either may throw, and the trip must outlive it.
  const disparo = outraChave ? null : disparoDaResposta(chave, outcome, recuperacao);
  if (disparo != null) disjuntor.bloqueio = disparo;

  await enviNfeCollection(fs, filialId).add(
    buildEnviNFeMsgFromConsulta({ chave, nRec: null, ret: retSit, tpEmis }),
  );

  console.warn(
    `[nfe/reconcile] chave ${chave}: ${motivo} no recibo ${nRec}; ` +
      `consSitNFe cStat ${outcome.cStat} → ${outraChave ? 'outra-chave' : recuperacao}`,
  );

  // Strict equality, same discipline as the receipt: a protocol for another
  // chave is never applied as ours.
  if (outraChave) {
    return terminal(
      `${ausente}; consulta por chave devolveu protNFe de outra chave (${chNFeDoProt}) — ` +
        'verificar manualmente',
      guardaRodada,
    );
  }

  switch (recuperacao) {
    case 'resolvida': {
      const patch = applyOutcome({ estado: contada.estado, retries: contada.retries }, outcome);
      const proc = buildProcForAuthorizedOutcome({
        cStat: patch.cStat,
        chaveMatches: chNFeDoProt === chave,
        signedXml: data.xml_assinado,
        prot: retSit.protNFe ?? null,
        logTag: 'nfe/reconcile',
        chave,
      });
      const { estado } = await gravar(
        patch,
        guardaRodada,
        proc != null ? swapAnchorForProc(proc) : undefined,
      );
      return { estado };
    }
    case 'pendente': {
      // The NF-e is still queued at SEFAZ: nothing to apply and nothing wrong
      // with the service — the counted write stands, no breaker.
      if (!noLimite) return { estado: contada.estado };
      return terminal(
        `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas; consulta por chave: ` +
          `${descreverConsSit(outcome)} — ainda aguardando processamento — verificar manualmente`,
        guardaRodada,
      );
    }
    case 'indisponivel': {
      // The outage breaker tripped above, on the answer.
      if (!noLimite) return { estado: contada.estado };
      return terminal(
        `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas; consulta por chave ` +
          `indisponível: ${descreverConsSit(outcome)} — verificar manualmente`,
        guardaRodada,
      );
    }
    case 'sem-resolucao': {
      // A 656 among these tripped the consumo-indevido breaker above.
      return terminal(
        `${ausente}; consulta por chave: ${descreverConsSit(outcome)} — verificar manualmente`,
        guardaRodada,
      );
    }
  }
}
