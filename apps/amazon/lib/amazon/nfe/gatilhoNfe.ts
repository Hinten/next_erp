/**
 * The body of the NF-e trigger `onNfeAprovadaAmazon` (step 14, PR 14-c): what
 * ONE `pedidos/{pedidoId}/nfev4/{nfeId}` write means for Amazon. The function
 * file (`functions/src/onNfeAprovadaAmazon.ts`) only binds the deps and hands
 * the raw snapshot bodies here.
 *
 * ⚠️ The FOURTH function on every `nfev4` write of the project (Mercado Livre's
 * and Shopee's NF-e triggers and `apps/functions`' `onNfeDeleted` are the other
 * three), so EVERY write fires it — the placeholder, the `enviando` anchor, each
 * SOAP retry, a cancellation, and the window's `nfe-totais` migration, which
 * rewrites every approved document. That is why the first rung costs ZERO
 * reads and logs NOTHING outside its two edges.
 *
 * ## The ladder, in order
 *
 * - **T1** — the two EDGES, never a level: `decideNfeUploadTransition(before,
 *   after)` (the upload edge: INTO ready — aprovada, a proc, tpAmb 1; a `p → a`
 *   pós-EPEC write is one, an `a → a` rewrite is not), else
 *   `cancelamentoDeNfeAprovadaAmazon(before, after)` (the a→c edge: an ELIGIBLE
 *   approved sale note cancelled at SEFAZ). Neither ⇒ zero reads, no line.
 * - **T1b** — the sale gate. Upload edge: `finalidadeDaNfeProc` on
 *   `after.xml_nfe_proc`; a legible NON-sale note (`outra`) is ONE INFO line
 *   `nfe-nao-e-de-venda` and stops; an ILLEGIBLE one goes on — the task judges
 *   it loudly (`xml-invalido`, aviso and stamp), and a drop here would turn that
 *   into silence. The a→c edge's gate is the edge predicate's own eligibility
 *   (`pedidoNfe.ts`: a legible non-sale cancelled note is no edge at all).
 * - **T2** — ONE raw pedido read. Its `readTime` is the clock of every aviso
 *   this trigger raises (`nfe/avisoNfe.ts`: every producer of the row clocks).
 * - **T3** — `avaliarPedidoParaNfeAmazon`: not proved (`nao-amazon`), the
 *   emission block (`emissao-bloqueada`) and the STORED pre-filter (`nao-dba`)
 *   each end in ONE line at the level `motivosNfe.ts` gives the reason
 *   (`MOTIVOS_NFE_SO_LOG_EM_WARNING`) — never decided here.
 * - **T3c** (the a→c edge only) — a stored CANCELLED SALE (`cancelado` or
 *   `estornadoIntegralmente`, `pedidoNfe.ts`'s `vendaCanceladaAmazon`) ⇒ one
 *   line, nothing else (a cancelled SALE is the incidente path's, the task's
 *   and the importer's); otherwise the aviso `nfe-cancelada` — no stamp, no enqueue, no
 *   Amazon call (the Delivery API has no cancel; step-14 plan §3 decision
 *   17(b)) — and stop.
 * - **T4** (the upload edge) — `enfileirarDoGatilho(tarefaInicialNfeAmazon(…),
 *   eventId)`, no delay: the ONE named enqueue, after the CloudEvent, so an
 *   Eventarc redelivery answers `ja-enfileirada` and enqueues nothing new.
 * - **T5** — ONLY `AmazonNfeTarefasDesligadasError` is caught: a WARNING line
 *   and the aviso `tarefas-desligadas`, clocked by T2's `readTime` (no NF-e
 *   sweep exists: the aviso list IS the re-drive worklist). Anything else — a
 *   transient, a missing region, a Firestore failure — propagates to the
 *   Eventarc retry (`retry: true`).
 *
 * ## Rule 7
 *
 * The happy path writes NO document: the enqueue is a Cloud Tasks call, named
 * (tier 0: `ALREADY_EXISTS` = already durable). The two avisos are the shared
 * seam's (tier 1 inside `escreverAviso`, `ocorrencias` an increment) clocked on
 * the Firestore timeline, so a raise from a read older than a resolve that
 * already landed is dropped.
 *
 * ## Logs
 *
 * `evento: 'nfe'`, through the app's ONE logger: the two document ids, the
 * order id once proved, the edge, the closed reason, the enqueue's verdict —
 * never the XML, the access key, a CNPJ or the pedido's data.
 *
 * ⚠️ D11 BY CONSTRUCTION: this module's import closure — with the function
 * file's and its composition root's — is pinned file by file
 * (`estrutura.test.ts`, type edges walked): no context, conta read,
 * credential, valve, env reader, importer or SP-API value. It never calls
 * Amazon, and cannot.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import type { ResultadoAviso } from '@delfrance/data/admin/avisos';
import { decideNfeUploadTransition, finalidadeDaNfeProc } from '@delfrance/schemas';

import {
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import {
  type AgendadorNfeAmazon,
  AmazonNfeTarefasDesligadasError,
  idDaTarefaDoGatilhoNfeAmazon,
} from './agendadorNfe';
import { avisarNfeAmazon } from './avisoNfe';
import {
  MOTIVOS_NFE_SO_LOG_EM_WARNING,
  MOTIVO_NFE_AMAZON,
  type MotivoNfeAmazon,
} from './motivosNfe';
import {
  avaliarPedidoParaNfeAmazon,
  cancelamentoDeNfeAprovadaAmazon,
  vendaCanceladaAmazon,
} from './pedidoNfe';
import { tarefaInicialNfeAmazon } from './tarefaNfe';

/** Everything one fire needs — injected, so a test drives the ladder with doubles. */
export interface DepsGatilhoNfeAmazon {
  /** Resolved LAZILY: a write that stops at T1 or T1b never builds the handle. */
  readonly db: () => Firestore;
  /** Built only at T4 — the root reads the queue valve at construction. */
  readonly agendador: () => AgendadorNfeAmazon;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter, tier 0. */
  readonly increment: (by: number) => unknown;
  /** Read ONLY on an aviso arm: the row's own `criadoEm`/`atualizadoEm`. */
  readonly agoraMs: () => number;
}

