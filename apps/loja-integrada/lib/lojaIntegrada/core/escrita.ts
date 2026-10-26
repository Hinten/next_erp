/**
 * The Loja Integrada WRITE ENGINE (master plan step 7, PR 7-b): the ONE module
 * of this app that sends a write. Every write flow (the status write-back
 * first, the catalogue, stock and price writes later) goes through it, and
 * `estrutura.test.ts` refuses a package write operation or a write-client
 * method named anywhere else.
 *
 * It decides NOTHING about a flow's data — whether a write is due, safe or
 * already reflected is the flow's (`lib/lojaIntegrada/rastreio/`, PR 7-d). It
 * owns HOW a write is made, and the ten write-engine requirements of PLAN step 7:
 *
 *  1. **The valve first.** {@link iniciarEscritaLi} reads the valve
 *     (`lerValvula`) as its first statement and writes the run-start line as its
 *     second. `off` (unset, blank, a typo) is `desligado`, and no motor can be
 *     built from it — so nothing below can run, no read, no payload. Only a start
 *     opened here builds a motor. The engine never receives a Firestore handle,
 *     and a run that may not write gets a result with no write in it.
 *  2. **One pre-write read per write kind**, in {@link LEITURA_PREVIA_LI}: the
 *     reader AND the read-back strategy of each kind. Both kinds of step 7 share
 *     one `GET /v1/pedido/{numero}/`. A target the read cannot find is never
 *     written (`ausente`).
 *  3. **The writer receives the target.** {@link escreverLi} takes it, refuses
 *     another conta's (a `TypeError`: a programming error), checks the envio id
 *     against the deciding read of THAT target, and builds the URL from it, so
 *     the canary key and the URL name the same order. The write is made with the
 *     deciding read's credential or not at all (the pin, `core/contextoEscrita.ts`).
 *  4. **A restore line before EACH write**, from its own deciding read
 *     ({@link lerBaseLi}): the read's token-scrubbed text through
 *     `corpoDeRestauracaoLi`, as ONE INFO line capped at 200 KB on the exact line.
 *     No line (too big, too deep, not JSON, a catalogue path) ⇒ that write is not
 *     made (`sem-restauracao`). A deciding read decides at most ONE write
 *     attempt, and a read-back is never a deciding read (another type), so after
 *     a refused write the next one needs a fresh read and its own line.
 *  5. **Dry-run diffs; a separate read-back; a policy per field.** A target the
 *     valve or the canary keeps from writing logs one `diff` line per field
 *     ({@link POLITICA_CAMPO_ESCRITA_LI}); a write that landed is read back by
 *     its own call ({@link lerDeVoltaLi}, two pacer intervals later) and
 *     compared with {@link conferirEscritaLi} (`deepEqual`, the shared leaf); a
 *     difference is one WARNING `deriva` line.
 *  6. **Nothing after a landed write may throw** — any 2xx resolves (the
 *     package), the logging is total (`log.ts`), and **no write follows a
 *     landed one in the same run** ({@link escreverLi} refuses it as a
 *     `TypeError`). The PERMITTED post-write throws, each safe only because every
 *     attempt re-derives its guards from a fresh read and skips what is already
 *     reflected (never "fix" one into a retry that skips that read):
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
 *     The package's `LiError` base is never tested.
 *  8. **The comparator** is `deepEqual`, the dependency-free leaf
 *     (`core/igualdadeJsonLi.ts`).
 *  9. **The chokepoint** is `estrutura.test.ts`'s.
 *  10. **Bulk mode** (list pages as base and read-back) is NOT built here: it
 *      has no consumer yet. The seam is requirement 2's table, which names the
 *      reader and the read-back strategy per kind, and the read-back being its
 *      own call: a page reader and a page read-back plug in as a kind's row.
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
 * retry starts.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write
 * call — not even in a comment (`estrutura.test.ts`) — and never builds a client:
 * the write context does.
 */
