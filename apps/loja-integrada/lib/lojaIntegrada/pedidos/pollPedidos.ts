/**
 * The 5-minute ORDER POLLER (master plan step 3, PR 3-e): one tick, and one
 * conta's run inside it. The guaranteed intake path (D13): it lists the orders
 * Loja Integrada says changed since a durable cursor, and enqueues ONE
 * synthetic notification per changed order onto the reads queue — ids only, the
 * importer re-fetches the order (step 5). Nothing here maps an order.
 *
 * The functions codebase's root (`functions/src/pollPedidos.ts`) binds every
 * dependency, the environment included: nothing under `lib/lojaIntegrada` reads
 * the process environment (`estrutura.test.ts`).
 *
 * ## One tick ({@link executarPollPedidosLi}), in order
 *
 *  1. **Importer gate.** No importer in the seam (`importadorPresente`, bound by
 *     the root to `importadorPedidoLi() !== null`) ⇒ one INFO line, ZERO reads.
 *     Every notification would park as `importador-ausente`, so polling now
 *     would only mint one terminal row per order (the Shopee backfill guard).
 *  2. **Read switch.** Not exactly `on` ⇒ one `chamada-bloqueada` line, zero
 *     reads. The context checks it again (defence in depth).
 *  3. **Enumerate** with `listarContasLojaIntegrada` — inactive contas are
 *     skipped in code, and a tipo-3 conta with no `nome` never comes back
 *     (`core/contas.ts`, a pre-cutover check of the window).
 *  4. **Per conta, sequentially**, each with min(100 s, what the tick's 220 s
 *     have left); one that would start with less than one page's planned cost
 *     is `sem-tempo` (nothing written; the next tick reaches it). Containment
 *     is per conta and covers a gRPC status error ONLY (`isGrpcStatusError`):
 *     anything else fails the tick loudly.
 *
 * ## One conta's run ({@link executarContaPollLi})
 *
 *  1. The id must match `contaIdLiSchema` (the task payload's own grammar),
 *     else a refusal record `id-de-conta-invalido`.
 *  2. The context (`registro { fluxo: 'poll' }`): gone, inactive, switch off or
 *     parked ⇒ nothing written (a park has its own aviso); a missing or corrupt
 *     credential ⇒ a refusal record.
 *  3. The poll document. Cursorless with an invalid look-back ⇒ a refusal
 *     record `lookback-invalido`; a stored cursor is unaffected.
 *  4. The LEASE on `pollPedidosLojaIntegrada/{id}`: `create` when absent, else
 *     `update({ emExecucaoAteMs, execucaoId }, { lastUpdateTime })` and only
 *     when the stored lease has EXPIRED (`emExecucaoAteMs <= agora`).
 *     ALREADY_EXISTS or FAILED_PRECONDITION ⇒ another run holds it: exit with
 *     zero calls. A cursorless document gets the bootstrap bound as its cursor
 *     IN this write, so repeated failures never slide the bootstrap forward.
 *     The lease's commit time is this run's aviso clock.
 *  5. The DRAIN: `paginarLi` over `GET /v1/pedido/search/`, at most
 *     `MAX_PAGINAS_POLL` pages, under a budget signal that aborts with
 *     {@link LiOrcamentoPollEsgotadoError} — caught by CLASS.
 *  6. Per row: enqueued when its stamp is newer than `vistos` (`janelaPoll.ts`).
 *     A transient or switched-off enqueue (`LiTarefasTransitoriasError`,
 *     `LiTarefasDesligadasError`) is persisted `failed` for the sweep (a
 *     deterministic doc id, so a re-poll never forks); any other enqueue
 *     failure is a broken deploy and fails the tick; a failed persist aborts
 *     the run (nothing more written, the lease expires).
 *  7. The aviso step, still holding the lease, clocked by its commit time.
 *  8. The FINAL write, `update(…, { lastUpdateTime: <the lease's write time> })`:
 *     the lease released, the cursor (forward only), `vistos`, the counters.
 *     On FAILED_PRECONDITION it re-reads ONCE: another run's lease ⇒ nothing
 *     written (a WARNING); still ours ⇒ re-derived from the re-read
 *     (`max(cursor)`, merged `vistos`) and retried once.
 *
 * ## What each outcome writes
 *
 * | outcome | cursor | `vistos` | `falhasSeguidas` | aviso |
 * | --- | --- | --- | --- | --- |
 * | success (drained, consistent) / empty window | advances / kept | merged, pruned | 0 once the resolve returned | resolve only if the stored value was > 0 |
 * | `conta-parada` mid-drain | kept | STORED kept (this run's additions dropped) | unchanged | none |
 * | `orcamento-esgotado` with ≥ 1 new row | kept | merged | unchanged | none |
 * | any other counted failure | kept | merged | +1 | at {@link LIMIAR_AVISO_IMPORTACAO_PARADA_LI} |
 * | refusal record | — | — | +1 | at the threshold |
 * | inactive, switch off, lease busy, conta gone, parked at start, `sem-tempo` | nothing written | | | none |
 *
 * `conta-parada` mid-drain covers the getter finding the conta unusable — parked
 * by another task, its token removed or unreadable — as well as a 401/403 this
 * run parked (`tratarFalhaDeAutenticacao`): its additions are dropped so the
 * re-drain after the token comes back re-enqueues them, and the NEXT tick's
 * context records whatever is still wrong (a refusal record, or the park's
 * own aviso).
 *
 * ## Errors → motivo (the `LiError` base is never caught)
 *
 * `LiAuthError` → park, `conta-parada`; `LiThrottleError`, `LiHttpError`,
 * `LiNetworkError`, the park's `LiEstacionamentoEmConflitoError` →
 * `falha-transitoria`; `LiSchemaError` → `resposta-invalida`;
 * `LiPaginacaoError` → `limite-de-paginas` | `paginacao-invalida`;
 * {@link LiOrcamentoPollEsgotadoError} → `orcamento-esgotado`. Anything else —
 * `LiConfigError`, a coding bug — is rethrown: nothing written, the lease
 * expires.
 *
 * After a complete drain, in this order of precedence: a row whose `numero` is
 * not a positive integer ⇒ `resposta-invalida`; an unreadable stamp (enqueued
 * once, `vistos` records the marker) ⇒ `formato-de-data`; fewer distinct rows
 * than announced ⇒ `janela-instavel`. Each blocks the advance.
 *
 * ## No transaction anywhere
 *
 * Every write is a native precondition on ONE document (root rule 7, tier 1);
 * the multi-document atomic-write API is never named in this app
 * (`estrutura.test.ts`).
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { pollPedidosLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isGrpcStatusError,
} from '@delfrance/data/admin/grpcErrors';
import {
  LiAuthError,
  LiHttpError,
  LiNetworkError,
  LiPaginacaoError,
  LiSchemaError,
  type PedidoBuscaLinhaLi,
  liPedidoBuscaLinhaSchema,
  paginarLi,
} from '@delfrance/integrations-loja-integrada';
import {
  MOTIVO_IMPORTACAO_PARADA_LI,
  type MotivoImportacaoParadaLi,
  ORIGEM_NOTIFICACAO_LI,
  type PollPedidosLojaIntegrada,
  TIPO_TAREFA_LI,
  contaIdLiSchema,
  numeroPedidoLiSchema,
  pollPedidosLojaIntegradaSchema,
} from '@delfrance/schemas';

import {
  avisarImportacaoParada,
  relogioDoDocumentoUs,
  resolverImportacaoParada,
} from '../avisos/avisos';
import { type ContaLojaIntegradaResumo, listarContasLojaIntegrada } from '../core/contas';
import { type ContextoLojaIntegrada, loadLojaIntegradaContext } from '../core/contexto';
import {
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiEstacionamentoEmConflitoError,
} from '../core/erros';
import { tratarFalhaDeAutenticacao } from '../core/estacionamento';
import {
  type CampoLogLi,
  type EscritorLogLi,
  type OpcoesRegistroLi,
  type SeveridadeLi,
  registrarEventoLi,
} from '../core/log';
import { type RitmoLi, ritmoDeLeituraLi } from '../core/ritmo';
import { type AmbienteLi, lerChaveDeChamadas, registrarChamadaBloqueadaLi } from '../core/valvulas';
import {
  type AgendadorLi,
  LiTarefasDesligadasError,
  LiTarefasTransitoriasError,
} from '../notificacoes/agendador';
import {
  type PayloadNotificacaoLi,
  persistirFalhaNotificacaoLi,
} from '../notificacoes/notificacao';
import { lerDataLi } from './dataLi';
import {
  CAMINHO_BUSCA_PEDIDOS_LI,
  OPERACAO_POLL_PEDIDOS_LI,
  consistenciaDaJanelaLi,
  deveEnfileirarLi,
  filtroIgnoradoLi,
  janelaGrandeDemaisLi,
  limiteDeBootstrapLi,
  limiteDeToleranciaLi,
  maiorCursorLi,
  mesclarVistosLi,
  podarVistosLi,
  proximoCursorLi,
  queryDaJanelaLi,
  sinceDaJanelaLi,
  vistoDaLinhaLi,
  zonaSuspeitaLi,
} from './janelaPoll';
import {
  DURACAO_LEASE_POLL_MS,
  MAX_PAGINAS_POLL,
  ORCAMENTO_MINIMO_CONTA_MS,
  orcamentoDaContaMs,
} from './orcamentoPoll';

/** The flow the poller's lines and calls are logged under (`jsonPayload.fluxo`). */
export const FLUXO_POLL_LI = 'poll';