/** One `nfev4` write, as the trigger received it — the RAW snapshot bodies. */
export interface EscritaNfeAmazon {
  /** The CloudEvent id: stable across Eventarc's redeliveries of this write. */
  readonly eventId: string;
  readonly pedidoId: string;
  readonly nfeId: string;
  /** `undefined` on a create. */
  readonly before: Record<string, unknown> | undefined;
  /** `undefined` on a delete. */
  readonly after: Record<string, unknown> | undefined;
}

/** Which edge a write is (T1). */
export type BordaNfeAmazon = 'envio' | 'cancelamento';

/** What one fire did. */
export type ResultadoGatilhoNfeAmazon =
  /** T1: neither edge — zero reads, no line. */
  | { readonly acao: 'fora-da-borda' }
  /** A log-only reason ended it (T1b, T3, T3c's cancelled sale). */
  | { readonly acao: 'descartado'; readonly motivo: MotivoNfeAmazon }
  /** T4: the named enqueue, new or already held. */
  | { readonly acao: 'enfileirada' | 'ja-enfileirada' }
  /** T3c or T5: the aviso raised (or dropped as stale by the shared writer). */
  | {
      readonly acao: 'avisado';
      readonly motivo:
        | typeof MOTIVO_NFE_AMAZON.nfeCancelada
        | typeof MOTIVO_NFE_AMAZON.tarefasDesligadas;
      readonly resultado: ResultadoAviso;
    };

/**
 * The flow name on this trigger's lines — `core/valvulas.ts`'s `FLUXO_AMAZON.nfe`,
 * spelled here because the valves are outside this closure (D11); the suite pins
 * the two equal.
 */
export const FLUXO_DO_GATILHO_NFE_AMAZON = 'nfe';

const ROTULO = '[amazon] onNfeAprovadaAmazon';

/** T1: the upload edge, else the a→c edge, else `null`. Reads nothing. */
export function bordaDaEscritaNfeAmazon(
  before: Record<string, unknown> | undefined,
  after: Record<string, unknown> | undefined,
): BordaNfeAmazon | null {
  if (decideNfeUploadTransition(before, after).action === 'enqueue') return 'envio';
  if (cancelamentoDeNfeAprovadaAmazon(before, after)) return 'cancelamento';
  return null;
}

/** One `evento: 'nfe'` line; `conta` only once the pedido is proved. */
function registrar(
  deps: DepsGatilhoNfeAmazon,
  severidade: SeveridadeAmazon,
  mensagem: string,
  campos: CamposLogAmazon,
  envelope: { readonly conta?: string; readonly idTarefa?: string } = {},
): void {
  registrarEventoAmazon(deps.logger, 'nfe', severidade, `${ROTULO} ${mensagem}`, campos, {
    ...envelope,
    fluxo: FLUXO_DO_GATILHO_NFE_AMAZON,
  });
}

/** The ONE line of a log-only end, at the level `motivosNfe.ts` gives the reason. */
function descartar(
  deps: DepsGatilhoNfeAmazon,
  e: EscritaNfeAmazon,
  borda: BordaNfeAmazon,
  motivo: MotivoNfeAmazon,
  conta?: string,
): ResultadoGatilhoNfeAmazon {
  registrar(
    deps,
    MOTIVOS_NFE_SO_LOG_EM_WARNING.has(motivo) ? 'WARNING' : 'INFO',
    'descartado',
    { acao: 'descartado', borda, motivo, pedidoId: e.pedidoId, nfeId: e.nfeId },
    conta === undefined ? {} : { conta },
  );
  return { acao: 'descartado', motivo };
}