import {
  type CodigoSituacaoEscritaLi,
  type EcoPedidoEnvioLi,
  type EcoSituacaoPedidoLi,
  LiAuthError,
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
  atualizarObjetoEnvioLi,
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

/**
 * The engine's write kinds (one per PLAN §4.26 row). Distinct from any task
 * payload's own `tipo`: this is what is WRITTEN, not what asked for it.
 */
export type TipoEscritaLi = 'objeto-envio' | 'situacao-pedido';

/** The field each kind writes. */
export type CampoEscritaLi = 'objeto' | 'codigo';

export const CAMPO_DO_TIPO_ESCRITA_LI = {
  'objeto-envio': 'objeto',
  'situacao-pedido': 'codigo',
} as const satisfies Record<TipoEscritaLi, CampoEscritaLi>;

/** Requirement 2's row: how one kind is read before a write, and read back after it. */
export interface LeituraPreviaLi {
  /** The pre-write reader: the order detail, `GET /v1/pedido/{numero}/`. */
  readonly leitura: 'pedido';
  /** The read-back strategy: the same resource, read again (a later kind may read a page). */
  readonly leituraDeVolta: 'recurso';
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
} as const satisfies Record<TipoEscritaLi, LeituraPreviaLi>;

/**
 * Requirement 5: how each written field may appear on a line. Both step-7
 * fields log their value (a tracking code and a situação codigo); a credential
 * a later step writes would be `so-mudou`.
 */
export const POLITICA_CAMPO_ESCRITA_LI = {
  objeto: 'valor',
  codigo: 'valor',
} as const satisfies Record<CampoEscritaLi, PoliticaCampoLi>;

/** B17: no write starts later than this after the task's dispatch began, in ms. */
export const PRAZO_ULTIMA_ESCRITA_MS = 260_000;

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

/** The starts this module opened — the only ones a motor is built from. */
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

interface EstadoMotorLi extends MotorEscritaLi {
  readonly contexto: ContextoEscritaLojaIntegrada;
  readonly agora: () => number;
  readonly inicioDaTarefaMs: number;
  readonly registro: OpcoesRegistroLi;
  /** Requirement 6: a write landed in this run (any 2xx) — nothing else may be written. */
  escritaAplicada: boolean;
}

const estados = new WeakMap<MotorEscritaLi, EstadoMotorLi>();

function estadoDe(motor: MotorEscritaLi): EstadoMotorLi {
  const estado = estados.get(motor);
  if (estado === undefined)
    throw new TypeError('escrita: motor que não foi criado por criarMotorEscritaLi');
  return estado;
}

/** A write run, from a start {@link iniciarEscritaLi} opened under a valve that is not `off`. */
export function criarMotorEscritaLi(o: OpcoesMotorEscritaLi): MotorEscritaLi {
  const inicio: InicioEscritaLi = o.inicio;
  if (!iniciosAbertos.has(inicio) || inicio.kind !== 'ativo') {
    throw new TypeError('escrita: um motor só nasce de iniciarEscritaLi com a válvula ligada');
  }
  const motor: MotorEscritaLi = { integracaoId: o.contexto.integracaoId, valvula: inicio.valvula };
  estados.set(motor, {
    ...motor,
    contexto: o.contexto,
    agora: o.agora,
    inicioDaTarefaMs: o.inicioDaTarefaMs,
    // `conta` and `fluxo` LAST: every line names this conta and this valve's flow.
    registro: { ...o.registro, conta: o.contexto.integracaoId, fluxo: inicio.valvula.fluxo },
    escritaAplicada: false,
  });
  return motor;
}

/** Wait `n` pacer intervals. */
async function esperarIntervalos(e: EstadoMotorLi, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await e.contexto.ritmo.esperar(e.contexto.ritmo.intervaloMs);
}

/** The target's numero as a path segment, after the conta check (a programming error otherwise). */
function numeroDoAlvo(e: EstadoMotorLi, alvo: AlvoLi): string {
  if (alvo.contaId !== e.integracaoId) {
    throw new TypeError('escrita: o alvo é de outra conta que a do contexto');
  }
  if (chaveDoAlvo(alvo) === null) throw new TypeError('escrita: alvo inválido');
  return String(alvo.recurso);
}

/** Requirement 2's reader for the step-7 kinds: the order detail, in its slash form. */
function caminhoDoPedido(numero: string): string {
  return `/v1/pedido/${numero}/`;
}

/** The path a kind's read-back strategy reads (requirement 2's table). */
function caminhoDaLeituraDeVolta(
  estrategia: LeituraPreviaLi['leituraDeVolta'],
  numero: string,
): string {
  switch (estrategia) {
    case 'recurso':
      return caminhoDoPedido(numero);
  }
}

/* -------------------------------------------------------------------------- */
/*                 Requirements 2 and 4: the deciding read (the base)          */
/* -------------------------------------------------------------------------- */

/** A deciding read that found the order. */
export interface BaseLidaLi {
  readonly kind: 'lida';
  readonly alvo: AlvoLi;
  /** The order as the package parsed it. */
  readonly pedido: PedidoLi;
  readonly status: number;
  /** The credential this read used — the run's pin. */
  readonly refCredencial: string;
  /** Requirement 4: the restore line was written. `false` ⇒ no write from this base. */
  readonly restauracao: boolean;
}

/** The deciding read: the order, or `ausente` (a 404 — never written). */
export type BaseEscritaLi = BaseLidaLi | { readonly kind: 'ausente'; readonly alvo: AlvoLi };

/** The bases this module read; each decides at most ONE write attempt. */
const basesLidas = new WeakMap<BaseLidaLi, { readonly motor: MotorEscritaLi; gasta: boolean }>();

/**
 * Requirements 2 and 4: the read a write is decided on — two pacer intervals,
 * then `GET /v1/pedido/{numero}/` through the write client (pinning its
 * credential), then the restore line. Every write needs one of its own: the
 * SECOND guard after a refused write is another call to this, with its own
 * line (and it doubles as the confirming read of a refused write's
 * credential). A read-back is never a base.
 *
 * A 404 is `ausente`; every other failure propagates, for the flow to classify.
 */
export async function lerBaseLi(motor: MotorEscritaLi, alvo: AlvoLi): Promise<BaseEscritaLi> {
  const e = estadoDe(motor);
  const numero = numeroDoAlvo(e, alvo);
  await esperarIntervalos(e, 2);
  const caminho = caminhoDoPedido(numero);
  let resposta: RespostaLeituraEscritaLi<PedidoLi>;
  try {
    resposta = await e.contexto.escrita.lerAntesDeEscreverLi({
      operacao: 'lerPedidoParaEscrita',
      caminho,
      schema: liPedidoSchema,
    });
  } catch (err) {
    if (err instanceof LiNotFoundError) return { kind: 'ausente', alvo };
    throw err;
  }
  e.contexto.credencial.fixar(resposta.refCredencial);
  const corpo = corpoDeRestauracaoLi({ caminho, status: resposta.status, texto: resposta.texto });
  const restauracao =
    corpo !== null &&
    registrarRestauracaoLi(
      { recurso: alvo.recurso, caminho, status: resposta.status, corpo },
      e.registro,
    ).escrita;
  const base: BaseLidaLi = {
    kind: 'lida',
    alvo,
    pedido: resposta.dados,
    status: resposta.status,
    refCredencial: resposta.refCredencial,
    restauracao,
  };
  basesLidas.set(base, { motor, gasta: false });
  return base;
}

/* -------------------------------------------------------------------------- */
/*                Requirements 3, 5 and 6: the write, or its diff              */
/* -------------------------------------------------------------------------- */

/** Where a write goes. The objeto's envio id must be one of the deciding read's envios. */
export type DestinoEscritaLi =
  | { readonly tipo: 'situacao-pedido'; readonly alvo: AlvoLi }
  | { readonly tipo: 'objeto-envio'; readonly alvo: AlvoLi; readonly envioId: number };

/** What a write sets. The field must be its kind's ({@link CAMPO_DO_TIPO_ESCRITA_LI}). */
export type PayloadEscritaLi =
  | { readonly campo: 'codigo'; readonly valor: CodigoSituacaoEscritaLi }
  | { readonly campo: 'objeto'; readonly valor: string };

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
      readonly resposta: RespostaEscritaLi<EcoPedidoEnvioLi | EcoSituacaoPedidoLi>;
    };

