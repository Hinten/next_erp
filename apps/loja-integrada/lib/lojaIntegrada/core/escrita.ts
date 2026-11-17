/**
 * The Loja Integrada WRITE ENGINE (master plan step 7, PR 7-b): the ONE module
 * of this app that sends a write. Every write flow (the status write-back
 * first, the stock writes of step 12, the catalogue and price writes later)
 * goes through it, and `estrutura.test.ts` refuses a package write operation
 * or a write-client method named anywhere else.
 *
 * It decides NOTHING about a flow's data — whether a write is due, safe or
 * already reflected is the flow's (`lib/lojaIntegrada/rastreio/`, PR 7-d, for
 * the status write-back; the stock flow's from PR 12-e on: which quantity, and
 * whether the row read names the product asked for). It owns HOW a write is
 * made, and the ten write-engine requirements of PLAN step 7:
 *
 *  1. **The valve first.** {@link iniciarEscritaLi} reads the valve
 *     (`lerValvula`) as its first statement and writes the run-start line as its
 *     second. `off` (unset, blank, a typo) is `desligado`, and no motor can be
 *     built from it — so nothing below can run, no read, no payload. Only a start
 *     opened here builds a motor, and only ONE: a run is one valve read, one
 *     run-start line and one motor. The engine never receives a Firestore handle,
 *     and a run that may not write gets a result with no write in it.
 *  2. **One pre-write read per write kind**, in {@link LEITURA_PREVIA_LI}: the
 *     reader AND the read-back strategy of each kind, each resolved by an
 *     exhaustive `switch` (a new reader does not compile until it is handled).
 *     A deciding read records its reader, and a write refuses a base its kind's
 *     row does not name: a stock write never decides on an order, an order
 *     write never on a stock row. Two readers serve the four kinds: both order
 *     kinds share one `GET /v1/pedido/{numero}/`, both stock kinds one
 *     `GET /v1/produto_estoque/{produto id}` (no slash, keyed by the PRODUCT id,
 *     never the stock row's own id). A kind belongs to ONE flow
 *     ({@link FLUXO_DO_TIPO_ESCRITA_LI}): only a run under that flow's valve may
 *     send it, or even diff it. A target the read cannot find is never written
 *     (`ausente`).
 *  3. **The writer receives the target.** {@link escreverLi} takes it, refuses
 *     another conta's (a `TypeError`: a programming error), checks the envio id
 *     against the deciding read of THAT target, and builds the URL from it, so
 *     the canary key and the URL name the same order or product. The write is
 *     made with the deciding read's credential or not at all (the pin,
 *     `core/contextoEscrita.ts`).
 *  4. **A restore line before EACH write**, from its own deciding read
 *     ({@link lerBaseLi}): the read's token-scrubbed text through
 *     `corpoDeRestauracaoLi`, as ONE INFO line capped at 200 KB on the exact line.
 *     No line (too big, too deep, not JSON, a catalogue path other than the
 *     stock detail, a stock detail whose nine leaves would not come out
 *     verbatim) ⇒ that write is not made (`sem-restauracao`). A deciding read
 *     decides at most ONE write attempt, and a read-back is never a deciding
 *     read (another type), so after a refused write the next one needs a fresh
 *     read and its own line.
 *  5. **Dry-run diffs; a separate read-back; a policy per field.** A target the
 *     valve or the canary keeps from writing logs one `diff` line per field
 *     ({@link POLITICA_CAMPO_ESCRITA_LI}); a write that landed is read back by
 *     its own call ({@link lerDeVoltaLi}, two pacer intervals later) and
 *     compared with {@link conferirEscritaLi} (`deepEqual`, the shared leaf); a
 *     difference is one WARNING `deriva` line. The stock kinds' one field
 *     (`estoque`) is the whole four-leaf body, so a store that keeps an
 *     unmanaged product or another situação after the write shows as a diff
 *     and as a deriva, not only a different quantity.
 *  6. **Nothing after a landed write may throw** — any 2xx resolves (the
 *     package), the logging is total (`log.ts`), and **no write follows one that
 *     landed OR MAY HAVE LANDED in the same run** ({@link escreverLi} refuses it
 *     as a `TypeError`). A write closes the run the moment it is sent — before
 *     its first `await`, so two writes started together send one — and only a
 *     failure that PROVES nothing landed reopens it: refused before anything was
 *     sent (the package's `LiConfigError`, a credential refusal, the task
 *     deadline) or answered 3xx/4xx other than 429. A 5xx, a 429, a timeout, a
 *     cut connection or an unclassified error keeps it closed: the write may
 *     have landed, and the next attempt decides afresh. The PERMITTED post-write
 *     throws, each safe only because every attempt re-derives its guards from a
 *     fresh read and skips what is already reflected (never "fix" one into a
 *     retry that skips that read):
 *     (b) the read-back's or the history read's credential re-read failing in
 *     Firestore (gRPC), rethrown by requirement 7; (c) the flow's aviso writes
 *     after a write; (d) the park after a read-back's 401/403
 *     (`tratarFalhaDeAutenticacao`); (e) the pipeline's disposition persist; and
 *     the package's three (`escrita.ts` in the package): (f) the caller's own
 *     abort — this engine passes none; (g) an observer that throws — the app
 *     logger is total, pinned in `log.test.ts` on every PUT outcome; (h) a 2xx
 *     body read failing with an unclassified error — only an injected `fetch`
 *     does that. ((a), a second write's failure after a landed one, cannot
 *     happen: there is no second write.)
 *  7. **Read-back and history failures are contained for the KNOWN classes
 *     only** — {@link CLASSES_CONTIDAS_LI}: the package's HTTP family (401/403,
 *     404, 429 and the rest), a body off its schema, the network (a timeout
 *     included), a page limit, and the app's refusals of the credential (absent,
 *     unreadable, parked, swapped). Each comes back `{ verificado: false }` with
 *     its class; `LiConfigError`, gRPC errors and anything else are rethrown.
 *     The package's `LiError` base is never tested. Both reads are tied to the
 *     write that landed: its target (and, for the read-back, its kind), with the
 *     run's pinned credential — anything else is a `TypeError`, nothing sent.
 *     The history read follows only an ORDER write, and a confirming read runs
 *     only in a run of the order flow: both read an order, never a product.
 *  8. **The comparator** is `deepEqual`, the dependency-free leaf
 *     (`core/igualdadeJsonLi.ts`).
 *  9. **The chokepoint** is `estrutura.test.ts`'s.
 *  10. **Bulk mode.** A list PAGE as a base is NOT built here: it has no
 *      consumer yet. The seam is requirement 2's table, which names the reader
 *      and the read-back strategy per kind, and the read-back being its own
 *      call: a page reader plugs in as a kind's row. `estoque-produto-lote` is
 *      the first kind to use the read-back half: its row declares `lista`, so
 *      the engine makes NO read-back call for it (one asked for is a
 *      `TypeError` before any wait) — the stock list's next walk is its
 *      read-back. Its deciding read is still the product's own detail.
 *
 * ## The pacer and the task deadline
 *
 * The context's writes pacer (`core/ritmo.ts`): two intervals before a deciding
 * read and before the read-back of a landed write, one before a confirming read
 * that decides nothing (the history read's own client waits its one), none
 * before a write. And no write STARTS later than {@link PRAZO_ULTIMA_ESCRITA_MS}
 * after the task's dispatch began (`PrazoDeEscritaEsgotadoLiError`, nothing
 * sent): with the queue's retry backoff above that bound plus the write
 * deadline, an attempt the queue abandoned can no longer write by the time a
 * retry starts. The deadline is checked before the write and AGAIN inside the
 * write client's credential re-read, after it and before the request (the
 * package awaits that re-read outside its own deadline, so a slow Firestore
 * read would otherwise push the request past the bound) — for the write only,
 * never for a read.
 *
 * The situação history read asks for ONE page ({@link MAX_PAGINAS_HISTORICO_CONFERENCIA_LI}):
 * one interval plus one request deadline, as the run's worst case counts it.
 * An order with more rows than a page holds comes back unverified
 * (`LiPaginacaoError`, contained), never as a read that outlives the task.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write
 * call — not even in a comment (`estrutura.test.ts`) — and never builds a client:
 * the write context does.
 */
