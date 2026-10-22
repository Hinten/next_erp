/**
 * The 15-minute BACKSTOP POLL (master plan step 4, PR 4-a): one tick, and one
 * conta's run inside it. Push (step 3) is the fast path; this poll is the
 * GUARANTEED one. It lists the orders Amazon says changed since a durable
 * cursor (`searchOrders`, this module's ONE caller — step-3/4 plan §3 decision
 * 21) and enqueues ONE synthetic `origem: 'poll'` notification per change onto
 * step 3's reads queue — ids only; the importer re-fetches the order (step 5).
 * Nothing here maps an order.
 *
 * The functions codebase's root (PR 4-b) binds every dependency, the
 * environment included: nothing under `lib/amazon` reads the process
 * environment (`estrutura.test.ts`).
 *
 * ## One tick ({@link executarPollPedidosAmazon}), in order
 *
 *  1. **Importer gate.** No importer in the seam (`importadorPresente`, bound by
 *     the root) ⇒ ONE INFO line, ZERO reads: every synthetic row would mint a
 *     `deferred` document per order per tick before step 5.
 *  2. **Read switch.** Not exactly `on` ⇒ ONE `chamada-bloqueada` line, ZERO
 *     reads — and so no poll document is ever created while it is off: the
 *     bootstrap cannot anchor at deploy time, weeks before W5.
 *  3. **Enumerate** (`listarContasAmazon`, the existing `(tipo, nome)` index);
 *     inactive contas skipped in code.
 *  4. **Per conta, sequentially**, each with min(`ORCAMENTO_CONTA_MS`, what the
 *     tick has left), the order ROTATED by the 15-minute slot. One the tick can
 *     no longer give `ORCAMENTO_MINIMO_CONTA_MS` is `sem-tempo` (nothing
 *     written). Containment per conta covers a gRPC status error and
 *     {@link PollAmazonDocumentoInvalidoError} ONLY. An app-secret refusal
 *     (`invalid_client`) ABORTS the tick after its conta's final write: it is
 *     app-wide, so every later conta would fail the same way (the park helper
 *     raised `amazonSegredoLwaRecusado`). Anything else fails the tick loudly.
 *
 * ## One conta's run ({@link executarContaPollAmazon})
 *
 *  1. The id must be the conta-id grammar, else a refusal `id-de-conta-invalido`.
 *  2. The conta cache entry is EVICTED, then the context loads (`registro {
 *     fluxo: 'poll' }`): the seller the payloads carry and the duplicate check
 *     below must be the stored one, never a copy a reconnect left stale on a
 *     warm instance. Gone, inactive, unconnected or parked ⇒ nothing written
 *     (the park has its own aviso); the credential absent or unreadable ⇒ a
 *     refusal record.
 *  3. **The seller.** The stored `selling_partner_id` must pass
 *     `sellingPartnerIdValido`, else a refusal `vendedor-invalido` (the callback
 *     never writes one outside the grammar: a hand edit or a legacy row; every
 *     payload would fail the task schema). Then `contasPorSellingPartnerId`
 *     (the declared composite) must answer exactly `[contaId]`, else a refusal
 *     `vendedor-duplicado` and NOTHING is polled: two contas on one seller would
 *     import every order under two different digests.
 *  4. The poll document. Cursorless with an invalid `AMAZON_POLL_LOOKBACK_H` ⇒ a
 *     refusal `lookback-invalido` — never a silent default.
 *  5. The LEASE (tier 1): `create` when absent, else — only once the stored
 *     lease EXPIRED — `update({ emExecucaoAteMs, execucaoId }, { lastUpdateTime
 *     })`. A cursorless document (a new conta, or a W7 re-bootstrap that deleted
 *     `cursorMs`) gets its bootstrap anchor `now − H` IN that same write, so
 *     failing runs never slide it; a document with a cursor is never
 *     re-anchored. ALREADY_EXISTS or FAILED_PRECONDITION ⇒ another run holds it:
 *     exit with zero calls. The lease hands the drain a NON-null cursor.
 *  6. The DRAIN: at most `MAX_PAGINAS_POLL_AMAZON` pages, each through the
 *     forced-refresh-once rule (`core/renovacaoUnica.ts`), the conta's DEADLINE
 *     checked before every page and before every enqueue. A stored `pendente`
 *     is resumed with its token and its `lastUpdatedAfter` + `marketplaceIds`
 *     byte-identical (unless the token is 23 h old); otherwise a fresh window
 *     from the LEASE's cursor minus the overlap. A window that reaches
 *     `MAX_PAGINAS_POR_JANELA_AMAZON` pages across runs, or a page announcing
 *     the very token it was asked with, never ends: `resposta-invalida`,
 *     counted, its position kept (so counted again on every tick).
 *  7. Per row: `orderId` + `lastUpdatedTime` (an invalid row is counted and
 *     blocks the advance; the valid ones still go — and when the drain stops
 *     before the window's end, the stored `pendente` carries the flag, so the
 *     run that COMPLETES the window counts it). The cursor candidate is the
 *     max stamp over the whole WINDOW, never one run: a stopped drain stores
 *     the running max in `pendente` beside the flag, the resumed run starts
 *     from it, and the completing run advances from the max of it and its own
 *     rows — the rows may come newest-first. Each row is enqueued only when NEWER
 *     than `vistos` and not already enqueued by this run. Each enqueue races
 *     `PRAZO_ENFILEIRAMENTO_POLL_MS`; a named transient, the valve or the
 *     deadline ⇒ persisted `failed` under the deterministic `poll:` id (handed
 *     off); a deploy-shaped failure (a raw Cloud Tasks SDK error, a missing
 *     region) ⇒ the drain stops, `fila-indisponivel`, this run's `vistos`
 *     additions dropped; a failed persist ⇒ the run aborts with nothing more
 *     written (the lease expires).
 *  8. The RESOLVE (a clean run over a stored count above 0), under the lease,
 *     clocked by its commit time.
 *  9. The FINAL write, `update(…, { lastUpdateTime: <the lease's writeTime> })`.
 *     On FAILED_PRECONDITION (or NOT_FOUND) it re-reads ONCE: another run's
 *     lease ⇒ nothing written (a WARNING); still ours ⇒ RE-DERIVED from the
 *     re-read (the max cursor, merged `vistos`, our `pendente` only if the
 *     stored one is still the one the lease read — `===` on two scalars, no
 *     fold; its two accumulators, the flag and the running max, are not
 *     identity) and retried once. Never the captured patch re-applied (rule 7).
 * 10. The RAISE (a counted failure at its motivo's threshold), only once step 9
 *     LANDED, against the count it stored, clocked by the lease's commit time.
 *
 * ## What each outcome writes
 *
 * | outcome | cursor | `pendente` | `vistos` | `falhasSeguidas` |
 * | --- | --- | --- | --- | --- |
 * | complete drain, every row valid | advances to the window's max row (this run's or the stored max; capped) / kept if empty | null | merged, pruned | 0 once resolved |
 * | complete drain, an invalid row (this run's, or the stored flag) | kept | null | merged, pruned | +1 (`resposta-invalida`) |
 * | truncated after 5 pages | kept | the next page's token (+ the flag, + the running max) | merged, pruned | unchanged |
 * | the window's page bound, or a repeated token | kept | the position (+ the flag, + the running max) | merged, pruned | +1 (`resposta-invalida`) |
 * | deadline (`orcamento-esgotado`) or a counted failure mid-drain | kept | the page it stopped at (+ the flag, + the running max) | merged, pruned | +1 |
 * | `fila-indisponivel` | kept | unchanged | STORED kept | +1 |
 * | a 400 on the resumed page (`paginacao-expirada`) | kept | null | merged, pruned | unchanged |
 * | `conta-parada` / `segredo-recusado` mid-drain | kept | unchanged | STORED kept | unchanged |
 * | refusal record | — | — | — | +1 |
 * | inactive, unconnected, parked at start, lease busy, `sem-tempo`, `documento-invalido` | nothing written | | | |
 *
 * ## Errors → motivo (the `AmazonError` and `ErroAppAmazon` bases are never tested)
 *
 * SP-API 401/403 after the forced refresh ⇒ `sem-permissao`; an LWA refusal ⇒
 * the park (`tratarFalhaDeAutenticacao`): `estacionar` ⇒ `conta-parada`,
 * `segredo-recusado` ⇒ the tick aborts; `AmazonThrottleError` ⇒
 * `limite-de-taxa` (no inline sleep: the refill is ~179 s per token); a 400 on
 * the first request of a RESUMED drain ⇒ `paginacao-expirada` (uncounted); any
 * other non-transient HTTP status ⇒ `requisicao-recusada`; 5xx, network,
 * timeout, the park's contention ⇒ `falha-transitoria`; `AmazonSchemaError`, an
 * invalid row or a window that never ends ⇒ `resposta-invalida`. Our own misconfiguration
 * (`ConfigAmazonAusenteError`, `AmazonConfigError`) and a bug are rethrown —
 * a package error through `sanitizarFalhaDaTarefaAmazon` first: nothing
 * written, the lease expires.
 *
 * ## No multi-document atomic write anywhere
 *
 * Every write is a native precondition on ONE document (root rule 7, tier 1) or
 * the shared store's tier-0 `create`; the API's call name is never written in
 * this app (`estrutura.test.ts`).
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { MissingRegionError } from '@delfrance/core/region';
import { pollPedidosAmazonCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isGrpcStatusError,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import {
  AmazonAuthError,
  AmazonHttpError,
  AmazonNetworkError,
  AmazonSchemaError,
  AmazonThrottleError,
  MARKETPLACE_ID_BR,
  buscarPedidosAtualizados,
} from '@delfrance/integrations-amazon-sp-api';
import {
  MOTIVO_IMPORTACAO_PARADA_AMAZON,
  type MotivoImportacaoParadaAmazon,
  type PendentePollAmazon,
  type PollPedidosAmazon,
  pollPedidosAmazonSchema,
  sellingPartnerIdValido,
} from '@delfrance/schemas';

import type { AmbienteAmazon } from '../env';
import { levantarImportacaoParadaAmazon, resolverImportacaoParadaAmazon } from '../avisos/avisos';
import { invalidarContaEmCache } from '../core/contaCache';
import {
  type ContaAmazonResumo,
  contasPorSellingPartnerId,
  idDeContaValido,
  listarContasAmazon,
} from '../core/contas';
import { type ContextoAmazon, loadAmazonContext } from '../core/contexto';
import {
  ChamadasAmazonDesligadasError,
  ContaAmazonInativaError,
  ContaAmazonNaoConectadaError,
  ContaAmazonNaoEncontradaError,
  ContaAmazonParadaError,
  CredencialAmazonAusenteError,
  CredencialAmazonInvalidaError,
  EstacionamentoAmazonEmConflitoError,
} from '../core/erros';
import { classificarFalhaAmazon, tratarFalhaDeAutenticacao } from '../core/estacionamento';
import {
  type CampoLogAmazon,
  type LoggerAmazon,
  type SeveridadeAmazon,
  registrarEventoAmazon,
} from '../core/log';
import { executarComRenovacaoUnica } from '../core/renovacaoUnica';
import {
  CHAMADAS_ENV_AMAZON,
  lerChaveDeChamadasAmazon,
  registrarChamadaBloqueadaAmazon,
} from '../core/valvulas';
import {
  type AgendadorAmazon,
  AmazonTarefasDesligadasError,
  AmazonTarefasTransitoriasError,
  descreverFalhaDeEnfileiramentoAmazon,
  ehFalhaDoSdkDeTarefasAmazon,
} from '../notificacoes/agendador';
import {
  type PayloadNotificacaoAmazon,
  persistirFalhaNotificacaoAmazon,
  sanitizarFalhaDaTarefaAmazon,
} from '../notificacoes/notificacao';
import {
  type AgendadorDePrazoAmazon,
  agendarPrazoPadraoAmazon,
  correrComPrazoAmazon,
} from '../notificacoes/prazo';
import {
  LOOKBACK_POLL_ENV_AMAZON,
  ancoraDoBootstrapMs,
  deveEnfileirar,
  lerLinhaPollAmazon,
  lerLookbackHorasAmazon,
  limiteInferior,
  mesclarVistos,
  pendenteRetomavel,
  podarVistos,
  proximoCursorMs,
} from './janelaPoll';
import { notificacaoDoPoll } from './notificacaoSintetica';
import {
  LEASE_POLL_MS,
  MAX_PAGINAS_POLL_AMAZON,
  MAX_PAGINAS_POR_JANELA_AMAZON,
  MAX_RESULTADOS_POR_PAGINA_AMAZON,
  ORCAMENTO_MINIMO_CONTA_MS,
  PRAZO_ENFILEIRAMENTO_POLL_MS,
  orcamentoDaContaMs,
  ordemDoTickAmazon,
  prazoDaContaMs,
} from './orcamentoPoll';

/** The flow the poll's lines and calls are logged under (`jsonPayload.fluxo`). */
export const FLUXO_POLL_AMAZON = 'poll';

