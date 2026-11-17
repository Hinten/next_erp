/**
 * The RECOVERY DELTA of the Amazon stock sync (step 12, PR 12-e2): what a stock
 * feed's end — or a lease release that found turned-away window batches
 * pending — leaves to re-send, found by the SAME window discovery the
 * five-minute tick reads with (`descobertaFirestore.ts`). Nothing here reaches
 * Amazon: it reads the window and enqueues named patch tasks, and the patch
 * task computes every quantity when it runs.
 *
 * Exported for the stock feed provider's recovery (PR 12-f), its one caller;
 * nothing calls it yet.
 *
 * ## One recovery ({@link enviarDeltaEstoqueAmazon})
 *
 *  1. The window, `janelaDaRecuperacao` over the recovered feed's snapshot `S`
 *     and the lease's pending start `p`: `(min(S − 5 min, p), agora]`, keeping
 *     every row COMMITTED after `S − 20 s` (forced: the feed may have read its
 *     old value) and every row STAMPED after `p` (never sent; not forced). A
 *     `RangeError` from the planner — a snapshot or a start too far ahead of
 *     the clock to be a ms instant — is caught BY CLASS, around that one call
 *     only: ONE WARNING line naming the class, `janela-invalida`, nothing read.
 *     No window (neither instant, or an empty range) ⇒ `nada`, nothing read.
 *  2. `descobrirJanelaEstoqueAmazon` at the depósito the caller names, under
 *     the caller's deadline: the conta's SKUs, each with its observation and
 *     whether it is forced. A truncated window (the page budget) or the
 *     deadline reached ⇒ a reconcile.
 *  3. `destinoDoLoteDelta` over the n distinct SKUs: none ⇒ `nada`; 1–30 ⇒ ONE
 *     NAMED patch task per SKU, at most 16 in flight, the deadline asked before
 *     STARTING each — a FORCED SKU as `origem: 'catch-up'`, its reference the
 *     recovered feed's (it must run even when the tick already sent that
 *     observation), any other as `origem: 'delta'`, its reference its
 *     observation (a movement the tick already enqueued is the same name, and
 *     dedupes); 31–3,000 ⇒ a delta feed of the window; more ⇒ a reconcile. The
 *     deadline reached before the last task started ⇒ a reconcile. A SKU the
 *     task payload cannot carry (more than 40 code points, which no write path
 *     can send) is counted and dropped.
 *
 * Re-running a recovery over the same rows mints the same names: every task
 * it enqueued already is `ja-enfileirada`, never a second task.
 *
 * ## The hand-offs are not durable yet
 *
 * Neither consumer exists in this PR: the delta feed and the reconcile are
 * WARNING placeholders on the recovery's line (`feed-necessario`,
 * `reconciliacao-necessaria`), and the answer carries what a caller needs to
 * make either durable — the window read, and why. The window's bounds and its
 * keep rule are all a delta feed carries: never its SKUs.
 *
 * ## Failures
 *
 * Only the window planner's `RangeError` is contained. A Firestore error, a
 * rejection of the stock producer (the queue valve, a named transient, a
 * region, a raw Cloud Tasks failure) and a bug PROPAGATE: a recovery runs as a
 * queued task, whose retry re-runs it, and every name it mints is per
 * observation or per feed, so a retry enqueues only what is missing. A context
 * outside its grammar (the conta id, the depósito id, the deadline, the
 * reference a forcing recovery names its tasks by) is a `RangeError` thrown
 * before anything is read — a wiring bug, never contained.
 *
 * ## Units
 *
 * The snapshot, the pending start, the window's bounds and the deadline are
 * MILLISECONDS since epoch. An observation is a Firestore commit `Timestamp`,
 * rendered as a delta task's reference and never converted here; the ONE
 * conversion of a commit time is the commit test's, inside
 * `descobertaEstoque.ts`.
 *
 * ## Rule 7
 *
 * No Firestore write. The enqueues are NAMED (tier 0): a catch-up by (conta,
 * the recovered feed's reference, SKU), a delta by (conta, observation, SKU).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { CONTA_ID_AMAZON_REGEX, ID_LOTE_FEED_AMAZON_REGEX } from '@delfrance/schemas';

import {
  type CampoLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import { FLUXO_AMAZON } from '../core/valvulas';
import { type JanelaEstoqueAmazon, janelaDaRecuperacao } from './descobertaEstoque';
import {
  DESFECHO_DESCOBERTA_ESTOQUE_AMAZON,
  type EtapaDescobertaEstoqueAmazon,
  descobrirJanelaEstoqueAmazon,
} from './descobertaFirestore';
import { formasRefDepositoEstoqueAmazon } from './familiaEstoque';
import { MOTIVO_ESTOQUE_AMAZON, type MotivoEstoqueAmazon } from './motivosEstoque';
import { DESTINO_LOTE_DELTA_ESTOQUE_AMAZON, destinoDoLoteDelta } from './planoEstoque';
import type { ProdutorEstoqueAmazon } from './produtorEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  VERSAO_TAREFA_ESTOQUE_AMAZON,
  referenciaDaObservacao,
  tarefaEstoqueAmazonSchema,
} from './tarefaEstoque';

/** The `fase` of the recovery's line. */
export const FASE_DELTA_ESTOQUE_AMAZON = 'recuperacao';

