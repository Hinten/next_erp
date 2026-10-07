/**
 * Manual re-verification of persisted `enviNfe` audit msgs — the server core
 * behind `POST /api/nfe/verificar` (the "Verificar novamente" action on
 * `/nfe/comunicacoes`).
 *
 * Resolves each msg's `targetsChnfe` to its nfev4 doc and re-runs the shared
 * `consultarChavePersistida` consulta for the non-final ones. Hard rules:
 *   - **Final estados are skipped, never consulted** (`isEstadoFinalNFe`):
 *     another consulta can't legitimately change aprovada/cancelada/
 *     inutilizada — and for cancelada it would even be harmful (`consSitNFe`
 *     still returns the original authorization protNFe).
 *   - **At most `MAX_CHAVES_POR_VERIFICACAO` chaves consult SEFAZ per run**:
 *     the route caps msg ids at 10, but a legacy batch msg can carry N chaves
 *     in `targetsChnfe`, so the fan-out must be bounded here too. Chaves past
 *     the cap (after dedupe) are reported as `erro` with NO SEFAZ call.
 *   - **A future `proximaConsultaEm` skips the consulta** (`sem-mudanca`):
 *     the async reconciler's Cloud Task is about to consult that nRec — a
 *     manual double-consult is the SEFAZ cStat=656 vector (656 is terminal).
 *     Past or null → proceed; that stuck case is what this feature is for.
 *   - **Sequential per-chave loop, never parallel** — a burst of consultas is
 *     the SEFAZ cStat=656 (consumo indevido) vector. A per-run consReci cache
 *     additionally collapses N same-lote chaves into ONE `consReciNFe` call.
 *   - **cStat=656 aborts the run**: the remaining chaves are reported as
 *     `erro` without any further SEFAZ call (re-querying after a 656 deepens
 *     the throttle hole — #77). Read from `ConsultaChaveResult.consumoIndevido`,
 *     never from the persisted cStat: a 656 on the receipt is now a BLOCKING
 *     terminal carrying cStat 103/104 (#1654).
 *   - Per-chave errors never leak `responseBody` (raw SEFAZ reply) — only
 *     `name: message`.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { nowMicros } from '@delfrance/core/datetime';
import { enviNfeMsgCollection, nfev4Collection } from '@delfrance/data/admin/collections';
import {
  NFeCertError,
  NFeConsumoIndevidoError,
  NFeEndpointError,
  NFeTransportError,
  NFeXmlError,
  isEstadoFinalNFe,
  type TRetConsReciNFe,
} from '@delfrance/integrations-nfe';
import { ESTADO_NFE, type EstadoNFe } from '@delfrance/schemas';

import type { NFeBaseRuntime } from '../runtime';
import { resolveFilialRuntime } from '../filial-cert';
import { safeLog } from '../log';
import { NFeOrchestratorError } from './errors';
import { envioEmCurso } from './audit';
import { consultarChavePersistida } from './consultar';

/** Per-chave verification outcome tag. */
export type VerificarChaveStatus = 'skipped-final' | 'atualizada' | 'sem-mudanca' | 'erro';

/** One chave's verification result. */
export interface VerificarChaveResult {
  readonly chave: string;
  readonly status: VerificarChaveStatus;
  readonly estadoAnterior: EstadoNFe | null;
  readonly estadoNovo: EstadoNFe | null;
  readonly cStat: string | null;
  readonly xMotivo: string | null;
  /** `name: message` of the per-chave failure — never the raw SEFAZ body. */
  readonly error: string | null;
}

/** Result of one `verificarEnviNfeMsgs` run. */
export interface VerificarEnviNfeResult {
  readonly filialId: string;
  readonly results: ReadonlyArray<VerificarChaveResult>;
  /** Requested msg ids with no doc under `filiais/{filialId}/enviNfe`. */
  readonly msgsNaoEncontradas: ReadonlyArray<string>;
}

const ABORT_656_ERROR = 'verificação interrompida — cStat 656 (consumo indevido)';

/**
 * Hard per-request SEFAZ fan-out cap, applied to the DEDUPED chave list. The
 * route's 10-msg cap bounds lookups, not consultas — one legacy batch msg can
 * target dozens of chaves. Chaves past this cap get an `erro` result entry
 * and never reach SEFAZ.
 */
export const MAX_CHAVES_POR_VERIFICACAO = 20;

const CAP_ERROR = `não consultada — limite de ${MAX_CHAVES_POR_VERIFICACAO} chaves por verificação`;