/** The deciding read's current value of the field (`undefined` when absent). */
function valorAtual(destino: DestinoEscritaLi, pedido: PedidoLi): unknown {
  if (destino.tipo === 'situacao-pedido') return pedido.situacao.codigo;
  return pedido.envios.find((envio) => envio.id === destino.envioId)?.objeto;
}

/** The ONE place a package write operation is called: the kind's operation, its target's path id. */
function enviar(
  e: EstadoMotorLi,
  destino: DestinoEscritaLi,
  payload: PayloadEscritaLi,
  numero: string,
): Promise<RespostaEscritaLi<EcoPedidoEnvioLi | EcoSituacaoPedidoLi>> {
  if (destino.tipo === 'objeto-envio' && payload.campo === 'objeto') {
    return atualizarObjetoEnvioLi(e.contexto.escrita, destino.envioId, payload.valor);
  }
  if (destino.tipo === 'situacao-pedido' && payload.campo === 'codigo') {
    return alterarSituacaoPedidoLi(e.contexto.escrita, numero, payload.valor);
  }
  // `escreverLi` refused the mismatch before deciding anything.
  throw new TypeError('escrita: o campo não é o do tipo de escrita');
}

/**
 * The write — or, where the valve or the canary keeps this target from
 * writing, its diff. In order, refusing as a `TypeError` (a programming error,
 * nothing sent) whatever breaks the engine's contract:
 *
 *  1. a write already landed in this run (requirement 6);
 *  2. a target of another conta, a base of another target or another motor, a
 *     field of another kind, an envio id the deciding read does not list
 *     (requirement 3);
 *  3. the target decision (`decidirAlvo`): not `on` ⇒ one `diff` line,
 *     `nao-enviado`;
 *  4. `on`: no restore line ⇒ `sem-restauracao`; a base that already decided a
 *     write attempt ⇒ `TypeError`; past the task deadline ⇒
 *     `PrazoDeEscritaEsgotadoLiError`; then the write, at once (no wait).
 *
 * A 2xx resolves `enviado` (one `escrita` line). Every other outcome is the
 * package's error, rethrown as-is, for the flow to classify — after which the
 * next write needs a fresh deciding read.
 */