/**
 * A hand-off the recovery cannot make durable yet (module header): a WARNING
 * placeholder, and the answer says which.
 */
export const REPASSE_DELTA_ESTOQUE_AMAZON = {
  /** 31–3,000 SKUs: one delta feed of the window. */
  feedNecessario: 'feed-necessario',
  /** More than 3,000 SKUs, a truncated window, or the deadline reached: a reconcile run. */
  reconciliacaoNecessaria: 'reconciliacao-necessaria',
} as const;
export type RepasseDeltaEstoqueAmazon =
  (typeof REPASSE_DELTA_ESTOQUE_AMAZON)[keyof typeof REPASSE_DELTA_ESTOQUE_AMAZON];

/** How one recovery ended (closed). */
export const DESFECHO_DELTA_ESTOQUE_AMAZON = {
  /** No window to read, or no SKU of the conta moved in it. */
  nada: 'nada',
  /** Every task of the batch enqueued (or already held by Cloud Tasks). */
  enfileirado: 'enfileirado',
  /** A hand-off placeholder: `repasse` names it. */
  repassado: 'repassado',
  /** The window planner refused an instant (a `RangeError`): nothing read. */
  janelaInvalida: 'janela-invalida',
} as const;
export type DesfechoDeltaEstoqueAmazon =
  (typeof DESFECHO_DELTA_ESTOQUE_AMAZON)[keyof typeof DESFECHO_DELTA_ESTOQUE_AMAZON];

/** Who recovers, for which conta, at which depósito, by which clock. */
export interface ContextoDeltaEstoqueAmazon {
  readonly db: Firestore;
  readonly contaId: string;
  /** The depósito the window is read at, as a document id (`depositoIdDaContaEstoqueAmazon`). */
  readonly depositoId: string;
  /** Now, in MILLISECONDS — read at every decision. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** The stock queue's producer — built only when a batch is due. */
  readonly produtor: () => ProdutorEstoqueAmazon;
}

/** The two instants a recovery window is planned from (module header, step 1). */
export interface EntradaDeltaEstoqueAmazon {
  /** ms — the recovered feed's snapshot; `null` when nothing of a feed may have applied. */
  readonly snapshotEmMs: number | null;
  /** ms — the turned-away window batches' earliest start; `null` when none. */
  readonly pendenteDesdeMs: number | null;
}

