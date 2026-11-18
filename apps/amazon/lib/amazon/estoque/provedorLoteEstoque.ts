/**
 * The STOCK provider of the feed core (step 12, PR 12-f): what one stock
 * `JSON_LISTINGS_FEED` is built from, written back from and recovered by — the
 * `estoque` row of the seam (`feeds/destinosLote.ts`), a FACTORY over the jobs
 * root's {@link RaizLoteAmazon} ({@link criarProvedorLoteEstoqueAmazon}). Two
 * batch kinds ride it: a BLOCK batch (the daily reconcile's drift, read from
 * its blocks by id) and a WINDOW batch (a delta feed: the members of a bounded
 * movement window, re-derived at send).
 *
 * ## `membros`
 *
 *  - Block batch: the run's drift blocks `{execucaoId}-{0…partes−1}`, ONE
 *    `getAll` by id (`divergenciasFirestore.ts`), `partes` from the PAYLOAD —
 *    never a query, never the reconcile document (the next run may have
 *    reclaimed it). The members are the blocks' SKUs, each with its block item
 *    and its block's depósito.
 *  - Window batch: `snapshotEmMs` = our clock FIRST, before the first window
 *    query, so a row committed while the window is re-derived falls after the
 *    snapshot and the recovery forces it. Then the conta's depósito (the
 *    context's conta, the ONE parse) must be the payload's — else
 *    `deposito-mudou`, no aviso (the tick's depósito hand-off re-reconciles) —
 *    and the window is re-derived there with the payload's keep rule
 *    (`descobrirJanelaEstoqueAmazon`, the tick's own reader). A truncated window,
 *    or more than `MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON` SKUs ⇒ one reconcile
 *    request (`'feed'`), then `janela-grande`. The re-derived set may differ
 *    from what the producer counted; the form stays the producer's.
 *
 * ## `montar`
 *
 *  - Window batch: the SHARED evaluator (`avaliarSkusEstoqueAmazon`, the
 *    reconcile walk's own module) with {@link MAX_GETS_LOTE_JANELA} GETs —
 *    the verdict, the ERP quantity, Amazon's live read, the gate — then
 *    `planejarEstoqueAmazon` per enviável SKU, with its observation's `forcar`
 *    and the lease's `ultimoFeedConcluidoEmMs` (`ctx.vez`, the send's E4 read).
 *    The SKUs whose plan writes become messages, sorted by SKU: a refused or
 *    `igual` SKU is counted, never sent; a SKU the patch path cannot carry
 *    (`sem-caminho` there) IS sent, a feed carries it. Amazon throttling the
 *    build (a 429, caught by class) ⇒ the complete members go to the per-SKU
 *    path and the build answers zero messages; any other failure is thrown.
 *  - Block batch: the conta's depósito must be the walk's, which every block
 *    stores — else `deposito-mudou` with `estoque-deposito-sem-linhas` (nothing
 *    posted). Then `snapshotEmMs` = our clock BEFORE the first ERP read; the
 *    units by `getAll`, masked, deduplicated; a unit GONE ⇒ dropped
 *    (`unidade-ausente`, never a 0 derived from a missing produto); a unit
 *    that now has children (refusal 4, `unidadeComVariacoesEstoqueAmazon` over
 *    a children seek of at most two ids) ⇒ dropped; the estoque rows and the
 *    DEDUPLICATED component rows through the family reader, for the units
 *    already read; a SKU whose quantity now equals the walk's Amazon quantity is
 *    dropped (it converged). Link docs are not re-read: a block holds only SKUs
 *    the walk found apt.
 *  - Zero messages ⇒ the core's `sem-escrita`.
 *
 * ## The 240-s budget
 *
 * `membros` and `montar` share `ORCAMENTO_MONTAGEM_LOTE_MS`, counted here from
 * `membros`' first clock read (never earlier than the send's own start), and
 * checked before every read batch. Past it ⇒ `snapshot-lento` with
 * `feed-estoque-falhou`, before any document. A WINDOW batch's members first go
 * to the per-SKU path (movement nothing else will see again) — or, when the
 * overrun came inside `membros`, so the member set is incomplete, one guarded
 * `'automatica'` reconcile request instead. A block batch's never do: the next
 * daily run re-walks them. The send handler's own check after each answer
 * hands over a window batch's complete members itself. The two hand over one
 * batch twice in exactly one case: a 429 during the build (which already handed
 * the members to patches) followed by an overrun of the budget. The second
 * hand-off enqueues the same NAMED tasks (`ALREADY_EXISTS`, nothing doubled),
 * and the batch then ends `snapshot-lento` with `feed-estoque-falhou`.
 *
 * ## `gravarResultado`
 *
 * The report's problem SKUs (at most 200, bounded by the core): each SKU's link
 * docs of the conta through the batch evaluator's own projected query, then
 * the outcome write-back (`envioEstoqueFirestore.ts`) with `via: 'feed'`,
 * `emMs` = the feed's `antesDoEnvioMs`, the `feedId` and `quantidade: null`. A
 * SKU with no link of the conta (or past the order import's ambiguity limit) is
 * skipped. At least one `recusado` that landed (or is still in conflict) ⇒
 * `estoque-recusado-pela-amazon` RAISED once, clocked by the LAST link-doc read
 * of such a write-back (the record's stored outcome clock only when none was
 * read): a raise claims only a `recusado` that read found, so a later clock is
 * safe, and a reconcile close that resolved after the outcome clock but before
 * this write-back cannot drop it; `feed-estoque-falhou` is never touched here.
 *
 * ## `recuperar`
 *
 * The stock valve FIRST (the root's environment): `off` ⇒ one line, nothing
 * read or written. Then ONE recovery delta (`deltaEstoque.ts`) at the conta's depósito, over S = the
 * feed's snapshot for `concluido`, `falhou`, `abandonado` and `incerto` (the
 * feed may have applied), `null` for `cancelado` and `vez`; its two hand-offs
 * are bound here: the delta feed is ONE window `feed-enviar` (`origem:
 * 'recuperacao'`) named by the recovery's identity (its reference and the
 * folded start: a retried recovery meets its own first batch), delayed until
 * at least `S + ESPACO_ENTRE_SNAPSHOTS_MS` (40 s), and carrying `esperaAteMs`
 * one hour on when its window has a commit filter — in the form the valve
 * gives a batch (`decidirLote`): under a canary LIST, the canary's SKUs as
 * patch tasks instead (a forced one a catch-up of the recovered feed), no
 * feed; the reconcile is one request. A window the planner refuses (`janela-invalida`: a stored instant a
 * day ahead) ⇒ that same reconcile request: the catch-up could not be planned,
 * and the run that re-reads everything is the safe direction.
 *
 * For an end that may not have applied (`falhou`, `abandonado`, `incerto`,
 * `cancelado`), also the failed feed's OWN members: a window batch's window
 * re-derived with its own keep rule and handed to the per-SKU path (no
 * request; a window that cannot be re-derived whole ⇒ the request); a block
 * batch's drift through one request. Such a recovery makes AT MOST ONE
 * request, always the 24-h-guarded `'automatica'` — its delta's truncation
 * included; any other recovery's is `'recuperacao'`.
 *
 * ## `repassarParaPatches`
 *
 * One NAMED patch task per SKU on the stock queue, no delay: a block batch's as
 * `reconciliacao` named by its run, carrying the walk's depósito (the walk is
 * already 20 minutes old); a window batch's as `delta` named by each SKU's
 * observation (a movement the tick already patched dedupes), and a FORCED one
 * as `catch-up` named by the batch's `execucaoId` (it must run even when the
 * tick already sent that observation).
 *
 * ## Units and rule 7
 *
 * Every instant is MILLISECONDS; the aviso clock is a Firestore `readTime`,
 * converted only in `avisos/avisos.ts`; delays are WHOLE seconds. No Firestore
 * write of its own: the write-back, the avisos seam and the reconcile request
 * write under their own tiers, and every enqueue is named.
 *
 * D11: nothing here calls Amazon but through the evaluator over the context,
 * which refuses while the read switch is off.
 */
