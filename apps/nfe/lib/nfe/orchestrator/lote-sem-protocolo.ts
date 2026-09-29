/**
 * The 104-without-our-protNFe branch of `reconcileByRecibo` (#513) — its pure
 * classifiers and the per-doc recovery `reconcileLoteSemProtocolo`.
 *
 * A processed lote (`cStat=104`) carries the result of EVERY NF-e it held
 * (MOC 7.0 p.75 §5.1, p.76 BR07; `TRetConsReciNFe/protNFe` is 0..50), so a 104
 * with no `protNFe` for our chave is final for that `nRec`: re-reading the same
 * receipt cannot change the answer, and re-fetching an already-delivered result
 * is the Consumo Indevido pattern (MOC 7.0 p.58 §4.3(c)(3), p.63 Tabela 4-9).
 * What is left to ask is what SEFAZ holds for the chave itself — the
 * `consSitNFe` recovery query (`.claude/skills/nfe/references/webservices.md`
 * lines 139-143, "NfeConsultaProtocolo"; MOC 7.0 p.78 §5.2.5 and p.84 J03–J06
 * for its answers).
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
  outcomeFromConsReci,
  type PersistGuard,
  persistPatchUnlessFinal,
  swapAnchorForProc,
} from './audit';

/** One `protNFe` element of a `retConsReciNFe`. */
type ProtNFeDoLote = NonNullable<TRetConsReciNFe['protNFe']>[number];

/**
 * True when the lote was processed (104) and carries no `protNFe` for our
 * chave. The caller resolves `ourProt` by STRICT equality on
 * `infProt.chNFe` — a near-miss chave counts as missing, never as ours.
 */
export function isLoteProcessadoSemProtocolo(
  ret: Pick<TRetConsReciNFe, 'cStat'>,
  ourProt: ProtNFeDoLote | null,
): boolean {
  return classifyCStat(ret.cStat) === 'lote-processado' && ourProt == null;
}

/**
 * True for a lote-level reply that says NOTHING about any chave of the lote:
 * 103 (lote recebido), 106 (lote não localizado), 107 (serviço em operação)
 * and 108/109/113/114 (serviço paralisado, SVC em desativação/desabilitada).
 * `reconcileByRecibo` keeps the doc's `retries` on these instead of letting
 * `applyOutcome` zero it, so an outage between two 104 rounds cannot restart
 * the 104 count — only our `protNFe` or a final answer clears it. The value is
 * kept exactly as read, and a non-answer is exempt from the cap (whose
 * terminal would carry the non-answer's NON-blocking cStat): a doc at MAX stays
 * in flight at MAX, and the next 104 sighting ends it past the cap with NO
 * consSit, by {@link reconcileLoteSemProtocolo}'s hard stop.
 *
 * False for every other category: 105 is already counted by `applyOutcome`,
 * 104 has its own branch, and the final / duplicidade / rejection / 656
 * categories keep their existing handling. A pure lote-level 106/108 chain is
 * still uncapped — resolving 106 via `consSitNFe` is a follow-up — and so is
 * a 104 whose `protNFe` for our chave carries a non-539 duplicidade
 * (204/205/218/635), which `applyOutcome` leaves in flight with `retries`
 * zeroed (pre-existing).
 */
export function loteSemRespostaParaAChave(cStat: string): boolean {
  switch (classifyCStat(cStat)) {
    case 'lote-recebido':
    case 'lote-nao-localizado':
    case 'servico-em-operacao':
    case 'servico-paralisado':
      return true;
    case 'lote-pendente':
    case 'lote-processado':
    case 'autorizada':
    case 'cancelada':
    case 'inutilizada':
    case 'denegada':
    case 'duplicidade':
    case 'rejeitada-schema':
    case 'rejeitada-certificado':
    case 'rejeitada-ambiente':
    case 'consumo-indevido':
    case 'rejeitada':
      return false;
  }
}

