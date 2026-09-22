/**
 * The MANUAL stock push — "enviar estoque agora" for a hand-picked set of
 * produtos, as opposed to the three scheduled sweeps.
 *
 * Shape, and how it differs from a sweep tick:
 *
 *  - **Synchronous, in-process, no job document.** The work is bounded at
 *    {@link SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS} by construction, so it needs
 *    neither a job document nor a poll route: the acceptance is a per-LISTING
 *    outcome and enqueueing would answer a latency complaint with more latency.
 *  - **Force-send.** No ledger pre-pass and no `deveEnviarFamiliaShopee`: the
 *    operator is asserting the published number is wrong. On this channel the
 *    argument is stronger than on Mercado Livre — Shopee RESTORES stock by
 *    itself when an order is cancelled, so "unchanged since our last send" was
 *    never a safe skip here. It also runs with `ignoreSyncFlag: true`, so the
 *    button works before the sweep valve flips.
 *  - **Sends through {@link processShopeeStockSendTask} verbatim.** That handler
 *    already owns the pause gate, the payload schema, the reserved floor, the
 *    whole error ladder and every write-back. A second sender would be a second
 *    place for the sent quantity to drift.
 *
 * ⚠️ **The rungs this module does NOT run.** `conta-fora-do-produto`, `sem-link`
 * and the whole per-link send gate belong to {@link montarTarefasDeEstoqueShopee};
 * the five conta gates belong to the sweep. Re-deriving any of them here would
 * be a second copy of a decision that already has a home, and the copies drift
 * toward plausible. What this module owns is the ACCOUNTING: every requested
 * produto leaves in exactly one list.
 *
 * ⚠️ **The retry ladder is load-bearing, not ceremony.** `retryCount: 0` on a
 * single call lets a transient refusal escape with nothing recorded; a single
 * call at the queue's last attempt latches a listing on one blip. The ladder
 * below maps its OWN last attempt onto `STOCK_SEND_MAX_ATTEMPTS - 1` and every
 * earlier one onto `0`, which decouples the two caps and still never acts on one
 * sample.
 *
 * ⚠️ **The deadline runs on ELAPSED wall clock, through the INJECTED
 * {@link DepsEnvioManual.agora}.** `nowMs` is the request's ONE logical instant
 * and is injected — tests pin it, and the task payload is stamped from it — so
 * measuring the budget as `nowMs + orçamento` mixes two clock domains: any
 * injected value in the past trips the deadline on the very first listing and
 * reports the whole run as not attempted. Injecting the elapsed clock as a
 * FUNCTION turns that trap into a type error, and it keeps this folder's
 * clock-discipline grep a clean, exception-free EMPTY.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  SHOPEE_ERROR_KIND,
  ShopeeConfigError,
  ShopeeError,
  ShopeeRateLimitError,
  ShopeeReauthRequiredError,
  type ShopeeClient,
} from '@delfrance/integrations-shopee';
import { produtoCollection } from '@delfrance/data/admin/collections';
import { idFromRef } from '@delfrance/schemas';

import { proximaViradaDaCotaMs } from '../anuncios/pausarAnuncio';
import {
  ENVIO_MANUAL_MAX_TENTATIVAS,
  ENVIO_MANUAL_RETRY_DELAY_MS,
  SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS,
  STOCK_SEND_MAX_ATTEMPTS,
  concurrentDispatches,
  manualConcurrencyRaw,
  manualDeadlineMs,
  ratePauseMin,
} from './constantesEstoque';
import {
  CODIGO_GUARDA_ENVIO,
  MENSAGEM_POR_MOTIVO,
  MOTIVO_ESTOQUE_SHOPEE,
  RESULTADO_MODELO,
  ShopeeEnvioEstoqueGuardError,
  ShopeeStockTasksDisabledError,
  type LinhaDeModeloEnviada,
  type MotivoEstoqueShopee,
} from './errosEstoque';
import {
  OUTCOME_ENVIO_ESTOQUE,
  processShopeeStockSendTask,
  type ResultadoEnvioEstoqueShopee,
} from './enviarEstoque';
import { buscarFamiliasShopeePorIds, type BuscarFamiliasShopeePorIds } from './descobertaEstoque';
import { lerEstadoEstoque } from './estadoEstoque';
import {
  montarTarefasDeEstoqueShopee,
  type PuloDeEstoque,
  type TarefaDeEstoqueShopee,
} from './planoEstoque';
import { quantidadesDaFamiliaShopee } from './quantidadeEstoque';
import type { AgendadorEstoqueShopee } from './shopeeStockTasks';

/** Seconds to milliseconds, in one named place. */
const MS_POR_SEGUNDO = 1_000;