/** Counted failures in a row before the import-stopped aviso, for a motivo that may heal by itself. */
export const AVISO_APOS_FALHAS_SEGUIDAS_LI = 3;

/**
 * The `falhasSeguidas` at which each motivo raises `lojaIntegradaImportacaoParada`:
 * 3 for what may heal by itself, at once (1) for what never will without a
 * person — a filter the platform ignored, a window too large to drain, a
 * look-back or a conta id this poller refuses. TOTAL over the motivos, so a
 * code added to the schema fails to compile here until it is placed.
 */
export const LIMIAR_AVISO_IMPORTACAO_PARADA_LI: Readonly<Record<MotivoImportacaoParadaLi, number>> =
  {
    [MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.credencialInvalida]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.lookbackInvalido]: 1,
    [MOTIVO_IMPORTACAO_PARADA_LI.idDeContaInvalido]: 1,
    [MOTIVO_IMPORTACAO_PARADA_LI.orcamentoEsgotado]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.janelaInstavel]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.falhaTransitoria]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.limiteDePaginas]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.paginacaoInvalida]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.respostaInvalida]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.formatoDeData]: AVISO_APOS_FALHAS_SEGUIDAS_LI,
    [MOTIVO_IMPORTACAO_PARADA_LI.filtroIgnorado]: 1,
    [MOTIVO_IMPORTACAO_PARADA_LI.janelaGrandeDemais]: 1,
  };

/**
 * A conta's run spent its time budget: the abort REASON of the run's signal,
 * which the package rethrows as itself (`client.ts`, `paginacao.ts`), so it is
 * caught here by class. A plain `Error`, never the package's `LiError`: a catch
 * written for a Loja Integrada answer must not swallow it.
 */
export class LiOrcamentoPollEsgotadoError extends Error {
  readonly integracaoId: string;

  constructor(integracaoId: string) {
    super(`O orçamento de tempo da varredura de pedidos da conta ${integracaoId} acabou.`);
    this.name = 'LiOrcamentoPollEsgotadoError';
    this.integracaoId = integracaoId;
  }
}