import {
  CAMINHO_ESTOQUE_LI,
  type CodigoSituacaoEscritaLi,
  ESTOQUE_FIXO_ESCRITA_LI,
  type EcoEstoqueProdutoLi,
  type EcoPedidoEnvioLi,
  type EcoSituacaoPedidoLi,
  type EstoqueProdutoDetalheLi,
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiNetworkError,
  LiNotFoundError,
  LiPaginacaoError,
  LiSchemaError,
  LiThrottleError,
  LiTimeoutError,
  type PedidoLi,
  type RespostaEscritaLi,
  type RespostaLeituraEscritaLi,
  type SituacaoHistoricoLinhaLi,
  alterarSituacaoPedidoLi,
  atualizarEstoqueProdutoLi,
  atualizarObjetoEnvioLi,
  liEstoqueProdutoDetalheSchema,
  liPedidoSchema,
  listarHistoricoSituacaoLi,
} from '@delfrance/integrations-loja-integrada';

import type { ContextoEscritaLojaIntegrada } from './contextoEscrita';
import {
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
  LiCredencialTrocadaError,
} from './erros';
import { deepEqual } from './igualdadeJsonLi';
import {
  type OpcoesRegistroLi,
  type PoliticaCampoLi,
  registrarDerivaLi,
  registrarDiffLi,
  registrarEscritaLi,
  registrarRestauracaoLi,
} from './log';
import { corpoDeRestauracaoLi } from './redacao';
import {
  type AlvoLi,
  type AmbienteLi,
  FLUXO_LI,
  type FluxoLi,
  MODO_LI,
  type MotivoDryRunLi,
  type ValvulaLi,
  chaveDoAlvo,
  decidirAlvo,
  lerValvula,
  registrarValvulaLi,
} from './valvulas';

/* -------------------------------------------------------------------------- */
/*                         The kinds, their reads, their fields                */
/* -------------------------------------------------------------------------- */

/** The order kinds (step 7): an envio's tracking code, and the order's situação. */
export type TipoEscritaPedidoLi = 'objeto-envio' | 'situacao-pedido';

/**
 * The stock kinds (step 12): ONE product's stock, `PUT /v1/produto_estoque/{produto id}`.
 * `estoque-produto` is a single product's write (an event, a manual send, a
 * publish, a deriva), read back by its own call; `estoque-produto-lote` is the
 * same write sent by a bulk origin (the reconcile, the kits), whose read-back is
 * the stock list's next walk (requirement 10).
 */
export type TipoEscritaEstoqueLi = 'estoque-produto' | 'estoque-produto-lote';

/**
 * The engine's write kinds (one per PLAN §4.26 row). Distinct from any task
 * payload's own `tipo`: this is what is WRITTEN, not what asked for it.
 */
export type TipoEscritaLi = TipoEscritaPedidoLi | TipoEscritaEstoqueLi;

/**
 * The field each kind writes. `estoque` is the WHOLE four-leaf stock body
 * ({@link CorpoEstoqueEscritaLi}), never the quantity alone.
 */
export type CampoEscritaLi = 'objeto' | 'codigo' | 'estoque';

export const CAMPO_DO_TIPO_ESCRITA_LI = {
  'objeto-envio': 'objeto',
  'situacao-pedido': 'codigo',
  'estoque-produto': 'estoque',
  'estoque-produto-lote': 'estoque',
} as const satisfies Record<TipoEscritaLi, CampoEscritaLi>;

/**
 * The flow each kind belongs to (requirement 2): a kind is sent, or diffed, only
 * by a run opened under THAT flow's valve and canary — the stock kinds never
 * under the status write-back's, and the reverse.
 */
export const FLUXO_DO_TIPO_ESCRITA_LI = {
  'objeto-envio': FLUXO_LI.rastreio,
  'situacao-pedido': FLUXO_LI.rastreio,
  'estoque-produto': FLUXO_LI.estoque,
  'estoque-produto-lote': FLUXO_LI.estoque,
} as const satisfies Record<TipoEscritaLi, FluxoLi>;

/**
 * The stock body a stock kind writes: the package's three fixed leaves
 * (`ESTOQUE_FIXO_ESCRITA_LI`) and the quantity. Whether the quantity is one the
 * package sends (a non-negative safe integer) is the package's route to refuse
 * (`LiConfigError`, nothing fetched).
 */
export type CorpoEstoqueEscritaLi = typeof ESTOQUE_FIXO_ESCRITA_LI & {
  readonly quantidade: number;
};

/**
 * The pre-write readers (requirement 2): `pedido`, the order detail,
 * `GET /v1/pedido/{numero}/`; `produto-estoque`, one product's stock detail,
 * `GET /v1/produto_estoque/{produto id}`. A later kind's reader (a list page)
 * joins this union, and {@link lerBaseLi} does not compile until it handles it.
 */
export type LeitorPrevioLi = 'pedido' | 'produto-estoque';

/** Requirement 2's row: how one kind is read before a write, and read back after it. */
export interface LeituraPreviaLi {
  /** The pre-write reader, which {@link lerBaseLi} is called with. */
  readonly leitura: LeitorPrevioLi;
  /**
   * The read-back strategy: `recurso`, the same resource read again by its own
   * call; `lista`, NO call — the list's next walk reads it back (requirement 10).
   */
  readonly leituraDeVolta: 'recurso' | 'lista';
  /** No write of this kind without its read. */
  readonly obrigatoria: true;
  /** A target the read cannot find is never written. */
  readonly ausente: 'dry-run';
}