/** What the recovery `consSitNFe` told us about a chave missing from a processed lote. */
export type RecuperacaoConsSit =
  /** SEFAZ gave the chave a final answer — apply it. */
  | 'resolvida'
  /** The service is down — nothing learned; the doc stays counted. */
  | 'indisponivel'
  /** No usable answer — terminal error that keeps cStat 104, verificar manualmente. */
  | 'sem-resolucao';

/**
 * 217 — "NF-e não consta na base de dados da SEFAZ" (MOC 7.0 p.84 Tabela 5-16,
 * J03): SEFAZ holds no NF-e for this emitente/modelo/série/número, so the
 * número was NOT consumed and re-emitting it cannot use it twice.
 */
const CSTAT_NFE_NAO_CONSTA_NA_BASE = '217';

/**
 * Classify `outcomeFromRetConsSit(retSit).cStat` — the inner `infProt.cStat`,
 * except for a top-level cancelada/inutilizada or an absent `protNFe`.
 *
 *  - autorizada / cancelada / inutilizada / denegada → `resolvida`. Denegada
 *    lands as rejeitada, same as every other consSit path, even though its
 *    número is consumed (cstat-rejeicoes.md, "Denial").
 *  - rejeitada → `resolvida` ONLY for 217 (above). 561/562/613 (MOC 7.0 p.84
 *    J04–J06: mês / código numérico / chave differ from the NF-e SEFAZ holds)
 *    mean the número EXISTS under another chave, so re-emitting would collide:
 *    `sem-resolucao`, like every other rejection.
 *  - servico-paralisado (108/109/113/114) → `indisponivel`.
 *  - everything else, 656 included → `sem-resolucao` (on 656 the caller also
 *    stops consulting for the rest of the run — cstat-rejeicoes.md §656).
 */