/**
 * T1–T5 for ONE `nfev4` write (module header). Never throws for a write that is
 * not ours; rethrows what Eventarc must retry.
 */
export async function tratarEscritaNfeAmazon(
  deps: DepsGatilhoNfeAmazon,
  e: EscritaNfeAmazon,
): Promise<ResultadoGatilhoNfeAmazon> {
  // ---- T1: the two edges. ZERO reads, and NO line on a skip. ----
  const borda = bordaDaEscritaNfeAmazon(e.before, e.after);
  if (borda === null) return { acao: 'fora-da-borda' };

  // ---- T1b: the sale gate on the upload edge (the a→c edge's is its predicate's). ----
  if (borda === 'envio') {
    // T1's edge implies a string proc; the fallback keeps the gate total.
    const xml = typeof e.after?.xml_nfe_proc === 'string' ? e.after.xml_nfe_proc : '';
    if (finalidadeDaNfeProc(xml) === 'outra') {
      return descartar(deps, e, borda, MOTIVO_NFE_AMAZON.nfeNaoEDeVenda);
    }
  }

  // ---- T2: ONE raw pedido read; its readTime clocks every aviso below. ----
  const db = deps.db();
  const snap = await pedidoCollection.docRef(db, {}, e.pedidoId).get();
  const raw = snap.exists ? ((snap.data() ?? {}) as Record<string, unknown>) : null;
  const relogio = snap.readTime;

  // ---- T3: the ownership proof, the emission block, the stored pre-filter. ----
  const avaliacao = avaliarPedidoParaNfeAmazon(e.pedidoId, raw);
  if (!avaliacao.ok) return descartar(deps, e, borda, avaliacao.motivo);
  const conta = avaliacao.contaId;
  const alvo = { integracaoId: conta, pedidoId: e.pedidoId, numero: avaliacao.orderId };
  const depsDoAviso = () => ({
    increment: deps.increment,
    nowMs: deps.agoraMs(),
    logger: deps.logger,
  });

  // ---- T3c: the a→c edge — tell the operator; nothing can go to Amazon. ----
  if (borda === 'cancelamento') {
    if (vendaCanceladaAmazon(raw)) {
      return descartar(deps, e, borda, MOTIVO_NFE_AMAZON.pedidoCancelado, conta);
    }
    const motivo = MOTIVO_NFE_AMAZON.nfeCancelada;
    const resultado = await avisarNfeAmazon(db, depsDoAviso(), { ...alvo, motivo, relogio });
    registrar(
      deps,
      'WARNING',
      'NF-e aprovada cancelada com o pedido vivo — aviso, nada enviado à Amazon',
      {
        acao: 'avisado',
        borda,
        motivo,
        aviso: resultado,
        pedidoId: e.pedidoId,
        nfeId: e.nfeId,
        pedido: alvo.numero,
      },
      { conta },
    );
    return { acao: 'avisado', motivo, resultado };
  }

  // ---- T4: the ONE named enqueue, after the CloudEvent; no delay. ----
  const tarefa = tarefaInicialNfeAmazon(e.pedidoId, e.nfeId);
  const idTarefa = idDaTarefaDoGatilhoNfeAmazon(e.eventId);
  let enfileiramento: 'enfileirada' | 'ja-enfileirada';
  try {
    enfileiramento = await deps.agendador().enfileirarDoGatilho(tarefa, e.eventId);
  } catch (err) {
    // ---- T5: the queue valve — the NF-e queue's OWN class, and nothing else. ----
    if (!(err instanceof AmazonNfeTarefasDesligadasError)) throw err;
    const motivo = MOTIVO_NFE_AMAZON.tarefasDesligadas;
    const resultado = await avisarNfeAmazon(db, depsDoAviso(), { ...alvo, motivo, relogio });
    registrar(
      deps,
      'WARNING',
      'não enfileirado — AMAZON_TASKS_DISABLED=1; sem varredura de NF-e, o aviso é a lista de reenvio',
      {
        acao: 'avisado',
        borda,
        motivo,
        aviso: resultado,
        pedidoId: e.pedidoId,
        nfeId: e.nfeId,
        pedido: alvo.numero,
      },
      { conta },
    );
    return { acao: 'avisado', motivo, resultado };
  }
  registrar(
    deps,
    'INFO',
    enfileiramento === 'enfileirada' ? 'enfileirado' : 'já enfileirado (evento reentregue)',
    { acao: enfileiramento, borda, pedidoId: e.pedidoId, nfeId: e.nfeId, pedido: alvo.numero },
    { conta, idTarefa },
  );
  return { acao: enfileiramento };
}