/** Requirement 2: one pre-write read per kind. A new kind fails to compile until it has its row. */
export const LEITURA_PREVIA_LI = {
  'objeto-envio': {
    leitura: 'pedido',
    leituraDeVolta: 'recurso',
    obrigatoria: true,
    ausente: 'dry-run',
  },
  'situacao-pedido': {
    leitura: 'pedido',
    leituraDeVolta: 'recurso',
    obrigatoria: true,
    ausente: 'dry-run',
  },
  'estoque-produto': {
    leitura: 'produto-estoque',
    leituraDeVolta: 'recurso',
    obrigatoria: true,
    ausente: 'dry-run',
  },
  'estoque-produto-lote': {
    leitura: 'produto-estoque',
    leituraDeVolta: 'lista',
    obrigatoria: true,
    ausente: 'dry-run',
  },
} as const satisfies Record<TipoEscritaLi, LeituraPreviaLi>;

/** The kinds a {@link lerDeVoltaLi} call exists for: those whose row reads the resource again. */
export type TipoComLeituraDeVoltaLi = {
  [T in TipoEscritaLi]: (typeof LEITURA_PREVIA_LI)[T]['leituraDeVolta'] extends 'recurso'
    ? T
    : never;
}[TipoEscritaLi];

/**
 * Requirement 5: how each written field may appear on a line. Every field logs
 * its value (a tracking code, a situação codigo, a stock body: none is a
 * secret); a credential a later step writes would be `so-mudou`.
 */
export const POLITICA_CAMPO_ESCRITA_LI = {
  objeto: 'valor',
  codigo: 'valor',
  estoque: 'valor',
} as const satisfies Record<CampoEscritaLi, PoliticaCampoLi>;

/** The task deadline: no write starts later than this after the task's dispatch began, in ms. */
export const PRAZO_ULTIMA_ESCRITA_MS = 260_000;

/**
 * The pages the situação history read after a write may take: ONE (50 rows,
 * far beyond any one order). More is `LiPaginacaoError`, contained as
 * unverified — never a read of up to ten pages after a write that landed.
 */
export const MAX_PAGINAS_HISTORICO_CONFERENCIA_LI = 1;

/**
 * The task's write deadline passed before a write: NOTHING was sent. Transient
 * (the retry decides afresh from a fresh read). A plain `Error`, not a
 * `LiAppError`: it is about this task's time, never about a conta.
 */
export class PrazoDeEscritaEsgotadoLiError extends Error {
  readonly decorridoMs: number;

  constructor(decorridoMs: number) {
    super(
      `Prazo de escrita da tarefa esgotado (${String(decorridoMs)} ms desde o início, ` +
        `limite ${String(PRAZO_ULTIMA_ESCRITA_MS)} ms). Nada foi enviado à Loja Integrada.`,
    );
    this.name = 'PrazoDeEscritaEsgotadoLiError';
    this.decorridoMs = decorridoMs;
  }
}

/* -------------------------------------------------------------------------- */
/*                         Requirement 1: the valve first                      */
/* -------------------------------------------------------------------------- */

/** How a write run starts: switched off, or open under a valve that is not `off`. */
export type InicioEscritaLi =
  | { readonly kind: 'desligado'; readonly valvula: ValvulaLi }
  | { readonly kind: 'ativo'; readonly valvula: ValvulaLi };

/** The starts this module opened and no motor took yet — the only ones a motor is built from. */
const iniciosAbertos = new WeakSet<InicioEscritaLi>();

/**
 * Requirement 1: THE first two statements of a write run — read the valve,
 * then write the run-start line. `off`, recognised or not, is `desligado`: the
 * caller returns (a task DEFERS, so a later valve still sends) before any read.
 */
export function iniciarEscritaLi(
  fluxo: FluxoLi,
  ambiente: AmbienteLi,
  o: Omit<OpcoesRegistroLi, 'fluxo'>,
): InicioEscritaLi {
  const valvula = lerValvula(fluxo, ambiente);
  registrarValvulaLi(valvula, o);
  const inicio: InicioEscritaLi =
    valvula.modo === MODO_LI.off ? { kind: 'desligado', valvula } : { kind: 'ativo', valvula };
  iniciosAbertos.add(inicio);
  return inicio;
}

export interface OpcoesMotorEscritaLi {
  /** An `ativo` start from {@link iniciarEscritaLi}, and nothing else. */
  readonly inicio: InicioEscritaLi & { readonly kind: 'ativo' };
  readonly contexto: ContextoEscritaLojaIntegrada;
  /** The clock, in ms (the task deadline). */
  readonly agora: () => number;
  /** When the task's dispatch began, in ms (the task deadline). */
  readonly inicioDaTarefaMs: number;
  /** What the engine's lines carry besides the conta and the flow (the attempt, the ids, a test sink). */
  readonly registro?: Omit<OpcoesRegistroLi, 'conta' | 'fluxo'>;
}

/** One write run. Opaque: its state is the engine's. */
export interface MotorEscritaLi {
  readonly integracaoId: string;
  readonly valvula: ValvulaLi;
}

/** The write a run sent (requirement 6). */
interface EscritaDaExecucaoLi {
  readonly destino: DestinoEscritaLi;
  /** A 2xx arrived. `false` while it is in flight, and after a failure that does not prove it never landed. */
  aplicada: boolean;
}

interface EstadoMotorLi extends MotorEscritaLi {
  readonly contexto: ContextoEscritaLojaIntegrada;
  readonly agora: () => number;
  readonly inicioDaTarefaMs: number;
  readonly registro: OpcoesRegistroLi;
  /**
   * Requirement 6: the write this run sent, which landed or may have landed —
   * while it is set, nothing else may be written. `null` until a write is sent,
   * and again only after a failure that proves it never landed.
   */
  escrita: EscritaDaExecucaoLi | null;
}

const estados = new WeakMap<MotorEscritaLi, EstadoMotorLi>();

function estadoDe(motor: MotorEscritaLi): EstadoMotorLi {
  const estado = estados.get(motor);
  if (estado === undefined)
    throw new TypeError('escrita: motor que não foi criado por criarMotorEscritaLi');
  return estado;
}

/**
 * A write run, from a start {@link iniciarEscritaLi} opened under a valve that
 * is not `off`. The start is TAKEN: one start builds one motor, so "no write
 * after a landed one" holds for the run, not for one of several motors.
 */
export function criarMotorEscritaLi(o: OpcoesMotorEscritaLi): MotorEscritaLi {
  const inicio: InicioEscritaLi = o.inicio;
  if (!iniciosAbertos.has(inicio) || inicio.kind !== 'ativo') {
    throw new TypeError(
      'escrita: um motor só nasce de iniciarEscritaLi com a válvula ligada, uma vez por início',
    );
  }
  iniciosAbertos.delete(inicio);
  const motor: MotorEscritaLi = { integracaoId: o.contexto.integracaoId, valvula: inicio.valvula };
  estados.set(motor, {
    ...motor,
    contexto: o.contexto,
    agora: o.agora,
    inicioDaTarefaMs: o.inicioDaTarefaMs,
    // `conta` and `fluxo` LAST: every line names this conta and this valve's flow.
    registro: { ...o.registro, conta: o.contexto.integracaoId, fluxo: inicio.valvula.fluxo },
    escrita: null,
  });
  return motor;
}