export function classificarConsSitDeRecuperacao(cStat: string): RecuperacaoConsSit {
  switch (classifyCStat(cStat)) {
    case 'autorizada':
    case 'cancelada':
    case 'inutilizada':
    case 'denegada':
      return 'resolvida';
    case 'rejeitada':
      return cStat === CSTAT_NFE_NAO_CONSTA_NA_BASE ? 'resolvida' : 'sem-resolucao';
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

/**
 * Per-run consSit circuit breaker, held by `reconcileByRecibo` across the docs
 * of one lote reconcile and threaded through this branch — and, in the
 * backstop sweep (`runProcessarPendentes`), across the later lotes of that run
 * at each type's own scope:
 *
 *  - `consumo-indevido` — a consSit answered 656 (or threw
 *    `NFeConsumoIndevidoError`): every remaining missing doc of the run goes
 *    terminal WITHOUT a call (cstat-rejeicoes.md §656, "Stop immediately";
 *    the same abort `verificar.ts` applies). Sweep scope: the whole FILIAL,
 *    since the 656 throttle is per CNPJ+IP.
 *  - `indisponivel` — the service is down (a consSit answered
 *    108/109/113/114, or threw `NFeTransportError`): the remaining missing
 *    docs are counted without a call, so an outage costs one consSit per
 *    round, not one per chave. An XSD / XML failure does NOT trip it — it can
 *    be deterministic for one chave, and must not starve the others. Sweep
 *    scope: the filial's lotes at the SAME authorizer (`autorizadorDe`) — the
 *    home SEFAZ being down says nothing about SVC-AN / SVC-RS.
 */
export type BloqueioConsSit =
  | { readonly tipo: 'consumo-indevido'; readonly chave: string; readonly xMotivo: string }
  | { readonly tipo: 'indisponivel'; readonly detalhe: string };

/** One in-flight doc of a processed lote whose reply carries no `protNFe` for it. */
export interface LoteSemProtocoloParams {
  readonly fs: Firestore;
  /** The filial's runtime — the consSit is built from it via `sefazCallFor`. */
  readonly rt: NFeRuntime;
  readonly filialId: string;
  readonly tpEmis: TpEmis;
  /** The receipt that answered 104 without our chave. */
  readonly nRec: string;
  /** That `consReciNFe` reply. */
  readonly ret: TRetConsReciNFe;
  readonly chave: string;
  /** The doc as `reconcileByRecibo`'s in-flight query read it. */
  readonly data: NotaFiscalEletronica;
  readonly nfeRef: FirebaseFirestore.DocumentReference;
  /** The run's breaker so far — `null` until a consSit of this run trips it. */
  readonly bloqueio: BloqueioConsSit | null;
}

export interface LoteSemProtocoloResult {
  /**
   * The doc's estado after this round: what was written, or — when the guard
   * refused the write because the doc changed concurrently — that live estado.
   */
  readonly estado: EstadoNFe;
  /** The breaker for the remaining docs of the run (the given one, or a newly tripped one). */
  readonly bloqueio: BloqueioConsSit | null;
}

/** `cStat <c> — <xMotivo>` of a consSit answer, for a terminal motivo. */
function descreverConsSit(outcome: SefazOutcome): string {
  return `cStat ${outcome.cStat} — ${outcome.xMotivo}`;
}

/**
 * Resolve one doc of a processed lote (104) whose reply carries no `protNFe`
 * for its chave (#513) — the branch `reconcileByRecibo` takes when
 * {@link isLoteProcessadoSemProtocolo} holds.
 *
 * **Every sighting counts.** `tentativa = (retries ?? 0) + 1`, on the same
 * per-doc counter the 105 path advances, so the chain is capped by
 * `MAX_RECONCILE_ATTEMPTS` whatever the lote keeps answering. Past the cap
 * (`tentativa > MAX`) the doc goes terminal with NO SEFAZ call.
 *
 * **The count is durable before any further SEFAZ call.** The counted patch
 * (`aguardandoResposta`, `retries: tentativa`, "(consulta k/N)" in xMotivo) is
 * written first — which also stamps `proximaConsultaEm` from the same backoff
 * the task uses — so a consSit that throws, or a function that times out,
 * still leaves the attempt recorded.
 *
 * **Then ONE `consSitNFe` for the chave** (on the FIRST sighting: a processed
 * lote's result is complete, so re-reading the receipt cannot help), classified
 * by {@link classificarConsSitDeRecuperacao} on `outcomeFromRetConsSit(retSit).cStat`:
 *  - `resolvida` → SEFAZ's own estado, with the digest-safe `<nfeProc>` stitch
 *    when it is an authorization;
 *  - `indisponivel` → stays counted (terminal once the count reaches the cap);
 *  - `sem-resolucao` → terminal `error` KEEPING cStat 104 (a
 *    `STATUS_BLOQUEADORES` code, so the pedido cannot be re-emitted over a
 *    número SEFAZ may hold — MOC 7.0 p.84 J04–J06), with the consSit
 *    cStat/xMotivo and "verificar manualmente" in the motivo.
 * A consSit whose `protNFe` names ANOTHER chave is terminal too — never
 * applied as ours.
 *
 * **The per-run breaker** ({@link BloqueioConsSit}) is read before and
 * returned after: after a 656 (answered or thrown) the remaining missing docs
 * go terminal with no call (cstat-rejeicoes.md lines 98-121: stop immediately;
 * gargalos-e-problemas.md lines 63-91), and after an unavailable service the
 * remaining ones are counted with no call — an outage costs one consSit per
 * round, not one per chave, and never turns into the "transient → retry → 656"
 * pattern (gargalos-e-problemas.md line 203).
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
export async function reconcileLoteSemProtocolo(
  params: LoteSemProtocoloParams,
): Promise<LoteSemProtocoloResult> {
  const { fs, rt, filialId, tpEmis, nRec, ret, chave, data, nfeRef } = params;
  let bloqueio = params.bloqueio;

  // Today's 104 patch for this doc: lote cStat '104' + the lote xMotivo.
  const base = applyOutcome(
    { estado: data.estado, retries: data.retries },
    outcomeFromConsReci(ret, chave),
  );
  const tentativa = (data.retries ?? 0) + 1;
  const noLimite = tentativa >= MAX_RECONCILE_ATTEMPTS;
  const ausente = `protNFe desta chave ausente no lote processado nRec ${nRec}`;

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

  /** Terminal `error` keeping cStat 104 (blocking) — the reason goes in xMotivo. */
  async function terminal(reason: string, guarda: PersistGuard): Promise<LoteSemProtocoloResult> {
    const { estado } = await gravar(markAsLost({ ...base, retries: tentativa }, reason), guarda);
    return { estado, bloqueio };
  }

  // Hard stop: the cap was already reached (a previous at-cap consSit threw) —
  // no further SEFAZ call.
  if (tentativa > MAX_RECONCILE_ATTEMPTS) {
    return terminal(
      `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas — verificar manualmente`,
      guardaContagem,
    );
  }

  // A 656 earlier in this run: consulting again deepens the throttle hole.
  if (bloqueio?.tipo === 'consumo-indevido') {
    return terminal(
      `${ausente}; consulta por chave suspensa nesta rodada após cStat 656 ` +
        `na chave ${bloqueio.chave} — verificar manualmente`,
      guardaContagem,
    );
  }

  const contada: NFeStatePatch = {
    ...base,
    estado: ESTADO_NFE.aguardandoResposta,
    retries: tentativa,
    xMotivo: `${base.xMotivo} | ${ausente} (consulta ${tentativa}/${MAX_RECONCILE_ATTEMPTS})`,
  };

  // The service was unavailable earlier in this run: count, don't call.
  if (bloqueio?.tipo === 'indisponivel') {
    if (!noLimite) return { estado: (await gravar(contada, guardaContagem)).estado, bloqueio };
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
  if (!contagem.written) return { estado: contagem.estado, bloqueio };

  let retSit: TRetConsSitNFe;
  try {
    retSit = await consultarSituacaoNFe(sefazCallFor(rt, tpEmis, 'NfeConsultaProtocolo'), {
      chave,
    });
  } catch (e) {
    if (e instanceof NFeConsumoIndevidoError) {
      bloqueio = { tipo: 'consumo-indevido', chave, xMotivo: e.xMotivo };
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
      // The SERVICE is unreachable: the remaining missing docs are counted
      // without a call.
      bloqueio = { tipo: 'indisponivel', detalhe: e.name };
      if (!noLimite) return { estado: contada.estado, bloqueio };
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
      // other missing docs of the run are still consulted.
      if (!noLimite) return { estado: contada.estado, bloqueio };
      return terminal(
        `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas; consulta por chave ` +
          `falhou (${e.name}) — verificar manualmente`,
        guardaRodada,
      );
    }
    throw e;
  }

  await enviNfeCollection(fs, filialId).add(
    buildEnviNFeMsgFromConsulta({ chave, nRec: null, ret: retSit, tpEmis }),
  );

  const outcome = outcomeFromRetConsSit(retSit);
  const chNFeDoProt = retSit.protNFe?.infProt.chNFe ?? null;
  const outraChave = chNFeDoProt != null && chNFeDoProt !== chave;
  const recuperacao = classificarConsSitDeRecuperacao(outcome.cStat);
  console.warn(
    `[nfe/reconcile] chave ${chave}: sem protNFe no lote processado nRec ${nRec}; ` +
      `consSitNFe cStat ${outcome.cStat} → ${outraChave ? 'outra-chave' : recuperacao}`,
  );

  // Strict equality, same discipline as the lote predicate: a protocol for
  // another chave is never applied as ours.
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
      return { estado, bloqueio };
    }
    case 'indisponivel': {
      bloqueio = { tipo: 'indisponivel', detalhe: `consSit cStat ${outcome.cStat}` };
      if (!noLimite) return { estado: contada.estado, bloqueio };
      return terminal(
        `${ausente} após ${MAX_RECONCILE_ATTEMPTS} consultas; consulta por chave ` +
          `indisponível: ${descreverConsSit(outcome)} — verificar manualmente`,
        guardaRodada,
      );
    }
    case 'sem-resolucao': {
      if (classifyCStat(outcome.cStat) === 'consumo-indevido') {
        bloqueio = { tipo: 'consumo-indevido', chave, xMotivo: outcome.xMotivo };
      }
      return terminal(
        `${ausente}; consulta por chave: ${descreverConsSit(outcome)} — verificar manualmente`,
        guardaRodada,
      );
    }
  }
}
