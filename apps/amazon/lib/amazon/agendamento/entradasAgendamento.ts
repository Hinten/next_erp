/**
 * The Easy Ship scheduling's two ENTRIES (step 15, PR 15-c): the only callers
 * of the producer's NAMED enqueue (`enfileirarEntrada`), each building the
 * chain's first payload (`tarefaInicialAgendamentoAmazon`) and naming its task
 * after the ONE observation that produced it (step-15 plan §3 decision 3):
 *
 * - **E1** — {@link enfileirarAgendamentoDoAceiteAmazon}, the NF-e task's
 *   acceptance seam (`nfe/destinoAceite.ts`): origem `aceite-nfe`, named after
 *   the NF-e dispatch's own task id, delayed
 *   {@link ATRASO_AGENDAMENTO_DO_ACEITE_S} (the order-level invoice status may
 *   lag the Delivery API's acceptance).
 * - **E2** — {@link enfileirarAgendamentoDaImportacaoAmazon}, the order
 *   import's post-commit step: origem `importacao`, named after the pedido and
 *   the import read's order clock (`watermarkUs`), no delay. It catches an NF-e
 *   uploaded by hand in Seller Central, which never passes through E1, and an
 *   order-level mirror lag longer than E1's waits.
 *
 * Both are ENQUEUE-ONLY: no Firestore read or write, no Amazon call. The task
 * re-reads the order live and decides there.
 *
 * ## The failure policy (step-15 plan §3 decision 2)
 *
 * - a DETERMINISTIC refusal — the queue valve
 *   (`AmazonAgendamentoTarefasDesligadasError`), a root's `MissingRegionError`,
 *   a malformed region (`AmazonAgendamentoRegiaoDaFilaInvalidaError`), a raw
 *   SDK failure the producer rethrew untouched — is ONE WARNING line
 *   `agendamento-nao-enfileirado` naming the class, never a throw: a retry would
 *   only repeat it, and the checkout print schedules anyway;
 * - a TRANSIENT (`AmazonTarefasTransitoriasError`) is RETHROWN, so the dispatch
 *   that owns the edge retries it: E1 out of the NF-e task's `aceita` (the whole
 *   NF-e dispatch retries; it never resubmits, and its retry enqueues under the
 *   SAME name) — except on the NF-e queue's LAST attempt, where it is the same
 *   WARNING; E2 always, into the import's own retry and failure persistence;
 * - `ja-enfileirada` (that observation's task is already durable: an NF-e queue
 *   retry, a redelivery of the same read) is ONE INFO line;
 * - anything else — a bug, a payload the builders refuse — propagates (root
 *   `CLAUDE.md` rule 6).
 *
 * A successful enqueue writes no line of its own: the task's dispatch line
 * reports it when it runs.
 *
 * ## What never reaches a line
 *
 * Ids (`pedidoId`, the order id, the conta), the origin, a closed motivo and an
 * error CLASS only — never an error message (an SDK message can quote a
 * response body), never a token, a URL or Amazon's text.
 */
import { MissingRegionError } from '@delfrance/core/region';