export interface DepsPollLi {
  /** The process environment, from the root — read for the read switch only. */
  readonly ambiente: AmbienteLi;
  /** `importadorPedidoLi() !== null`, bound by the root: the gate of step 1. */
  readonly importadorPresente: boolean;
  /**
   * `LOJA_INTEGRADA_POLL_LOOKBACK_H` as hours (`lerLookbackHorasLi`), read by
   * the root; `null` when invalid — refused per cursorless conta, never defaulted.
   */
  readonly lookbackHoras: number | null;
  /** The reads-queue producer (`criarAgendadorLiDoAmbiente` in the root). */
  readonly agendador: AgendadorLi;
  /** Now, in MILLISECONDS — read at every decision (the budget, the lease, the stamps). */
  readonly agoraMs: () => number;
  /** The pacer's sleep: `setTimeout` in the root, a recording fake in tests. */
  readonly esperar: (ms: number) => Promise<void>;
  /** `(by) => FieldValue.increment(by)`, for the avisos' counters. */
  readonly increment: (by: number) => unknown;
  /** A fresh id per conta run: the lease's owner. */
  readonly gerarExecucaoId: () => string;
  /** For the park's and the avisos' warnings. */
  readonly logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /** The sink of this run's lines and of its calls' lines (tests); stdout otherwise. */
  readonly escrever?: EscritorLogLi;
  /** Test seam, forwarded to the context's client. */
  readonly fetch?: typeof globalThis.fetch;
}

/** How one conta's run ended — the outcome table in the module header. */
export type DesfechoPollLi =
  | 'sucesso'
  | 'janela-vazia'
  | 'falha'
  | 'orcamento-com-progresso'
  | 'conta-parada'
  | 'recusa'
  | 'recusa-adiada'
  | 'lease-ocupado'
  | 'lease-perdido'
  | 'inativa'
  | 'chamadas-desligadas'
  | 'conta-inexistente'
  | 'sem-tempo'
  | 'erro-firestore';

export interface ResultadoContaPollLi {
  readonly integracaoId: string;
  readonly desfecho: DesfechoPollLi;
  /** The counted failure's code (`falha`, `recusa`, `recusa-adiada`); `null` otherwise. */
  readonly motivo: MotivoImportacaoParadaLi | null;
  /** Notifications put on the reads queue. */
  readonly enfileiradas: number;
  /** Notifications persisted `failed` for the sweep instead (a transient or switched-off enqueue). */
  readonly persistidas: number;
  readonly paginas: number;
  readonly cursorAvancou: boolean;
  /** The gRPC code of a contained failure (`erro-firestore`); `null` otherwise. */
  readonly codigoGrpc: number | null;
}

export interface ResultadoTickPollLi {
  /** Why the tick did nothing at all; `null` when it walked the contas. */
  readonly portao: 'importador-ausente' | 'chamadas-desligadas' | null;
  readonly contas: readonly ResultadoContaPollLi[];
}

/* -------------------------------------------------------------------------- */
/*                                  Logging                                   */
/* -------------------------------------------------------------------------- */

function opcoesDoRegistro(deps: DepsPollLi, conta: string | null): OpcoesRegistroLi {
  return {
    conta,
    fluxo: FLUXO_POLL_LI,
    tentativa: null,
    idTarefa: null,
    idNotificacao: null,
    escrever: deps.escrever,
  };
}

/** One `evento: 'poll'` line, with the channel logger's envelope. */
function registrarPoll(
  deps: DepsPollLi,
  conta: string | null,
  severidade: SeveridadeLi,
  campos: Readonly<Record<string, CampoLogLi>>,
): void {
  registrarEventoLi('poll', severidade, campos, opcoesDoRegistro(deps, conta));
}

const DESFECHOS_DE_ALERTA: ReadonlySet<DesfechoPollLi> = new Set<DesfechoPollLi>([
  'falha',
  'recusa',
  'recusa-adiada',
  'lease-perdido',
  'sem-tempo',
  'erro-firestore',
]);

/** The ONE line per conta run (an inactive conta, skipped every tick, writes none). */
function registrarConta(deps: DepsPollLi, r: ResultadoContaPollLi): void {
  registrarPoll(deps, r.integracaoId, DESFECHOS_DE_ALERTA.has(r.desfecho) ? 'WARNING' : 'INFO', {
    desfecho: r.desfecho,
    motivo: r.motivo,
    enfileiradas: r.enfileiradas,
    persistidas: r.persistidas,
    paginas: r.paginas,
    cursorAvancou: r.cursorAvancou,
    codigoGrpc: r.codigoGrpc,
  });
}