/** Wait `n` pacer intervals. */
async function esperarIntervalos(e: EstadoMotorLi, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await e.contexto.ritmo.esperar(e.contexto.ritmo.intervaloMs);
}

/**
 * The target's key as a path segment, after the conta check (a programming
 * error otherwise): the order `numero`, or the PRODUCT id of a stock target —
 * never a stock row's own `id`, which the store answers 404 for.
 */
function idDoAlvo(e: EstadoMotorLi, alvo: AlvoLi): string {
  if (alvo.contaId !== e.integracaoId) {
    throw new TypeError('escrita: o alvo é de outra conta que a do contexto');
  }
  if (chaveDoAlvo(alvo) === null) throw new TypeError('escrita: alvo inválido');
  return String(alvo.recurso);
}

/** The order detail, in its slash form: the `pedido` reader's path. */
function caminhoDoPedido(numero: string): string {
  return `/v1/pedido/${numero}/`;
}

/**
 * One product's stock detail, in the no-slash form — the `produto-estoque`
 * reader's path, and the one the stock write's route accepts.
 */
function caminhoDoEstoque(produtoId: string): string {
  return `${CAMINHO_ESTOQUE_LI}/${produtoId}`;
}

/** The path a pre-write reader reads (requirement 2's table); an unknown reader is a programming error. */
function caminhoDoLeitorPrevio(leitura: LeitorPrevioLi, id: string): string {
  switch (leitura) {
    case 'pedido':
      return caminhoDoPedido(id);
    case 'produto-estoque':
      return caminhoDoEstoque(id);
  }
  const desconhecido: never = leitura;
  throw new TypeError(`escrita: leitura prévia desconhecida (${String(desconhecido)})`);
}

/** The task deadline: refused, with nothing sent, once it has passed. */
function verificarPrazoDaEscrita(e: EstadoMotorLi): void {
  const decorridoMs = e.agora() - e.inicioDaTarefaMs;
  if (decorridoMs > PRAZO_ULTIMA_ESCRITA_MS) throw new PrazoDeEscritaEsgotadoLiError(decorridoMs);
}

/** Whether `alvo` is the target of the write this run landed. */
function ehAlvoDaEscrita(escrita: EscritaDaExecucaoLi, alvo: AlvoLi): boolean {
  return (
    escrita.destino.alvo.contaId === alvo.contaId && escrita.destino.alvo.recurso === alvo.recurso
  );
}

/**
 * The write this run LANDED, for a read after it — refused (a `TypeError`,
 * nothing sent) when none landed or `alvo` is another target.
 */
function escritaAplicadaPara(e: EstadoMotorLi, alvo: AlvoLi): EscritaDaExecucaoLi {
  const escrita = e.escrita;
  if (escrita === null || !escrita.aplicada) {
    throw new TypeError('escrita: nada chegou nesta execução — não há o que ler depois da escrita');
  }
  if (!ehAlvoDaEscrita(escrita, alvo)) {
    throw new TypeError('escrita: o alvo não é o da escrita que chegou nesta execução');
  }
  return escrita;
}

/**
 * Whether a write's failure PROVES it never landed (requirement 6): refused
 * before anything was sent — the package's own refusal of the route or body,
 * the credential re-read's refusals, the task deadline — or answered 3xx/4xx
 * other than 429. Everything else (a 5xx, a 429, a timeout or a cut
 * connection, an unclassified error) may have landed.
 */
function provaQueNaoChegou(err: unknown): boolean {
  if (err instanceof LiThrottleError) return false;
  if (err instanceof LiHttpError) return err.status >= 300 && err.status < 500;
  return (
    err instanceof LiConfigError ||
    err instanceof LiCredencialAusenteError ||
    err instanceof LiCredencialInvalidaError ||
    err instanceof LiContaParadaError ||
    err instanceof LiCredencialTrocadaError ||
    err instanceof PrazoDeEscritaEsgotadoLiError
  );
}

/**
 * The path a kind's read-back strategy reads (requirement 2's table): the
 * kind's own reader again. `lista` makes no call (requirement 10), so asking
 * for one is a programming error — refused before any wait, nothing sent.
 */
function caminhoDaLeituraDeVolta(
  estrategia: LeituraPreviaLi['leituraDeVolta'],
  leitura: LeitorPrevioLi,
  id: string,
): string {
  switch (estrategia) {
    case 'recurso':
      return caminhoDoLeitorPrevio(leitura, id);
    case 'lista':
      throw new TypeError(
        'escrita: a leitura de volta de um lote é a próxima passada da lista, nunca uma chamada',
      );
  }
  const desconhecida: never = estrategia;
  throw new TypeError(`escrita: leitura de volta desconhecida (${String(desconhecida)})`);
}

/** One resource read through the write client, by reader: what it parsed it as. */
type LeituraDoRecursoLi =
  | { readonly leitura: 'pedido'; readonly resposta: RespostaLeituraEscritaLi<PedidoLi> }
  | {
      readonly leitura: 'produto-estoque';
      readonly resposta: RespostaLeituraEscritaLi<EstoqueProdutoDetalheLi>;
    };

/** The call names of each reader: as the deciding read, and as the read-back. */
const OPERACOES_DO_LEITOR_LI = {
  pedido: { decisoria: 'lerPedidoParaEscrita', deVolta: 'lerPedidoDeVolta' },
  'produto-estoque': { decisoria: 'lerEstoqueParaEscrita', deVolta: 'lerEstoqueDeVolta' },
} as const satisfies Record<LeitorPrevioLi, { decisoria: string; deVolta: string }>;

/**
 * `GET caminho` through the write client (its credential is the run's pin),
 * parsed by the reader's own package schema: the order, or one product's stock
 * detail (`liEstoqueProdutoDetalheSchema`, so a detail without a leaf the write
 * decides on refuses the read). Every failure propagates.
 */
async function lerRecursoLi(
  e: EstadoMotorLi,
  leitura: LeitorPrevioLi,
  caminho: string,
  finalidade: 'decisoria' | 'deVolta',
): Promise<LeituraDoRecursoLi> {
  const operacao = OPERACOES_DO_LEITOR_LI[leitura][finalidade];
  switch (leitura) {
    case 'pedido':
      return {
        leitura,
        resposta: await e.contexto.escrita.lerAntesDeEscreverLi({
          operacao,
          caminho,
          schema: liPedidoSchema,
        }),
      };
    case 'produto-estoque':
      return {
        leitura,
        resposta: await e.contexto.escrita.lerAntesDeEscreverLi({
          operacao,
          caminho,
          schema: liEstoqueProdutoDetalheSchema,
        }),
      };
  }
  const desconhecido: never = leitura;
  throw new TypeError(`escrita: leitura prévia desconhecida (${String(desconhecido)})`);
}

/* -------------------------------------------------------------------------- */
/*                 Requirements 2 and 4: the deciding read (the base)          */
/* -------------------------------------------------------------------------- */

/** What every deciding read that found its target carries. */
interface BaseLidaComumLi {
  readonly kind: 'lida';
  readonly alvo: AlvoLi;
  readonly status: number;
  /** The credential this read used — the run's pin. */
  readonly refCredencial: string;
  /** Requirement 4: the restore line was written. `false` ⇒ no write from this base. */
  readonly restauracao: boolean;
}