/* -------------------------------------------------------------------------- */
/*                                 the envelope                                */
/* -------------------------------------------------------------------------- */

/**
 * FOUR outcomes, never five.
 *
 * ⚠️ A PARTIAL send is tempting to call `'parcial'` and must not be: the web
 * side's `PushOutcome` is SHARED with the price push and one dialog renders
 * both, so a fifth member is a cost this step would force onto every consumer.
 * A partial is `'falha'` with `motivo: 'envio-parcial'` and no quantity — a
 * success to the queue is still a failure to the operator who asked for the
 * number to be right.
 */
export type EnvioEstoqueOutcome = 'enviado' | 'pulado' | 'falha' | 'nao-tentado';

/** One LISTING's row. The send unit is the item, so never one row per model. */
export interface EnvioEstoqueListing {
  /**
   * The REQUESTED produto — the family anchor that owns the listing.
   *
   * ⚠️ Always the anchor, even for a line the planner raised about one child
   * model: the accounting invariant is a set equality against what the caller
   * asked for, and a child id appearing here would make the envelope claim a
   * produto nobody selected. The child travels in {@link variacoes}.
   */
  readonly produtoId: string;
  readonly produtoNome: string | null;
  /** Permanently `null` — the send unit is the ITEM, carrying up to 50 models. */
  readonly variacaoProdutoId: null;
  /** `String(item_id)`, or `null` when the listing never had one. */
  readonly anuncioId: string | null;
  readonly linkDocId: string | null;
  readonly outcome: EnvioEstoqueOutcome;
  /** A `MotivoEstoqueShopee` slug; `null` only on a clean, unclamped send. */
  readonly motivo: string | null;
  /** RENDERED pt-BR, always. Never a slug and never provider prose. */
  readonly mensagem: string;
  /** What was SENT; `null` whenever nothing was. */
  readonly quantidade: number | null;
  /** One row per model the call carried, in the payload's order. */
  readonly variacoes: readonly LinhaDeModeloEnviada[];
  /** Models Shopee refused inside an otherwise accepted call. */
  readonly modelosRecusados: number;
  /** Models whose quantity was raised to a promotion's reserved floor. */
  readonly clampados: number;
  /**
   * Permanently `null`.
   *
   * Mercado Livre's re-arm exists to clear an error latch it stores on the link;
   * this channel has no such latch — a refusal here is a fingerprint that the
   * next reading clears by itself — so there is nothing to re-arm. The key stays
   * so the web provider is the ML one with the canal literal swapped.
   */
  readonly rearme: null;
}

/** A requested produto that produced no listing at all, and why. */
export interface EnvioEstoqueSemEnvio {
  readonly produtoId: string;
  readonly produtoNome: string | null;
  readonly motivo: string;
  readonly mensagem: string;
}

export interface EnvioEstoqueResponse {
  readonly canal: 'shopee';
  readonly integracaoId: string;
  readonly contaNome: string | null;
  /** The DEDUPED request size. */
  readonly solicitados: number;
  /** Families discovery actually returned. */
  readonly familias: number;
  readonly resumo: {
    readonly enviados: number;
    readonly pulados: number;
    readonly falhas: number;
    readonly naoTentados: number;
  };
  readonly listings: readonly EnvioEstoqueListing[];
  readonly produtosSemEnvio: readonly EnvioEstoqueSemEnvio[];
  /** ISO-8601 — set when the conta is paused; the rest was not attempted. */
  readonly pausadoAte: string | null;
}

/**
 * The key sets, declared as data.
 *
 * ⚠️ FIVE lists, not one: a key added to a per-listing row would still leave
 * through an envelope-only assertion, and the per-MODEL rows are the level that
 * carries the provider's own attribution — its verbatim `failed_reason` in
 * `codigo`. The route builds its body BY NAME at every level and the tests
 * compare `Object.keys().sort()` against these.
 */
export const CHAVES_DO_ENVELOPE = [
  'canal',
  'integracaoId',
  'contaNome',
  'solicitados',
  'familias',
  'resumo',
  'listings',
  'produtosSemEnvio',
  'pausadoAte',
] as const;