import {
  AmazonTarefasTransitoriasError,
  descreverFalhaDoSdkDeTarefasAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../core/filaTarefas';
import { type LoggerAmazon, type SeveridadeAmazon, registrarEventoAmazon } from '../core/log';
import { FLUXO_AMAZON } from '../core/valvulas';
import type { AceiteNfeAmazon, DepsDestinoAceiteNfeAmazon } from '../nfe/destinoAceite';
import {
  type AgendadorAgendamentoAmazon,
  AmazonAgendamentoRegiaoDaFilaInvalidaError,
  AmazonAgendamentoTarefasDesligadasError,
  type ObservacaoDaEntradaAgendamentoAmazon,
  type ResultadoEnfileiramentoAgendamentoAmazon,
} from './agendadorAgendamento';
import {
  ATRASO_AGENDAMENTO_DO_ACEITE_S,
  ORIGEM_AGENDAMENTO_AMAZON,
  type TarefaAgendamentoAmazon,
  tarefaInicialAgendamentoAmazon,
} from './tarefaAgendamento';

/** The closed motivos of an entry's own lines. */
export type MotivoEntradaAgendamentoAmazon = 'agendamento-nao-enfileirado' | 'ja-enfileirada';

export const MOTIVO_ENTRADA_AGENDAMENTO_AMAZON = {
  /** A deterministic refusal (or a transient on the observing dispatch's last attempt): nothing enqueued. */
  naoEnfileirado: 'agendamento-nao-enfileirado',
  /** That observation's task is already durable (tier 0). */
  jaEnfileirada: 'ja-enfileirada',
} as const satisfies Record<string, MotivoEntradaAgendamentoAmazon>;

/** What one entry did. */
export type ResultadoEntradaAgendamentoAmazon =
  | ResultadoEnfileiramentoAgendamentoAmazon
  | 'nao-enfileirada';

/**
 * The producer, as an entry needs it: the named enqueue alone. The order
 * import's structural port (`ProdutorAgendamentoAmazon` in
 * `notificacoes/notificacao.ts`) is assigned to it where the importer hands it
 * in (only the arity and the result count there: this target declares a method).
 * The payload and the observation are checked at the functions root's binding,
 * real producer to port (the port's docblock).
 */
export type ProdutorEntradaAgendamentoAmazon = Pick<
  AgendadorAgendamentoAmazon,
  'enfileirarEntrada'
>;

/** One entry's enqueue, with what its lines say. */
interface Entrada {
  readonly tarefa: TarefaAgendamentoAmazon;
  readonly observacao: ObservacaoDaEntradaAgendamentoAmazon;
  readonly atrasoS: number;
  readonly agendamento: () => ProdutorEntradaAgendamentoAmazon;
  readonly logger: LoggerAmazon;
  /** The OBSERVING dispatch: its attempt (when known) and its task id. */
  readonly tentativa?: number | null;
  readonly idTarefa: string | null;
  /** Answer a transient with the WARNING instead of rethrowing it (E1 on the NF-e dispatch's last attempt). */
  readonly conterTransitorio: boolean;
}

/**
 * The CLASS of a refusal the entry answers with a WARNING (module header), or
 * `null` when it must propagate — a transient the observing dispatch retries, or anything
 * unnamed. A class and a code only, never a message.
 */
function classeDaRecusa(err: unknown, conterTransitorio: boolean): string | null {
  if (err instanceof AmazonTarefasTransitoriasError) return conterTransitorio ? err.name : null;
  if (err instanceof AmazonAgendamentoTarefasDesligadasError) return err.name;
  if (err instanceof MissingRegionError) return err.name;
  if (err instanceof AmazonAgendamentoRegiaoDaFilaInvalidaError) return err.name;
  if (ehFalhaDoSdkDeTarefasAmazon(err)) return descreverFalhaDoSdkDeTarefasAmazon(err);
  return null;
}

const MENSAGEM: Readonly<Record<MotivoEntradaAgendamentoAmazon, string>> = {
  [MOTIVO_ENTRADA_AGENDAMENTO_AMAZON.naoEnfileirado]:
    '[amazon/agendamento] a entrada do agendamento da coleta não foi enfileirada',
  [MOTIVO_ENTRADA_AGENDAMENTO_AMAZON.jaEnfileirada]:
    '[amazon/agendamento] a entrada do agendamento da coleta já estava enfileirada',
};

/** One `evento: 'agendamento'` line of an entry (module header): ids, a closed motivo, a class. */
function registrar(
  e: Entrada,
  severidade: SeveridadeAmazon,
  motivo: MotivoEntradaAgendamentoAmazon,
  erro: string | null,
): void {
  registrarEventoAmazon(
    e.logger,
    'agendamento',
    severidade,
    MENSAGEM[motivo],
    {
      origem: e.tarefa.origem,
      motivo,
      erro,
      pedidoId: e.tarefa.pedidoId,
      pedido: e.tarefa.orderId,
    },
    {
      conta: e.tarefa.contaId,
      fluxo: FLUXO_AMAZON.agendamento,
      ...(e.tentativa === undefined ? {} : { tentativa: e.tentativa }),
      idTarefa: e.idTarefa,
    },
  );
}

/** The enqueue and its failure policy (module header). */
async function entrar(e: Entrada): Promise<ResultadoEntradaAgendamentoAmazon> {
  let r: ResultadoEnfileiramentoAgendamentoAmazon;
  try {
    r = await e.agendamento().enfileirarEntrada(e.tarefa, e.observacao, e.atrasoS);
  } catch (err) {
    const classe = classeDaRecusa(err, e.conterTransitorio);
    if (classe === null) throw err;
    registrar(e, 'WARNING', MOTIVO_ENTRADA_AGENDAMENTO_AMAZON.naoEnfileirado, classe);
    return 'nao-enfileirada';
  }
  if (r === 'ja-enfileirada') {
    registrar(e, 'INFO', MOTIVO_ENTRADA_AGENDAMENTO_AMAZON.jaEnfileirada, null);
  }
  return r;
}

/**
 * **E1**: the NF-e task's acceptance seam (`nfe/destinoAceite.ts`). ONE
 * enqueue, origem `aceite-nfe`, named after `deps.idTarefa` (the NF-e
 * dispatch's own task id), after {@link ATRASO_AGENDAMENTO_DO_ACEITE_S}. A
 * transient is rethrown unless `deps.ultimaTentativa` (module header).
 */
export async function enfileirarAgendamentoDoAceiteAmazon(
  aceite: AceiteNfeAmazon,
  deps: DepsDestinoAceiteNfeAmazon,
): Promise<void> {
  await entrar({
    tarefa: tarefaInicialAgendamentoAmazon(
      aceite.pedidoId,
      aceite.contaId,
      aceite.orderId,
      ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe,
    ),
    observacao: { origem: ORIGEM_AGENDAMENTO_AMAZON.aceiteNfe, idTarefaNfe: deps.idTarefa },
    atrasoS: ATRASO_AGENDAMENTO_DO_ACEITE_S,
    agendamento: deps.agendamento,
    logger: deps.logger,
    idTarefa: deps.idTarefa,
    conterTransitorio: deps.ultimaTentativa,
  });
}

/** The import read E2 is named after. */
export interface ImportacaoAgendamentoAmazon {
  readonly contaId: string;
  readonly pedidoId: string;
  /** Amazon's order id (3-7-7). */
  readonly orderId: string;
  /** The import read's order clock, µs (`lastUpdatedTime`). */
  readonly watermarkUs: number;
}

/** What E2 needs from the import. */
export interface DepsImportacaoAgendamentoAmazon {
  readonly agendamento: () => ProdutorEntradaAgendamentoAmazon;
  readonly logger: LoggerAmazon;
  /** The import's queue attempt (`null` in a sweep re-drive) and task id. */
  readonly registro: { readonly tentativa: number | null; readonly idTarefa: string | null };
}

/**
 * **E2**: the order import's post-commit enqueue. ONE enqueue, origem
 * `importacao`, named after `(pedidoId, watermarkUs)`, no delay. A transient is
 * ALWAYS rethrown, into the import's own retry (module header).
 */
export async function enfileirarAgendamentoDaImportacaoAmazon(
  importacao: ImportacaoAgendamentoAmazon,
  deps: DepsImportacaoAgendamentoAmazon,
): Promise<ResultadoEntradaAgendamentoAmazon> {
  return await entrar({
    tarefa: tarefaInicialAgendamentoAmazon(
      importacao.pedidoId,
      importacao.contaId,
      importacao.orderId,
      ORIGEM_AGENDAMENTO_AMAZON.importacao,
    ),
    observacao: {
      origem: ORIGEM_AGENDAMENTO_AMAZON.importacao,
      pedidoId: importacao.pedidoId,
      watermarkUs: importacao.watermarkUs,
    },
    atrasoS: 0,
    agendamento: deps.agendamento,
    logger: deps.logger,
    tentativa: deps.registro.tentativa,
    idTarefa: deps.registro.idTarefa,
    conterTransitorio: false,
  });
}
