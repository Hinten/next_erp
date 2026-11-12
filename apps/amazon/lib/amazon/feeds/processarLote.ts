/**
 * The jobs queue's DISPATCHER (step 12a, PR 12-c): the body of
 * `processAmazonListingsJob` (`functions/src/filaLotes.ts`). ONE queue carries
 * the feed core's four tasks, told apart by `tipo`:
 *
 *  - `feed-enviar` → `./enviarFeed` (build and submit one feed);
 *  - `feed-resultado` → `./resultadoFeed` (a poll rung, a wake-up, an adoption);
 *  - `feed-incerto` → `./incertoFeed` (the wait after a lost `createFeed` answer);
 *  - `feed-recuperar` → `./recuperarFeed` (what an end leaves to recover).
 *
 * **P0** — the payload goes through the strict union `tarefaLoteAmazonSchema`
 * (`./tarefaLote`): an unknown `tipo`, or a known one whose fields fail their
 * grammar, is ONE ERROR line and NO throw — the same bytes would fail the same
 * way on every retry, and the line names the `tipo` (when it is one of the four)
 * and the top-level FIELDS Zod blamed, never a value.
 *
 * The provider is read from the seam PER RUN (`deps.provedorDe`, the jobs root
 * binds `./destinosLote`): by the payload's fluxo for a send, an uncertain wait
 * and a recovery; by the RECORD's for a result (its payload names no fluxo). A
 * `null` row is each handler's to answer: a send ends `sem-provedor` having
 * taken nothing, a result still advances its record and skips the write-back,
 * an uncertain wait still recovers and releases, a recovery logs and ends.
 *
 * Every handler writes its OWN one dispatch line; this module writes only P0's.
 * A throw is each handler's, for the queue's retry, already sanitized.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { type LoggerAmazon, registrarEventoAmazon } from '../core/log';
import type { FluxoComLoteAmazon } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import type { AgendadorLotesAmazon } from './agendadorLotes';
import { type ResultadoEnvioFeedAmazon, enviarFeedAmazon } from './enviarFeed';
import {
  type RegistroLoteAmazon,
  type ResultadoIncertoFeedAmazon,
  processarIncertoFeedAmazon,
} from './incertoFeed';
import type { ProvedorLoteAmazon } from './provedorLote';
import {
  type ResultadoRecuperacaoFeedAmazon,
  processarRecuperacaoFeedAmazon,
} from './recuperarFeed';
import { type ResultadoConsultaFeedAmazon, processarResultadoFeedAmazon } from './resultadoFeed';
import {
  TIPO_TAREFA_LOTE_AMAZON,
  type TipoTarefaLoteAmazon,
  tarefaLoteAmazonSchema,
  tipoTarefaLoteAmazonSchema,
} from './tarefaLote';

/** Everything one jobs-queue dispatch needs — bound by the jobs root, doubles in the tests. */
export interface DepsProcessarLoteAmazon {
  /** The process environment: the read switch, the LWA pair, the valves and canaries. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS. Read per decision, never captured. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** The jobs queue's producer — built only when an enqueue is due. */
  readonly agendador: () => AgendadorLotesAmazon;
  /** The seam, read per run (`./destinosLote`'s `provedorDoLoteAmazon`). */
  readonly provedorDe: (
    fluxo: FluxoComLoteAmazon,
  ) => ProvedorLoteAmazon<FluxoComLoteAmazon, unknown> | null;
  readonly registro: RegistroLoteAmazon;
  /** REQUIRED, never defaulted: the context, the write client and both transfers take it. */
  readonly fetch: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** P0's refusals (closed). */
export const RECUSA_DO_LOTE = {
  /** No `tipo` this queue knows. */
  tipoDesconhecido: 'tipo-desconhecido',
  /** A known `tipo` whose fields fail their grammar. */
  payloadInvalido: 'payload-invalido',
} as const;
export type RecusaDoLoteAmazon = (typeof RECUSA_DO_LOTE)[keyof typeof RECUSA_DO_LOTE];

/** What one dispatch came to: P0's refusal, or the handler's own result. */
export type DespachoLoteAmazon =
  | { readonly tipo: null; readonly recusa: RecusaDoLoteAmazon }
  | { readonly tipo: typeof TIPO_TAREFA_LOTE_AMAZON.enviar; readonly r: ResultadoEnvioFeedAmazon }
  | {
      readonly tipo: typeof TIPO_TAREFA_LOTE_AMAZON.resultado;
      readonly r: ResultadoConsultaFeedAmazon;
    }
  | {
      readonly tipo: typeof TIPO_TAREFA_LOTE_AMAZON.incerto;
      readonly r: ResultadoIncertoFeedAmazon;
    }
  | {
      readonly tipo: typeof TIPO_TAREFA_LOTE_AMAZON.recuperar;
      readonly r: ResultadoRecuperacaoFeedAmazon;
    };

/** The `tipo` a refused payload claims, when it is one of the four. */
function tipoDeclarado(dados: unknown): TipoTarefaLoteAmazon | null {
  const tipo = (dados as { readonly tipo?: unknown } | null)?.tipo;
  const lido = tipoTarefaLoteAmazonSchema.safeParse(tipo);
  return lido.success ? lido.data : null;
}

/**
 * ONE jobs-queue dispatch (module header): P0, then the handler of its `tipo`.
 * Returns what it came to; throws only what a handler rethrew for the retry.
 */
export async function processarLoteAmazon(
  db: Firestore,
  dados: unknown,
  deps: DepsProcessarLoteAmazon,
): Promise<DespachoLoteAmazon> {
  // ---- P0: the payload. ----
  const lido = tarefaLoteAmazonSchema.safeParse(dados);
  if (!lido.success) {
    const tipo = tipoDeclarado(dados);
    const recusa = tipo === null ? RECUSA_DO_LOTE.tipoDesconhecido : RECUSA_DO_LOTE.payloadInvalido;
    const campos = [...new Set(lido.error.issues.map((i) => String(i.path[0] ?? '(raiz)')))].sort();
    registrarEventoAmazon(
      deps.logger,
      'feed',
      'ERROR',
      `[amazon] fila de lotes: payload recusado (${recusa})`,
      { fase: 'despacho', recusa, tipo, campos: campos.join(',') },
      { tentativa: deps.registro.tentativa, idTarefa: deps.registro.idTarefa },
    );
    return { tipo: null, recusa };
  }

  const t = lido.data;
  const base = {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    increment: deps.increment,
    agendador: deps.agendador,
    registro: deps.registro,
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  switch (t.tipo) {
    case TIPO_TAREFA_LOTE_AMAZON.enviar:
      return {
        tipo: t.tipo,
        r: await enviarFeedAmazon(db, t, { ...base, provedor: deps.provedorDe(t.fluxo) }),
      };
    case TIPO_TAREFA_LOTE_AMAZON.resultado:
      return {
        tipo: t.tipo,
        r: await processarResultadoFeedAmazon(db, t, { ...base, provedorDe: deps.provedorDe }),
      };
    case TIPO_TAREFA_LOTE_AMAZON.incerto:
      return {
        tipo: t.tipo,
        r: await processarIncertoFeedAmazon(db, t, { ...base, provedor: deps.provedorDe(t.fluxo) }),
      };
    case TIPO_TAREFA_LOTE_AMAZON.recuperar:
      return {
        tipo: t.tipo,
        r: await processarRecuperacaoFeedAmazon(db, t, {
          ...base,
          provedor: deps.provedorDe(t.fluxo),
        }),
      };
  }
}