export interface OpcoesDeltaEstoqueAmazon {
  /**
   * The recovered feed's reference (its `feedId`, else the send run's
   * `execucaoId`): every FORCED SKU's catch-up task is named by it. Required
   * in the id grammar whenever a snapshot is given.
   */
  readonly referencia: string;
  /** ms — the instant past which no read and no enqueue is started. */
  readonly prazoMs: number;
}

/** What one recovery did (logged ONCE). */
export interface ResultadoDeltaEstoqueAmazon {
  readonly contaId: string;
  readonly desfecho: DesfechoDeltaEstoqueAmazon;
  /** The batch's form, in the stock sync's closed vocabulary. */
  readonly motivo: MotivoEstoqueAmazon | null;
  /** The hand-off placeholder this recovery logged, if any. */
  readonly repasse: RepasseDeltaEstoqueAmazon | null;
  /**
   * The window this recovery read — bounds and keep rule, what a delta feed of
   * it carries; `null` when none was planned.
   */
  readonly janela: JanelaEstoqueAmazon | null;
  /** Window queries run, rows returned, produtos read, link partitions listed. */
  readonly paginas: number;
  readonly linhas: number;
  readonly produtos: number;
  readonly sondas: number;
  /** The conta's distinct SKUs the window mapped to, and how many of them are forced. */
  readonly skus: number;
  readonly forcados: number;
  /** Tasks enqueued, already held by Cloud Tasks, and never started (the deadline). */
  readonly tarefas: number;
  readonly jaEnfileiradas: number;
  readonly naoTentadas: number;
  /** SKUs the task payload cannot carry (more than 40 code points, which no write path sends): counted and dropped. */
  readonly foraDaTarefa: number;
  readonly truncada: boolean;
  /** The read the discovery's deadline stopped before, if it did. */
  readonly prazo: EtapaDescobertaEstoqueAmazon | null;
  /** The deadline stopped the enqueues before the last one started. */
  readonly orcamentoEsgotado: boolean;
  /** The contained failure's CLASS — never its message. */
  readonly erro: string | null;
}

function resultado(
  contaId: string,
  desfecho: DesfechoDeltaEstoqueAmazon,
  extra: Partial<Omit<ResultadoDeltaEstoqueAmazon, 'contaId' | 'desfecho'>> = {},
): ResultadoDeltaEstoqueAmazon {
  return {
    contaId,
    desfecho,
    motivo: null,
    repasse: null,
    janela: null,
    paginas: 0,
    linhas: 0,
    produtos: 0,
    sondas: 0,
    skus: 0,
    forcados: 0,
    tarefas: 0,
    jaEnfileiradas: 0,
    naoTentadas: 0,
    foraDaTarefa: 0,
    truncada: false,
    prazo: null,
    orcamentoEsgotado: false,
    erro: null,
    ...extra,
  };
}

/** A hand-off placeholder (module header): the reason, and what was read. */
function repassar(
  contaId: string,
  repasse: RepasseDeltaEstoqueAmazon,
  extra: Partial<Omit<ResultadoDeltaEstoqueAmazon, 'contaId' | 'desfecho'>>,
): ResultadoDeltaEstoqueAmazon {
  const motivo =
    repasse === REPASSE_DELTA_ESTOQUE_AMAZON.feedNecessario
      ? MOTIVO_ESTOQUE_AMAZON.emFeed
      : MOTIVO_ESTOQUE_AMAZON.emReconciliacao;
  return resultado(contaId, DESFECHO_DELTA_ESTOQUE_AMAZON.repassado, { ...extra, motivo, repasse });
}

const DESFECHOS_EM_WARNING: ReadonlySet<DesfechoDeltaEstoqueAmazon> = new Set([
  DESFECHO_DELTA_ESTOQUE_AMAZON.repassado,
  DESFECHO_DELTA_ESTOQUE_AMAZON.janelaInvalida,
]);