function resultado(
  integracaoId: string,
  desfecho: DesfechoPollLi,
  extra: Partial<Omit<ResultadoContaPollLi, 'integracaoId' | 'desfecho'>> = {},
): ResultadoContaPollLi {
  return {
    integracaoId,
    desfecho,
    motivo: null,
    enfileiradas: 0,
    persistidas: 0,
    paginas: 0,
    cursorAvancou: false,
    codigoGrpc: null,
    ...extra,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 The budget                                 */
/* -------------------------------------------------------------------------- */

interface OrcamentoDaContaLi {
  readonly sinal: AbortSignal;
  /** Abort the run once the clock reached its deadline; then throw the abort reason, if any. */
  verificar(): void;
}

/**
 * A conta's budget, checked against the injected clock at every checkpoint:
 * before and after each pacer wait (so before every request) and before each
 * enqueue. The package also checks the signal before every page. A request
 * already in flight is bounded by its own deadline (`PRAZO_LI_MS.leitura`), so
 * a run overshoots its budget by at most one interval plus one request — what
 * `DURACAO_LEASE_POLL_MS` is sized to outlive.
 */
function criarOrcamentoLi(
  agoraMs: () => number,
  prazoAteMs: number,
  integracaoId: string,
): OrcamentoDaContaLi {
  const controle = new AbortController();
  return {
    sinal: controle.signal,
    verificar() {
      if (!controle.signal.aborted && agoraMs() >= prazoAteMs) {
        controle.abort(new LiOrcamentoPollEsgotadoError(integracaoId));
      }
      controle.signal.throwIfAborted();
    },
  };
}

/** The reads pacer, with the budget checked on both sides of every wait. */
function ritmoComOrcamento(deps: DepsPollLi, orcamento: OrcamentoDaContaLi): RitmoLi {
  return ritmoDeLeituraLi(async (ms) => {
    orcamento.verificar();
    await deps.esperar(ms);
    orcamento.verificar();
  });
}

/* -------------------------------------------------------------------------- */
/*                          The poll document's writes                         */
/* -------------------------------------------------------------------------- */

interface AlvoPollLi {
  readonly integracaoId: string;
  /** The operator-facing store name; the id only for a malformed legacy row. */
  readonly lojaNome: string;
}

/** A poll document as read: its state, strictly parsed, and its commit stamp. */
interface PollLido {
  readonly estado: PollPedidosLojaIntegrada;
  readonly updateTime: Timestamp;
}

/**
 * The poll document, strictly parsed, or `null` when absent. A document that
 * no longer parses (only a hand edit can make one: every write here goes
 * through the schema) throws its `ZodError` — the tick fails loudly.
 */
function lerPoll(snap: DocumentSnapshot): PollLido | null {
  if (!snap.exists) return null;
  const updateTime = snap.updateTime;
  if (updateTime === undefined) {
    throw new TypeError('pollPedidosLojaIntegrada: documento existente sem updateTime');
  }
  return { estado: pollPedidosLojaIntegradaSchema.parse(snap.data()), updateTime };
}

/** A lease is HELD while its expiry is still ahead; at the very instant it expires, it is free. */
function leaseOcupado(estado: PollPedidosLojaIntegrada, agoraMs: number): boolean {
  return estado.emExecucaoAteMs > agoraMs;
}

/** What raising the aviso needs, from the run's first poll-document write. */
interface ContagemDeFalha {
  readonly alvo: AlvoPollLi;
  readonly motivo: MotivoImportacaoParadaLi;
  readonly falhasSeguidas: number;
  readonly relogioUs: number;
}

/**
 * The aviso step's writes may fail on Firestore; a gRPC status error there is
 * logged and swallowed, so the final write still lands. The raise is repeated
 * by the next failing run; a resolve that failed leaves `falhasSeguidas` set, so
 * the next clean run retries it.
 */
async function semDerrubarORun<T>(
  deps: DepsPollLi,
  alvo: AlvoPollLi,
  passo: string,
  fn: () => Promise<T>,
): Promise<{ readonly ok: true; readonly valor: T } | { readonly ok: false }> {
  try {
    return { ok: true, valor: await fn() };
  } catch (err) {
    if (!isGrpcStatusError(err)) throw err;
    registrarPoll(deps, alvo.integracaoId, 'WARNING', {
      alerta: 'aviso-nao-gravado',
      passo,
      codigoGrpc: err.code,
    });
    return { ok: false };
  }
}

/** Raise the aviso when this failure count reached its motivo's threshold. */
async function avisarSeNoLimiar(
  db: Firestore,
  c: ContagemDeFalha,
  deps: DepsPollLi,
): Promise<void> {
  if (c.falhasSeguidas < LIMIAR_AVISO_IMPORTACAO_PARADA_LI[c.motivo]) return;
  await semDerrubarORun(deps, c.alvo, 'avisar', () =>
    avisarImportacaoParada(
      db,
      {
        integracaoId: c.alvo.integracaoId,
        lojaNome: c.alvo.lojaNome,
        motivo: c.motivo,
        relogioUs: c.relogioUs,
      },
      { increment: deps.increment, nowMs: deps.agoraMs(), logger: deps.logger },
    ),
  );
}

/**
 * The REFUSAL RECORD: how a refusal that takes no lease still gets a counter and
 * an aviso clock. It never touches the cursor (the first lease anchors the
 * bootstrap) nor the lease.
 *
 *  - absent → `create` with `falhasSeguidas: 1`; ALREADY_EXISTS → skip;
 *  - present, lease not held → `update({ ultimoErro, falhasSeguidas + 1,
 *    ultimaVarreduraEmMs }, { lastUpdateTime })`; FAILED_PRECONDITION → skip;
 *  - lease held → skip: the next tick retries.
 *
 * Its commit time is the aviso clock.
 */
async function registrarRecusa(
  db: Firestore,
  alvo: AlvoPollLi,
  motivo: MotivoImportacaoParadaLi,
  lido: PollLido | null | undefined,
  deps: DepsPollLi,
): Promise<ResultadoContaPollLi> {
  const ref = pollPedidosLojaIntegradaCollection.docRef(db, {}, alvo.integracaoId);
  const atual = lido === undefined ? lerPoll(await ref.get()) : lido;
  const agoraMs = deps.agoraMs();
  const adiada = resultado(alvo.integracaoId, 'recusa-adiada', { motivo });

  let falhasSeguidas: number;
  let writeTime: Timestamp;
  if (atual === null) {
    falhasSeguidas = 1;
    try {
      ({ writeTime } = await ref.create(
        pollPedidosLojaIntegradaCollection.parse({
          cursor: null,
          emExecucaoAteMs: 0,
          execucaoId: null,
          ultimaVarreduraEmMs: agoraMs,
          ultimoErro: motivo,
          falhasSeguidas,
          vistos: {},
        }),
      ));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return adiada;
    }
  } else {
    if (leaseOcupado(atual.estado, agoraMs)) return adiada;
    falhasSeguidas = atual.estado.falhasSeguidas + 1;
    try {
      ({ writeTime } = await ref.update(
        pollPedidosLojaIntegradaCollection.parseMerge({
          ultimoErro: motivo,
          falhasSeguidas,
          ultimaVarreduraEmMs: agoraMs,
        }),
        { lastUpdateTime: atual.updateTime },
      ));
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
      return adiada;
    }
  }

  await avisarSeNoLimiar(
    db,
    { alvo, motivo, falhasSeguidas, relogioUs: relogioDoDocumentoUs(writeTime) },
    deps,
  );
  return resultado(alvo.integracaoId, 'recusa', { motivo });
}

/** A lease this run took. */
interface LeaseLi {
  readonly execucaoId: string;
  /** The cursor the run drains from: the stored one, or the bootstrap bound this write anchored. */
  readonly cursor: string;
  /** The lease's commit time — the final write's precondition. */
  readonly writeTime: Timestamp;
  /** The same instant in µs: this run's aviso clock. */
  readonly relogioUs: number;
  /** The document as it stands after the lease. */
  readonly estado: PollPedidosLojaIntegrada;
}

/**
 * Take the lease (module header, step 4), or `null` when another run holds it.
 * `lookbackHoras` is non-null whenever the stored cursor is null (checked by
 * the caller).
 */
async function tomarLease(
  ref: DocumentReference,
  lido: PollLido | null,
  lookbackHoras: number | null,
  deps: DepsPollLi,
): Promise<LeaseLi | null> {
  const agoraMs = deps.agoraMs();
  const armazenado = lido?.estado ?? null;
  if (armazenado !== null && leaseOcupado(armazenado, agoraMs)) return null;

  const execucaoId = deps.gerarExecucaoId();
  const emExecucaoAteMs = agoraMs + DURACAO_LEASE_POLL_MS;
  let cursor = armazenado?.cursor ?? null;
  const ancorar = cursor === null;
  if (cursor === null) {
    if (lookbackHoras === null) {
      throw new TypeError('tomarLease: um documento sem cursor exige um look-back válido');
    }
    cursor = limiteDeBootstrapLi(agoraMs, lookbackHoras);
  }

  let writeTime: Timestamp;
  let estado: PollPedidosLojaIntegrada;
  if (lido === null) {
    estado = pollPedidosLojaIntegradaCollection.parse({
      cursor,
      emExecucaoAteMs,
      execucaoId,
      ultimaVarreduraEmMs: null,
      ultimoErro: null,
      falhasSeguidas: 0,
      vistos: {},
    });
    try {
      ({ writeTime } = await ref.create(estado));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return null;
    }
  } else {
    // Only the lease fields — plus the bootstrap anchor on a cursorless document.
    const patch = pollPedidosLojaIntegradaCollection.parseMerge({
      emExecucaoAteMs,
      execucaoId,
      ...(ancorar ? { cursor } : {}),
    });
    try {
      ({ writeTime } = await ref.update(patch, { lastUpdateTime: lido.updateTime }));
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
      return null;
    }
    estado = { ...lido.estado, emExecucaoAteMs, execucaoId, cursor };
  }
  return { execucaoId, cursor, writeTime, relogioUs: relogioDoDocumentoUs(writeTime), estado };
}

/* -------------------------------------------------------------------------- */
/*                                  The drain                                 */
/* -------------------------------------------------------------------------- */

/** One search row, as the run decides on it. */
interface LinhaLida {
  /** The task payload's `numero`, or `null` when the row's is not a positive integer. */
  readonly numero: string | null;
  /** The row's numero as text, valid or not — what the distinct count is over. */
  readonly chave: string;
  /** The canonical stamp, or `null` when unreadable (`formato-de-data`). */
  readonly carimbo: string | null;
}

function lerLinha(linha: PedidoBuscaLinhaLi): LinhaLida {
  const chave = String(linha.numero);
  return {
    numero: numeroPedidoLiSchema.safeParse(chave).success ? chave : null,
    chave,
    carimbo: lerDataLi(linha.data_modificacao),
  };
}

/** How the drain stopped. */
type FimDoDreno =
  | { readonly tipo: 'drenado' }
  | { readonly tipo: 'orcamento' }
  | { readonly tipo: 'conta-parada' }
  | { readonly tipo: 'contada'; readonly motivo: MotivoImportacaoParadaLi };

interface Dreno {
  readonly fim: FimDoDreno;
  /** numero → what `vistos` records for each row THIS run enqueued (or persisted). */
  readonly novos: Readonly<Record<string, string>>;
  readonly enfileiradas: number;
  readonly persistidas: number;
  readonly paginas: number;
  readonly maiorCarimbo: string | null;
  readonly distintos: number;
  readonly totais: readonly (number | null | undefined)[];
  readonly ilegivel: boolean;
  readonly numeroInvalido: boolean;
}

/**
 * Enqueue one notification; a transient or switched-off enqueue is persisted
 * `failed` for the sweep instead. Anything else — a broken deploy, a region
 * guard, a coding bug — propagates and fails the tick.
 */
async function enfileirarOuPersistir(
  db: Firestore,
  payload: PayloadNotificacaoLi,
  deps: DepsPollLi,
): Promise<'enfileirada' | 'persistida'> {
  try {
    await deps.agendador.enfileirar(payload);
    return 'enfileirada';
  } catch (err) {
    if (
      !(err instanceof LiTarefasTransitoriasError) &&
      !(err instanceof LiTarefasDesligadasError)
    ) {
      throw err;
    }
    // The message names the class, code and status only (`agendador.ts`).
    await persistirFalhaNotificacaoLi(db, payload, err.message);
    return 'persistida';
  }
}

/**
 * A drain failure → how the drain stopped, or `null` when the caller must
 * rethrow the ORIGINAL error. The `LiHttpError` SUBCLASSES (`LiAuthError`,
 * `LiThrottleError`) are tested first; the `LiError` base never is
 * (`LiConfigError` must stay loud).
 */
async function fimDaFalha(
  db: Firestore,
  err: unknown,
  alvo: AlvoPollLi,
  deps: DepsPollLi,
): Promise<FimDoDreno | null> {
  if (err instanceof LiOrcamentoPollEsgotadoError) return { tipo: 'orcamento' };
  // The getter found the conta unusable mid-drain (module header).
  if (
    err instanceof LiContaParadaError ||
    err instanceof LiCredencialAusenteError ||
    err instanceof LiCredencialInvalidaError
  ) {
    return { tipo: 'conta-parada' };
  }
  if (err instanceof LiAuthError) {
    try {
      await tratarFalhaDeAutenticacao(db, alvo, err, {
        agoraMs: deps.agoraMs,
        increment: deps.increment,
        logger: deps.logger,
      });
    } catch (falha) {
      if (falha instanceof LiCredencialInvalidaError) return { tipo: 'conta-parada' };
      if (falha instanceof LiEstacionamentoEmConflitoError) {
        return { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.falhaTransitoria };
      }
      throw falha;
    }
    return { tipo: 'conta-parada' };
  }
  if (err instanceof LiHttpError || err instanceof LiNetworkError) {
    return { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.falhaTransitoria };
  }
  if (err instanceof LiSchemaError) {
    return { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.respostaInvalida };
  }
  if (err instanceof LiPaginacaoError) {
    return {
      tipo: 'contada',
      motivo:
        err.motivo === 'limite-de-paginas'
          ? MOTIVO_IMPORTACAO_PARADA_LI.limiteDePaginas
          : MOTIVO_IMPORTACAO_PARADA_LI.paginacaoInvalida,
    };
  }
  return null;
}

/**
 * Read the window and enqueue what changed (module header, steps 5–6).
 * Ordering is never assumed: the cursor candidate is the max stamp over the
 * whole drain.
 */
async function drenar(
  db: Firestore,
  contexto: ContextoLojaIntegrada,
  alvo: AlvoPollLi,
  lease: LeaseLi,
  orcamento: OrcamentoDaContaLi,
  deps: DepsPollLi,
): Promise<Dreno> {
  const since = sinceDaJanelaLi(lease.cursor);
  const limiteTolerancia = limiteDeToleranciaLi(since);
  const agoraMs = deps.agoraMs();
  const novos: Record<string, string> = {};
  const distintos = new Set<string>();
  const totais: (number | null | undefined)[] = [];
  let enfileiradas = 0;
  let persistidas = 0;
  let paginas = 0;
  let maiorCarimbo: string | null = null;
  let ilegivel = false;
  let numeroInvalido = false;
  let zonaRegistrada = false;

  const dreno = (fim: FimDoDreno): Dreno => ({
    fim,
    novos,
    enfileiradas,
    persistidas,
    paginas,
    maiorCarimbo,
    distintos: distintos.size,
    totais,
    ilegivel,
    numeroInvalido,
  });

  try {
    for await (const pagina of paginarLi(contexto.cliente, {
      operacao: OPERACAO_POLL_PEDIDOS_LI,
      caminho: CAMINHO_BUSCA_PEDIDOS_LI,
      query: queryDaJanelaLi(since),
      schemaLinha: liPedidoBuscaLinhaSchema,
      maxPaginas: MAX_PAGINAS_POLL,
      sinal: orcamento.sinal,
    })) {
      paginas = pagina.numero;
      // Refused before draining: more rows than the cap can ever read.
      if (pagina.numero === 1 && janelaGrandeDemaisLi(pagina.meta)) {
        return dreno({ tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.janelaGrandeDemais });
      }
      totais.push(pagina.meta.total_count);
      const linhas = pagina.objetos.map(lerLinha);
      // The WHOLE page first: a filter the platform ignored enqueues nothing more.
      if (linhas.some((l) => l.carimbo !== null && filtroIgnoradoLi(l.carimbo, limiteTolerancia))) {
        return dreno({ tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.filtroIgnorado });
      }
      for (const linha of linhas) {
        distintos.add(linha.chave);
        const { numero, carimbo } = linha;
        if (carimbo === null) {
          ilegivel = true;
        } else {
          if (maiorCarimbo === null || carimbo > maiorCarimbo) maiorCarimbo = carimbo;
          if (!zonaRegistrada && zonaSuspeitaLi(carimbo, agoraMs)) {
            zonaRegistrada = true;
            registrarPoll(deps, alvo.integracaoId, 'WARNING', { alerta: 'zona-suspeita' });
          }
        }
        if (numero === null) {
          numeroInvalido = true;
          continue;
        }
        if (!deveEnfileirarLi(novos[numero] ?? lease.estado.vistos[numero], carimbo)) continue;
        orcamento.verificar();
        const como = await enfileirarOuPersistir(
          db,
          {
            tipo: TIPO_TAREFA_LI.pedido,
            contaId: alvo.integracaoId,
            numero,
            origem: ORIGEM_NOTIFICACAO_LI.poll,
            dataModificacaoLi: carimbo,
          },
          deps,
        );
        if (como === 'enfileirada') enfileiradas += 1;
        else persistidas += 1;
        novos[numero] = vistoDaLinhaLi(carimbo);
      }
    }
  } catch (err) {
    const fim = await fimDaFalha(db, err, alvo, deps);
    if (fim === null) throw err;
    return dreno(fim);
  }
  return dreno({ tipo: 'drenado' });
}

/* -------------------------------------------------------------------------- */
/*                          Conclusion and final write                         */
/* -------------------------------------------------------------------------- */

/** What the run concluded, for the counters and the aviso. */
type Conclusao =
  | { readonly tipo: 'sucesso' }
  | { readonly tipo: 'contada'; readonly motivo: MotivoImportacaoParadaLi }
  | {
      readonly tipo: 'sem-contagem';
      readonly desfecho: 'orcamento-com-progresso' | 'conta-parada';
    };

function concluir(d: Dreno, alvo: AlvoPollLi, deps: DepsPollLi): Conclusao {
  switch (d.fim.tipo) {
    case 'contada':
      return { tipo: 'contada', motivo: d.fim.motivo };
    case 'conta-parada':
      return { tipo: 'sem-contagem', desfecho: 'conta-parada' };
    case 'orcamento':
      return d.enfileiradas + d.persistidas > 0
        ? { tipo: 'sem-contagem', desfecho: 'orcamento-com-progresso' }
        : { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.orcamentoEsgotado };
    case 'drenado':
      break;
  }
  if (d.numeroInvalido) {
    return { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.respostaInvalida };
  }
  if (d.ilegivel) return { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.formatoDeData };
  const consistencia = consistenciaDaJanelaLi(d.totais, d.distintos);
  if (consistencia === 'instavel') {
    return { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_LI.janelaInstavel };
  }
  if (consistencia === 'sem-total') {
    registrarPoll(deps, alvo.integracaoId, 'INFO', { alerta: 'sem-total' });
  }
  return { tipo: 'sucesso' };
}

/** What the final write applies, on whatever document state it is derived from. */
interface PlanoDaEscritaFinal {
  readonly conclusao: Conclusao;
  /** The cursor this run reached (success only; the stored one otherwise). */
  readonly cursor: string;
  readonly novos: Readonly<Record<string, string>>;
  readonly limiteTolerancia: string;
  /**
   * The import-stopped aviso was resolved by THIS run (the resolve returned).
   * Only then may a success reset a stored count above 0: a count this run did
   * not resolve — its resolve failed, or a failure was recorded after the
   * lease read 0 — is left for the next clean run.
   */
  readonly avisoResolvido: boolean;
  readonly agoraMs: number;
}

/**
 * The final write's patch, DERIVED from `base` — the state at the lease on the
 * first attempt, the re-read on the retry — so the retry never re-applies what
 * the losing attempt decided (root rule 7). Forward only: the cursor is the max
 * of the stored one and this run's, `vistos` the merge.
 */
function patchFinal(
  base: PollPedidosLojaIntegrada,
  p: PlanoDaEscritaFinal,
): Partial<PollPedidosLojaIntegrada> {
  const patch: Record<string, unknown> = {
    emExecucaoAteMs: 0,
    execucaoId: null,
    ultimaVarreduraEmMs: p.agoraMs,
  };
  switch (p.conclusao.tipo) {
    case 'sucesso':
      patch.cursor = maiorCursorLi(base.cursor, p.cursor);
      if (base.falhasSeguidas === 0 || p.avisoResolvido) {
        patch.falhasSeguidas = 0;
        patch.ultimoErro = null;
      }
      break;
    case 'contada':
      patch.falhasSeguidas = base.falhasSeguidas + 1;
      patch.ultimoErro = p.conclusao.motivo;
      break;
    case 'sem-contagem':
      break;
  }
  // A parked run drops its additions: the re-drain after the token comes back
  // must re-enqueue them (module header). Every other run keeps what it enqueued.
  const pararVistos =
    p.conclusao.tipo === 'sem-contagem' && p.conclusao.desfecho === 'conta-parada';
  if (!pararVistos) {
    patch.vistos = podarVistosLi(mesclarVistosLi(base.vistos, p.novos), p.limiteTolerancia);
  }
  return pollPedidosLojaIntegradaCollection.parseMerge(patch);
}

/**
 * The final write under the lease's precondition, with ONE re-read and ONE
 * retry (module header, step 8). `false` when another run took the lease (or
 * the document is gone, the re-bootstrap runbook): nothing written.
 */
async function escreverFinal(
  ref: DocumentReference,
  lease: LeaseLi,
  plano: PlanoDaEscritaFinal,
  alvo: AlvoPollLi,
  deps: DepsPollLi,
): Promise<boolean> {
  try {
    await ref.update(patchFinal(lease.estado, plano), { lastUpdateTime: lease.writeTime });
    return true;
  } catch (err) {
    if (!isFailedPrecondition(err)) throw err;
  }
  const atual = lerPoll(await ref.get());
  if (atual === null || atual.estado.execucaoId !== lease.execucaoId) {
    registrarPoll(deps, alvo.integracaoId, 'WARNING', { alerta: 'lease-perdido' });
    return false;
  }
  try {
    await ref.update(patchFinal(atual.estado, plano), { lastUpdateTime: atual.updateTime });
    return true;
  } catch (err) {
    if (!isFailedPrecondition(err)) throw err;
    registrarPoll(deps, alvo.integracaoId, 'WARNING', { alerta: 'lease-perdido' });
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/*                                One conta's run                              */
/* -------------------------------------------------------------------------- */

/**
 * One conta's run (module header). `orcamentoMs` is its budget, from the tick.
 * A gRPC status error propagates: the tick contains it per conta.
 */
export async function executarContaPollLi(
  db: Firestore,
  conta: ContaLojaIntegradaResumo,
  orcamentoMs: number,
  deps: DepsPollLi,
): Promise<ResultadoContaPollLi> {
  const { integracaoId } = conta;
  const alvo: AlvoPollLi = {
    integracaoId,
    lojaNome: conta.nome === '' ? integracaoId : conta.nome,
  };
  const orcamento = criarOrcamentoLi(deps.agoraMs, deps.agoraMs() + orcamentoMs, integracaoId);

  // 1. The id: the task payload's own grammar, or no notification could carry it.
  if (!contaIdLiSchema.safeParse(integracaoId).success) {
    return registrarRecusa(
      db,
      alvo,
      MOTIVO_IMPORTACAO_PARADA_LI.idDeContaInvalido,
      undefined,
      deps,
    );
  }

  // 2. The context: switch (again), conta, credential.
  let contexto: ContextoLojaIntegrada;
  try {
    contexto = await loadLojaIntegradaContext(db, integracaoId, {
      ambiente: deps.ambiente,
      ritmo: ritmoComOrcamento(deps, orcamento),
      registro: { fluxo: FLUXO_POLL_LI, tentativa: null, idTarefa: null, escrever: deps.escrever },
      fetch: deps.fetch,
    });
  } catch (err) {
    if (err instanceof LiChamadasDesligadasError)
      return resultado(integracaoId, 'chamadas-desligadas');
    if (err instanceof LiContaNaoEncontradaError)
      return resultado(integracaoId, 'conta-inexistente');
    if (err instanceof LiContaInativaError) return resultado(integracaoId, 'inativa');
    if (err instanceof LiContaParadaError) return resultado(integracaoId, 'conta-parada');
    if (err instanceof LiCredencialAusenteError) {
      return registrarRecusa(
        db,
        alvo,
        MOTIVO_IMPORTACAO_PARADA_LI.credencialAusente,
        undefined,
        deps,
      );
    }
    if (err instanceof LiCredencialInvalidaError) {
      return registrarRecusa(
        db,
        alvo,
        MOTIVO_IMPORTACAO_PARADA_LI.credencialInvalida,
        undefined,
        deps,
      );
    }
    throw err;
  }

  // 3. The poll document.
  const ref = pollPedidosLojaIntegradaCollection.docRef(db, {}, integracaoId);
  const lido = lerPoll(await ref.get());
  if ((lido?.estado.cursor ?? null) === null && deps.lookbackHoras === null) {
    return registrarRecusa(db, alvo, MOTIVO_IMPORTACAO_PARADA_LI.lookbackInvalido, lido, deps);
  }

  // 4. The lease.
  const lease = await tomarLease(ref, lido, deps.lookbackHoras, deps);
  if (lease === null) return resultado(integracaoId, 'lease-ocupado');

  // 5–6. The drain.
  const dreno = await drenar(db, contexto, alvo, lease, orcamento, deps);
  const conclusao = concluir(dreno, alvo, deps);

  // 7. The aviso step, under the lease, clocked by the lease's commit time.
  const falhasArmazenadas = lease.estado.falhasSeguidas;
  let avisoResolvido = false;
  let cursor = lease.cursor;
  if (conclusao.tipo === 'contada') {
    await avisarSeNoLimiar(
      db,
      {
        alvo,
        motivo: conclusao.motivo,
        falhasSeguidas: falhasArmazenadas + 1,
        relogioUs: lease.relogioUs,
      },
      deps,
    );
  } else if (conclusao.tipo === 'sucesso') {
    const agoraMs = deps.agoraMs();
    const proximo = proximoCursorLi({
      armazenado: lease.cursor,
      maiorCarimbo: dreno.maiorCarimbo,
      agoraMs,
    });
    if (proximo.noFuturo) {
      registrarPoll(deps, integracaoId, 'WARNING', { alerta: 'carimbo-no-futuro' });
    }
    cursor = proximo.cursor;
    if (falhasArmazenadas > 0) {
      const r = await semDerrubarORun(deps, alvo, 'resolver', () =>
        resolverImportacaoParada(
          db,
          integracaoId,
          { nowMs: agoraMs },
          { relogioUs: lease.relogioUs, lojaNome: alvo.lojaNome },
        ),
      );
      avisoResolvido = r.ok;
    }
  }

  // 8. The final write.
  const escrito = await escreverFinal(
    ref,
    lease,
    {
      conclusao,
      cursor,
      novos: dreno.novos,
      limiteTolerancia: limiteDeToleranciaLi(sinceDaJanelaLi(lease.cursor)),
      avisoResolvido,
      agoraMs: deps.agoraMs(),
    },
    alvo,
    deps,
  );

  const contagem = {
    enfileiradas: dreno.enfileiradas,
    persistidas: dreno.persistidas,
    paginas: dreno.paginas,
  };
  if (!escrito) return resultado(integracaoId, 'lease-perdido', contagem);
  switch (conclusao.tipo) {
    case 'contada':
      return resultado(integracaoId, 'falha', { ...contagem, motivo: conclusao.motivo });
    case 'sem-contagem':
      return resultado(integracaoId, conclusao.desfecho, contagem);
    case 'sucesso':
      return resultado(integracaoId, dreno.maiorCarimbo === null ? 'janela-vazia' : 'sucesso', {
        ...contagem,
        cursorAvancou: cursor !== lease.cursor,
      });
  }
}

/* -------------------------------------------------------------------------- */
/*                                  One tick                                  */
/* -------------------------------------------------------------------------- */

/** One conta inside the tick: the budget, the skip rules and the gRPC containment. */
async function contaNoTick(
  db: Firestore,
  conta: ContaLojaIntegradaResumo,
  inicioDoTickMs: number,
  deps: DepsPollLi,
): Promise<ResultadoContaPollLi> {
  if (!conta.ativo) return resultado(conta.integracaoId, 'inativa');
  const orcamentoMs = orcamentoDaContaMs(inicioDoTickMs, deps.agoraMs());
  if (orcamentoMs < ORCAMENTO_MINIMO_CONTA_MS) return resultado(conta.integracaoId, 'sem-tempo');
  try {
    return await executarContaPollLi(db, conta, orcamentoMs, deps);
  } catch (err) {
    if (!isGrpcStatusError(err)) throw err;
    return resultado(conta.integracaoId, 'erro-firestore', { codigoGrpc: err.code });
  }
}

/**
 * One tick of the 5-minute schedule (module header). The contas run one after
 * another, never in parallel: the pacer spaces the calls of ONE run, and two
 * contas at once would double the poller's rate.
 */
export async function executarPollPedidosLi(
  db: Firestore,
  deps: DepsPollLi,
): Promise<ResultadoTickPollLi> {
  // 1. No importer: nothing could process a notification. Zero reads.
  if (!deps.importadorPresente) {
    registrarPoll(deps, null, 'INFO', { desfecho: 'importador-ausente' });
    return { portao: 'importador-ausente', contas: [] };
  }
  // 2. The read switch. Zero reads.
  if (!lerChaveDeChamadas(deps.ambiente)) {
    registrarChamadaBloqueadaLi(
      OPERACAO_POLL_PEDIDOS_LI,
      deps.ambiente,
      opcoesDoRegistro(deps, null),
    );
    return { portao: 'chamadas-desligadas', contas: [] };
  }

  const inicioDoTickMs = deps.agoraMs();
  const { contas } = await listarContasLojaIntegrada(db);
  const resultados: ResultadoContaPollLi[] = [];
  for (const conta of contas) {
    const r = await contaNoTick(db, conta, inicioDoTickMs, deps);
    resultados.push(r);
    if (r.desfecho !== 'inativa') registrarConta(deps, r);
  }
  return { portao: null, contas: resultados };
}

/** The tick's counters, for the root's ONE summary line: how many contas ended each way. */
export function resumirTickPollLi(r: ResultadoTickPollLi): Readonly<Record<string, unknown>> {
  const desfechos: Partial<Record<DesfechoPollLi, number>> = {};
  let enfileiradas = 0;
  let persistidas = 0;
  for (const c of r.contas) {
    desfechos[c.desfecho] = (desfechos[c.desfecho] ?? 0) + 1;
    enfileiradas += c.enfileiradas;
    persistidas += c.persistidas;
  }
  return { portao: r.portao, contas: r.contas.length, desfechos, enfileiradas, persistidas };
}
