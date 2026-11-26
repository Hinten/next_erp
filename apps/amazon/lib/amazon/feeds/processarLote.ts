/**
 * The jobs queue's DISPATCHER (step 12a, PR 12-c): the body of
 * `processAmazonListingsJob` (`functions/src/filaLotes.ts`). ONE queue carries
 * the feed core's four tasks, the stock reconcile's page, the price task and a
 * price run's page, told apart by `tipo`:
 *
 *  - `feed-enviar` → `./enviarFeed` (build and submit one feed);
 *  - `feed-resultado` → `./resultadoFeed` (a poll rung, a wake-up, an adoption);
 *  - `feed-incerto` → `./incertoFeed` (the wait after a lost `createFeed` answer);
 *  - `feed-recuperar` → `./recuperarFeed` (what an end leaves to recover);
 *  - `reconciliacao` (step 12, PR 12-f) → the BOUND page handler
 *    (`deps.paginaReconciliacao`): the jobs root binds the stock reconcile's
 *    page, so this module imports no fluxo's own module (the seam table stays
 *    the only binding between the feed core and a fluxo);
 *  - `preco-sku` (step 13, PR 13-d) → the BOUND price task
 *    (`deps.tarefaPrecoSku`), bound by the jobs root the same way. A
 *    dispatcher built WITHOUT it refuses a price task with ONE ERROR line
 *    (`sem-processador`) and no throw, nothing read: the same deploy would
 *    refuse the same task on every retry;
 *  - `preco-pagina` (step 13, PR 13-e) → the BOUND page of a price run
 *    (`deps.paginaPreco`), bound and refused when unbound exactly as the price
 *    task.
 *
 * **P0** — the payload goes through the queue's whole strict union,
 * {@link tarefaFilaLotesAmazonSchema}: the feed core's tasks and the reconcile
 * page (`./tarefaLote`) plus the price task and the price page
 * (`preco/tarefaPreco.ts`, a pure contract), joined HERE because the price payload takes the queue's version
 * from `./tarefaLote`, which therefore cannot import it back without a cycle.
 * An unknown `tipo`, or a known one whose fields fail their grammar, is ONE ERROR line and NO throw — the same bytes would fail the same
 * way on every retry, and the line names the `tipo` (when it is one it knows)
 * and the top-level FIELDS Zod blamed, never a value.
 *
 * The provider comes from the BOUND seam (`deps.provedores`: the jobs root
 * binds `./destinosLote`'s factories ONCE per process, and hands the same
 * bound rows to every dispatch): by the payload's fluxo for a send, an
 * uncertain wait and a recovery; by the RECORD's for a result (its payload names
 * no fluxo). A `null` row is each handler's to answer: a send ends
 * `sem-provedor` having taken nothing, a result still advances its record and
 * skips the write-back, an uncertain wait still recovers and releases, a
 * recovery logs and ends.
 *
 * Every handler writes its OWN one dispatch line; this module writes only P0's.
 * A throw is each handler's, for the queue's retry, already sanitized.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';

import { type LoggerAmazon, registrarEventoAmazon } from '../core/log';
import type { FluxoComLoteAmazon } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import type { AgendadorLotesAmazon } from './agendadorLotes';
import type { ProvedoresLoteAmazon } from './destinosLote';
import { type ResultadoEnvioFeedAmazon, enviarFeedAmazon } from './enviarFeed';
import {
  type RegistroLoteAmazon,
  type ResultadoIncertoFeedAmazon,
  processarIncertoFeedAmazon,
} from './incertoFeed';
import {
  type ResultadoRecuperacaoFeedAmazon,
  processarRecuperacaoFeedAmazon,
} from './recuperarFeed';
import { type ResultadoConsultaFeedAmazon, processarResultadoFeedAmazon } from './resultadoFeed';
import {
  TIPO_TAREFA_PRECO_AMAZON,
  tarefaPaginaPrecoAmazonSchema,
  tarefaPrecoSkuAmazonSchema,
} from '../preco/tarefaPreco';
import {
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaPaginaReconciliacaoAmazon,
  tarefaLoteAmazonSchema,
  tipoTarefaLoteAmazonSchema,
} from './tarefaLote';

/** Every tipo the jobs queue carries (module header, P0): the feed core's, the reconcile page, the price task and page. */
export const tipoTarefaFilaLotesAmazonSchema = z.enum([
  ...tipoTarefaLoteAmazonSchema.options,
  TIPO_TAREFA_PRECO_AMAZON.sku,
  TIPO_TAREFA_PRECO_AMAZON.pagina,
]);
export type TipoTarefaFilaLotesAmazon = z.infer<typeof tipoTarefaFilaLotesAmazonSchema>;