/** The operation name the read switch's refusal line carries for the tick. */
export const ROTA_POLL_AMAZON = 'pollPedidos';

/**
 * The `falhasSeguidas` at which each motivo raises `amazonImportacaoParada`:
 * 1 for what never heals without a person, 2 for a malformed answer, 4 (one
 * hour of ticks) for what may heal by itself. TOTAL over the motivos, so a code
 * added to the schema fails to compile here until it is placed.
 */
export const LIMIAR_AVISO_IMPORTACAO_PARADA_AMAZON: Readonly<
  Record<MotivoImportacaoParadaAmazon, number>
> = {
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.idDeContaInvalido]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialAusente]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialInvalida]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.vendedorDuplicado]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.vendedorInvalido]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.lookbackInvalido]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.semPermissao]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.requisicaoRecusada]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.filaIndisponivel]: 1,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida]: 2,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.limiteDeTaxa]: 4,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria]: 4,
  [MOTIVO_IMPORTACAO_PARADA_AMAZON.orcamentoEsgotado]: 4,
};

/**
 * A stored poll document no longer parses — only a hand edit can make one
 * (every write here goes through the schema). The tick contains it PER CONTA
 * (`documento-invalido`, a WARNING naming the broken top-level fields, never a
 * value) and moves on; nothing is written for that conta until a person fixes
 * the document.
 */
export class PollAmazonDocumentoInvalidoError extends Error {
  readonly integracaoId: string;
  /** The top-level field names Zod blamed — never a value, never a key inside a map. */
  readonly campos: readonly string[];

  constructor(integracaoId: string, campos: readonly string[]) {
    super(
      `O documento pollPedidosAmazon/${integracaoId} não é válido (campos: ${campos.join(', ')}).`,
    );
    this.name = 'PollAmazonDocumentoInvalidoError';
    this.integracaoId = integracaoId;
    this.campos = campos;
  }
}

export interface DepsPollAmazon {
  /** The process environment, from the root: the read switch, the LWA pair and the look-back. */
  readonly ambiente: AmbienteAmazon;
  /** `importadorPedidoAmazon() !== null`, bound by the root: the gate of tick step 1. */
  readonly importadorPresente: boolean;
  /** The reads-queue producer (the functions root's `criarAgendadorAmazonDoAmbiente`). */
  readonly agendador: AgendadorAmazon;
  /** Now, in MILLISECONDS — read at every decision (the budget, the lease, the stamps). */
  readonly agora: () => number;
  /** `(by) => FieldValue.increment(by)`, for the avisos' counters. */
  readonly increment: (by: number) => unknown;
  readonly logger: LoggerAmazon;
  /** A fresh id per conta run: the lease's owner. */
  readonly gerarExecucaoId: () => string;
  /**
   * A sleep, bound by the root. ⚠️ The poll NEVER calls it: a 429 stops the
   * conta (the bucket refills ~179 s per token, longer than any wait a run could
   * afford). It is a dependency only so a test can prove it is never called.
   */
  readonly esperar: (ms: number) => Promise<void>;
  /** The enqueue deadline's timer; the production one is an unref'd `setTimeout`. */
  readonly agendarPrazo?: AgendadorDePrazoAmazon;
  /** Test seams, forwarded to the context's client. */
  readonly fetch?: typeof globalThis.fetch;
  readonly gerarCorrelationId?: () => string;
}