/** The ONE line of a recovery: never a SKU, a reference or a value. */
function registrar(
  ctx: ContextoDeltaEstoqueAmazon,
  r: ResultadoDeltaEstoqueAmazon,
): ResultadoDeltaEstoqueAmazon {
  const severidade: SeveridadeAmazon = DESFECHOS_EM_WARNING.has(r.desfecho) ? 'WARNING' : 'INFO';
  const campos: Readonly<Record<string, CampoLogAmazon>> = {
    fase: FASE_DELTA_ESTOQUE_AMAZON,
    desfecho: r.desfecho,
    motivo: r.motivo,
    repasse: r.repasse,
    paginas: r.paginas,
    linhas: r.linhas,
    produtos: r.produtos,
    sondas: r.sondas,
    skus: r.skus,
    forcados: r.forcados,
    tarefas: r.tarefas,
    jaEnfileiradas: r.jaEnfileiradas,
    naoTentadas: r.naoTentadas,
    foraDaTarefa: r.foraDaTarefa,
    truncada: r.truncada,
    prazo: r.prazo,
    orcamentoEsgotado: r.orcamentoEsgotado,
    erro: r.erro,
  };
  registrarEventoAmazon(
    ctx.logger,
    'estoque',
    severidade,
    `[amazon/estoque] recuperação: ${r.desfecho}`,
    campos,
    { conta: r.contaId, fluxo: FLUXO_AMAZON.estoque },
  );
  return r;
}

/**
 * The context checked before anything is read (module header, "Failures").
 *
 * @throws {RangeError} naming the field, never its value.
 */
function exigirContexto(
  ctx: ContextoDeltaEstoqueAmazon,
  entrada: EntradaDeltaEstoqueAmazon,
  opcoes: OpcoesDeltaEstoqueAmazon,
): void {
  if (!CONTA_ID_AMAZON_REGEX.test(ctx.contaId)) {
    throw new RangeError('deltaEstoque.ts: contaId fora de CONTA_ID_AMAZON_REGEX');
  }
  formasRefDepositoEstoqueAmazon(ctx.depositoId);
  if (!Number.isSafeInteger(opcoes.prazoMs) || opcoes.prazoMs < 0) {
    throw new RangeError('deltaEstoque.ts: prazoMs deve ser um instante em ms');
  }
  if (entrada.snapshotEmMs !== null && !ID_LOTE_FEED_AMAZON_REGEX.test(opcoes.referencia)) {
    throw new RangeError('deltaEstoque.ts: referencia fora de ID_LOTE_FEED_AMAZON_REGEX');
  }
}

/**
 * One recovery delta (module header): the window, the conta's SKUs that moved
 * in it, and the batch they make — patch tasks, or a hand-off placeholder.
 * Writes ONE `evento: 'estoque'` line (`fase: 'recuperacao'`).
 *
 * @throws {RangeError} a context outside its grammar (nothing read).
 */