export const CHAVES_DO_RESUMO = ['enviados', 'pulados', 'falhas', 'naoTentados'] as const;

export const CHAVES_DA_LISTAGEM = [
  'produtoId',
  'produtoNome',
  'variacaoProdutoId',
  'anuncioId',
  'linkDocId',
  'outcome',
  'motivo',
  'mensagem',
  'quantidade',
  'variacoes',
  'modelosRecusados',
  'clampados',
  'rearme',
] as const;

export const CHAVES_SEM_ENVIO = ['produtoId', 'produtoNome', 'motivo', 'mensagem'] as const;

/**
 * The per-MODEL row — the eleven keys of `LinhaDeModeloEnviada`.
 *
 * ⚠️ This is the level the other four cannot see. A response double whose
 * `variacoes` is empty leaves the route's innermost projection unasserted, and
 * a leak check over the whole body only catches a planted STRING — a number or
 * a boolean added here sails through it. It is also the level that holds
 * Shopee's own words (`codigo` is the verbatim `failed_reason`), so a key added
 * upstream and forwarded blindly is how provider prose leaves the building.
 */
export const CHAVES_DO_MODELO = [
  'modelId',
  'produtoId',
  'varLinkDocId',
  'quantidadeSolicitada',
  'quantidadeEnviada',
  'resultado',
  'motivo',
  'codigo',
  'mensagem',
  'clampado',
  'piso',
] as const;

/**
 * The ONE sentence a clean send gets.
 *
 * ⚠️ It lives here rather than in `MENSAGEM_POR_MOTIVO` because that map is a
 * vocabulary of REFUSALS plus one annotation: it deliberately has no member for
 * "it worked", and adding one would give every refusal-counting reader a value
 * it has to special-case. Every other `mensagem` in this module is that map's
 * lookup, verbatim, and a test asserts it.
 */
export const MENSAGEM_ENVIO_LIMPO = 'Estoque enviado à Shopee.';

/* -------------------------------------------------------------------------- */
/*                                   the deps                                  */
/* -------------------------------------------------------------------------- */

export interface DepsEnvioManual {
  /** MILLISECONDS — the request's ONE logical instant, injected. */
  readonly nowMs: number;
  /**
   * The ELAPSED clock. Read at the start and before each listing; never
   * confused with {@link nowMs}. See the module docblock for the trap.
   */
  readonly agora: () => number;
  /** The wait between ladder attempts. Injected so this folder holds no timer. */
  readonly esperar: (ms: number) => Promise<void>;
  /** The conta document, already loaded by the caller. */
  readonly conta: Readonly<Record<string, unknown>>;
  readonly contaNome: string | null;
  /** ONE shop-signed client for the whole request. */
  readonly client: ShopeeClient;
  /** The avisos counter sentinel, built by the caller that owns the admin import. */
  readonly increment: (by: number) => unknown;
  /** Injectable purely so tests never go near the real pipeline. */
  readonly buscarFamilias?: BuscarFamiliasShopeePorIds;
  /** Injectable purely so tests never go near the real handler. */
  readonly enviarTarefa?: typeof processShopeeStockSendTask;
}

export interface ArgsEnvioManual {
  readonly integracaoId: string;
  readonly produtoIds: readonly string[];
  /**
   * Bypass the per-link skip set — and NOTHING else.
   *
   * It is the one documented way past the refusal fingerprint, for an operator
   * who has just fixed the listing in Seller Centre and cannot wait for the
   * reading to move on its own. A removed listing, a native kit or an unpublished
   * link still refuse with it on.
   */
  readonly reenviarComErro: boolean;
}

/* -------------------------------------------------------------------------- */
/*                              the small helpers                              */
/* -------------------------------------------------------------------------- */

/**
 * The bounded pool. ~30 lines here rather than a shared helper because this app
 * has none yet; promote it the day a second folder needs one.
 *
 * ⚠️ **`allSettled`, never `all`.** `Promise.all` settles on the FIRST
 * rejection while every sibling worker keeps pulling off the shared cursor, so
 * a throw would let the run answer its caller — the route has already built and
 * flushed its error body by then — while later listings were still calling
 * `update_stock` and patching link documents, in a response that reports
 * neither. Waiting for all of them costs nothing, because the one caller that
 * throws sets its abort flag first and every remaining iteration
 * short-circuits. The first rejection, in WORKER order, is then rethrown
 * unchanged.
 */