/** How one conta's run ended — the outcome table in the module header. */
export type DesfechoPollAmazon =
  | 'sucesso'
  | 'janela-vazia'
  | 'truncado'
  | 'paginacao-expirada'
  | 'falha'
  | 'conta-parada'
  | 'segredo-recusado'
  | 'recusa'
  | 'recusa-adiada'
  | 'lease-ocupado'
  | 'lease-perdido'
  | 'inativa'
  | 'nao-conectada'
  | 'chamadas-desligadas'
  | 'conta-inexistente'
  | 'sem-tempo'
  | 'erro-firestore'
  | 'documento-invalido';

export interface ResultadoContaPollAmazon {
  readonly integracaoId: string;
  readonly desfecho: DesfechoPollAmazon;
  /** The counted failure's code (`falha`, `recusa`, `recusa-adiada`); `null` otherwise. */
  readonly motivo: MotivoImportacaoParadaAmazon | null;
  /** Notifications put on the reads queue. */
  readonly enfileiradas: number;
  /** Notifications persisted `failed` for the sweep instead. */
  readonly persistidas: number;
  /** Pages read by THIS run. */
  readonly paginas: number;
  /** Whether this run resumed a stored drain. */
  readonly retomada: boolean;
  readonly cursorAvancou: boolean;
  /** Whether any page echoed `lastUpdatedBefore` — logged, never trusted (§3 decision 20). */
  readonly lastUpdatedBeforeEcoado: boolean;
  /** The gRPC code of a contained failure (`erro-firestore`); `null` otherwise. */
  readonly codigoGrpc: number | null;
}

export interface ResultadoTickPollAmazon {
  /** Why the tick did nothing at all; `null` when it walked the contas. */
  readonly portao: 'importador-ausente' | 'chamadas-desligadas' | null;
  readonly contas: readonly ResultadoContaPollAmazon[];
  /** Set when an app-wide refusal stopped the tick before every conta ran. */
  readonly abortado: 'segredo-recusado' | null;
}

/* -------------------------------------------------------------------------- */
/*                                  Logging                                   */
/* -------------------------------------------------------------------------- */

/** One `evento: 'poll'` line. The seller id never reaches one (`estrutura.test.ts`). */
function registrarPoll(
  deps: DepsPollAmazon,
  conta: string | null,
  severidade: SeveridadeAmazon,
  mensagem: string,
  campos: Readonly<Record<string, CampoLogAmazon>>,
): void {
  registrarEventoAmazon(deps.logger, 'poll', severidade, mensagem, campos, {
    conta,
    fluxo: FLUXO_POLL_AMAZON,
  });
}

const DESFECHOS_DE_ALERTA: ReadonlySet<DesfechoPollAmazon> = new Set<DesfechoPollAmazon>([
  'falha',
  'segredo-recusado',
  'recusa',
  'recusa-adiada',
  'lease-perdido',
  'sem-tempo',
  'erro-firestore',
  'documento-invalido',
]);

/** The ONE line per conta run (an inactive conta, skipped every tick, writes none). */
function registrarConta(deps: DepsPollAmazon, r: ResultadoContaPollAmazon): void {
  registrarPoll(
    deps,
    r.integracaoId,
    DESFECHOS_DE_ALERTA.has(r.desfecho) ? 'WARNING' : 'INFO',
    `[amazon/poll] conta: ${r.desfecho}`,
    {
      desfecho: r.desfecho,
      motivo: r.motivo,
      enfileiradas: r.enfileiradas,
      persistidas: r.persistidas,
      paginas: r.paginas,
      retomada: r.retomada,
      cursorAvancou: r.cursorAvancou,
      lastUpdatedBeforeEcoado: r.lastUpdatedBeforeEcoado,
      codigoGrpc: r.codigoGrpc,
    },
  );
}

function resultado(
  integracaoId: string,
  desfecho: DesfechoPollAmazon,
  extra: Partial<Omit<ResultadoContaPollAmazon, 'integracaoId' | 'desfecho'>> = {},
): ResultadoContaPollAmazon {
  return {
    integracaoId,
    desfecho,
    motivo: null,
    enfileiradas: 0,
    persistidas: 0,
    paginas: 0,
    retomada: false,
    cursorAvancou: false,
    lastUpdatedBeforeEcoado: false,
    codigoGrpc: null,
    ...extra,
  };
}

/** The class name of whatever was thrown, for a log line — never its message. */
function nomeDaClasse(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const nome: unknown = (err as { name?: unknown }).name;
    if (typeof nome === 'string' && nome !== '') return nome;
    return '<objeto>';
  }
  return typeof err;
}

/* -------------------------------------------------------------------------- */
/*                          The poll document's writes                         */
/* -------------------------------------------------------------------------- */

interface AlvoPollAmazon {
  readonly integracaoId: string;
  /** The operator-facing conta name; the id for a malformed legacy row. */
  readonly lojaNome: string;
}

/** A poll document as read: its state, strictly parsed, and its commit stamp. */
interface PollLido {
  readonly estado: PollPedidosAmazon;
  readonly updateTime: Timestamp;
}

/**
 * The poll document, strictly parsed, or `null` when absent. One that no longer
 * parses throws {@link PollAmazonDocumentoInvalidoError}, which the tick
 * contains per conta.
 */
function lerPoll(snap: DocumentSnapshot): PollLido | null {
  if (!snap.exists) return null;
  const updateTime = snap.updateTime;
  if (updateTime === undefined) {
    throw new TypeError('pollPedidosAmazon: documento existente sem updateTime');
  }
  const lido = pollPedidosAmazonSchema.safeParse(snap.data());
  if (!lido.success) {
    // The FIRST path segment only: a `vistos` key is an order id.
    const campos = new Set(lido.error.issues.map((i) => String(i.path[0] ?? '(raiz)')));
    throw new PollAmazonDocumentoInvalidoError(snap.id, [...campos]);
  }
  return { estado: lido.data, updateTime };
}

/** A lease is HELD while its expiry is still ahead; at the very instant it expires, it is free. */
function leaseOcupado(estado: PollPedidosAmazon, agoraMs: number): boolean {
  return estado.emExecucaoAteMs > agoraMs;
}

/**
 * The aviso writes may fail on Firestore; a gRPC status error there is logged
 * and swallowed, so the run still ends. A raise that failed is repeated by the
 * next failing run; a resolve that failed leaves `falhasSeguidas` set, so the
 * next clean run retries it.
 */
async function semDerrubarORun<T>(
  deps: DepsPollAmazon,
  alvo: AlvoPollAmazon,
  passo: string,
  fn: () => Promise<T>,
): Promise<{ readonly ok: true; readonly valor: T } | { readonly ok: false }> {
  try {
    return { ok: true, valor: await fn() };
  } catch (err) {
    if (!isGrpcStatusError(err)) throw err;
    registrarPoll(deps, alvo.integracaoId, 'WARNING', '[amazon/poll] aviso não gravado', {
      alerta: 'aviso-nao-gravado',
      passo,
      codigoGrpc: err.code,
    });
    return { ok: false };
  }
}

/** What raising the aviso needs: the count as STORED, and the run's first write's commit. */
interface ContagemDeFalha {
  readonly alvo: AlvoPollAmazon;
  readonly motivo: MotivoImportacaoParadaAmazon;
  readonly falhasSeguidas: number;
  readonly commit: Timestamp;
}