/** A deciding read that found the order. */
export interface BaseLidaPedidoLi extends BaseLidaComumLi {
  /** The reader that read it: a write decides only on its own kind's reader (requirement 2). */
  readonly leitura: 'pedido';
  /** The order as the package parsed it. */
  readonly pedido: PedidoLi;
}

/**
 * A deciding read that found the product's stock row. ⚠️ The row's `produto`
 * is NOT checked against the target here: whether the row names the product
 * asked for is the flow's to judge (`produtoIdDoEstoqueLi`), as the status
 * write-back judges an order's `numero`.
 */
export interface BaseLidaEstoqueLi extends BaseLidaComumLi {
  /** The reader that read it: a write decides only on its own kind's reader (requirement 2). */
  readonly leitura: 'produto-estoque';
  /** The stock row as the package parsed it (`liEstoqueProdutoDetalheSchema`). */
  readonly produtoEstoque: EstoqueProdutoDetalheLi;
}

/** A deciding read that found its target, discriminated by the reader that read it. */
export type BaseLidaLi = BaseLidaPedidoLi | BaseLidaEstoqueLi;

/** A deciding read that found nothing (a 404): never written. */
export interface BaseAusenteLi {
  readonly kind: 'ausente';
  readonly alvo: AlvoLi;
}

/** The deciding read: its target as read, or `ausente` (a 404 — never written). */
export type BaseEscritaLi = BaseLidaLi | BaseAusenteLi;
/** The order reader's deciding read. */
export type BaseEscritaPedidoLi = BaseLidaPedidoLi | BaseAusenteLi;
/** The stock reader's deciding read. */
export type BaseEscritaEstoqueLi = BaseLidaEstoqueLi | BaseAusenteLi;

/** The bases this module read; each decides at most ONE write attempt. */
const basesLidas = new WeakMap<BaseLidaLi, { readonly motor: MotorEscritaLi; gasta: boolean }>();

/** The base of a read that found its target, in the arm of the reader that read it. */
function baseDaLeitura(alvo: AlvoLi, lido: LeituraDoRecursoLi, restauracao: boolean): BaseLidaLi {
  switch (lido.leitura) {
    case 'pedido':
      return {
        kind: 'lida',
        alvo,
        leitura: lido.leitura,
        pedido: lido.resposta.dados,
        status: lido.resposta.status,
        refCredencial: lido.resposta.refCredencial,
        restauracao,
      };
    case 'produto-estoque':
      return {
        kind: 'lida',
        alvo,
        leitura: lido.leitura,
        produtoEstoque: lido.resposta.dados,
        status: lido.resposta.status,
        refCredencial: lido.resposta.refCredencial,
        restauracao,
      };
  }
  const desconhecida: never = lido;
  throw new TypeError(`escrita: leitura desconhecida (${String(desconhecida)})`);
}

/**
 * Requirements 2 and 4: the read a write is decided on, by the reader its
 * kind's row names (`leitura`: `pedido` for both order kinds, `produto-estoque`
 * for both stock kinds) — two pacer intervals, then `GET /v1/pedido/{numero}/`
 * or `GET /v1/produto_estoque/{produto id}` through the write client (pinning
 * its credential), then the restore line. Every write needs one of its own: the
 * SECOND guard after a refused write is another call to this, with its own
 * line (and it doubles as the confirming read of a refused write's
 * credential). A read-back is never a base. Reading is not tied to a flow; the
 * write is ({@link escreverLi}).
 *
 * A 404 is `ausente` — for a stock target, a product with no stock row and a
 * stock row's own id alike; every other failure propagates, for the flow to
 * classify.
 */
export function lerBaseLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  leitura: 'pedido',
): Promise<BaseEscritaPedidoLi>;
export function lerBaseLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  leitura: 'produto-estoque',
): Promise<BaseEscritaEstoqueLi>;
export function lerBaseLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  leitura: LeitorPrevioLi,
): Promise<BaseEscritaLi>;
export async function lerBaseLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  leitura: LeitorPrevioLi,
): Promise<BaseEscritaLi> {
  const e = estadoDe(motor);
  const id = idDoAlvo(e, alvo);
  const caminho = caminhoDoLeitorPrevio(leitura, id);
  await esperarIntervalos(e, 2);
  let lido: LeituraDoRecursoLi;
  try {
    lido = await lerRecursoLi(e, leitura, caminho, 'decisoria');
  } catch (err) {
    if (err instanceof LiNotFoundError) return { kind: 'ausente', alvo };
    throw err;
  }
  const resposta = lido.resposta;
  e.contexto.credencial.fixar(resposta.refCredencial);
  const corpo = corpoDeRestauracaoLi({ caminho, status: resposta.status, texto: resposta.texto });
  const restauracao =
    corpo !== null &&
    registrarRestauracaoLi(
      { recurso: alvo.recurso, caminho, status: resposta.status, corpo },
      e.registro,
    ).escrita;
  const base = baseDaLeitura(alvo, lido, restauracao);
  basesLidas.set(base, { motor, gasta: false });
  return base;
}

/* -------------------------------------------------------------------------- */
/*                Requirements 3, 5 and 6: the write, or its diff              */
/* -------------------------------------------------------------------------- */

/**
 * Where a write goes. The objeto's envio id must be one of the deciding read's
 * envios; a stock target's `recurso` is the PRODUCT id.
 */
export type DestinoEscritaLi =
  | { readonly tipo: 'situacao-pedido'; readonly alvo: AlvoLi }
  | { readonly tipo: 'objeto-envio'; readonly alvo: AlvoLi; readonly envioId: number }
  | { readonly tipo: 'estoque-produto'; readonly alvo: AlvoLi }
  | { readonly tipo: 'estoque-produto-lote'; readonly alvo: AlvoLi };

/** What a write sets. The field must be its kind's ({@link CAMPO_DO_TIPO_ESCRITA_LI}). */
export type PayloadEscritaLi =
  | { readonly campo: 'codigo'; readonly valor: CodigoSituacaoEscritaLi }
  | { readonly campo: 'objeto'; readonly valor: string }
  | { readonly campo: 'estoque'; readonly valor: CorpoEstoqueEscritaLi };

/** The echo a write's answer carries, by kind. */
export type EcoEscritaLi = EcoPedidoEnvioLi | EcoSituacaoPedidoLi | EcoEstoqueProdutoLi;

/**
 * What one write call did. Only `enviado` carries a write — a run that may not
 * write cannot hold one, and cannot mark anything sent.
 */
export type ResultadoEscritaLi =
  /** The valve or the canary keeps this target from writing: one `diff` line per field, nothing sent. */
  | { readonly kind: 'nao-enviado'; readonly motivo: MotivoDryRunLi }
  /** It could write, but the deciding read has no restore line (requirement 4): nothing sent. */
  | { readonly kind: 'sem-restauracao' }
  /** A 2xx: the write landed (or was accepted, 202). The run writes nothing else. */
  | {
      readonly kind: 'enviado';
      readonly resposta: RespostaEscritaLi<EcoEscritaLi>;
    };