export async function enviarDeltaEstoqueAmazon(
  ctx: ContextoDeltaEstoqueAmazon,
  entrada: EntradaDeltaEstoqueAmazon,
  opcoes: OpcoesDeltaEstoqueAmazon,
): Promise<ResultadoDeltaEstoqueAmazon> {
  exigirContexto(ctx, entrada, opcoes);
  const { contaId } = ctx;

  // 1. The window. Its planner's RangeError is the ONE failure contained here.
  let janela: JanelaEstoqueAmazon | null;
  try {
    janela = janelaDaRecuperacao({
      snapshotEmMs: entrada.snapshotEmMs,
      pendenteDesdeMs: entrada.pendenteDesdeMs,
      agoraMs: ctx.agora(),
    });
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    return registrar(
      ctx,
      resultado(contaId, DESFECHO_DELTA_ESTOQUE_AMAZON.janelaInvalida, { erro: err.name }),
    );
  }
  if (janela === null) {
    return registrar(ctx, resultado(contaId, DESFECHO_DELTA_ESTOQUE_AMAZON.nada));
  }

  // 2. The rows, the produtos, the probes, the conta's SKUs.
  const d = await descobrirJanelaEstoqueAmazon(
    { db: ctx.db, contaId, depositoId: ctx.depositoId, agora: ctx.agora },
    janela,
    { prazoMs: opcoes.prazoMs },
  );
  const lidos = {
    janela,
    paginas: d.contagem.paginas,
    linhas: d.contagem.linhas,
    produtos: d.contagem.produtos,
    sondas: d.contagem.sondas,
  };
  if (d.tipo === DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.truncada) {
    return registrar(
      ctx,
      repassar(contaId, REPASSE_DELTA_ESTOQUE_AMAZON.reconciliacaoNecessaria, {
        ...lidos,
        truncada: true,
      }),
    );
  }
  if (d.tipo === DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.prazo) {
    return registrar(
      ctx,
      repassar(contaId, REPASSE_DELTA_ESTOQUE_AMAZON.reconciliacaoNecessaria, {
        ...lidos,
        prazo: d.etapa,
      }),
    );
  }

  // 3. The batch's form, from its distinct SKUs as the recovery sees them.
  const comSkus = {
    ...lidos,
    skus: d.observacoes.length,
    forcados: d.observacoes.filter((o) => o.forcar).length,
  };
  switch (destinoDoLoteDelta(d.observacoes.length)) {
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.nada:
      return registrar(ctx, resultado(contaId, DESFECHO_DELTA_ESTOQUE_AMAZON.nada, comSkus));
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.feed:
      return registrar(
        ctx,
        repassar(contaId, REPASSE_DELTA_ESTOQUE_AMAZON.feedNecessario, comSkus),
      );
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.reconciliacao:
      return registrar(
        ctx,
        repassar(contaId, REPASSE_DELTA_ESTOQUE_AMAZON.reconciliacaoNecessaria, comSkus),
      );
    case DESTINO_LOTE_DELTA_ESTOQUE_AMAZON.patches:
      break;
  }

  // 1–30: one named task per SKU — a forced one a catch-up of the feed, any
  // other a delta of its observation; a SKU no payload can carry is counted.
  const tarefas: TarefaEstoqueAmazon[] = [];
  let foraDaTarefa = 0;
  for (const o of d.observacoes) {
    const t = tarefaEstoqueAmazonSchema.safeParse(
      o.forcar
        ? {
            v: VERSAO_TAREFA_ESTOQUE_AMAZON,
            contaId,
            sku: o.sku,
            origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp,
            referencia: opcoes.referencia,
            depositoId: null,
          }
        : {
            v: VERSAO_TAREFA_ESTOQUE_AMAZON,
            contaId,
            sku: o.sku,
            origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
            referencia: referenciaDaObservacao(o.updateTime),
            depositoId: null,
          },
    );
    if (t.success) tarefas.push(t.data);
    else foraDaTarefa += 1;
  }
  let lote = { enfileiradas: 0, jaEnfileiradas: 0, naoTentadas: 0 };
  if (tarefas.length > 0) {
    lote = await ctx
      .produtor()
      .enfileirarLote(tarefas, { continuar: () => ctx.agora() < opcoes.prazoMs });
  }
  const contados = {
    ...comSkus,
    foraDaTarefa,
    tarefas: lote.enfileiradas,
    jaEnfileiradas: lote.jaEnfileiradas,
    naoTentadas: lote.naoTentadas,
  };
  if (lote.naoTentadas > 0) {
    return registrar(
      ctx,
      repassar(contaId, REPASSE_DELTA_ESTOQUE_AMAZON.reconciliacaoNecessaria, {
        ...contados,
        orcamentoEsgotado: true,
      }),
    );
  }
  return registrar(
    ctx,
    resultado(contaId, DESFECHO_DELTA_ESTOQUE_AMAZON.enfileirado, {
      ...contados,
      motivo: MOTIVO_ESTOQUE_AMAZON.emPatches,
    }),
  );
}