import type { MembroDaFamilia } from '@delfrance/data/admin/estoque';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { produtoCollection } from '@delfrance/data/admin/collections';
import {
  AmazonThrottleError,
  CAMINHO_ATRIBUTO_DISPONIBILIDADE,
  CANAL_MFN,
  type MensagemListingsFeed,
  type PatchListingAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import {
  type ItemDivergenciaEstoqueAmazon,
  MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON,
  MOTIVO_CONTA_AMAZON,
  RESULTADO_ENVIO_ESTOQUE_AMAZON,
  TIPO_LOTE_FEED_AMAZON,
  type TimestampLike,
} from '@delfrance/schemas';

import {
  ACAO_AVISO_CONTA_ESTOQUE_AMAZON,
  sincronizarAvisoContaEstoqueAmazon,
} from '../avisos/avisos';
import { type CamposLogAmazon, type LoggerAmazon, registrarEventoAmazon } from '../core/log';
import { FLUXO_AMAZON, MODO_AMAZON, decidirAlvo, decidirLote, lerValvula } from '../core/valvulas';
import { MAX_ATRASO_LOTE_S } from '../feeds/agendadorLotes';
import type { RaizLoteAmazon } from '../feeds/destinosLote';
import {
  type AbortoLoteAmazon,
  type ContextoLoteAmazon,
  type DesfechoRecuperacaoLoteAmazon,
  ESPERA_MAXIMA_LOTE_RECUPERACAO_MS,
  MOTIVO_ABORTO_LOTE,
  type MembrosLoteAmazon,
  type MontagemLoteAmazon,
  ORCAMENTO_MONTAGEM_LOTE_MS,
  type ProvedorLoteAmazon,
  type RecuperacaoLoteAmazon,
  type ResultadoLoteAmazon,
} from '../feeds/provedorLote';
import {
  DESFECHO_RECUPERACAO_FEED_AMAZON,
  type DesfechoRecuperacaoFeedAmazon,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaEnviarFeedAmazon,
  VERSAO_TAREFA_LOTE_AMAZON,
  execucaoIdDaRecuperacaoFeed,
  nomeEnvioFeed,
  tarefaEnviarFeedAmazonSchema,
} from '../feeds/tarefaLote';
import {
  CAMPOS_LEITURA_UNIDADES_AVALIACAO_ESTOQUE_AMAZON,
  DESFECHO_AVALIACAO_ESTOQUE_AMAZON,
  MAX_GETS_LOTE_JANELA,
  avaliarSkusEstoqueAmazon,
  lerVinculosDosSkusEstoqueAmazon,
} from './avaliacaoLoteEstoque';
import {
  DESFECHO_DELTA_ESTOQUE_AMAZON,
  type DesfechoRepasseDeltaEstoqueAmazon,
  enviarDeltaEstoqueAmazon,
} from './deltaEstoque';
import {
  ESPACO_ENTRE_SNAPSHOTS_MS,
  type JanelaEstoqueAmazon,
  type ObservacaoEstoqueAmazon,
} from './descobertaEstoque';
import {
  DESFECHO_DESCOBERTA_ESTOQUE_AMAZON,
  descobrirJanelaEstoqueAmazon,
} from './descobertaFirestore';
import { lerBlocosDivergenciaEstoqueAmazon } from './divergenciasFirestore';
import { envioDoFeed } from './envioEstoque';
import { gravarEnvioEstoqueAmazon } from './envioEstoqueFirestore';
import {
  type UnidadeLidaEstoqueAmazon,
  depositoIdDaContaEstoqueAmazon,
  depositoIdGravavelDaContaEstoqueAmazon,
  quantidadeEstoqueAmazon,
} from './familiaEstoque';
import {
  LARGURA_PARTICOES_ESTOQUE_AMAZON,
  MAX_REFS_GETALL_ESTOQUE_AMAZON,
  lerMembrosEstoqueAmazon,
} from './familiaEstoqueFirestore';
import { MOTIVO_ESTOQUE_AMAZON } from './motivosEstoque';
import { planejarEstoqueAmazon } from './planoEstoque';
import {
  ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON,
  type OrigemPedidoReconciliacaoEstoqueAmazon,
  solicitarReconciliacaoEstoqueAmazon,
} from './reconciliacaoEstoque';
import { lerFilhosDaUnidadeEstoqueAmazon } from './resolverEstoque';
import {
  ORIGEM_TAREFA_ESTOQUE_AMAZON,
  type TarefaEstoqueAmazon,
  VERSAO_TAREFA_ESTOQUE_AMAZON,
  referenciaDaObservacao,
  tarefaEstoqueAmazonSchema,
} from './tarefaEstoque';
import { unidadeComVariacoesEstoqueAmazon } from './vinculoEstoque';

/* -------------------------------------------------------------------------- */
/*                                  contract                                  */
/* -------------------------------------------------------------------------- */

/** The producer label of a recovery's window batch, on its `feed-enviar`. */
export const ORIGEM_LOTE_RECUPERACAO_ESTOQUE_AMAZON = 'recuperacao';

/** One recovery dispatch's own budget (the delta and the failed feed's own members), ms. */
export const ORCAMENTO_RECUPERACAO_ESTOQUE_AMAZON_MS = 240_000;

/** The `fase` of the provider's own lines. */
export const FASE_PROVEDOR_ESTOQUE_AMAZON = {
  montagem: 'feed-montagem',
  gravacao: 'feed-gravacao',
  recuperacao: 'feed-recuperacao',
} as const;

/** One block member: its block's item and the depósito that block's walk read. */
export interface MembroDoBlocoEstoqueAmazon {
  readonly item: ItemDivergenciaEstoqueAmazon;
  /** The walk's depósito id, as its block stores it (`null` only for a missing block). */
  readonly depositoId: string | null;
}

/** What `membros` hands `montar` (opaque to the core). */
export type DadosLoteEstoqueAmazon =
  | {
      readonly tipo: typeof TIPO_LOTE_FEED_AMAZON.janela;
      /** ms — our clock before the first window query: the snapshot AND the budget's start. */
      readonly snapshotEmMs: number;
      /** Per member SKU, its observation and whether it is forced. */
      readonly observacoes: ReadonlyMap<string, ObservacaoEstoqueAmazon>;
    }
  | {
      readonly tipo: typeof TIPO_LOTE_FEED_AMAZON.blocos;
      /** ms — the budget's start (the blocks' read). */
      readonly inicioMs: number;
      /** Per member SKU, its block item and its block's depósito. */
      readonly membros: ReadonlyMap<string, MembroDoBlocoEstoqueAmazon>;
    };

/** The stock provider, as its factory builds it. */
export type ProvedorLoteEstoqueAmazon = ProvedorLoteAmazon<'estoque', DadosLoteEstoqueAmazon>;

/* -------------------------------------------------------------------------- */
/*                                   helpers                                  */
/* -------------------------------------------------------------------------- */

/** Code-unit order (a SKU is compared as exact bytes). */
function porTexto(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** `itens` in consecutive slices of at most `tamanho`. */
function fatias<T>(itens: readonly T[], tamanho: number): T[][] {
  const saida: T[][] = [];
  for (let i = 0; i < itens.length; i += tamanho) saida.push(itens.slice(i, i + tamanho));
  return saida;
}

/**
 * The stock merge of ONE SKU's quantity as a feed message carries it: the
 * MFN fulfillment-availability merge, built from the package's named keys.
 * `provedorLoteEstoque.test.ts` pins it to the body the package's own
 * `patchListingsItem` helper sends.
 */
export function patchEstoqueAmazon(quantidade: number): PatchListingAmazon {
  return {
    op: 'merge',
    path: CAMINHO_ATRIBUTO_DISPONIBILIDADE,
    value: [{ fulfillment_channel_code: CANAL_MFN, quantity: quantidade }],
  };
}

function mensagem(sku: string, quantidade: number): MensagemListingsFeed {
  return { sku, patches: [patchEstoqueAmazon(quantidade)] };
}

/** The abort of a build past the shared budget (module header). */
const ABORTO_LENTO: AbortoLoteAmazon = {
  abortado: MOTIVO_ABORTO_LOTE.snapshotLento,
  aviso: MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
};

/** The window batch's keep rule and bounds, as the payload carries them. */
function janelaDoLote(
  lote: Extract<TarefaEnviarFeedAmazon['lote'], { readonly tipo: 'janela' }>,
): JanelaEstoqueAmazon {
  return {
    desdeMs: lote.desdeMs,
    ateMs: lote.ateMs,
    manterDesdeMs: lote.manterDesdeMs,
    commitAposMs: lote.commitAposMs,
  };
}

/**
 * One patch task per observation of a window (module header,
 * `repassarParaPatches`): a FORCED one a catch-up named by `referenciaForcados`,
 * any other a delta named by its observation. A SKU no payload can carry is
 * counted and left out.
 */
function tarefasDasObservacoes(
  contaId: string,
  observacoes: readonly ObservacaoEstoqueAmazon[],
  referenciaForcados: string,
): { readonly tarefas: TarefaEstoqueAmazon[]; readonly foraDaTarefa: number } {
  const tarefas: TarefaEstoqueAmazon[] = [];
  let foraDaTarefa = 0;
  for (const o of observacoes) {
    const t = tarefaEstoqueAmazonSchema.safeParse({
      v: VERSAO_TAREFA_ESTOQUE_AMAZON,
      contaId,
      sku: o.sku,
      origem: o.forcar ? ORIGEM_TAREFA_ESTOQUE_AMAZON.catchUp : ORIGEM_TAREFA_ESTOQUE_AMAZON.delta,
      referencia: o.forcar ? referenciaForcados : referenciaDaObservacao(o.updateTime),
      depositoId: null,
    });
    if (t.success) tarefas.push(t.data);
    else foraDaTarefa += 1;
  }
  return { tarefas, foraDaTarefa };
}

/** A snapshot's data, or `null` when the document does not exist. */
function dadosDe(snap: DocumentSnapshot | undefined): Readonly<Record<string, unknown>> | null {
  if (snap?.exists !== true) return null;
  return (snap.data() ?? {}) as Record<string, unknown>;
}

/** The reconcile request's deps, from the provider's context and the root. */
function depsDoPedido(ctx: ContextoLoteAmazon, raiz: RaizLoteAmazon) {
  return {
    agora: ctx.agora,
    logger: ctx.logger,
    increment: raiz.increment,
    agendador: raiz.agendadorLotes,
    gerarExecucaoId: raiz.gerarExecucaoId,
  };
}

/** One line of the provider's own (`evento: 'estoque'`): closed codes and counts only. */
function registrar(
  logger: LoggerAmazon,
  contaId: string,
  mensagemLog: string,
  campos: CamposLogAmazon,
): void {
  registrarEventoAmazon(logger, 'estoque', 'INFO', mensagemLog, campos, {
    conta: contaId,
    fluxo: FLUXO_AMAZON.estoque,
  });
}

/* -------------------------------------------------------------------------- */
/*                                  the factory                               */
/* -------------------------------------------------------------------------- */

/**
 * The stock row of the seam (module header), bound ONCE by the jobs root. It
 * builds nothing at bind time: every producer stays a thunk until an enqueue.
 */
export function criarProvedorLoteEstoqueAmazon(raiz: RaizLoteAmazon): ProvedorLoteEstoqueAmazon {
  const provedor: ProvedorLoteEstoqueAmazon = {
    fluxo: FLUXO_AMAZON.estoque,
    motivoFalha: MOTIVO_CONTA_AMAZON.feedEstoqueFalhou,
    membros: (ctx, entrada) =>
      entrada.lote.tipo === TIPO_LOTE_FEED_AMAZON.janela
        ? membrosDaJanela(ctx, entrada, raiz)
        : membrosDosBlocos(ctx, entrada),
    montar: (ctx, entrada, membrosOn, dados) =>
      dados.tipo === TIPO_LOTE_FEED_AMAZON.janela
        ? montarJanela(ctx, entrada, membrosOn, dados, raiz)
        : montarBlocos(ctx, membrosOn, dados),
    gravarResultado: (ctx, resultado) => gravarResultado(ctx, resultado, raiz),
    recuperar: (ctx, recuperacao) => recuperar(ctx, recuperacao, raiz),
    repassarParaPatches: (ctx, entrada, skus, dados) =>
      repassarParaPatches(ctx, entrada, skus, dados, raiz),
  };
  return provedor;
}

/* -------------------------------------------------------------------------- */
/*                                   membros                                  */
/* -------------------------------------------------------------------------- */

/** A window batch's members (module header): snapshot FIRST, then the window re-derived. */
async function membrosDaJanela(
  ctx: ContextoLoteAmazon,
  entrada: TarefaEnviarFeedAmazon,
  raiz: RaizLoteAmazon,
): Promise<MembrosLoteAmazon<DadosLoteEstoqueAmazon>> {
  // ⚠️ Before the first window query: the snapshot AND the shared budget's start.
  const snapshotEmMs = ctx.agora();
  const { lote } = entrada;
  if (lote.tipo !== TIPO_LOTE_FEED_AMAZON.janela) {
    throw new TypeError('provedorLoteEstoque.ts: membros de janela sem janela');
  }
  const janela = janelaDoLote(lote);
  const contaId = ctx.contexto.integracaoId;
  const depositoDaConta = depositoIdDaContaEstoqueAmazon(ctx.contexto.conta.depositoOuterRef);
  if (depositoDaConta !== lote.depositoId) {
    return { abortado: MOTIVO_ABORTO_LOTE.depositoMudou, aviso: null };
  }
  const d = await descobrirJanelaEstoqueAmazon(
    { db: ctx.db, contaId, depositoId: lote.depositoId, agora: ctx.agora },
    janela,
    { prazoMs: snapshotEmMs + ORCAMENTO_MONTAGEM_LOTE_MS },
  );
  if (d.tipo === DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.prazo) {
    // The member set is incomplete: nothing can be handed to patches whole.
    await solicitarReconciliacaoEstoqueAmazon(
      ctx.db,
      contaId,
      ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.automatica,
      depsDoPedido(ctx, raiz),
    );
    return ABORTO_LENTO;
  }
  if (
    d.tipo === DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.truncada ||
    d.observacoes.length > MAX_SKUS_FEED_DELTA_ESTOQUE_AMAZON
  ) {
    await solicitarReconciliacaoEstoqueAmazon(
      ctx.db,
      contaId,
      ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.feed,
      depsDoPedido(ctx, raiz),
    );
    return { abortado: MOTIVO_ABORTO_LOTE.janelaGrande, aviso: null };
  }
  return {
    skus: d.observacoes.map((o) => o.sku),
    dados: {
      tipo: TIPO_LOTE_FEED_AMAZON.janela,
      snapshotEmMs,
      observacoes: new Map(d.observacoes.map((o) => [o.sku, o] as const)),
    },
  };
}

/** A block batch's members (module header): the run's blocks by id, ZERO queries. */
async function membrosDosBlocos(
  ctx: ContextoLoteAmazon,
  entrada: TarefaEnviarFeedAmazon,
): Promise<MembrosLoteAmazon<DadosLoteEstoqueAmazon>> {
  const inicioMs = ctx.agora();
  const { lote } = entrada;
  if (lote.tipo !== TIPO_LOTE_FEED_AMAZON.blocos) {
    throw new TypeError('provedorLoteEstoque.ts: membros de blocos sem blocos');
  }
  const blocos = await lerBlocosDivergenciaEstoqueAmazon(ctx.db, {
    contaId: ctx.contexto.integracaoId,
    execucaoId: entrada.execucaoId,
    partes: lote.partes,
  });
  const membros = new Map<string, MembroDoBlocoEstoqueAmazon>();
  for (const bloco of blocos) {
    for (const item of bloco.itens) {
      // A SKU is evaluated on ONE page of its walk; a repeat keeps the first.
      if (!membros.has(item.sku)) membros.set(item.sku, { item, depositoId: bloco.depositoId });
    }
  }
  return {
    skus: [...membros.keys()].sort(porTexto),
    dados: { tipo: TIPO_LOTE_FEED_AMAZON.blocos, inicioMs, membros },
  };
}

/* -------------------------------------------------------------------------- */
/*                                    montar                                  */
/* -------------------------------------------------------------------------- */

/** A window batch's build (module header): the shared evaluator, then the plan per SKU. */
async function montarJanela(
  ctx: ContextoLoteAmazon,
  entrada: TarefaEnviarFeedAmazon,
  membrosOn: readonly string[],
  dados: Extract<DadosLoteEstoqueAmazon, { readonly tipo: 'janela' }>,
  raiz: RaizLoteAmazon,
): Promise<MontagemLoteAmazon> {
  const { lote } = entrada;
  if (lote.tipo !== TIPO_LOTE_FEED_AMAZON.janela) {
    throw new TypeError('provedorLoteEstoque.ts: montagem de janela sem janela');
  }
  const prazoMs = dados.snapshotEmMs + ORCAMENTO_MONTAGEM_LOTE_MS;
  let avaliacao: Awaited<ReturnType<typeof avaliarSkusEstoqueAmazon>>;
  try {
    avaliacao = await avaliarSkusEstoqueAmazon(
      {
        contexto: ctx.contexto,
        db: ctx.db,
        logger: ctx.logger,
        agora: ctx.agora,
        sellerId: ctx.sellerId,
        esperar: raiz.esperar,
      },
      membrosOn,
      { depositoId: lote.depositoId, prazoMs, maxGets: MAX_GETS_LOTE_JANELA },
    );
  } catch (err) {
    if (!(err instanceof AmazonThrottleError)) throw err;
    return limitada(ctx, entrada, membrosOn, dados, raiz);
  }
  if (avaliacao.tipo === DESFECHO_AVALIACAO_ESTOQUE_AMAZON.prazo) {
    // The members are complete: they go per SKU before the abort (module header).
    await repassarParaPatches(ctx, entrada, membrosOn, dados, raiz);
    return ABORTO_LENTO;
  }
  const feedRecenteEmMs = ctx.vez?.ultimoFeedConcluidoEmMs ?? null;
  const mensagens: MensagemListingsFeed[] = [];
  let iguais = 0;
  let forcados = 0;
  let recusados = 0;
  for (const s of avaliacao.skus) {
    if (!s.enviavel) {
      recusados += 1;
      continue;
    }
    const forcar = dados.observacoes.get(s.sku)?.forcar === true;
    const plano = planejarEstoqueAmazon(
      s.quantidadeErp,
      s.gate,
      s.vinculo.envioRecente,
      ctx.agora(),
      {
        forcar,
        feedRecenteEmMs,
      },
    );
    if (!plano.escrever) {
      iguais += 1;
      continue;
    }
    if (forcar) forcados += 1;
    mensagens.push(mensagem(s.sku, plano.quantidade));
  }
  mensagens.sort((a, b) => porTexto(a.sku, b.sku));
  const porChave = avaliacao.contagem.porChave;
  return {
    mensagens,
    snapshotEmMs: dados.snapshotEmMs,
    diff: {
      lote: TIPO_LOTE_FEED_AMAZON.janela,
      membros: membrosOn.length,
      enviaveis: avaliacao.contagem.enviaveis,
      mensagens: mensagens.length,
      iguais,
      forcados,
      recusados,
      naoConfirmados: porChave[MOTIVO_ESTOQUE_AMAZON.naoConfirmado] ?? 0,
      buscas: avaliacao.contagem.leituras.buscas,
      gets: avaliacao.contagem.leituras.gets,
    },
  };
}

/**
 * Amazon throttled a window build (a 429 from a search or a GET): its members
 * are complete, so they go to the per-SKU path now — each patch task paces its
 * own 429s — and the build answers ZERO messages (the core's `sem-escrita`: no
 * aviso, no failure counted, nothing posted). Rethrown, the build would be
 * redone on every one of the queue's attempts and, all spent, dropped with the
 * window's movement, whose tick cursor has already moved on. Any other failure
 * still leaves for the queue's retry.
 */
async function limitada(
  ctx: ContextoLoteAmazon,
  entrada: TarefaEnviarFeedAmazon,
  membrosOn: readonly string[],
  dados: Extract<DadosLoteEstoqueAmazon, { readonly tipo: 'janela' }>,
  raiz: RaizLoteAmazon,
): Promise<MontagemLoteAmazon> {
  const { tarefas } = await repassarParaPatches(ctx, entrada, membrosOn, dados, raiz);
  const contaId = ctx.contexto.integracaoId;
  registrar(ctx.logger, contaId, '[amazon/estoque] feed: montagem limitada pela Amazon', {
    fase: FASE_PROVEDOR_ESTOQUE_AMAZON.montagem,
    membros: membrosOn.length,
    destino: 'patches',
    tarefas,
  });
  return {
    mensagens: [],
    snapshotEmMs: dados.snapshotEmMs,
    diff: {
      lote: TIPO_LOTE_FEED_AMAZON.janela,
      membros: membrosOn.length,
      mensagens: 0,
      limitada: true,
      repassados: tarefas,
    },
  };
}

/**
 * A block batch's snapshot (module header): the depósito first, the snapshot
 * stamp BEFORE the first ERP read, then the units, their children and their
 * rows, and only the SKUs whose quantity still differs from the walk's.
 *
 * Past the shared budget ⇒ `snapshot-lento`, nothing handed over. The named
 * fallback for a block batch that keeps overrunning — recompute only the drift
 * units whose estoque stamp moved since the walk began, plus every drift kit —
 * is NOT built: it waits for a staging timing probe of this snapshot.
 */
async function montarBlocos(
  ctx: ContextoLoteAmazon,
  membrosOn: readonly string[],
  dados: Extract<DadosLoteEstoqueAmazon, { readonly tipo: 'blocos' }>,
): Promise<MontagemLoteAmazon> {
  const prazoMs = dados.inicioMs + ORCAMENTO_MONTAGEM_LOTE_MS;
  const venceu = () => ctx.agora() >= prazoMs;
  const membros = membrosOn.flatMap((sku) => {
    const m = dados.membros.get(sku);
    return m === undefined ? [] : [m];
  });

  // 1. The depósito: the conta's now against the walk's, which every block stores.
  const depositoDaConta = depositoIdDaContaEstoqueAmazon(ctx.contexto.conta.depositoOuterRef);
  if (membros.some((m) => depositoDaConta === null || m.depositoId !== depositoDaConta)) {
    return {
      abortado: MOTIVO_ABORTO_LOTE.depositoMudou,
      aviso: MOTIVO_CONTA_AMAZON.estoqueDepositoSemLinhas,
    };
  }

  // 2. The snapshot, BEFORE the first ERP read.
  const snapshotEmMs = ctx.agora();
  const contagem = { unidadesAusentes: 0, unidadesComVariacoes: 0, convergidos: 0 };
  if (membros.length === 0 || depositoDaConta === null) {
    return {
      mensagens: [],
      snapshotEmMs,
      diff: { lote: TIPO_LOTE_FEED_AMAZON.blocos, membros: 0, mensagens: 0, ...contagem },
    };
  }

  // 3. The units, masked and deduplicated.
  const unidadeIds = [...new Set(membros.map((m) => m.item.unidadeId))];
  const unidades = new Map<string, UnidadeLidaEstoqueAmazon>();
  for (const fatia of fatias(unidadeIds, MAX_REFS_GETALL_ESTOQUE_AMAZON)) {
    if (venceu()) return ABORTO_LENTO;
    const snaps = await ctx.db.getAll(
      ...fatia.map((id) => produtoCollection.docRef(ctx.db, {}, id)),
      {
        fieldMask: [...CAMPOS_LEITURA_UNIDADES_AVALIACAO_ESTOQUE_AMAZON],
      },
    );
    for (const [i, id] of fatia.entries()) {
      const raw = dadosDe(snaps[i]);
      if (raw !== null) unidades.set(id, { id, raw });
    }
  }

  // 4. Each present unit's children: one seek each, at most 16 in flight.
  const comVariacoes = new Set<string>();
  for (const fatia of fatias([...unidades.values()], LARGURA_PARTICOES_ESTOQUE_AMAZON)) {
    if (venceu()) return ABORTO_LENTO;
    const filhos = await Promise.all(
      fatia.map((u) => lerFilhosDaUnidadeEstoqueAmazon(ctx.db, u.id)),
    );
    for (const [i, u] of fatia.entries()) {
      if (unidadeComVariacoesEstoqueAmazon(u.id, { raw: u.raw, filhosIds: filhos[i] ?? [] })) {
        comVariacoes.add(u.id);
      }
    }
  }

  // 5. The rows of the units still apt, components deduplicated.
  if (venceu()) return ABORTO_LENTO;
  const aptas = [...unidades.values()].filter((u) => !comVariacoes.has(u.id));
  const membrosDaFamilia: Map<string, MembroDaFamilia> = await lerMembrosEstoqueAmazon(ctx.db, {
    unidades: aptas,
    depositoId: depositoDaConta,
  });
  if (venceu()) return ABORTO_LENTO;

  // 6. Only what still differs from Amazon's walk-time quantity.
  const mensagens: MensagemListingsFeed[] = [];
  for (const { item } of membros) {
    if (!unidades.has(item.unidadeId)) {
      contagem.unidadesAusentes += 1;
      continue;
    }
    if (comVariacoes.has(item.unidadeId)) {
      contagem.unidadesComVariacoes += 1;
      continue;
    }
    const membro = membrosDaFamilia.get(item.unidadeId);
    if (membro === undefined) {
      throw new TypeError('provedorLoteEstoque.ts: uma unidade apta sem o seu membro');
    }
    const quantidade = quantidadeEstoqueAmazon(membro);
    if (quantidade === item.quantidadeAmazon) {
      contagem.convergidos += 1;
      continue;
    }
    mensagens.push(mensagem(item.sku, quantidade));
  }
  mensagens.sort((a, b) => porTexto(a.sku, b.sku));
  return {
    mensagens,
    snapshotEmMs,
    diff: {
      lote: TIPO_LOTE_FEED_AMAZON.blocos,
      membros: membros.length,
      mensagens: mensagens.length,
      ...contagem,
    },
  };
}

/* -------------------------------------------------------------------------- */
/*                               gravarResultado                              */
/* -------------------------------------------------------------------------- */

/** The report's per-SKU write-back (module header). */
async function gravarResultado(
  ctx: ContextoLoteAmazon,
  resultado: ResultadoLoteAmazon,
  raiz: RaizLoteAmazon,
): Promise<void> {
  const contaId = ctx.contexto.integracaoId;
  const skus = [...resultado.problemas.keys()].sort(porTexto);
  if (skus.length === 0) return;
  const vinculos = await lerVinculosDosSkusEstoqueAmazon(ctx.db, contaId, skus, {
    agora: ctx.agora,
    prazoMs: Number.MAX_SAFE_INTEGER,
  });
  if (vinculos === null) {
    throw new TypeError('provedorLoteEstoque.ts: a leitura dos vínculos não tem prazo aqui');
  }
  let gravados = 0;
  let semVinculo = 0;
  let recusadosGravados = 0;
  // The raise's clock: the LAST link-doc read of a `recusado` that counted (each
  // read later than the one before), so a reconcile close that resolved between
  // the record's outcome clock and this write-back cannot drop the raise.
  let relogioDaRecusa: TimestampLike | null = null;
  for (const sku of skus) {
    const lido = vinculos.get(sku);
    if (lido === undefined || lido.tipo !== 'docs' || lido.docs.length === 0) {
      semVinculo += 1;
      continue;
    }
    const envio = envioDoFeed(resultado.problemas.get(sku) ?? [], resultado.feedId, resultado.emMs);
    const r = await gravarEnvioEstoqueAmazon(
      ctx.db,
      {
        contaId,
        sku,
        links: lido.docs.map((d) => ({ produtoId: d.donoId, linkId: d.linkId })),
        envio,
        agoraMs: ctx.agora(),
      },
      { logger: ctx.logger },
    );
    const valeu = r.gravados + r.emConflito > 0;
    if (valeu) gravados += 1;
    if (valeu && envio.resultado === RESULTADO_ENVIO_ESTOQUE_AMAZON.recusado) {
      recusadosGravados += 1;
      relogioDaRecusa = r.relogio ?? relogioDaRecusa;
    }
  }
  if (recusadosGravados > 0) {
    await sincronizarAvisoContaEstoqueAmazon(
      ctx.db,
      { increment: raiz.increment, nowMs: ctx.agora(), logger: ctx.logger },
      {
        integracaoId: contaId,
        motivo: MOTIVO_CONTA_AMAZON.estoqueRecusadoPelaAmazon,
        acao: ACAO_AVISO_CONTA_ESTOQUE_AMAZON.levantar,
        relogio: relogioDaRecusa ?? resultado.relogio,
      },
    );
  }
  registrar(ctx.logger, contaId, '[amazon/estoque] feed: resultado gravado nos vínculos', {
    fase: FASE_PROVEDOR_ESTOQUE_AMAZON.gravacao,
    feedId: resultado.feedId,
    skus: skus.length,
    gravados,
    semVinculo,
    recusados: recusadosGravados,
  });
}

/* -------------------------------------------------------------------------- */
/*                                  recuperar                                 */
/* -------------------------------------------------------------------------- */

/** The ends after which some, none or all of the feed may have applied, or nothing did. */
const NAO_CONCLUIDOS: ReadonlySet<DesfechoRecuperacaoFeedAmazon> = new Set([
  DESFECHO_RECUPERACAO_FEED_AMAZON.falhou,
  DESFECHO_RECUPERACAO_FEED_AMAZON.abandonado,
  DESFECHO_RECUPERACAO_FEED_AMAZON.incerto,
  DESFECHO_RECUPERACAO_FEED_AMAZON.cancelado,
]);

/** The ends whose feed may have applied: the catch-up reads from its snapshot. */
const COM_SNAPSHOT: ReadonlySet<DesfechoRecuperacaoFeedAmazon> = new Set([
  DESFECHO_RECUPERACAO_FEED_AMAZON.concluido,
  DESFECHO_RECUPERACAO_FEED_AMAZON.falhou,
  DESFECHO_RECUPERACAO_FEED_AMAZON.abandonado,
  DESFECHO_RECUPERACAO_FEED_AMAZON.incerto,
]);

/** One recovery (module header): the delta, then the failed feed's own members. */
async function recuperar(
  ctx: ContextoLoteAmazon,
  r: RecuperacaoLoteAmazon,
  raiz: RaizLoteAmazon,
): Promise<DesfechoRecuperacaoLoteAmazon> {
  const contaId = ctx.contexto.integracaoId;
  // The stock valve FIRST: `off` reads and writes nothing (every task this
  // recovery could make would stop at its own valve, and a request would spend
  // the day's automatic guard on a run whose pages stop there too).
  const valvula = lerValvula(FLUXO_AMAZON.estoque, raiz.ambiente());
  if (valvula.modo === MODO_AMAZON.off) {
    registrar(ctx.logger, contaId, '[amazon/estoque] feed: recuperação com a válvula desligada', {
      fase: FASE_PROVEDOR_ESTOQUE_AMAZON.recuperacao,
      desfecho: r.desfecho,
      destino: 'valvula-desligada',
    });
    return { nada: true };
  }
  const naoConcluido = NAO_CONCLUIDOS.has(r.desfecho);
  const snapshotEmMs = COM_SNAPSHOT.has(r.desfecho) ? r.snapshotEmMs : null;
  const prazoMs = ctx.agora() + ORCAMENTO_RECUPERACAO_ESTOQUE_AMAZON_MS;
  const feito: {
    feed: string | null;
    pedido: Promise<DesfechoRepasseDeltaEstoqueAmazon> | null;
    tarefas: number;
  } = { feed: null, pedido: null, tarefas: 0 };

  // At most ONE reconcile request per recovery: the guarded one after a failure.
  const origemDoPedido: OrigemPedidoReconciliacaoEstoqueAmazon = naoConcluido
    ? ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.automatica
    : ORIGEM_PEDIDO_RECONCILIACAO_ESTOQUE_AMAZON.recuperacao;
  const pedir = async (): Promise<DesfechoRepasseDeltaEstoqueAmazon> => {
    if (feito.pedido !== null) {
      await feito.pedido;
      return 'ja-pedido';
    }
    feito.pedido = solicitarReconciliacaoEstoqueAmazon(
      ctx.db,
      contaId,
      origemDoPedido,
      depsDoPedido(ctx, raiz),
    ).then((p) => p.acao);
    return feito.pedido;
  };

  // 1. The recovery delta, at the conta's depósito as the stock documents store it.
  const depositoId = depositoIdGravavelDaContaEstoqueAmazon(ctx.contexto.conta.depositoOuterRef);
  if (depositoId !== null) {
    const execucaoId = execucaoIdDaRecuperacaoFeed(contaId, r.referencia, r.pendenteDesdeMs);
    const delta = await enviarDeltaEstoqueAmazon(
      {
        db: ctx.db,
        contaId,
        depositoId,
        agora: ctx.agora,
        logger: ctx.logger,
        produtor: raiz.produtorEstoque,
        repassar: {
          feed: async (janela, observacoes) => {
            // The batch's form, as the valve gives it (every producer of 31+
            // decides it before it enqueues): under a canary LIST, the canary's
            // SKUs as patch tasks — a forced one a catch-up of the recovered
            // feed, as the delta's own patches — and no feed; the rest a feed.
            if (decidirLote(valvula).modo === 'so-patches-do-canario') {
              const noCanario = observacoes.filter(
                (o) => decidirAlvo(valvula, contaId, o.sku).modo === MODO_AMAZON.on,
              );
              const { tarefas } = tarefasDasObservacoes(contaId, noCanario, r.referencia);
              if (tarefas.length > 0) {
                const lote = await raiz
                  .produtorEstoque()
                  .enfileirarLote(tarefas, { continuar: () => ctx.agora() < prazoMs });
                feito.tarefas += lote.enfileiradas + lote.jaEnfileiradas;
                if (lote.naoTentadas > 0) return pedir();
              }
              return 'so-patches';
            }
            const enviada = await enfileirarFeedDaRecuperacao(ctx, raiz, {
              contaId,
              execucaoId,
              depositoId,
              janela,
              snapshotEmMs,
            });
            feito.feed = execucaoId;
            return enviada;
          },
          reconciliacao: pedir,
        },
      },
      { snapshotEmMs, pendenteDesdeMs: r.pendenteDesdeMs },
      { referencia: r.referencia, prazoMs },
    );
    if (delta.desfecho === DESFECHO_DELTA_ESTOQUE_AMAZON.janelaInvalida) await pedir();
    feito.tarefas += delta.tarefas + delta.jaEnfileiradas;
  }

  // 2. The failed feed's OWN members (module header).
  if (naoConcluido) {
    const proprios = await membrosDoFeedQueFalhou(ctx, r, raiz, { prazoMs, pedir });
    feito.tarefas += proprios.tarefas;
    registrar(ctx.logger, contaId, '[amazon/estoque] feed: membros do feed que falhou', {
      fase: FASE_PROVEDOR_ESTOQUE_AMAZON.recuperacao,
      desfecho: r.desfecho,
      lote: r.janela === null ? TIPO_LOTE_FEED_AMAZON.blocos : TIPO_LOTE_FEED_AMAZON.janela,
      destino: proprios.destino,
      tarefas: proprios.tarefas,
      pedido: feito.pedido === null ? null : await feito.pedido,
    });
  }

  if (feito.feed !== null) return { feed: feito.feed };
  if (feito.pedido !== null) return { repassado: 'reconciliacao' };
  if (feito.tarefas > 0) return { tarefas: feito.tarefas };
  return { nada: true };
}

/**
 * The failed feed's OWN members (module header): a window batch's window
 * re-derived with its own keep rule and handed to the per-SKU path (a window
 * that cannot be re-derived whole, or tasks the budget left unstarted ⇒ the
 * request); a block batch's drift through the request.
 */
async function membrosDoFeedQueFalhou(
  ctx: ContextoLoteAmazon,
  r: RecuperacaoLoteAmazon,
  raiz: RaizLoteAmazon,
  e: { readonly prazoMs: number; readonly pedir: () => Promise<DesfechoRepasseDeltaEstoqueAmazon> },
): Promise<{ readonly destino: 'patches' | 'reconciliacao'; readonly tarefas: number }> {
  if (r.janela === null) {
    await e.pedir();
    return { destino: 'reconciliacao', tarefas: 0 };
  }
  const contaId = ctx.contexto.integracaoId;
  const d = await descobrirJanelaEstoqueAmazon(
    { db: ctx.db, contaId, depositoId: r.janela.depositoId, agora: ctx.agora },
    r.janela,
    { prazoMs: e.prazoMs },
  );
  if (d.tipo !== DESFECHO_DESCOBERTA_ESTOQUE_AMAZON.completa) {
    await e.pedir();
    return { destino: 'reconciliacao', tarefas: 0 };
  }
  const { tarefas } = tarefasDasObservacoes(contaId, d.observacoes, r.referencia);
  if (tarefas.length === 0) return { destino: 'patches', tarefas: 0 };
  const lote = await raiz
    .produtorEstoque()
    .enfileirarLote(tarefas, { continuar: () => ctx.agora() < e.prazoMs });
  if (lote.naoTentadas > 0) {
    await e.pedir();
    return { destino: 'reconciliacao', tarefas: lote.enfileiradas + lote.jaEnfileiradas };
  }
  return { destino: 'patches', tarefas: lote.enfileiradas + lote.jaEnfileiradas };
}

/**
 * The recovery delta's feed hand-off (module header): ONE window `feed-enviar`
 * named by the recovery, delayed until `S + ESPACO_ENTRE_SNAPSHOTS_MS`, waiting
 * at most an hour behind a held lease when its window has a commit filter.
 */
async function enfileirarFeedDaRecuperacao(
  ctx: ContextoLoteAmazon,
  raiz: RaizLoteAmazon,
  e: {
    readonly contaId: string;
    readonly execucaoId: string;
    readonly depositoId: string;
    readonly janela: JanelaEstoqueAmazon;
    readonly snapshotEmMs: number | null;
  },
): Promise<DesfechoRepasseDeltaEstoqueAmazon> {
  const agoraMs = ctx.agora();
  // Whole seconds, within the producer's one-day bound (a snapshot at most a day ahead).
  const atrasoS =
    e.snapshotEmMs === null
      ? 0
      : Math.min(
          MAX_ATRASO_LOTE_S,
          Math.max(0, Math.ceil((e.snapshotEmMs + ESPACO_ENTRE_SNAPSHOTS_MS - agoraMs) / 1000)),
        );
  const tarefa = tarefaEnviarFeedAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.enviar,
    fluxo: FLUXO_AMAZON.estoque,
    contaId: e.contaId,
    execucaoId: e.execucaoId,
    origem: ORIGEM_LOTE_RECUPERACAO_ESTOQUE_AMAZON,
    lote: {
      tipo: TIPO_LOTE_FEED_AMAZON.janela,
      ...e.janela,
      depositoId: e.depositoId,
      esperaAteMs:
        e.janela.commitAposMs === null ? null : agoraMs + ESPERA_MAXIMA_LOTE_RECUPERACAO_MS,
    },
  });
  return raiz.agendadorLotes().enfileirarLote(tarefa, {
    nome: nomeEnvioFeed(e.contaId, e.execucaoId),
    atrasoS,
  });
}