/** Raise the aviso when this failure count reached its motivo's threshold. */
async function avisarSeNoLimiar(
  db: Firestore,
  c: ContagemDeFalha,
  deps: DepsPollAmazon,
): Promise<void> {
  if (c.falhasSeguidas < LIMIAR_AVISO_IMPORTACAO_PARADA_AMAZON[c.motivo]) return;
  await semDerrubarORun(deps, c.alvo, 'avisar', () =>
    levantarImportacaoParadaAmazon(
      db,
      {
        integracaoId: c.alvo.integracaoId,
        lojaNome: c.alvo.lojaNome,
        motivo: c.motivo,
        commit: c.commit,
      },
      { increment: deps.increment, nowMs: deps.agora(), logger: deps.logger },
    ),
  );
}

/**
 * The REFUSAL RECORD: how a refusal that takes no lease still gets a counter and
 * an aviso clock (the Loja Integrada poller's shape). It never touches the
 * cursor (the first lease anchors the bootstrap) nor the lease:
 *
 *  - absent → `create` with `falhasSeguidas: 1`; ALREADY_EXISTS → skip;
 *  - present, lease not held → `update({ ultimoErro, falhasSeguidas + 1,
 *    ultimaVarreduraEmMs }, { lastUpdateTime })`; FAILED_PRECONDITION → skip;
 *  - lease held → skip: the next tick retries.
 *
 * Its commit time is the aviso clock; the raise runs only once it LANDED.
 */
async function registrarRecusa(
  db: Firestore,
  alvo: AlvoPollAmazon,
  motivo: MotivoImportacaoParadaAmazon,
  lido: PollLido | null | undefined,
  deps: DepsPollAmazon,
): Promise<ResultadoContaPollAmazon> {
  const ref = pollPedidosAmazonCollection.docRef(db, {}, alvo.integracaoId);
  const atual = lido === undefined ? lerPoll(await ref.get()) : lido;
  const agoraMs = deps.agora();
  const adiada = resultado(alvo.integracaoId, 'recusa-adiada', { motivo });

  let falhasSeguidas: number;
  let writeTime: Timestamp;
  if (atual === null) {
    falhasSeguidas = 1;
    try {
      ({ writeTime } = await ref.create(
        pollPedidosAmazonCollection.parse({
          cursorMs: null,
          pendente: null,
          vistos: {},
          emExecucaoAteMs: 0,
          execucaoId: null,
          ultimaVarreduraEmMs: agoraMs,
          ultimoErro: motivo,
          falhasSeguidas,
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
        pollPedidosAmazonCollection.parseMerge({
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

  await avisarSeNoLimiar(db, { alvo, motivo, falhasSeguidas, commit: writeTime }, deps);
  return resultado(alvo.integracaoId, 'recusa', { motivo });
}

/** A lease this run took. */
interface LeaseAmazon {
  readonly execucaoId: string;
  /** The cursor the run drains from: the stored one, or the bootstrap this write anchored. NEVER null. */
  readonly cursorMs: number;
  /** The lease's commit time — the final write's precondition and the aviso clock. */
  readonly writeTime: Timestamp;
  /** The document as it stands after the lease. */
  readonly estado: PollPedidosAmazon;
}

/**
 * Take the lease (module header, step 5), or `null` when another run holds it.
 * `lookbackHoras` is non-null whenever the stored cursor is null (checked by the
 * caller, which refuses `lookback-invalido` otherwise).
 */
async function tomarLease(
  ref: DocumentReference,
  lido: PollLido | null,
  lookbackHoras: number | null,
  deps: DepsPollAmazon,
): Promise<LeaseAmazon | null> {
  const agoraMs = deps.agora();
  const armazenado = lido?.estado ?? null;
  if (armazenado !== null && leaseOcupado(armazenado, agoraMs)) return null;

  const execucaoId = deps.gerarExecucaoId();
  const emExecucaoAteMs = agoraMs + LEASE_POLL_MS;
  const guardado = armazenado?.cursorMs ?? null;
  let cursorMs: number;
  if (guardado === null) {
    if (lookbackHoras === null) {
      throw new TypeError('tomarLease: um documento sem cursor exige um look-back válido');
    }
    cursorMs = ancoraDoBootstrapMs(agoraMs, lookbackHoras);
  } else {
    cursorMs = guardado;
  }

  let writeTime: Timestamp;
  let estado: PollPedidosAmazon;
  if (lido === null) {
    estado = pollPedidosAmazonCollection.parse({
      cursorMs,
      pendente: null,
      vistos: {},
      emExecucaoAteMs,
      execucaoId,
      ultimaVarreduraEmMs: null,
      ultimoErro: null,
      falhasSeguidas: 0,
    });
    try {
      ({ writeTime } = await ref.create(estado));
    } catch (err) {
      if (!isAlreadyExists(err)) throw err;
      return null;
    }
  } else {
    // Only the lease fields — plus the bootstrap anchor on a cursorless document
    // (a W7 re-bootstrap deleted the field), under the SAME precondition.
    const patch = pollPedidosAmazonCollection.parseMerge({
      emExecucaoAteMs,
      execucaoId,
      ...(guardado === null ? { cursorMs } : {}),
    });
    try {
      ({ writeTime } = await ref.update(patch, { lastUpdateTime: lido.updateTime }));
    } catch (err) {
      if (!isFailedPrecondition(err)) throw err;
      return null;
    }
    estado = { ...lido.estado, emExecucaoAteMs, execucaoId, cursorMs };
  }
  return { execucaoId, cursorMs, writeTime, estado };
}

/* -------------------------------------------------------------------------- */
/*                                  The drain                                 */
/* -------------------------------------------------------------------------- */

/** The window a drain reads: resent byte-identical on every page. */
interface Janela {
  readonly lastUpdatedAfter: string;
  readonly marketplaceIds: string;
  readonly inicioDrenagemMs: number;
  /** Whether it came from a stored `pendente`. */
  readonly retomada: boolean;
  /** An EARLIER run of this window read an invalid row (the stored `pendente`'s flag). */
  readonly linhaInvalida: boolean;
  /** The largest row stamp (ms) EARLIER runs of this window read (the stored `pendente`'s); null = none recorded. */
  readonly maiorLinhaMs: number | null;
}

/** Where a drain stands: the request that FETCHES the next page to read. */
interface Posicao {
  readonly paginationToken: string | null;
  readonly tokenEmMs: number;
  /** Pages of this window read before this position, across runs. */
  readonly paginas: number;
}

/** The larger of two optional stamps; `null` only when both are. */
function maiorDe(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.max(a, b);
}

/**
 * The `pendente` a stopped drain stores: its position, the window's exact
 * strings, whether ANY run of this window read an invalid row — the flag that
 * makes the run completing the window count it, however many runs later — and
 * the largest row stamp ANY run of it read, which that run advances the cursor
 * from. Both accumulate over the stored ones, never restart with this run.
 */
function pendenteDe(
  janela: Janela,
  posicao: Posicao,
  linhaInvalidaNesteRun: boolean,
  maiorLinhaNesteRunMs: number | null,
): PendentePollAmazon {
  return {
    paginationToken: posicao.paginationToken,
    lastUpdatedAfter: janela.lastUpdatedAfter,
    marketplaceIds: janela.marketplaceIds,
    inicioDrenagemMs: janela.inicioDrenagemMs,
    tokenEmMs: posicao.tokenEmMs,
    paginas: posicao.paginas,
    linhaInvalida: janela.linhaInvalida || linhaInvalidaNesteRun,
    maiorLinhaMs: maiorDe(janela.maiorLinhaMs, maiorLinhaNesteRunMs),
  };
}

/** How the drain stopped. */
type FimDoDreno =
  | { readonly tipo: 'drenado' }
  | { readonly tipo: 'truncado' }
  | { readonly tipo: 'orcamento' }
  | { readonly tipo: 'paginacao-expirada' }
  | { readonly tipo: 'conta-parada' }
  | { readonly tipo: 'segredo-recusado' }
  | { readonly tipo: 'contada'; readonly motivo: MotivoImportacaoParadaAmazon };

/** The final write keeps the stored `pendente` untouched. */
const MANTER = Symbol('manter-pendente');

interface Dreno {
  readonly fim: FimDoDreno;
  /** What the final write stores as `pendente`: a position, null, or the stored one kept. */
  readonly pendente: PendentePollAmazon | null | typeof MANTER;
  /** orderId → µs of every row THIS run handed off (enqueued or persisted). */
  readonly novos: Readonly<Record<string, number>>;
  /** This run's `vistos` additions are dropped (a park, the app secret, a broken queue). */
  readonly descartarNovos: boolean;
  /**
   * The cursor candidate: the largest row stamp (ms) of the whole WINDOW — this
   * run's rows and the stored running max of its earlier runs. Null = no row yet.
   */
  readonly maiorLinhaMs: number | null;
  readonly inicioDrenagemMs: number;
  readonly enfileiradas: number;
  readonly persistidas: number;
  readonly paginas: number;
  readonly retomada: boolean;
  readonly lastUpdatedBeforeEcoado: boolean;
}

/** The outcome of one enqueue (module header, step 7). */
type DesfechoDoEnfileiramento = 'enfileirada' | 'persistida' | 'fila-indisponivel';

/**
 * Enqueue one notification, raced against {@link PRAZO_ENFILEIRAMENTO_POLL_MS}
 * (`notificacoes/prazo.ts`, the receiver's race). A named transient, the valve
 * or the deadline ⇒ persisted `failed` under the deterministic `poll:` id; a
 * deploy-shaped failure ⇒ `fila-indisponivel`; anything else — and a failed
 * persist — propagates (the run aborts; the lease expires).
 */
async function enfileirarOuPersistir(
  db: Firestore,
  payload: PayloadNotificacaoAmazon,
  alvo: AlvoPollAmazon,
  deps: DepsPollAmazon,
): Promise<DesfechoDoEnfileiramento> {
  const corrida = await correrComPrazoAmazon(
    () => deps.agendador.enfileirar(payload),
    PRAZO_ENFILEIRAMENTO_POLL_MS,
    {
      agendarPrazo: deps.agendarPrazo ?? agendarPrazoPadraoAmazon,
      // THE consume-all of `prazo.ts`: the class only, never rethrown.
      aoRejeitarTarde: (erro) => {
        const nomeada =
          erro instanceof AmazonTarefasTransitoriasError ||
          erro instanceof AmazonTarefasDesligadasError;
        registrarPoll(
          deps,
          alvo.integracaoId,
          nomeada ? 'WARNING' : 'ERROR',
          '[amazon/poll] rejeição tardia depois do prazo — consumida',
          { alerta: 'rejeicao-tardia', classe: nomeDaClasse(erro) },
        );
      },
    },
  );
  if (corrida.tipo === 'concluida') return 'enfileirada';

  let falha: AmazonTarefasTransitoriasError | AmazonTarefasDesligadasError;
  if (corrida.tipo === 'prazo') {
    falha = AmazonTarefasTransitoriasError.porPrazo();
  } else {
    const err = corrida.erro;
    if (
      err instanceof AmazonTarefasTransitoriasError ||
      err instanceof AmazonTarefasDesligadasError
    ) {
      falha = err;
    } else if (ehFalhaDoSdkDeTarefasAmazon(err) || err instanceof MissingRegionError) {
      // Deploy-shaped (step-3/4 plan §3 decision 22): COUNTED, so an aviso
      // reaches an operator — where a failed tick would reach only the logs.
      registrarPoll(
        deps,
        alvo.integracaoId,
        'ERROR',
        '[amazon/poll] a fila de leitura recusou o enfileiramento',
        {
          alerta: MOTIVO_IMPORTACAO_PARADA_AMAZON.filaIndisponivel,
          classe: ehFalhaDoSdkDeTarefasAmazon(err)
            ? descreverFalhaDeEnfileiramentoAmazon(err)
            : nomeDaClasse(err),
        },
      );
      return 'fila-indisponivel';
    } else {
      throw err;
    }
  }
  await persistirFalhaNotificacaoAmazon(
    db,
    payload,
    `enfileiramento/${descreverFalhaDeEnfileiramentoAmazon(falha)}`,
  );
  return 'persistida';
}

/**
 * A page failure → how the drain stopped, or `null` when the caller must
 * rethrow the ORIGINAL error. Most-derived first (`AmazonAuthError`,
 * `AmazonThrottleError` before `AmazonHttpError`); the bases are never tested.
 */
async function fimDaFalha(
  db: Firestore,
  err: unknown,
  alvo: AlvoPollAmazon,
  primeiraDaRetomada: boolean,
  deps: DepsPollAmazon,
): Promise<FimDoDreno | null> {
  const contada = (motivo: MotivoImportacaoParadaAmazon): FimDoDreno => ({
    tipo: 'contada',
    motivo,
  });
  // The getter found the conta unusable mid-drain: parked by another task, its
  // credential removed or unreadable. The NEXT tick's context says which.
  if (
    err instanceof ContaAmazonParadaError ||
    err instanceof CredencialAmazonAusenteError ||
    err instanceof CredencialAmazonInvalidaError
  ) {
    return { tipo: 'conta-parada' };
  }
  if (err instanceof AmazonAuthError) {
    const classe = classificarFalhaAmazon(err);
    // An SP-API 401/403 that survived the forced refresh: a role grant (L1).
    if (classe === 'renovar-acesso') return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.semPermissao);
    if (classe === 'nenhuma') return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria);
    try {
      await tratarFalhaDeAutenticacao(
        db,
        { integracaoId: alvo.integracaoId, contaNome: alvo.lojaNome },
        err,
        { agoraMs: deps.agora, increment: deps.increment, logger: deps.logger },
      );
    } catch (falha) {
      if (falha instanceof CredencialAmazonInvalidaError) return { tipo: 'conta-parada' };
      if (falha instanceof EstacionamentoAmazonEmConflitoError) {
        return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria);
      }
      throw falha;
    }
    return classe === 'segredo-recusado' ? { tipo: 'segredo-recusado' } : { tipo: 'conta-parada' };
  }
  if (err instanceof AmazonThrottleError) {
    return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.limiteDeTaxa);
  }
  if (err instanceof AmazonHttpError) {
    if (err.transitorio) return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria);
    // A stored token (or window) Amazon no longer accepts: restart, uncounted.
    if (err.status === 400 && primeiraDaRetomada) return { tipo: 'paginacao-expirada' };
    return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.requisicaoRecusada);
  }
  if (err instanceof AmazonNetworkError) {
    return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria);
  }
  if (err instanceof EstacionamentoAmazonEmConflitoError) {
    return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.falhaTransitoria);
  }
  if (err instanceof AmazonSchemaError) {
    return contada(MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida);
  }
  return null;
}