/** Named members of {@link tipoTarefaFilaLotesAmazonSchema} — see `delfrance/prefer-schema-enum`. */
export const TIPO_TAREFA_FILA_LOTES_AMAZON = {
  ...TIPO_TAREFA_LOTE_AMAZON,
  precoSku: TIPO_TAREFA_PRECO_AMAZON.sku,
  precoPagina: TIPO_TAREFA_PRECO_AMAZON.pagina,
} as const satisfies Record<string, TipoTarefaFilaLotesAmazon>;

/** Every payload the jobs queue carries (module header, P0). */
export const tarefaFilaLotesAmazonSchema = z.discriminatedUnion('tipo', [
  ...tarefaLoteAmazonSchema.options,
  tarefaPrecoSkuAmazonSchema,
  tarefaPaginaPrecoAmazonSchema,
]);
export type TarefaFilaLotesAmazon = z.infer<typeof tarefaFilaLotesAmazonSchema>;

/** What the bound reconcile page answers: its closed outcome, which its own line names. */
export interface ResultadoPaginaReconciliacaoLoteAmazon {
  readonly acao: string;
}

/**
 * The stock reconcile's page, as the jobs root BINDS it: this dispatch's deps
 * are handed through, and the root adds what only the page needs.
 */
export type ProcessadorPaginaReconciliacaoAmazon = (
  db: Firestore,
  tarefa: TarefaPaginaReconciliacaoAmazon,
  deps: DepsProcessarLoteAmazon,
) => Promise<ResultadoPaginaReconciliacaoLoteAmazon>;

/** What the bound price task answers: its closed outcome, which its own line names. */
export interface ResultadoTarefaPrecoSkuLoteAmazon {
  readonly acao: string;
}

/** The price task's payload, as the queue's union parsed it. */
export type TarefaPrecoSkuLoteAmazon = Extract<
  TarefaFilaLotesAmazon,
  { readonly tipo: typeof TIPO_TAREFA_FILA_LOTES_AMAZON.precoSku }
>;

/**
 * The price task, as the jobs root BINDS it: this dispatch's deps are handed
 * through, and the root adds what only the task needs.
 */
export type ProcessadorTarefaPrecoSkuAmazon = (
  db: Firestore,
  tarefa: TarefaPrecoSkuLoteAmazon,
  deps: DepsProcessarLoteAmazon,
) => Promise<ResultadoTarefaPrecoSkuLoteAmazon>;

/** What the bound price page answers: its closed outcome, which its own line names. */
export interface ResultadoPaginaPrecoLoteAmazon {
  readonly acao: string;
}

/** A price run's page payload, as the queue's union parsed it. */
export type TarefaPaginaPrecoLoteAmazon = Extract<
  TarefaFilaLotesAmazon,
  { readonly tipo: typeof TIPO_TAREFA_FILA_LOTES_AMAZON.precoPagina }
>;

/**
 * A price run's page, as the jobs root BINDS it: this dispatch's deps are
 * handed through, and the root adds what only the page needs.
 */
export type ProcessadorPaginaPrecoAmazon = (
  db: Firestore,
  tarefa: TarefaPaginaPrecoLoteAmazon,
  deps: DepsProcessarLoteAmazon,
) => Promise<ResultadoPaginaPrecoLoteAmazon>;

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
  /** The seam BOUND by the jobs root (`./destinosLote`'s `vincularDestinosLoteAmazon`). */
  readonly provedores: ProvedoresLoteAmazon;
  readonly registro: RegistroLoteAmazon;
  /** REQUIRED, never defaulted: the context, the write client and both transfers take it. */
  readonly fetch: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
  /** The stock reconcile's page, bound by the jobs root (module header). */
  readonly paginaReconciliacao: ProcessadorPaginaReconciliacaoAmazon;
  /** The price task, bound by the jobs root; absent ⇒ `sem-processador` (module header). */
  readonly tarefaPrecoSku?: ProcessadorTarefaPrecoSkuAmazon;
  /** A price run's page, bound by the jobs root; absent ⇒ `sem-processador` (module header). */
  readonly paginaPreco?: ProcessadorPaginaPrecoAmazon;
}