async function executarEmPool<T>(
  itens: readonly T[],
  largura: number,
  executar: (item: T, indice: number) => Promise<void>,
): Promise<void> {
  let proximo = 0;
  const trabalhador = async (): Promise<void> => {
    for (;;) {
      const indice = proximo;
      proximo += 1;
      const item = itens[indice];
      if (item === undefined) return;
      await executar(item, indice);
    }
  };
  const trabalhadores = Math.min(Math.max(1, largura), Math.max(1, itens.length));
  const saidas = await Promise.allSettled(
    Array.from({ length: trabalhadores }, () => trabalhador()),
  );
  for (const saida of saidas) {
    if (saida.status === 'rejected') throw saida.reason;
  }
}

/**
 * ⚠️ CLAMPED to the queue's own width, never merely defaulted to it. A burst
 * wider than the deployed queue earns a rate limit, which arms the pause and
 * breaks the unattended SWEEP for the whole conta — so a misconfigured
 * environment variable must not be able to violate the invariant. The floor of 1
 * keeps a `0` or a negative value from deadlocking the pool.
 */
export function concorrenciaEnvioManual(): number {
  return Math.max(1, Math.min(manualConcurrencyRaw(), concurrentDispatches()));
}

/**
 * The pause gate inside the send handler defers past a pause by enqueueing.
 * Doing that behind an operator's back is wrong — the manual push must SAY the
 * conta is paused — so it gets a scheduler that refuses.
 *
 * ⚠️ It must reject with {@link ShopeeStockTasksDisabledError} specifically:
 * that is the only class the handler's pause and burst arms narrow, and anything
 * else rethrows unclassified.
 */
const agendadorQueRecusa: AgendadorEstoqueShopee = {
  enqueue() {
    return Promise.reject(new ShopeeStockTasksDisabledError());
  },
};