/** The window this run reads: the stored drain when resumable, else a fresh one from the lease's cursor. */
function janelaDaExecucao(
  lease: LeaseAmazon,
  alvo: AlvoPollAmazon,
  deps: DepsPollAmazon,
): { readonly janela: Janela; readonly posicao: Posicao } {
  const agoraMs = deps.agora();
  const guardado = lease.estado.pendente;
  if (guardado !== null) {
    if (pendenteRetomavel(guardado, agoraMs)) {
      return {
        janela: {
          lastUpdatedAfter: guardado.lastUpdatedAfter,
          marketplaceIds: guardado.marketplaceIds,
          inicioDrenagemMs: guardado.inicioDrenagemMs,
          retomada: true,
          linhaInvalida: guardado.linhaInvalida,
          maiorLinhaMs: guardado.maiorLinhaMs,
        },
        posicao: {
          paginationToken: guardado.paginationToken,
          tokenEmMs: guardado.tokenEmMs,
          paginas: guardado.paginas,
        },
      };
    }
    registrarPoll(deps, alvo.integracaoId, 'INFO', '[amazon/poll] drenagem guardada expirou', {
      alerta: 'pendente-expirado',
    });
  }
  return {
    janela: {
      lastUpdatedAfter: limiteInferior(lease.cursorMs),
      marketplaceIds: MARKETPLACE_ID_BR,
      inicioDrenagemMs: agoraMs,
      retomada: false,
      linhaInvalida: false,
      maiorLinhaMs: null,
    },
    posicao: { paginationToken: null, tokenEmMs: agoraMs, paginas: 0 },
  };
}