/** What a field's current value is read from: a deciding read, or a verified read-back. */
type LeituraDoAlvoLi =
  | { readonly leitura: 'pedido'; readonly pedido: PedidoLi }
  | { readonly leitura: 'produto-estoque'; readonly produtoEstoque: EstoqueProdutoDetalheLi };

/** The order a read holds — a `TypeError` when it read a stock row (narrowing, never a cast). */
function pedidoDa(fonte: LeituraDoAlvoLi): PedidoLi {
  if (fonte.leitura !== 'pedido') {
    throw new TypeError('escrita: a leitura não é a do pedido que este tipo de escrita lê');
  }
  return fonte.pedido;
}

/** The stock row a read holds — a `TypeError` when it read an order (narrowing, never a cast). */
function estoqueDa(fonte: LeituraDoAlvoLi): EstoqueProdutoDetalheLi {
  if (fonte.leitura !== 'produto-estoque') {
    throw new TypeError('escrita: a leitura não é a do estoque que este tipo de escrita lê');
  }
  return fonte.produtoEstoque;
}

/**
 * A read's current value of the kind's field (`undefined` when absent). For a
 * stock kind, the four leaves a stock write SETS, as the package parsed the row
 * (`wireInt` reads a quoted `'5'` as `5`): never the store's reservation or its
 * available quantity, which no write sets.
 */
function valorAtual(destino: DestinoEscritaLi, fonte: LeituraDoAlvoLi): unknown {
  switch (destino.tipo) {
    case 'situacao-pedido':
      return pedidoDa(fonte).situacao.codigo;
    case 'objeto-envio':
      return pedidoDa(fonte).envios.find((envio) => envio.id === destino.envioId)?.objeto;
    case 'estoque-produto':
    case 'estoque-produto-lote': {
      const linha = estoqueDa(fonte);
      return {
        gerenciado: linha.gerenciado,
        quantidade: linha.quantidade,
        situacao_em_estoque: linha.situacao_em_estoque,
        situacao_sem_estoque: linha.situacao_sem_estoque,
      };
    }
  }
  const desconhecido: never = destino;
  throw new TypeError(`escrita: tipo de escrita desconhecido (${String(desconhecido)})`);
}

/**
 * Whether a stock body is shaped as the one the package sends: a `quantidade`
 * key plus the three fixed leaves, equal to `ESTOQUE_FIXO_ESCRITA_LI` and
 * nothing else (`deepEqual`: own keys, any order, no fold). So the diff and the
 * deriva never compare a body other than the one the write would carry. The
 * quantity's VALUE is the package route's to refuse (`LiConfigError`).
 */
function corpoDeEstoqueConforme(corpo: CorpoEstoqueEscritaLi): boolean {
  const fixos = Object.fromEntries(
    Object.entries(corpo).filter(([chave]) => chave !== 'quantidade'),
  );
  return Object.hasOwn(corpo, 'quantidade') && deepEqual(fixos, ESTOQUE_FIXO_ESCRITA_LI);
}

/** The ONE place a package write operation is called: the kind's operation, its target's path id. */
function enviar(
  e: EstadoMotorLi,
  destino: DestinoEscritaLi,
  payload: PayloadEscritaLi,
  id: string,
): Promise<RespostaEscritaLi<EcoEscritaLi>> {
  switch (destino.tipo) {
    case 'objeto-envio':
      if (payload.campo === 'objeto') {
        return atualizarObjetoEnvioLi(e.contexto.escrita, destino.envioId, payload.valor);
      }
      break;
    case 'situacao-pedido':
      if (payload.campo === 'codigo') {
        return alterarSituacaoPedidoLi(e.contexto.escrita, id, payload.valor);
      }
      break;
    case 'estoque-produto':
    case 'estoque-produto-lote':
      // The package adds the three fixed leaves itself; `escreverLi` checked the payload holds them.
      if (payload.campo === 'estoque') {
        return atualizarEstoqueProdutoLi(e.contexto.escrita, id, payload.valor.quantidade);
      }
      break;
  }
  // `escreverLi` refused the mismatch before deciding anything.
  throw new TypeError('escrita: o campo não é o do tipo de escrita');
}

/**
 * The write — or, where the valve or the canary keeps this target from
 * writing, its diff. In order, refusing as a `TypeError` (a programming error,
 * nothing sent) whatever breaks the engine's contract:
 *
 *  1. a write already sent in this run that landed or may have landed
 *     (requirement 6);
 *  2. a kind of another flow than the run's valve (requirement 2) — before the
 *     diff, so a dry-run refuses it too;
 *  3. a target of another conta, a base of another target, another motor or
 *     another reader than the kind's row names (an order base for a stock
 *     write, a stock base for an order write), a field of another kind, an
 *     envio id the deciding read does not list, a stock body other than the
 *     package's four leaves (requirements 2 and 3);
 *  4. the target decision (`decidirAlvo`): not `on` ⇒ one `diff` line,
 *     `nao-enviado`;
 *  5. `on`: no restore line ⇒ `sem-restauracao`; a base that already decided a
 *     write attempt ⇒ `TypeError`; past the task deadline ⇒
 *     `PrazoDeEscritaEsgotadoLiError`; then the write, at once (no wait). The
 *     run is closed BEFORE the write is sent, and the deadline is armed again
 *     for the write client's credential re-read.
 *
 * A 2xx resolves `enviado` (one `escrita` line). Every other outcome is the
 * package's error (or the deadline's), rethrown as-is, for the flow to
 * classify — after which the next write needs a fresh deciding read, and is
 * possible at all only when the failure proved nothing landed.
 */