/** P0's refusals (closed). */
export const RECUSA_DO_LOTE = {
  /** No `tipo` this queue knows. */
  tipoDesconhecido: 'tipo-desconhecido',
  /** A known `tipo` whose fields fail their grammar. */
  payloadInvalido: 'payload-invalido',
  /** A valid price task or page, and no handler bound for it (module header). */
  semProcessador: 'sem-processador',
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
    }
  | {
      readonly tipo: typeof TIPO_TAREFA_LOTE_AMAZON.reconciliacao;
      readonly r: ResultadoPaginaReconciliacaoLoteAmazon;
    }
  | {
      readonly tipo: typeof TIPO_TAREFA_FILA_LOTES_AMAZON.precoSku;
      readonly r: ResultadoTarefaPrecoSkuLoteAmazon;
    }
  | {
      readonly tipo: typeof TIPO_TAREFA_FILA_LOTES_AMAZON.precoPagina;
      readonly r: ResultadoPaginaPrecoLoteAmazon;
    };

/** The `tipo` a refused payload claims, when it is one this queue knows. */
function tipoDeclarado(dados: unknown): TipoTarefaFilaLotesAmazon | null {
  const tipo = (dados as { readonly tipo?: unknown } | null)?.tipo;
  const lido = tipoTarefaFilaLotesAmazonSchema.safeParse(tipo);
  return lido.success ? lido.data : null;
}

/** P0's ONE ERROR line (module header): the `tipo` and the FIELDS, never a value. */
function registrarRecusa(
  deps: DepsProcessarLoteAmazon,
  recusa: RecusaDoLoteAmazon,
  tipo: TipoTarefaFilaLotesAmazon | null,
  campos: readonly string[],
): { readonly tipo: null; readonly recusa: RecusaDoLoteAmazon } {
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
  const lido = tarefaFilaLotesAmazonSchema.safeParse(dados);
  if (!lido.success) {
    const tipo = tipoDeclarado(dados);
    const recusa = tipo === null ? RECUSA_DO_LOTE.tipoDesconhecido : RECUSA_DO_LOTE.payloadInvalido;
    const campos = [...new Set(lido.error.issues.map((i) => String(i.path[0] ?? '(raiz)')))].sort();
    return registrarRecusa(deps, recusa, tipo, campos);
  }

  const t = lido.data;
  const provedorDe = (fluxo: FluxoComLoteAmazon) => deps.provedores[fluxo];
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
        r: await enviarFeedAmazon(db, t, { ...base, provedor: provedorDe(t.fluxo) }),
      };
    case TIPO_TAREFA_LOTE_AMAZON.resultado:
      return {
        tipo: t.tipo,
        r: await processarResultadoFeedAmazon(db, t, { ...base, provedorDe }),
      };
    case TIPO_TAREFA_LOTE_AMAZON.incerto:
      return {
        tipo: t.tipo,
        r: await processarIncertoFeedAmazon(db, t, { ...base, provedor: provedorDe(t.fluxo) }),
      };
    case TIPO_TAREFA_LOTE_AMAZON.recuperar:
      return {
        tipo: t.tipo,
        r: await processarRecuperacaoFeedAmazon(db, t, {
          ...base,
          provedor: provedorDe(t.fluxo),
        }),
      };
    case TIPO_TAREFA_LOTE_AMAZON.reconciliacao:
      return { tipo: t.tipo, r: await deps.paginaReconciliacao(db, t, deps) };
    case TIPO_TAREFA_FILA_LOTES_AMAZON.precoSku: {
      const tarefaPreco = deps.tarefaPrecoSku;
      if (tarefaPreco === undefined) {
        return registrarRecusa(deps, RECUSA_DO_LOTE.semProcessador, t.tipo, []);
      }
      return { tipo: t.tipo, r: await tarefaPreco(db, t, deps) };
    }
    case TIPO_TAREFA_FILA_LOTES_AMAZON.precoPagina: {
      const paginaPreco = deps.paginaPreco;
      if (paginaPreco === undefined) {
        return registrarRecusa(deps, RECUSA_DO_LOTE.semProcessador, t.tipo, []);
      }
      return { tipo: t.tipo, r: await paginaPreco(db, t, deps) };
    }
  }
}