/**
 * Read the window and enqueue what changed (module header, steps 6–7). The
 * order of the rows is never assumed: the cursor candidate is the max stamp
 * over the whole WINDOW — this run's rows and the max the stored `pendente`
 * carried from the window's earlier runs.
 */
async function drenar(
  db: Firestore,
  contexto: ContextoAmazon,
  alvo: AlvoPollAmazon,
  lease: LeaseAmazon,
  prazoMs: number,
  deps: DepsPollAmazon,
): Promise<Dreno> {
  const { janela, posicao: inicial } = janelaDaExecucao(lease, alvo, deps);
  const sellingPartnerId = contexto.conta.selling_partner_id;
  if (!sellingPartnerIdValido(sellingPartnerId)) {
    // Unreachable: the run refused it (`vendedor-invalido`) before the lease.
    throw new TypeError('drenar: conta sem vendedor válido depois do contexto');
  }
  const contaDoPoll = { integracaoId: alvo.integracaoId, sellingPartnerId };
  let posicao = inicial;
  const novos: Record<string, number> = {};
  const nesteRun = new Set<string>();
  /** THIS run's largest row stamp; the window's is the max with `janela.maiorLinhaMs`. */
  let maiorLinhaMs: number | null = null;
  let linhaInvalida = false;
  let enfileiradas = 0;
  let persistidas = 0;
  let paginas = 0;
  let eco = false;
  const venceu = () => deps.agora() >= prazoMs;

  const dreno = (
    fim: FimDoDreno,
    pendente: PendentePollAmazon | null | typeof MANTER,
    descartarNovos = false,
  ): Dreno => ({
    fim,
    pendente,
    novos,
    descartarNovos,
    maiorLinhaMs: maiorDe(janela.maiorLinhaMs, maiorLinhaMs),
    inicioDrenagemMs: janela.inicioDrenagemMs,
    enfileiradas,
    persistidas,
    paginas,
    retomada: janela.retomada,
    lastUpdatedBeforeEcoado: eco,
  });
  /** Where this drain stands, as the final write would store it. */
  const aqui = () => pendenteDe(janela, posicao, linhaInvalida, maiorLinhaMs);
  /** A window that never ends (§5 risk 6): a malformed answer, counted, its position kept. */
  const semFim = (tokenRepetido: boolean): Dreno => {
    registrarPoll(deps, alvo.integracaoId, 'WARNING', '[amazon/poll] paginação sem fim', {
      alerta: 'paginacao-sem-fim',
      paginas: posicao.paginas,
      tokenRepetido,
    });
    return dreno(
      { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida },
      aqui(),
    );
  };

  for (;;) {
    // The window's page bound, before any request: a resumed window already at
    // it costs no call, and is counted on every tick until a person looks.
    if (posicao.paginas >= MAX_PAGINAS_POR_JANELA_AMAZON) return semFim(false);
    // Five pages read and another announced: the next tick resumes here.
    if (paginas >= MAX_PAGINAS_POLL_AMAZON) return dreno({ tipo: 'truncado' }, aqui());
    // The deadline, before every page: what stops here re-reads this page next tick.
    if (venceu()) return dreno({ tipo: 'orcamento' }, aqui());

    const filtro = {
      lastUpdatedAfter: janela.lastUpdatedAfter,
      marketplaceIds: janela.marketplaceIds,
      maxResultsPerPage: MAX_RESULTADOS_POR_PAGINA_AMAZON,
      paginationToken: posicao.paginationToken,
    };
    let pagina: Awaited<ReturnType<typeof buscarPedidosAtualizados>>;
    try {
      pagina = await executarComRenovacaoUnica(contexto, () =>
        buscarPedidosAtualizados(contexto.cliente, filtro),
      );
    } catch (err) {
      const fim = await fimDaFalha(db, err, alvo, janela.retomada && paginas === 0, deps);
      if (fim === null) throw sanitizarFalhaDaTarefaAmazon(err);
      switch (fim.tipo) {
        case 'conta-parada':
        case 'segredo-recusado':
          return dreno(fim, MANTER, true);
        case 'paginacao-expirada':
          return dreno(fim, null);
        case 'contada':
        case 'orcamento':
        case 'drenado':
        case 'truncado':
          return dreno(fim, aqui());
      }
    }
    paginas += 1;
    const chegadaMs = deps.agora();
    if (pagina.dados.lastUpdatedBefore !== undefined) eco = true;

    for (const bruta of pagina.dados.orders) {
      const linha = lerLinhaPollAmazon(bruta);
      if (linha === null) {
        linhaInvalida = true;
        continue;
      }
      if (maiorLinhaMs === null || linha.lastUpdatedMs > maiorLinhaMs) {
        maiorLinhaMs = linha.lastUpdatedMs;
      }
      if (nesteRun.has(linha.orderId)) continue;
      if (!deveEnfileirar(lease.estado.vistos[linha.orderId], linha.lastUpdatedUs)) continue;
      // The deadline, before every enqueue: this page is re-read next tick, and
      // `vistos` lets it enqueue only what remains.
      if (venceu()) return dreno({ tipo: 'orcamento' }, aqui());
      const como = await enfileirarOuPersistir(
        db,
        notificacaoDoPoll(contaDoPoll, linha),
        alvo,
        deps,
      );
      if (como === 'fila-indisponivel') {
        return dreno(
          { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.filaIndisponivel },
          MANTER,
          true,
        );
      }
      if (como === 'enfileirada') enfileiradas += 1;
      else persistidas += 1;
      nesteRun.add(linha.orderId);
      novos[linha.orderId] = linha.lastUpdatedUs;
    }

    const proximo = pagina.dados.pagination?.nextToken;
    if (proximo === undefined) {
      // The window is complete. An invalid row read by THIS run or by an earlier
      // run of the same window (the stored flag) blocks the advance and counts.
      return dreno(
        janela.linhaInvalida || linhaInvalida
          ? { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.respostaInvalida }
          : { tipo: 'drenado' },
        null,
      );
    }
    // Amazon announced the very token it was asked with: the same page forever.
    if (proximo === posicao.paginationToken) return semFim(true);
    posicao = { paginationToken: proximo, tokenEmMs: chegadaMs, paginas: posicao.paginas + 1 };
  }
}

/* -------------------------------------------------------------------------- */
/*                         Conclusion and final write                          */
/* -------------------------------------------------------------------------- */

/** What the run concluded, for the counters and the aviso. */
type Conclusao =
  | { readonly tipo: 'sucesso' }
  | { readonly tipo: 'contada'; readonly motivo: MotivoImportacaoParadaAmazon }
  | {
      readonly tipo: 'sem-contagem';
      readonly desfecho: 'truncado' | 'paginacao-expirada' | 'conta-parada' | 'segredo-recusado';
    };

function concluir(fim: FimDoDreno): Conclusao {
  switch (fim.tipo) {
    case 'drenado':
      return { tipo: 'sucesso' };
    case 'orcamento':
      return { tipo: 'contada', motivo: MOTIVO_IMPORTACAO_PARADA_AMAZON.orcamentoEsgotado };
    case 'contada':
      return { tipo: 'contada', motivo: fim.motivo };
    case 'truncado':
    case 'paginacao-expirada':
    case 'conta-parada':
    case 'segredo-recusado':
      return { tipo: 'sem-contagem', desfecho: fim.tipo };
  }
}

/** What the final write applies, on whatever document state it is derived from. */
interface PlanoDaEscritaFinal {
  readonly conclusao: Conclusao;
  readonly dreno: Dreno;
  /** The stored `pendente` as the LEASE read it: the re-derive's identity. */
  readonly pendenteLido: PendentePollAmazon | null;
  /** `falhasSeguidas` as the lease read it: what the resolve was decided against. */
  readonly falhasNoLease: number;
  /** The import-stopped aviso was resolved by THIS run (the resolve returned). */
  readonly avisoResolvido: boolean;
  readonly agoraMs: number;
}