export async function escreverLi(
  motor: MotorEscritaLi,
  destino: DestinoEscritaLi,
  payload: PayloadEscritaLi,
  base: BaseLidaLi,
): Promise<ResultadoEscritaLi> {
  const e = estadoDe(motor);
  if (e.escritaAplicada) {
    throw new TypeError('escrita: esta execução já enviou uma escrita que chegou — nenhuma outra');
  }
  const numero = numeroDoAlvo(e, destino.alvo);
  const lidaPor = basesLidas.get(base);
  if (base.kind !== 'lida' || lidaPor === undefined || lidaPor.motor !== motor) {
    throw new TypeError('escrita: a base não é uma leitura decisória deste motor');
  }
  if (base.alvo.contaId !== destino.alvo.contaId || base.alvo.recurso !== destino.alvo.recurso) {
    throw new TypeError('escrita: a base é de outro alvo');
  }
  if (CAMPO_DO_TIPO_ESCRITA_LI[destino.tipo] !== payload.campo) {
    throw new TypeError('escrita: o campo não é o do tipo de escrita');
  }
  if (
    destino.tipo === 'objeto-envio' &&
    !base.pedido.envios.some((envio) => envio.id === destino.envioId)
  ) {
    throw new TypeError('escrita: o envio não está na leitura decisória do alvo');
  }

  const decisao = decidirAlvo(e.valvula, destino.alvo);
  if (decisao.modo === MODO_LI.off) {
    throw new TypeError('escrita: um motor nunca roda com a válvula desligada');
  }
  if (decisao.modo === MODO_LI.dryRun) {
    const politica = POLITICA_CAMPO_ESCRITA_LI[payload.campo];
    const antes = valorAtual(destino, base.pedido);
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
  const decorridoMs = e.agora() - e.inicioDaTarefaMs;
  if (decorridoMs > PRAZO_ULTIMA_ESCRITA_MS) throw new PrazoDeEscritaEsgotadoLiError(decorridoMs);

  // Spent BEFORE sending: whatever happens to this attempt, the next write is
  // decided by a fresh read.
  lidaPor.gasta = true;
  const resposta = await enviar(e, destino, payload, numero);

  // The write LANDED: from here on nothing may throw (requirement 6).
  e.escritaAplicada = true;
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

/** A read-back: the order as read, or a contained failure (`verificado: false`). */
export type LeituraDeVoltaLi =
  | { readonly verificado: true; readonly pedido: PedidoLi; readonly status: number }
  | ({ readonly verificado: false } & FalhaContidaLi);

/**
 * Requirement 5's read-back, a SEPARATE call (requirement 10's seam): two
 * pacer intervals after a write that landed, then the kind's read-back
 * strategy ({@link LEITURA_PREVIA_LI}) — the order detail again, with the run's
 * pinned credential. Contained per requirement 7. Its result never decides a
 * write in this run: no write follows a landed one, and it is not a base.
 */
export async function lerDeVoltaLi(
  motor: MotorEscritaLi,
  alvo: AlvoLi,
  tipo: TipoEscritaLi,
): Promise<LeituraDeVoltaLi> {
  const e = estadoDe(motor);
  if (!e.escritaAplicada) {
    throw new TypeError('escrita: nada chegou nesta execução — não há o que ler de volta');
  }
  const numero = numeroDoAlvo(e, alvo);
  const caminho = caminhoDaLeituraDeVolta(LEITURA_PREVIA_LI[tipo].leituraDeVolta, numero);
  await esperarIntervalos(e, 2);
  try {
    const r = await e.contexto.escrita.lerAntesDeEscreverLi({
      operacao: 'lerPedidoDeVolta',
      caminho,
      schema: liPedidoSchema,
    });
    return { verificado: true, pedido: r.dados, status: r.status };
  } catch (err) {
    const falha = falhaContida(err);
    if (falha === null) throw err;
    return { verificado: false, ...falha };
  }
}

/**
 * Requirement 5: whether the read-back holds what was written — `deepEqual`,
 * no fold (case, spacing, a number and its string, `null` and absent all
 * differ). A difference is one WARNING `deriva` line; what it MEANS (an aviso,
 * a re-check) is the flow's.
 */
export function conferirEscritaLi(
  motor: MotorEscritaLi,
  destino: DestinoEscritaLi,
  payload: PayloadEscritaLi,
  leitura: LeituraDeVoltaLi & { readonly verificado: true },
): 'igual' | 'deriva' {
  const e = estadoDe(motor);
  const lido = valorAtual(destino, leitura.pedido);
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
 * silently overwritten): every page of `GET /v1/situacao_historico/search/`,
 * through the read client (one pacer interval per page, in its getter), with
 * the run's pinned credential. Contained per requirement 7: the write landed and
 * stays done. The rows come back as received; ordering and judging them is the
 * flow's.
 */
export async function lerHistoricoSituacaoParaConferenciaLi(
  motor: MotorEscritaLi,
  numero: number,
): Promise<HistoricoParaConferenciaLi> {
  const e = estadoDe(motor);
  try {
    const historico = await listarHistoricoSituacaoLi(e.contexto.leitura, numero);
    return { lida: true, linhas: historico.linhas };
  } catch (err) {
    const falha = falhaContida(err);
    if (falha === null) throw err;
    return { lida: false, ...falha };
  }
}

/**
 * A confirming read that decides nothing (A9 of the step-7 plan: after a
 * situação write refused with 401/403, does the token still READ?): one pacer
 * interval, then `GET /v1/pedido/{numero}/` with the run's pinned credential.
 * Resolves when the read succeeds; every failure propagates for the flow to
 * classify (a 401/403 parks the conta; a getter refusal sends nothing). After a
 * refused tracking-code write, the confirming read is the next deciding read
 * instead ({@link lerBaseLi}).
 */
export async function confirmarCredencialLi(motor: MotorEscritaLi, alvo: AlvoLi): Promise<void> {
  const e = estadoDe(motor);
  const numero = numeroDoAlvo(e, alvo);
  await esperarIntervalos(e, 1);
  await e.contexto.escrita.lerAntesDeEscreverLi({
    operacao: 'confirmarCredencial',
    caminho: caminhoDoPedido(numero),
    schema: liPedidoSchema,
  });
}