export async function escreverLi(
  motor: MotorEscritaLi,
  destino: DestinoEscritaLi,
  payload: PayloadEscritaLi,
  base: BaseLidaLi,
): Promise<ResultadoEscritaLi> {
  const e = estadoDe(motor);
  if (e.escrita !== null) {
    throw new TypeError(
      'escrita: esta execução já enviou uma escrita que chegou ou pode ter chegado — nenhuma outra',
    );
  }
  if (FLUXO_DO_TIPO_ESCRITA_LI[destino.tipo] !== e.valvula.fluxo) {
    throw new TypeError(
      'escrita: este tipo de escrita é de outro fluxo que o da válvula da execução',
    );
  }
  const id = idDoAlvo(e, destino.alvo);
  const lidaPor = basesLidas.get(base);
  if (base.kind !== 'lida' || lidaPor === undefined || lidaPor.motor !== motor) {
    throw new TypeError('escrita: a base não é uma leitura decisória deste motor');
  }
  if (base.alvo.contaId !== destino.alvo.contaId || base.alvo.recurso !== destino.alvo.recurso) {
    throw new TypeError('escrita: a base é de outro alvo');
  }
  if (base.leitura !== LEITURA_PREVIA_LI[destino.tipo].leitura) {
    throw new TypeError('escrita: a base não foi lida pela leitura prévia deste tipo de escrita');
  }
  if (CAMPO_DO_TIPO_ESCRITA_LI[destino.tipo] !== payload.campo) {
    throw new TypeError('escrita: o campo não é o do tipo de escrita');
  }
  if (
    destino.tipo === 'objeto-envio' &&
    !pedidoDa(base).envios.some((envio) => envio.id === destino.envioId)
  ) {
    throw new TypeError('escrita: o envio não está na leitura decisória do alvo');
  }
  if (payload.campo === 'estoque' && !corpoDeEstoqueConforme(payload.valor)) {
    throw new TypeError(
      'escrita: o corpo de estoque não é o do pacote (quantidade e os três campos fixos)',
    );
  }

  const decisao = decidirAlvo(e.valvula, destino.alvo);
  if (decisao.modo === MODO_LI.off) {
    throw new TypeError('escrita: um motor nunca roda com a válvula desligada');
  }
  if (decisao.modo === MODO_LI.dryRun) {
    const politica = POLITICA_CAMPO_ESCRITA_LI[payload.campo];
    const antes = valorAtual(destino, base);
    registrarDiffLi(
      {
        recurso: destino.alvo.recurso,
        tipo: destino.tipo,
        campo: payload.campo,
        politica,
        antes,
        depois: payload.valor,
        mudou: !deepEqual(antes, payload.valor),
        motivo: decisao.motivo,
      },
      e.registro,
    );
    return { kind: 'nao-enviado', motivo: decisao.motivo };
  }

  if (!base.restauracao) return { kind: 'sem-restauracao' };
  if (lidaPor.gasta) {
    throw new TypeError('escrita: esta leitura decisória já decidiu uma escrita — leia de novo');
  }
  verificarPrazoDaEscrita(e);

  // Spent BEFORE sending: whatever happens to this attempt, the next write is
  // decided by a fresh read.
  lidaPor.gasta = true;
  // The run is closed BEFORE the first `await`: a write started alongside this
  // one is refused above, and a write that may have landed keeps it closed.
  const enviada: EscritaDaExecucaoLi = { destino, aplicada: false };
  e.escrita = enviada;
  // The deadline again, inside the write client's credential re-read — after
  // it, before the request — for THIS write only.
  e.contexto.verificacaoDaEscrita.armar(() => {
    verificarPrazoDaEscrita(e);
  });
  let resposta: RespostaEscritaLi<EcoEscritaLi>;
  try {
    resposta = await enviar(e, destino, payload, id);
  } catch (err) {
    // Reopened only when nothing can have landed; rethrown as-is either way.
    if (provaQueNaoChegou(err)) e.escrita = null;
    throw err;
  } finally {
    e.contexto.verificacaoDaEscrita.desarmar();
  }

  // The write LANDED: from here on nothing may throw (requirement 6).
  enviada.aplicada = true;
  registrarEscritaLi(
    {
      recurso: destino.alvo.recurso,
      tipo: destino.tipo,
      campo: payload.campo,
      resultado: resposta.aplicada === 'sim' ? 'aplicada' : 'pendente',
      status: resposta.status,
      aplicada: resposta.aplicada,
      leituraEco: resposta.leituraEco,
    },
    e.registro,
  );
  return { kind: 'enviado', resposta };
}

/* -------------------------------------------------------------------------- */
/*                Requirement 7: the read-back and its containment             */
/* -------------------------------------------------------------------------- */

/**
 * The classes a read after a write CONTAINS (requirement 7), most specific
 * first so each is named by its own class. Anything else — `LiConfigError`,
 * a gRPC error, an unknown error — is rethrown.
 */
export const CLASSES_CONTIDAS_LI = [
  'LiAuthError',
  'LiNotFoundError',
  'LiThrottleError',
  'LiHttpError',
  'LiSchemaError',
  'LiTimeoutError',
  'LiNetworkError',
  'LiPaginacaoError',
  'LiCredencialAusenteError',
  'LiCredencialInvalidaError',
  'LiContaParadaError',
  'LiCredencialTrocadaError',
] as const;

export type ClasseContidaLi = (typeof CLASSES_CONTIDAS_LI)[number];

/** A contained failure: its class, and the error itself (a 401 still reaches the park). */
export interface FalhaContidaLi {
  readonly classe: ClasseContidaLi;
  readonly erro: Error;
}

/**
 * The contained class of `err`, or `null` to rethrow it. Narrowed class by
 * class (rule 6); the package's `LiError` base is never tested, so its
 * `LiConfigError` — our own misconfiguration — stays loud.
 */
function falhaContida(err: unknown): FalhaContidaLi | null {
  // The `LiHttpError` subclasses BEFORE `LiHttpError` itself, `LiTimeoutError` before its parent.
  if (err instanceof LiAuthError) return { classe: 'LiAuthError', erro: err };
  if (err instanceof LiNotFoundError) return { classe: 'LiNotFoundError', erro: err };
  if (err instanceof LiThrottleError) return { classe: 'LiThrottleError', erro: err };
  if (err instanceof LiHttpError) return { classe: 'LiHttpError', erro: err };
  if (err instanceof LiSchemaError) return { classe: 'LiSchemaError', erro: err };
  if (err instanceof LiTimeoutError) return { classe: 'LiTimeoutError', erro: err };
  if (err instanceof LiNetworkError) return { classe: 'LiNetworkError', erro: err };
  if (err instanceof LiPaginacaoError) return { classe: 'LiPaginacaoError', erro: err };
  if (err instanceof LiCredencialAusenteError)
    return { classe: 'LiCredencialAusenteError', erro: err };
  if (err instanceof LiCredencialInvalidaError) {
    return { classe: 'LiCredencialInvalidaError', erro: err };
  }
  if (err instanceof LiContaParadaError) return { classe: 'LiContaParadaError', erro: err };
  if (err instanceof LiCredencialTrocadaError)
    return { classe: 'LiCredencialTrocadaError', erro: err };
  return null;
}

/** A read-back of an order kind: the order as read, or a contained failure (`verificado: false`). */
export type LeituraDeVoltaPedidoLi =
  | {
      readonly verificado: true;
      readonly leitura: 'pedido';
      readonly pedido: PedidoLi;
      readonly status: number;
    }
  | ({ readonly verificado: false } & FalhaContidaLi);

/** A read-back of `estoque-produto`: the stock row as read, or a contained failure. */
export type LeituraDeVoltaEstoqueLi =
  | {
      readonly verificado: true;
      readonly leitura: 'produto-estoque';
      readonly produtoEstoque: EstoqueProdutoDetalheLi;
      readonly status: number;
    }
  | ({ readonly verificado: false } & FalhaContidaLi);

/** A read-back, discriminated (when verified) by the reader that read it. */
export type LeituraDeVoltaLi = LeituraDeVoltaPedidoLi | LeituraDeVoltaEstoqueLi;