/**
 * Is the stored `pendente` still the one the lease read? `===` on two scalars
 * the run read — the token and when it arrived — never a structural compare or
 * any fold: the same token with another `tokenEmMs` is ANOTHER drain.
 *
 * The two ACCUMULATORS (`linhaInvalida`, `maiorLinhaMs`) are deliberately not
 * identity: they describe the drain, they do not name it. Ours are derived
 * from the ones the lease read, and only a final write under a lease stores a
 * `pendente` — while this lease holds, no other run's lands. The identity
 * guards the POSITION: a running max lost here only makes the completion
 * advance the cursor less (a re-listed backlog, never a skipped row), and a
 * larger one is still capped at the window's start minus five minutes.
 */
function mesmoPendente(a: PendentePollAmazon | null, b: PendentePollAmazon | null): boolean {
  return (
    (a?.paginationToken ?? null) === (b?.paginationToken ?? null) &&
    (a?.tokenEmMs ?? null) === (b?.tokenEmMs ?? null)
  );
}

/**
 * The final write's patch, DERIVED from `base` — the state at the lease on the
 * first attempt, the re-read on the retry — so the retry never re-applies what
 * the losing attempt decided (root rule 7): the cursor is the max of the stored
 * one and this run's, `vistos` the merge, and our `pendente` lands only over the
 * one the lease read.
 */
