/**
 * The feed RECOVERY handler (step 12a, PR 12-c), `tipo: 'feed-recuperar'`:
 * what a feed's end — or a lease release that found turned-away batches
 * pending (`vez`) — leaves for its fluxo to do, in its OWN dispatch and its own
 * budget. Every producer names its task (`./tarefaLote`): a feed's tail by
 * (conta, `feedId`, the start it folded), the uncertain path by the send run's
 * `execucaoId`, a `vez` recovery by its releaser; so a retried producer
 * dedupes on the queue.
 *
 * The handler itself decides nothing about the outcome: the PROVIDER does
 * (`ProvedorLoteAmazon.recuperar`) — stock re-sends what moved after the
 * snapshot and, for an end that may not have applied, the failed batch's own
 * members; price raises an aviso. In order:
 *
 *  1. the provider (`null` seam row ⇒ one line and the end, nothing read);
 *  2. the context (the read switch first): a switch, conta or credential
 *     refusal is ONE WARNING line and the end;
 *  3. `recuperar(ctx, { desfecho, snapshotEmMs, pendenteDesdeMs, referencia,
 *     janela })`, `referencia` derived by `referenciaDaRecuperacaoFeed` — the
 *     same value the task's name and a recovery-born batch's `execucaoId` are
 *     minted from;
 *  4. ONE dispatch line with its answer.
 *
 * A failure is rethrown, sanitized: the queue retries the recovery (five
 * attempts); exhausted, the next daily reconcile is the backstop. The feed's
 * lease was already released by whoever enqueued this task.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { type FluxoFeedAmazon, ID_LOTE_FEED_AMAZON_REGEX } from '@delfrance/schemas';

import { type ContextoAmazon, type ContextoAmazonDeps, loadAmazonContext } from '../core/contexto';
import { EVENTO_DO_LOTE_AMAZON } from '../core/escrita';
import {
  type CamposLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import type { FluxoComLoteAmazon } from '../core/valvulas';
import type { AmbienteAmazon } from '../env';
import { sanitizarFalhaDaTarefaAmazon } from '../notificacoes/notificacao';
import {
  FALHA_LEITURA_AMAZON,
  type FalhaLeituraAmazon,
  classificarFalhaDeLeituraAmazon,
} from '../pedidos/falhaLeituraAmazon';
import type { RegistroLoteAmazon } from './incertoFeed';
import type { DesfechoRecuperacaoLoteAmazon, ProvedorLoteAmazon } from './provedorLote';
import {
  type DesfechoRecuperacaoFeedAmazon,
  type TarefaRecuperarFeedAmazon,
  referenciaDaRecuperacaoFeed,
} from './tarefaLote';

/** Everything one recovery dispatch needs — bound by the jobs root, doubles in the tests. */
export interface DepsRecuperarFeedAmazon {
  /** The process environment: the read switch and the LWA pair. */
  readonly ambiente: AmbienteAmazon;
  /** Now, in MILLISECONDS. Read per decision, never captured. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** The fluxo's provider, read from the seam per run; `null` while the row is empty. */
  readonly provedor: ProvedorLoteAmazon<FluxoComLoteAmazon, unknown> | null;
  readonly registro: RegistroLoteAmazon;
  /** REQUIRED, never the global: the context's client takes the SAME `fetch`. */
  readonly fetch: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** What one recovery dispatch did (closed). */
export const ACAO_RECUPERACAO_FEED = {
  /** The seam row is empty: nothing read, nothing recovered. */
  semProvedor: 'sem-provedor',
  /** The switch, the conta or its credential refused. */
  contextoRecusado: 'contexto-recusado',
  /** The provider answered. */
  recuperado: 'recuperado',
} as const;
export type AcaoRecuperacaoFeedAmazon =
  (typeof ACAO_RECUPERACAO_FEED)[keyof typeof ACAO_RECUPERACAO_FEED];

/** The provider's answer, as a closed token. */
export type RespostaRecuperacaoFeed = 'tarefas' | 'feed' | 'reconciliacao' | 'nada';

/** The dispatch's result, logged ONCE ({@link registrarDespachoRecuperacaoFeedAmazon}). */
export interface ResultadoRecuperacaoFeedAmazon {
  readonly fluxo: FluxoFeedAmazon;
  readonly contaId: string;
  readonly desfecho: DesfechoRecuperacaoFeedAmazon;
  readonly acao: AcaoRecuperacaoFeedAmazon;
  readonly motivo: FalhaLeituraAmazon | null;
  /** The reference the provider received (a `feedId`, a run id, or a `vez:` one). */
  readonly referencia: string;
  readonly resposta: RespostaRecuperacaoFeed | null;
  /** The per-SKU tasks the provider enqueued (`tarefas`). */
  readonly tarefas: number | null;
  /** The send the provider handed the recovery to (`feed`), as it named it. */
  readonly envio: string | null;
}

/** The provider's answer, reduced to the line's two fields. */
function lerResposta(
  r: DesfechoRecuperacaoLoteAmazon,
): Pick<ResultadoRecuperacaoFeedAmazon, 'resposta' | 'tarefas' | 'envio'> {
  if ('tarefas' in r) return { resposta: 'tarefas', tarefas: r.tarefas, envio: null };
  if ('feed' in r) {
    // An id under the core's grammar, or nothing: a line never carries free text.
    const envio = ID_LOTE_FEED_AMAZON_REGEX.test(r.feed) ? r.feed : '<invalido>';
    return { resposta: 'feed', tarefas: null, envio };
  }
  if ('repassado' in r) return { resposta: 'reconciliacao', tarefas: null, envio: null };
  return { resposta: 'nada', tarefas: null, envio: null };
}

/** WARNING when nothing could be recovered for a reason a person may fix. */
function severidade(r: ResultadoRecuperacaoFeedAmazon): SeveridadeAmazon {
  return r.acao === ACAO_RECUPERACAO_FEED.contextoRecusado ? 'WARNING' : 'INFO';
}

/** The ONE `feed-recuperar` line: ids, closed tokens, ms stamps and counts only. */
export function registrarDespachoRecuperacaoFeedAmazon(
  logger: LoggerAmazon,
  t: Pick<TarefaRecuperarFeedAmazon, 'feedId' | 'execucaoId' | 'snapshotEmMs' | 'pendenteDesdeMs'>,
  r: ResultadoRecuperacaoFeedAmazon,
  registro: RegistroLoteAmazon,
): void {
  const campos: CamposLogAmazon = {
    fase: 'recuperacao',
    acao: r.acao,
    motivo: r.motivo,
    desfecho: r.desfecho,
    feedId: t.feedId,
    execucaoId: t.execucaoId,
    referencia: r.referencia,
    snapshotEmMs: t.snapshotEmMs,
    pendenteDesdeMs: t.pendenteDesdeMs,
    resposta: r.resposta,
    tarefas: r.tarefas,
    envio: r.envio,
  };
  registrarEventoAmazon(
    logger,
    EVENTO_DO_LOTE_AMAZON[r.fluxo],
    severidade(r),
    `[amazon] feed ${r.fluxo}: recuperação (${r.acao})`,
    campos,
    {
      conta: r.contaId,
      fluxo: r.fluxo,
      tentativa: registro.tentativa,
      idTarefa: registro.idTarefa,
    },
  );
}

/**
 * ONE recovery dispatch (module header). Returns the result it logged; throws
 * only what the queue must retry, sanitized.
 */
export async function processarRecuperacaoFeedAmazon(
  db: Firestore,
  t: TarefaRecuperarFeedAmazon,
  deps: DepsRecuperarFeedAmazon,
): Promise<ResultadoRecuperacaoFeedAmazon> {
  let r: ResultadoRecuperacaoFeedAmazon;
  try {
    r = await executarRecuperacao(db, t, deps);
  } catch (err) {
    // The ONE boundary: a package error leaves as its class and status only.
    throw sanitizarFalhaDaTarefaAmazon(err);
  }
  registrarDespachoRecuperacaoFeedAmazon(deps.logger, t, r, deps.registro);
  return r;
}

async function executarRecuperacao(
  db: Firestore,
  t: TarefaRecuperarFeedAmazon,
  deps: DepsRecuperarFeedAmazon,
): Promise<ResultadoRecuperacaoFeedAmazon> {
  const referencia = referenciaDaRecuperacaoFeed(t);
  const base = {
    fluxo: t.fluxo,
    contaId: t.contaId,
    desfecho: t.desfecho,
    referencia,
    motivo: null,
    resposta: null,
    tarefas: null,
    envio: null,
  } as const;

  // 1. The provider: an empty seam row recovers nothing, and reads nothing.
  const provedor = deps.provedor;
  if (provedor === null) return { ...base, acao: ACAO_RECUPERACAO_FEED.semProvedor };
  if (provedor.fluxo !== t.fluxo) {
    throw new TypeError('recuperarFeed.ts: o provedor e a tarefa nomeiam fluxos diferentes');
  }

  // 2. The context — the read switch first.
  const depsDoContexto: ContextoAmazonDeps = {
    ambiente: deps.ambiente,
    agora: deps.agora,
    logger: deps.logger,
    registro: {
      fluxo: t.fluxo,
      tentativa: deps.registro.tentativa,
      idTarefa: deps.registro.idTarefa,
    },
    fetch: deps.fetch,
    gerarCorrelationId: deps.gerarCorrelationId,
  };
  let contexto: ContextoAmazon;
  try {
    contexto = await loadAmazonContext(db, t.contaId, depsDoContexto);
  } catch (err) {
    const token = classificarFalhaDeLeituraAmazon(err);
    if (
      token !== FALHA_LEITURA_AMAZON.chamadasDesligadas &&
      token !== FALHA_LEITURA_AMAZON.contaInativa &&
      token !== FALHA_LEITURA_AMAZON.contaIndisponivel
    ) {
      throw err;
    }
    return { ...base, acao: ACAO_RECUPERACAO_FEED.contextoRecusado, motivo: token };
  }
  const sellerId = contexto.conta.selling_partner_id;
  if (typeof sellerId !== 'string' || sellerId === '') {
    // The context loader refuses a conta with no seller: only a bug reaches this.
    throw new TypeError('recuperarFeed.ts: o contexto não nomeia o vendedor');
  }

  // 3. The provider's recovery.
  const resposta = await provedor.recuperar(
    {
      contexto,
      db,
      logger: deps.logger,
      agora: deps.agora,
      sellerId,
      relogioVez: null,
    },
    {
      desfecho: t.desfecho,
      snapshotEmMs: t.snapshotEmMs,
      pendenteDesdeMs: t.pendenteDesdeMs,
      referencia,
      janela: t.janela,
    },
  );
  return { ...base, acao: ACAO_RECUPERACAO_FEED.recuperado, ...lerResposta(resposta) };
}