/* -------------------------------------------------------------------------- */
/*                              repassarParaPatches                           */
/* -------------------------------------------------------------------------- */

/** A batch handed to the per-SKU path (module header): one named task per SKU, no delay. */
async function repassarParaPatches(
  ctx: ContextoLoteAmazon,
  entrada: TarefaEnviarFeedAmazon,
  skus: readonly string[],
  dados: DadosLoteEstoqueAmazon,
  raiz: RaizLoteAmazon,
): Promise<{ readonly tarefas: number }> {
  const contaId = ctx.contexto.integracaoId;
  let tarefas: TarefaEstoqueAmazon[];
  if (dados.tipo === TIPO_LOTE_FEED_AMAZON.janela) {
    const observacoes = skus.flatMap((sku) => {
      const o = dados.observacoes.get(sku);
      return o === undefined ? [] : [o];
    });
    ({ tarefas } = tarefasDasObservacoes(contaId, observacoes, entrada.execucaoId));
  } else {
    tarefas = skus.flatMap((sku) => {
      const m = dados.membros.get(sku);
      if (m === undefined || m.depositoId === null) return [];
      const t = tarefaEstoqueAmazonSchema.safeParse({
        v: VERSAO_TAREFA_ESTOQUE_AMAZON,
        contaId,
        sku,
        origem: ORIGEM_TAREFA_ESTOQUE_AMAZON.reconciliacao,
        referencia: entrada.execucaoId,
        depositoId: m.depositoId,
      });
      return t.success ? [t.data] : [];
    });
  }
  if (tarefas.length === 0) return { tarefas: 0 };
  const lote = await raiz.produtorEstoque().enfileirarLote(tarefas);
  return { tarefas: lote.enfileiradas + lote.jaEnfileiradas };
}