function patchFinal(base: PollPedidosAmazon, p: PlanoDaEscritaFinal): Partial<PollPedidosAmazon> {
  const patch: Record<string, unknown> = {
    emExecucaoAteMs: 0,
    execucaoId: null,
    ultimaVarreduraEmMs: p.agoraMs,
  };
  let cursorGuardado = base.cursorMs;
  if (p.conclusao.tipo === 'sucesso' && p.dreno.maiorLinhaMs !== null) {
    const proximo = proximoCursorMs({
      armazenadoMs: base.cursorMs ?? 0,
      maiorLinhaMs: p.dreno.maiorLinhaMs,
      inicioDrenagemMs: p.dreno.inicioDrenagemMs,
    });
    if (base.cursorMs === null || proximo !== base.cursorMs) {
      patch.cursorMs = proximo;
      cursorGuardado = proximo;
    }
  }
  if (p.dreno.pendente !== MANTER && mesmoPendente(base.pendente, p.pendenteLido)) {
    patch.pendente = p.dreno.pendente;
  }
  if (!p.dreno.descartarNovos) {
    const mesclados = mesclarVistos(base.vistos, p.dreno.novos);
    patch.vistos = cursorGuardado === null ? mesclados : podarVistos(mesclados, cursorGuardado);
  }
  switch (p.conclusao.tipo) {
    case 'sucesso':
      // Re-derived from `base`, never re-applied: the decision taken against the
      // lease's count holds only while the count is unchanged.
      if (base.falhasSeguidas === p.falhasNoLease && (p.falhasNoLease === 0 || p.avisoResolvido)) {
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
  return pollPedidosAmazonCollection.parseMerge(patch);
}

/** What a final write that LANDED stored: the count the aviso threshold reads, and the cursor. */
interface EscritaFinal {
  readonly falhasSeguidas: number;
  readonly cursorMs: number | null;
}

/** One attempt of the final write, derived from `base` under `lastUpdateTime`. */
async function aplicarFinal(
  ref: DocumentReference,
  base: PollPedidosAmazon,
  lastUpdateTime: Timestamp,
  plano: PlanoDaEscritaFinal,
): Promise<EscritaFinal> {
  const patch = patchFinal(base, plano);
  await ref.update(patch, { lastUpdateTime });
  return {
    falhasSeguidas: patch.falhasSeguidas ?? base.falhasSeguidas,
    cursorMs: patch.cursorMs ?? base.cursorMs,
  };
}

/**
 * The final write under the lease's precondition, with ONE re-read and ONE
 * retry (module header, step 9). `null` when another run took the lease (or the
 * document is gone): nothing written.
 */
async function escreverFinal(
  ref: DocumentReference,
  lease: LeaseAmazon,
  plano: PlanoDaEscritaFinal,
  alvo: AlvoPollAmazon,
  deps: DepsPollAmazon,
): Promise<EscritaFinal | null> {
  try {
    return await aplicarFinal(ref, lease.estado, lease.writeTime, plano);
  } catch (err) {
    if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
  }
  const perdido = () => {
    registrarPoll(deps, alvo.integracaoId, 'WARNING', '[amazon/poll] lease perdido', {
      alerta: 'lease-perdido',
    });
    return null;
  };
  const atual = lerPoll(await ref.get());
  if (atual === null || atual.estado.execucaoId !== lease.execucaoId) return perdido();
  try {
    return await aplicarFinal(ref, atual.estado, atual.updateTime, plano);
  } catch (err) {
    if (!isFailedPrecondition(err) && !isNotFound(err)) throw err;
    return perdido();
  }
}

/* -------------------------------------------------------------------------- */
/*                               One conta's run                               */
/* -------------------------------------------------------------------------- */

/**
 * One conta's run (module header). `orcamentoMs` is its budget, from the tick.
 * A gRPC status error and {@link PollAmazonDocumentoInvalidoError} propagate:
 * the tick contains them per conta.
 */
export async function executarContaPollAmazon(
  db: Firestore,
  conta: ContaAmazonResumo,
  orcamentoMs: number,
  deps: DepsPollAmazon,
): Promise<ResultadoContaPollAmazon> {
  const { integracaoId } = conta;
  const alvo: AlvoPollAmazon = {
    integracaoId,
    lojaNome: conta.nome === '' ? integracaoId : conta.nome,
  };
  const prazoMs = prazoDaContaMs(deps.agora(), orcamentoMs);

  // 1. The id: the task payload's own grammar, or no notification could carry it.
  if (!idDeContaValido(integracaoId)) {
    return registrarRecusa(
      db,
      alvo,
      MOTIVO_IMPORTACAO_PARADA_AMAZON.idDeContaInvalido,
      undefined,
      deps,
    );
  }

  // 2. The context, from a FRESH conta read (module header).
  invalidarContaEmCache(integracaoId);
  let contexto: ContextoAmazon;
  try {
    contexto = await loadAmazonContext(db, integracaoId, {
      ambiente: deps.ambiente,
      agora: deps.agora,
      logger: deps.logger,
      registro: {
        fluxo: FLUXO_POLL_AMAZON,
        tentativa: null,
        idTarefa: null,
        idNotificacao: null,
      },
      fetch: deps.fetch,
      gerarCorrelationId: deps.gerarCorrelationId,
    });
  } catch (err) {
    if (err instanceof ChamadasAmazonDesligadasError) {
      return resultado(integracaoId, 'chamadas-desligadas');
    }
    if (err instanceof ContaAmazonNaoEncontradaError) {
      return resultado(integracaoId, 'conta-inexistente');
    }
    if (err instanceof ContaAmazonInativaError) return resultado(integracaoId, 'inativa');
    if (err instanceof ContaAmazonNaoConectadaError)
      return resultado(integracaoId, 'nao-conectada');
    if (err instanceof ContaAmazonParadaError) return resultado(integracaoId, 'conta-parada');
    if (err instanceof CredencialAmazonAusenteError) {
      return registrarRecusa(
        db,
        alvo,
        MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialAusente,
        undefined,
        deps,
      );
    }
    if (err instanceof CredencialAmazonInvalidaError) {
      return registrarRecusa(
        db,
        alvo,
        MOTIVO_IMPORTACAO_PARADA_AMAZON.credencialInvalida,
        undefined,
        deps,
      );
    }
    throw err;
  }
  const alvoDoContexto: AlvoPollAmazon = {
    integracaoId,
    lojaNome: contexto.conta.nome === '' ? integracaoId : contexto.conta.nome,
  };

  // 3. A seller id every payload can carry, then one seller, one conta — or
  //    nothing is polled.
  const vendedor = contexto.conta.selling_partner_id;
  if (!sellingPartnerIdValido(vendedor)) {
    return registrarRecusa(
      db,
      alvoDoContexto,
      MOTIVO_IMPORTACAO_PARADA_AMAZON.vendedorInvalido,
      undefined,
      deps,
    );
  }
  const contasDoVendedor = await contasPorSellingPartnerId(db, vendedor);
  if (contasDoVendedor.length !== 1 || contasDoVendedor[0] !== integracaoId) {
    return registrarRecusa(
      db,
      alvoDoContexto,
      MOTIVO_IMPORTACAO_PARADA_AMAZON.vendedorDuplicado,
      undefined,
      deps,
    );
  }

  // 4. The poll document; a cursorless one needs a valid look-back.
  const ref = pollPedidosAmazonCollection.docRef(db, {}, integracaoId);
  const lido = lerPoll(await ref.get());
  const lookbackHoras = lerLookbackHorasAmazon(deps.ambiente[LOOKBACK_POLL_ENV_AMAZON]);
  if ((lido?.estado.cursorMs ?? null) === null && lookbackHoras === null) {
    return registrarRecusa(
      db,
      alvoDoContexto,
      MOTIVO_IMPORTACAO_PARADA_AMAZON.lookbackInvalido,
      lido,
      deps,
    );
  }

  // 5. The lease.
  const lease = await tomarLease(ref, lido, lookbackHoras, deps);
  if (lease === null) return resultado(integracaoId, 'lease-ocupado');

  // 6–7. The drain.
  const dreno = await drenar(db, contexto, alvoDoContexto, lease, prazoMs, deps);
  const conclusao = concluir(dreno.fim);

  // 8. The RESOLVE, under the lease, clocked by its commit time — BEFORE the
  //    final write, which may reset the count only once the resolve returned (a
  //    reset whose resolve then failed would leave an open aviso over a count of
  //    0, which no clean run ever reads above 0 again).
  const falhasNoLease = lease.estado.falhasSeguidas;
  let avisoResolvido = false;
  if (conclusao.tipo === 'sucesso' && falhasNoLease > 0) {
    const r = await semDerrubarORun(deps, alvoDoContexto, 'resolver', () =>
      resolverImportacaoParadaAmazon(
        db,
        integracaoId,
        { nowMs: deps.agora() },
        { commit: lease.writeTime, lojaNome: alvoDoContexto.lojaNome },
      ),
    );
    avisoResolvido = r.ok;
  }

  // 9. The final write.
  const escrito = await escreverFinal(
    ref,
    lease,
    {
      conclusao,
      dreno,
      pendenteLido: lease.estado.pendente,
      falhasNoLease,
      avisoResolvido,
      agoraMs: deps.agora(),
    },
    alvoDoContexto,
    deps,
  );

  // 10. The RAISE — only once the count it stands for is STORED (#1908's
  //     finding): an open aviso always has a stored count above 0 behind it,
  //     which is what makes the next clean run resolve it.
  if (escrito !== null && conclusao.tipo === 'contada') {
    await avisarSeNoLimiar(
      db,
      {
        alvo: alvoDoContexto,
        motivo: conclusao.motivo,
        falhasSeguidas: escrito.falhasSeguidas,
        commit: lease.writeTime,
      },
      deps,
    );
  }

  const contagem = {
    enfileiradas: dreno.enfileiradas,
    persistidas: dreno.persistidas,
    paginas: dreno.paginas,
    retomada: dreno.retomada,
    lastUpdatedBeforeEcoado: dreno.lastUpdatedBeforeEcoado,
  };
  if (escrito === null) return resultado(integracaoId, 'lease-perdido', contagem);
  switch (conclusao.tipo) {
    case 'contada':
      return resultado(integracaoId, 'falha', { ...contagem, motivo: conclusao.motivo });
    case 'sem-contagem':
      return resultado(integracaoId, conclusao.desfecho, contagem);
    case 'sucesso':
      return resultado(integracaoId, dreno.maiorLinhaMs === null ? 'janela-vazia' : 'sucesso', {
        ...contagem,
        cursorAvancou: escrito.cursorMs !== lease.cursorMs,
      });
  }
}

/* -------------------------------------------------------------------------- */
/*                                  One tick                                  */
/* -------------------------------------------------------------------------- */

/** One conta inside the tick: the budget, the skip rules and the containment. */
async function contaNoTick(
  db: Firestore,
  conta: ContaAmazonResumo,
  inicioDoTickMs: number,
  deps: DepsPollAmazon,
): Promise<ResultadoContaPollAmazon> {
  if (!conta.ativo) return resultado(conta.integracaoId, 'inativa');
  const orcamentoMs = orcamentoDaContaMs(inicioDoTickMs, deps.agora());
  if (orcamentoMs < ORCAMENTO_MINIMO_CONTA_MS) return resultado(conta.integracaoId, 'sem-tempo');
  try {
    return await executarContaPollAmazon(db, conta, orcamentoMs, deps);
  } catch (err) {
    if (err instanceof PollAmazonDocumentoInvalidoError) {
      registrarPoll(deps, conta.integracaoId, 'WARNING', '[amazon/poll] documento inválido', {
        alerta: 'documento-invalido',
        campos: err.campos.join(','),
      });
      return resultado(conta.integracaoId, 'documento-invalido');
    }
    if (!isGrpcStatusError(err)) throw err;
    return resultado(conta.integracaoId, 'erro-firestore', { codigoGrpc: err.code });
  }
}

/**
 * One tick of the 15-minute schedule (module header). The contas run one after
 * another, never in parallel: two contas at once would double the poll's rate.
 */
export async function executarPollPedidosAmazon(
  db: Firestore,
  deps: DepsPollAmazon,
): Promise<ResultadoTickPollAmazon> {
  // 1. No importer: nothing could process a notification. Zero reads.
  if (!deps.importadorPresente) {
    registrarPoll(deps, null, 'INFO', '[amazon/poll] sem importador — nada lido', {
      desfecho: 'importador-ausente',
    });
    return { portao: 'importador-ausente', contas: [], abortado: null };
  }
  // 2. The read switch. Zero reads, so no poll document is ever created.
  if (!lerChaveDeChamadasAmazon(deps.ambiente)) {
    registrarChamadaBloqueadaAmazon(deps.logger, {
      rota: ROTA_POLL_AMAZON,
      valor: deps.ambiente[CHAMADAS_ENV_AMAZON],
    });
    return { portao: 'chamadas-desligadas', contas: [], abortado: null };
  }

  // 3–4. Enumerate, then each conta, rotated.
  const inicioDoTickMs = deps.agora();
  const { contas } = await listarContasAmazon(db);
  const resultados: ResultadoContaPollAmazon[] = [];
  let abortado: ResultadoTickPollAmazon['abortado'] = null;
  for (const conta of ordemDoTickAmazon(contas, inicioDoTickMs)) {
    const r = await contaNoTick(db, conta, inicioDoTickMs, deps);
    resultados.push(r);
    if (r.desfecho !== 'inativa') registrarConta(deps, r);
    if (r.desfecho === 'segredo-recusado') {
      // App-wide: every later conta's refresh would be refused the same way.
      abortado = 'segredo-recusado';
      break;
    }
  }
  return { portao: null, contas: resultados, abortado };
}

/**
 * The tick's counters, FLAT, for the root's ONE summary line (PR 4-b): how many
 * contas ended each way (`desfecho_<nome>`), and the notifications handed off.
 */
export function resumirTickPollAmazon(
  r: ResultadoTickPollAmazon,
): Readonly<Record<string, CampoLogAmazon>> {
  const saida: Record<string, CampoLogAmazon> = {
    portao: r.portao,
    abortado: r.abortado,
    contas: r.contas.length,
    enfileiradas: 0,
    persistidas: 0,
  };
  let enfileiradas = 0;
  let persistidas = 0;
  for (const c of r.contas) {
    const chave = `desfecho_${c.desfecho}`;
    const atual = saida[chave];
    saida[chave] = (typeof atual === 'number' ? atual : 0) + 1;
    enfileiradas += c.enfileiradas;
    persistidas += c.persistidas;
  }
  saida.enfileiradas = enfileiradas;
  saida.persistidas = persistidas;
  return saida;
}