/** A verified read-back, in the arm of the reader that read it. */
function leituraDeVoltaVerificada(lido: LeituraDoRecursoLi): LeituraDeVoltaLi {
  switch (lido.leitura) {
    case 'pedido':
      return {
        verificado: true,
        leitura: lido.leitura,
        pedido: lido.resposta.dados,
        status: lido.resposta.status,
      };
    case 'produto-estoque':
      return {
        verificado: true,
        leitura: lido.leitura,
        produtoEstoque: lido.resposta.dados,
        status: lido.resposta.status,
      };
  }
  const desconhecida: never = lido;
  throw new TypeError(`escrita: leitura desconhecida (${String(desconhecida)})`);
}

/**
 * Requirement 5's read-back, a SEPARATE call (requirement 10's seam): two
 * pacer intervals after a write that landed, then the kind's read-back
 * strategy ({@link LEITURA_PREVIA_LI}) — the order detail, or the product's
 * stock detail, again, with the run's pinned credential. Only of the write that
 * landed: its target and its kind, or a `TypeError` with nothing sent. A kind
 * whose strategy is `lista` (`estoque-produto-lote`) has no read-back call: its
 * type does not compile here, and asking anyway is a `TypeError` before any
 * wait. Contained per requirement 7. Its result never decides a write in this
 * run: no write follows a landed one, and it is not a base.
 */
export function lerDeVoltaLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  tipo: TipoEscritaPedidoLi,
): Promise<LeituraDeVoltaPedidoLi>;
export function lerDeVoltaLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  tipo: 'estoque-produto',
): Promise<LeituraDeVoltaEstoqueLi>;
export function lerDeVoltaLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  tipo: TipoComLeituraDeVoltaLi,
): Promise<LeituraDeVoltaLi>;
export async function lerDeVoltaLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  tipo: TipoEscritaLi,
): Promise<LeituraDeVoltaLi> {
  const e = estadoDe(motor);
  const escrita = escritaAplicadaPara(e, alvo);
  if (escrita.destino.tipo !== tipo) {
    throw new TypeError('escrita: o tipo não é o da escrita que chegou nesta execução');
  }
  const id = idDoAlvo(e, alvo);
  const linha = LEITURA_PREVIA_LI[tipo];
  const caminho = caminhoDaLeituraDeVolta(linha.leituraDeVolta, linha.leitura, id);
  await esperarIntervalos(e, 2);
  let lido: LeituraDoRecursoLi;
  try {
    lido = await lerRecursoLi(e, linha.leitura, caminho, 'deVolta');
  } catch (err) {
    const falha = falhaContida(err);
    if (falha === null) throw err;
    return { verificado: false, ...falha };
  }
  return leituraDeVoltaVerificada(lido);
}

/**
 * Requirement 5: whether the read-back holds what was written — `deepEqual`,
 * no fold (case, spacing, a number and its string, `null` and absent all
 * differ; for a stock kind, the four leaves written, in any key order, as the
 * package parsed them — a quoted integer already read as its number). A
 * difference is one WARNING `deriva` line; what it MEANS (an aviso, a re-check)
 * is the flow's. A read-back of another reader than the kind's is a `TypeError`.
 */
export function conferirEscritaLi(
  motor: MotorEscritaLi,
  destino: DestinoEscritaLi,
  payload: PayloadEscritaLi,
  leitura: LeituraDeVoltaLi & { readonly verificado: true },
): 'igual' | 'deriva' {
  const e = estadoDe(motor);
  const lido = valorAtual(destino, leitura);
  if (deepEqual(lido, payload.valor)) return 'igual';
  registrarDerivaLi(
    {
      recurso: destino.alvo.recurso,
      tipo: destino.tipo,
      campo: payload.campo,
      politica: POLITICA_CAMPO_ESCRITA_LI[payload.campo],
      escrito: payload.valor,
      lido,
    },
    e.registro,
  );
  return 'deriva';
}

/** The situação history of one order, as read for the check after a write, or a contained failure. */
export type HistoricoParaConferenciaLi =
  | { readonly lida: true; readonly linhas: readonly SituacaoHistoricoLinhaLi[] }
  | ({ readonly lida: false } & FalhaContidaLi);

/**
 * The situação-history read after a write that moved the situação (the check
 * that a status someone else set in the instant before our write was not
 * silently overwritten): `GET /v1/situacao_historico/search/` for the target of
 * the write that LANDED (any other target, or no landed write, is a `TypeError`
 * with nothing sent), through the read client (one pacer interval, in its
 * getter), with the run's pinned credential. ONE page
 * ({@link MAX_PAGINAS_HISTORICO_CONFERENCIA_LI}): more is `LiPaginacaoError`.
 * Contained per requirement 7: the write landed and stays done. The rows come
 * back as received; ordering and judging them is the flow's. Only after an
 * ORDER write: after a stock write the target is a product, whose id names no
 * order — a `TypeError`, nothing sent.
 */
export async function lerHistoricoSituacaoParaConferenciaLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
): Promise<HistoricoParaConferenciaLi> {
  const e = estadoDe(motor);
  const escrita = escritaAplicadaPara(e, alvo);
  if (LEITURA_PREVIA_LI[escrita.destino.tipo].leitura !== 'pedido') {
    throw new TypeError('escrita: o histórico de situação só segue uma escrita de pedido');
  }
  const numero = idDoAlvo(e, alvo);
  try {
    const historico = await listarHistoricoSituacaoLi(e.contexto.leitura, numero, {
      maxPaginas: MAX_PAGINAS_HISTORICO_CONFERENCIA_LI,
    });
    return { lida: true, linhas: historico.linhas };
  } catch (err) {
    const falha = falhaContida(err);
    if (falha === null) throw err;
    return { lida: false, ...falha };
  }
}

/**
 * A confirming read that decides nothing (after a situação write refused with
 * 401/403: does the token still READ?): one pacer interval, then
 * `GET /v1/pedido/{numero}/` with the run's pinned credential.
 * Resolves when the read succeeds; every failure propagates for the flow to
 * classify (a 401/403 parks the conta; a getter refusal sends nothing). After a
 * refused tracking-code write, the confirming read is the next deciding read
 * instead ({@link lerBaseLi}). Before any deciding read there is no pinned
 * credential to confirm: a `TypeError`, nothing sent. Only in a run of the
 * order flow: a stock run's target is a product, and its confirming read is the
 * next deciding read, as after a refused tracking code — a `TypeError`, nothing
 * sent.
 */
export async function confirmarCredencialLi(motor: MotorEscritaLi, alvo: AlvoLi): Promise<void> {
  const e = estadoDe(motor);
  if (e.valvula.fluxo !== FLUXO_LI.rastreio) {
    throw new TypeError('escrita: a leitura de confirmação lê um pedido — só no fluxo de rastreio');
  }
  if (e.contexto.credencial.fixada() === null) {
    throw new TypeError('escrita: nenhuma leitura decisória fixou a credencial a confirmar');
  }
  const numero = idDoAlvo(e, alvo);
  await esperarIntervalos(e, 1);
  await e.contexto.escrita.lerAntesDeEscreverLi({
    operacao: 'confirmarCredencial',
    caminho: caminhoDoPedido(numero),
    schema: liPedidoSchema,
  });
}