/**
 * Re-verify the NF-es referenced by a set of `enviNfe` audit msgs against
 * SEFAZ. Chaves are deduped across the msgs' `targetsChnfe`; each unique
 * chave resolves to its newest nfev4 doc via the collection-group query.
 *
 * Throws `NFeCertError` when the filial has no usable A1 (resolved once,
 * before any SEFAZ call) — the route maps it to 422. Per-chave SEFAZ/
 * orchestrator failures are captured as `erro` entries instead of throwing,
 * so one bad chave never sinks the batch.
 */
export async function verificarEnviNfeMsgs(
  fs: Firestore,
  baseRt: NFeBaseRuntime,
  params: { filialId: string; enviNfeMsgIds: ReadonlyArray<string> },
): Promise<VerificarEnviNfeResult> {
  const { filialId } = params;

  const msgsNaoEncontradas: string[] = [];
  // Dedupe across msgs, preserving first-seen order (deterministic reporting).
  const chaves: string[] = [];
  const seen = new Set<string>();
  for (const msgId of params.enviNfeMsgIds) {
    const snap = await enviNfeMsgCollection.docRef(fs, { filialId }, msgId).get();
    if (!snap.exists) {
      msgsNaoEncontradas.push(msgId);
      continue;
    }
    const msg = enviNfeMsgCollection.parseRead(snap.data(), snap.ref.path);
    for (const chave of msg.targetsChnfe) {
      if (!seen.has(chave)) {
        seen.add(chave);
        chaves.push(chave);
      }
    }
  }

  // Resolve the filial's signing cert ONCE — an NFeCertError here (no stored
  // cert / undecryptable) aborts the whole run before any SEFAZ contact.
  const rt = await resolveFilialRuntime(fs, baseRt, filialId);

  const results: VerificarChaveResult[] = [];
  // Set on the first cStat=656 — every remaining chave short-circuits to
  // `erro` with this message, no further SEFAZ calls.
  let abort656 = false;
  // Per-run consReci dedupe: N chaves of the same lote (one legacy batch msg)
  // share ONE consReciNFe round-trip for their common nRec — see the
  // `consReciCache` jsdoc on `consultarChavePersistida`.
  const consReciCache = new Map<string, TRetConsReciNFe>();

  // SEQUENTIAL on purpose — see the module doc (consumo-indevido vector).
  for (const [index, chave] of chaves.entries()) {
    // Fan-out cap — deduped chaves past the limit never reach SEFAZ.
    if (index >= MAX_CHAVES_POR_VERIFICACAO) {
      results.push(erroResult(chave, null, CAP_ERROR));
      continue;
    }

    if (abort656) {
      results.push(erroResult(chave, null, ABORT_656_ERROR));
      continue;
    }

    // Newest nfev4 doc carrying this chave (a chave can appear on more than
    // one doc only via legacy duplicates — the most recently modified wins,
    // same tiebreak as consultarPedido's slot scan).
    const snap = await nfev4Collection.groupQuery(fs).where('chave', '==', chave).get();
    const chosen = snap.docs
      .map((d) => ({
        ref: d.ref,
        nota: nfev4Collection.parseRead(d.data(), d.ref.path),
        updateTime: d.updateTime,
      }))
      .sort((a, b) => (b.nota.ultima_modificacao ?? 0) - (a.nota.ultima_modificacao ?? 0))[0];
    if (!chosen) {
      results.push(erroResult(chave, null, 'nenhum documento nfev4 com esta chave'));
      continue;
    }
    const nota = chosen.nota;

    if (isEstadoFinalNFe(nota.estado)) {
      results.push({
        chave,
        status: 'skipped-final',
        estadoAnterior: nota.estado,
        estadoNovo: nota.estado,
        cStat: nota.cStat,
        xMotivo: nota.xMotivo,
        error: null,
      });
      continue;
    }

    // An EPEC-approved doc is never consulted here (#1675): a consSit goes to
    // the HOME SEFAZ, which answers 217 until the Ambiente Nacional shares the
    // EPEC with it (then 124 "EPEC Autorizado", which this table does not read
    // as authorized either), and a 217 would write `rejeitada` over a registered
    // EPEC — whose next emit regenerates over the bytes it summarises. Its recovery path is the
    // pós-EPEC transmission (an emit, or the sweep once contingency is off).
    if (nota.estado === ESTADO_NFE.epecAprovado) {
      results.push({
        chave,
        status: 'sem-mudanca',
        estadoAnterior: nota.estado,
        estadoNovo: nota.estado,
        cStat: nota.cStat,
        xMotivo:
          'EPEC registrado — aguardando a transmissão da NF-e completa (pós-EPEC); ' +
          'nenhuma consulta feita',
        error: null,
      });
      continue;
    }

    // Due-gate: a FUTURE `proximaConsultaEm` (µs epoch) means either the async
    // reconciler's Cloud Task is scheduled to consult this doc's nRec — a
    // manual consulta now would double-consult the same receipt back-to-back
    // (SEFAZ answers cStat=656, which is terminal) — or, on a doc with no
    // receipt, a send is in progress / a paced retry is pending (#1675,
    // `envioEmCurso`), whose doc only its owner may write. Past or null →
    // proceed: an overdue doc is exactly the stuck case this action exists for.
    const agora = nowMicros();
    if (nota.proximaConsultaEm != null && nota.proximaConsultaEm > agora) {
      const ate = new Date(nota.proximaConsultaEm / 1000).toISOString();
      results.push({
        chave,
        status: 'sem-mudanca',
        estadoAnterior: nota.estado,
        estadoNovo: nota.estado,
        cStat: nota.cStat,
        xMotivo: envioEmCurso(nota, agora)
          ? `envio em curso ou nova tentativa agendada até ${ate}`
          : `consulta agendada pelo reconciliador para ${ate}`,
        error: null,
      });
      continue;
    }

    // Doc path is `pedidos/{pedidoId}/nfev4/{nfeId}` — parent.parent is the
    // pedido doc.
    const pedidoId = chosen.ref.parent.parent?.id ?? chosen.ref.path;

    try {
      const { patch, consumoIndevido, recusado } = await consultarChavePersistida({
        fs,
        rt,
        filialId,
        pedidoId,
        nfeRef: chosen.ref,
        nota,
        updateTimeLido: chosen.updateTime,
        chave,
        consReciCache,
      });
      results.push(
        recusado
          ? {
              // #1675 — nothing was written: another run changed the doc during
              // the consult (or a send is in progress). Report its live state
              // without claiming this verify updated anything.
              chave,
              status: 'sem-mudanca',
              estadoAnterior: nota.estado,
              estadoNovo: patch.estado,
              cStat: patch.cStat,
              xMotivo:
                'nada gravado — outro processo alterou este documento durante a consulta ' +
                `(estado atual ${patch.estado}, cStat ${patch.cStat}: ${patch.xMotivo})`,
              error: null,
            }
          : {
              chave,
              status: patch.estado !== nota.estado ? 'atualizada' : 'sem-mudanca',
              estadoAnterior: nota.estado,
              estadoNovo: patch.estado,
              cStat: patch.cStat,
              xMotivo: patch.xMotivo,
              error: null,
            },
      );
      // 656 surfaces as an answer (not a thrown error) in this codebase —
      // abort the rest of the run. The flag, not `patch.cStat`: a 656 on the
      // receipt is persisted as a blocking terminal (cStat 103/104, #1654).
      if (consumoIndevido) abort656 = true;
    } catch (e) {
      // Consumo indevido as a thrown error (the library shield) — same abort.
      if (e instanceof NFeConsumoIndevidoError) {
        abort656 = true;
        results.push(erroResult(chave, nota.estado, e));
        safeLog('error', `[nfe/verificar] chave ${chave}:`, e);
        continue;
      }
      if (
        e instanceof NFeTransportError ||
        e instanceof NFeCertError ||
        e instanceof NFeEndpointError ||
        e instanceof NFeXmlError ||
        e instanceof NFeOrchestratorError
      ) {
        // Per-chave isolation: report and move on. `e.message` never carries
        // the raw SEFAZ body (that lives on NFeTransportError.responseBody,
        // which stays server-side).
        results.push(erroResult(chave, nota.estado, e));
        safeLog('error', `[nfe/verificar] chave ${chave}:`, e);
        continue;
      }
      throw e;
    }
  }

  return { filialId, results, msgsNaoEncontradas };
}

/**
 * Shape one `erro` result entry. `error` is either a plain reason string
 * (cap / abort / no-doc entries) or an `Error`, rendered as `name: message` —
 * never the raw SEFAZ body.
 */
function erroResult(
  chave: string,
  estado: EstadoNFe | null,
  error: Error | string,
): VerificarChaveResult {
  return {
    chave,
    status: 'erro',
    estadoAnterior: estado,
    estadoNovo: estado,
    cStat: null,
    xMotivo: null,
    error: typeof error === 'string' ? error : `${error.name}: ${error.message}`,
  };
}