/** The produto names for the requested ids — one read each, bounded at the cap. */
async function nomesDosProdutos(
  db: Firestore,
  produtoIds: readonly string[],
): Promise<Map<string, string | null>> {
  const pares = await Promise.all(
    produtoIds.map(async (produtoId): Promise<[string, string | null]> => {
      const snap = await produtoCollection.docRef(db, {}, produtoId).get();
      const bruto = (snap.data() ?? {}) as Record<string, unknown>;
      const nome = bruto['nome'];
      return [produtoId, typeof nome === 'string' && nome.trim() !== '' ? nome : null];
    }),
  );
  return new Map(pares);
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/* -------------------------------------------------------------------------- */
/*                              the outcome table                              */
/* -------------------------------------------------------------------------- */

/**
 * Map one send result onto the envelope's four outcomes. Pure, exported and
 * table-tested.
 *
 * `'erro-registrado'` maps to `falha`, not to success: it is a SUCCESS to the
 * queue (the state was recorded, stop retrying) and a FAILURE to the operator,
 * who asked for the quantity to reach Shopee and it did not.
 *
 * ⚠️ `'descartado'` with `tasks-desabilitadas` is the shape the refusing
 * scheduler produces when the handler's pause or burst arm tries to defer, so it
 * renders as `conta-pausada` — which is also the motivo this module watches for
 * to abort the rest of the run.
 */
export function paraOutcomeDeEnvio(r: ResultadoEnvioEstoqueShopee): {
  outcome: EnvioEstoqueOutcome;
  motivo: MotivoEstoqueShopee | null;
} {
  switch (r.outcome) {
    case OUTCOME_ENVIO_ESTOQUE.enviado:
      // `motivo` is null on a clean send and `clampado-na-reserva` on a clamped
      // one — an ANNOTATION, never a refusal, so the outcome stays `enviado`.
      return { outcome: 'enviado', motivo: r.motivo };
    case OUTCOME_ENVIO_ESTOQUE.enviadoParcial:
      return { outcome: 'falha', motivo: MOTIVO_ESTOQUE_SHOPEE.envioParcial };
    case OUTCOME_ENVIO_ESTOQUE.pulado:
      return { outcome: 'pulado', motivo: r.motivo ?? MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida };
    case OUTCOME_ENVIO_ESTOQUE.erroRegistrado:
      return { outcome: 'falha', motivo: r.motivo ?? MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida };
    case OUTCOME_ENVIO_ESTOQUE.descartado:
      return r.motivo === MOTIVO_ESTOQUE_SHOPEE.tasksDesabilitadas
        ? { outcome: 'nao-tentado', motivo: MOTIVO_ESTOQUE_SHOPEE.contaPausada }
        : {
            outcome: 'nao-tentado',
            motivo: r.motivo ?? MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida,
          };
    case OUTCOME_ENVIO_ESTOQUE.pausadoReenfileirado:
      return { outcome: 'nao-tentado', motivo: r.motivo ?? MOTIVO_ESTOQUE_SHOPEE.contaPausada };
  }
}

/** The rendered sentence for a row. One lookup, one exception, no fallback. */
function mensagemDe(motivo: MotivoEstoqueShopee | null): string {
  return motivo === null ? MENSAGEM_ENVIO_LIMPO : MENSAGEM_POR_MOTIVO[motivo];
}

/* -------------------------------------------------------------------------- */
/*                                  the ladder                                 */
/* -------------------------------------------------------------------------- */

/**
 * The bounded inline ladder (module docblock). A rate limit breaks out
 * immediately — hammering a limited conta is the one thing this must never do.
 */
async function enviarComLadder(
  db: Firestore,
  tarefa: TarefaDeEstoqueShopee,
  deps: DepsEnvioManual,
  enviarTarefa: typeof processShopeeStockSendTask,
): Promise<ResultadoEnvioEstoqueShopee> {
  let ultimoErro: unknown = null;
  for (let tentativa = 0; tentativa < ENVIO_MANUAL_MAX_TENTATIVAS; tentativa += 1) {
    const ultima = tentativa === ENVIO_MANUAL_MAX_TENTATIVAS - 1;
    try {
      return await enviarTarefa(db, tarefa, {
        scheduler: agendadorQueRecusa,
        nowMs: deps.nowMs,
        increment: deps.increment,
        retryCount: ultima ? STOCK_SEND_MAX_ATTEMPTS - 1 : 0,
        // The manual push works before the sweep valve flips — that is the whole
        // point of the button, and the queue never sets this.
        ignoreSyncFlag: true,
        // This path never re-enqueues, so jitter is meaningless; pinning it to 0
        // keeps every delay in the tests deterministic.
        jitterSec: () => 0,
        clientFor: () => Promise.resolve(deps.client),
      });
    } catch (err) {
      if (err instanceof ShopeeRateLimitError) throw err;
      ultimoErro = err;
      if (ultima) throw err;
      await deps.esperar(ENVIO_MANUAL_RETRY_DELAY_MS);
    }
  }
  // Unreachable: the loop either returns or throws on its last iteration.
  throw ultimoErro instanceof Error ? ultimoErro : new Error('envio manual de estoque falhou');
}

/* -------------------------------------------------------------------------- */
/*                                   the run                                   */
/* -------------------------------------------------------------------------- */

/** One planned unit: either a row that is already final, or a task to send. */
interface Entrada {
  readonly produtoId: string;
  readonly tarefa: TarefaDeEstoqueShopee | null;
  readonly linha: EnvioEstoqueListing | null;
}

function linhaDePulo(
  produtoId: string,
  produtoNome: string | null,
  pulo: PuloDeEstoque,
): EnvioEstoqueListing {
  return {
    produtoId,
    produtoNome,
    variacaoProdutoId: null,
    anuncioId: pulo.itemId === null ? null : String(pulo.itemId),
    linkDocId: pulo.linkDocId,
    outcome: 'pulado',
    motivo: pulo.motivo,
    mensagem: pulo.mensagem,
    quantidade: null,
    variacoes: [],
    modelosRecusados: 0,
    clampados: 0,
    rearme: null,
  };
}

function linhaBase(
  produtoNome: string | null,
  tarefa: TarefaDeEstoqueShopee,
): Omit<EnvioEstoqueListing, 'outcome' | 'motivo' | 'mensagem'> {
  return {
    produtoId: tarefa.produtoId,
    produtoNome,
    variacaoProdutoId: null,
    anuncioId: String(tarefa.itemId),
    linkDocId: tarefa.linkDocId,
    quantidade: null,
    variacoes: [],
    modelosRecusados: 0,
    clampados: 0,
    rearme: null,
  };
}

/**
 * The two planner rungs that mean "this produto has no listing on this conta at
 * all". They are the ONLY skips that belong in `produtosSemEnvio` rather than in
 * a listing row, and both return from the planner immediately — so a plan that
 * consists of exactly one of them and no task is the whole family's verdict.
 */
const MOTIVOS_SEM_LISTAGEM: ReadonlySet<MotivoEstoqueShopee> = new Set<MotivoEstoqueShopee>([
  MOTIVO_ESTOQUE_SHOPEE.contaForaDoProduto,
  MOTIVO_ESTOQUE_SHOPEE.semLink,
]);

/**
 * ⚠️ THE ACCOUNTING INVARIANT — the reason this module exists at all. Every
 * requested produto leaves in exactly ONE of the two lists, and neither list
 * carries an id nobody asked for. A produto that silently vanishes under a green
 * summary is the failure this whole area is built against, so it is asserted in
 * code and it THROWS rather than logging.
 */
function conferirContabilidade(
  solicitados: readonly string[],
  listings: readonly EnvioEstoqueListing[],
  semEnvio: readonly EnvioEstoqueSemEnvio[],
): void {
  const pedidos = new Set(solicitados);
  const cobertos = new Set<string>();
  for (const l of listings) cobertos.add(l.produtoId);
  for (const s of semEnvio) {
    if (cobertos.has(s.produtoId)) {
      throw new Error(
        `envio manual de estoque: ${s.produtoId} aparece nas DUAS listas — contabilidade quebrada`,
      );
    }
    cobertos.add(s.produtoId);
  }
  for (const id of pedidos) {
    if (!cobertos.has(id)) {
      throw new Error(
        `envio manual de estoque: ${id} foi solicitado e não aparece em nenhuma lista`,
      );
    }
  }
  for (const id of cobertos) {
    if (!pedidos.has(id)) {
      throw new Error(`envio manual de estoque: ${id} não foi solicitado e aparece no envelope`);
    }
  }
}

function montarResposta(
  integracaoId: string,
  contaNome: string | null,
  solicitados: number,
  familias: number,
  listings: readonly EnvioEstoqueListing[],
  produtosSemEnvio: readonly EnvioEstoqueSemEnvio[],
  pausadoAte: string | null,
): EnvioEstoqueResponse {
  return {
    canal: 'shopee',
    integracaoId,
    contaNome,
    solicitados,
    familias,
    resumo: {
      enviados: listings.filter((l) => l.outcome === 'enviado').length,
      pulados: listings.filter((l) => l.outcome === 'pulado').length,
      falhas: listings.filter((l) => l.outcome === 'falha').length,
      naoTentados: listings.filter((l) => l.outcome === 'nao-tentado').length,
    },
    listings,
    produtosSemEnvio,
    pausadoAte,
  };
}

export async function enviarEstoqueManualShopee(
  db: Firestore,
  args: ArgsEnvioManual,
  deps: DepsEnvioManual,
): Promise<EnvioEstoqueResponse> {
  const buscarFamilias = deps.buscarFamilias ?? buscarFamiliasShopeePorIds;
  const enviarTarefa = deps.enviarTarefa ?? processShopeeStockSendTask;

  const solicitados = [...new Set(args.produtoIds)];
  // ⚠️ Asserted, not enforced: the route refuses an oversize selection first,
  // with the limit and the count, because this class maps to a 500 and "server
  // misconfig" is the wrong answer for an operator who selected too many rows.
  // Reachable only from a caller that is not the route.
  if (solicitados.length > SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS) {
    throw new ShopeeConfigError(
      `envio manual de estoque: ${String(solicitados.length)} produtos excedem o limite de ${String(
        SHOPEE_ENVIO_ESTOQUE_MAX_PRODUTOS,
      )}`,
    );
  }

  // The depósito guard. The route refuses a blank reference first; what it
  // cannot see is a non-blank reference that yields no document id.
  const depositoRef = deps.conta['depositoOuterRef'];
  const depositoId =
    typeof depositoRef === 'string' && depositoRef.trim() !== '' ? idFromRef(depositoRef) : '';
  if (depositoId === '') {
    throw new ShopeeEnvioEstoqueGuardError(
      CODIGO_GUARDA_ENVIO.contaSemDeposito,
      MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.semDeposito],
    );
  }

  const listings: EnvioEstoqueListing[] = [];
  const produtosSemEnvio: EnvioEstoqueSemEnvio[] = [];

  if (solicitados.length === 0) {
    // The by-ids reader THROWS on an empty list by contract; short-circuit.
    return montarResposta(
      args.integracaoId,
      deps.contaNome,
      0,
      0,
      listings,
      produtosSemEnvio,
      null,
    );
  }

  const nomes = await nomesDosProdutos(db, solicitados);
  const nomeDe = (produtoId: string): string | null => nomes.get(produtoId) ?? null;

  const rows = await buscarFamilias(db, {
    integracaoId: args.integracaoId,
    depositoId,
    produtoIds: solicitados,
  });
  const rowPorAnchor = new Map(rows.map((r) => [r.anchorId, r]));

  // The plan, in REQUEST order — so the envelope's rows come back in the order
  // the operator selected them however the pool interleaves the sends.
  const entradas: Entrada[] = [];
  for (const produtoId of solicitados) {
    const row = rowPorAnchor.get(produtoId);
    if (row === undefined) {
      // No row: the requested document does not exist.
      produtosSemEnvio.push({
        produtoId,
        produtoNome: nomeDe(produtoId),
        motivo: MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado,
        mensagem: MENSAGEM_POR_MOTIVO[MOTIVO_ESTOQUE_SHOPEE.produtoNaoEncontrado],
      });
      continue;
    }

    const plano = montarTarefasDeEstoqueShopee(row, quantidadesDaFamiliaShopee(row), {
      integracaoId: args.integracaoId,
      // Deterministic and self-describing in the send handler's own log lines.
      sweepId: `manual-${args.integracaoId}-${String(deps.nowMs)}`,
      // Manual quantities are computed NOW, so the handler reads an age of ~0.
      sweepComputadoEmMs: deps.nowMs,
      nowMs: deps.nowMs,
      ignorarRecusa: args.reenviarComErro,
    });

    const semListagem =
      plano.tarefas.length === 0 &&
      plano.pulos.length > 0 &&
      plano.pulos.every((p) => MOTIVOS_SEM_LISTAGEM.has(p.motivo));
    if (semListagem) {
      // ⚠️ The motivo and the sentence are the PLANNER's, never re-derived here.
      const primeiro = plano.pulos[0];
      if (primeiro !== undefined) {
        produtosSemEnvio.push({
          produtoId,
          produtoNome: nomeDe(produtoId),
          motivo: primeiro.motivo,
          mensagem: primeiro.mensagem,
        });
      }
      continue;
    }

    for (const pulo of plano.pulos) {
      entradas.push({
        produtoId,
        tarefa: null,
        linha: linhaDePulo(produtoId, nomeDe(produtoId), pulo),
      });
    }
    for (const tarefa of plano.tarefas) {
      entradas.push({ produtoId, tarefa, linha: null });
    }
  }

  // ⚠️ ELAPSED wall clock, from HERE, through the injected reader.
  const inicioMs = deps.agora();
  const orcamentoMs = manualDeadlineMs();
  const resolvidas = new Array<EnvioEstoqueListing | null>(entradas.length).fill(null);
  let abortado = false;
  let pausadoAte: string | null = null;

  const paraEnviar: { entrada: Entrada; indice: number }[] = [];
  entradas.forEach((entrada, indice) => {
    if (entrada.linha !== null) resolvidas[indice] = entrada.linha;
    else paraEnviar.push({ entrada, indice });
  });

  /** Where an escaping rate limit says the conta re-opens. */
  const pausaDeUmLimite = async (err: ShopeeRateLimitError): Promise<number> => {
    if (err.kind === SHOPEE_ERROR_KIND.daily) {
      // The daily quota resets at a fixed wall-clock instant; the header says
      // less than the documented reset does. IMPORTED, never re-derived.
      return proximaViradaDaCotaMs(deps.nowMs);
    }
    // A burst the handler ARMED is already on the state document, and that is
    // the window actually enforced; re-read it rather than guessing. One that
    // escaped before arming leaves nothing there, so the header (or the
    // configured pause) is the honest fallback — counted from the LOGICAL
    // instant, like the daily arm and the comparison above: this is an epoch
    // stamp the envelope renders, and the elapsed reader is only ever
    // subtracted from itself (module docblock).
    const estado = await lerEstadoEstoque(db, args.integracaoId);
    if (estado.pausadoAte !== null && estado.pausadoAte > deps.nowMs) return estado.pausadoAte;
    return deps.nowMs + (err.retryAfterSeconds ?? ratePauseMin() * 60) * MS_POR_SEGUNDO;
  };

  await executarEmPool(paraEnviar, concorrenciaEnvioManual(), async ({ entrada, indice }) => {
    const tarefa = entrada.tarefa;
    if (tarefa === null) return;
    const base = linhaBase(nomeDe(entrada.produtoId), tarefa);

    if (abortado || deps.agora() - inicioMs > orcamentoMs) {
      const motivo = abortado
        ? MOTIVO_ESTOQUE_SHOPEE.contaPausada
        : MOTIVO_ESTOQUE_SHOPEE.tempoEsgotado;
      resolvidas[indice] = {
        ...base,
        outcome: 'nao-tentado',
        motivo,
        mensagem: mensagemDe(motivo),
      };
      return;
    }

    try {
      const r = await enviarComLadder(db, tarefa, deps, enviarTarefa);
      const { outcome, motivo } = paraOutcomeDeEnvio(r);
      resolvidas[indice] = {
        ...base,
        outcome,
        motivo,
        mensagem: mensagemDe(motivo),
        quantidade: outcome === 'enviado' ? r.quantidadeEnviada : null,
        variacoes: r.modelos,
        modelosRecusados: r.modelos.filter((m) => m.resultado === RESULTADO_MODELO.recusado).length,
        clampados: r.modelos.filter((m) => m.clampado).length,
      };
      // ⚠️ On the PAUSE the handler reports, whichever slug it carries — never
      // on `conta-pausada` alone. The handler CONTAINS a daily quota (it arms
      // the pause itself and RETURNS `descartado` + `cota-diaria` + the
      // rollover), and so do the holiday, warehouse and shop-shape arms: none
      // of those ever throws, so the `ShopeeRateLimitError` rung below cannot
      // see them. Matching one slug left the run going and answered a 200 whose
      // `pausadoAte` was `null` while the state document this very call had
      // just written said the conta is blocked until the quota rolls over.
      if (outcome === 'nao-tentado' && r.pausadoAte !== null) {
        abortado = true;
        pausadoAte = iso(r.pausadoAte);
      }
    } catch (err) {
      // ⚠️ MOST DERIVED FIRST. All three of these sit in one `instanceof` chain
      // and a bare test of the base class above them swallows the other two.
      if (err instanceof ShopeeRateLimitError) {
        abortado = true;
        pausadoAte = iso(await pausaDeUmLimite(err));
        const motivo = MOTIVO_ESTOQUE_SHOPEE.contaPausada;
        resolvidas[indice] = {
          ...base,
          outcome: 'nao-tentado',
          motivo,
          mensagem: mensagemDe(motivo),
        };
        return;
      }
      // A dead grant stops the WHOLE run: every remaining listing would fail
      // identically, and the only useful answer is "reconnect the conta", which
      // the route renders as its own status.
      //
      // ⚠️ `abortado` FIRST, on both rethrows. The pool waits for its workers,
      // but the siblings are still pulling off the shared cursor while this one
      // unwinds: without the flag they would keep spending `update_stock` calls
      // for a run whose answer is already decided, and those sends would appear
      // in no envelope at all, since a throw means `montarResposta` never runs.
      if (err instanceof ShopeeReauthRequiredError) {
        abortado = true;
        throw err;
      }
      // A caller bug (a malformed request WE built) must never be contained as a
      // provider condition — it is the one exclusion from the package's base.
      if (err instanceof ShopeeError && !(err instanceof ShopeeConfigError)) {
        const motivo = MOTIVO_ESTOQUE_SHOPEE.recusaDesconhecida;
        resolvidas[indice] = { ...base, outcome: 'falha', motivo, mensagem: mensagemDe(motivo) };
        return;
      }
      abortado = true;
      throw err;
    }
  });

  for (const linha of resolvidas) {
    if (linha !== null) listings.push(linha);
  }

  conferirContabilidade(solicitados, listings, produtosSemEnvio);

  return montarResposta(
    args.integracaoId,
    deps.contaNome,
    solicitados.length,
    rows.length,
    listings,
    produtosSemEnvio,
    pausadoAte,
  );
}
