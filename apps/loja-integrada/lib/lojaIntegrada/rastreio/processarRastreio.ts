/**
 * ONE status write-back run (master plan step 7, PR 7-d): a freight event of a
 * pedido — posted, delivered, awaiting pickup — reflected onto its Loja
 * Integrada order through the write engine (`core/escrita.ts`), the ONLY module
 * that sends a write. The decisions are the pure plan's (`planoRastreio.ts`),
 * the identity proof `identidadeRastreio.ts`'s, the aviso `avisosRastreio.ts`'s.
 *
 * ## The order of one run
 *
 *  1. The valve FIRST (`iniciarEscritaLi`): `off` — recognised or not — is
 *     `desligado`, which DEFERS with zero reads (an event queued before a flip
 *     back to `off` waits; nothing is deleted).
 *  2. ONE raw pedido read by id. Absent ⇒ `pedido-inexistente`; not an imported
 *     Loja Integrada order of THIS conta and numero ⇒ `pedido-nao-li` (both drop).
 *  3. Freshness: an event the pedido no longer describes ⇒ `superado`, with ONE
 *     INFO line (the window's census reads it).
 *  4. The target decision (`decidirAlvo`): `on`, or a dry-run reason.
 *  5. The write context (the read switch FIRST, then the conta and credential);
 *     its refusals defer, a conta gone drops.
 *  6. The deciding read (`lerBaseLi`): two pacer intervals, the order detail, the
 *     credential pin, the restore line. A 404 or another numero ⇒ `pedido-ausente`.
 *  7. The plan: the envio's identity, the objeto, the situação — the ONE write
 *     this run may send.
 *  8. Not `on` (dry-run, outside the canary, no canary): a diff line for what
 *     `on` would write, then EVERY outcome but `ja-refletido` DEFERS, carrying the
 *     would-be refusal in its reason — no aviso, no write; the flip to `on`
 *     replays it. A deciding read refused for good (a body off its schema, a
 *     3xx or 4xx that is not a 404) defers too, with one WARNING line: only a
 *     run under `on` parks it.
 *  9. `on`: at most ONE write that lands. A posting with a sendable code writes
 *     the code ALONE — Loja Integrada moves the order to `pedido_enviado` and
 *     e-mails the buyer by itself — and the read-back CHECKS the move: seen ⇒
 *     done (and the history check); not seen ⇒ `parcial/efeito-pendente`, and a
 *     run at least an hour later decides from a fresh read. A refused code
 *     raises `escrita-recusada`, and a SECOND deciding read decides 11. A
 *     situação write is read back and then checked against the situação history.
 *     A write that landed but whose effect the run did not see (its read-back
 *     failed, a 202) is still checked against the history, and so is a code
 *     read back as another code (`deriva`): neither proves Loja Integrada never
 *     moved. Our code read back at a THIRD codigo (the order moved during the
 *     run) is checked too, and there the history decides the move: a row of it
 *     ⇒ seen (`efeito-observado`, done — or the overwrite it reveals); no row,
 *     no anchor or no history ⇒ `parcial/efeito-pendente`. Only our code read
 *     back at the deciding codigo (no move yet) skips it. Any aviso is raised
 *     ONCE, at the end, clocked by the event; when a run meets more than one
 *     motivo, the most serious wins (`pesoDoMotivo`).
 *
 * ## The 11 over our own unmoved code waits an hour
 *
 * Loja Integrada already holding our code at a codigo before shipment means a
 * code PUT landed and the move to 11 has not been seen yet. Only a run at least
 * an hour after that code may have landed writes the 11 (WARNING
 * `objeto-sem-efeito`); a run that may come sooner
 * ({@link EventoRastreioLi.escritaRecentePossivel}: a Cloud Tasks attempt, a row
 * the deferred lane just sent back) ends `parcial/efeito-pendente` with no write,
 * so a slow Loja Integrada never costs a second e-mail.
 *
 * ## A write refused with 401/403
 *
 * The refusal is confirmed with one paced read on the SAME, pinned credential
 * (for the tracking code, the second deciding read IS that confirmation). The
 * read refused too ⇒ the conta is parked (`tratarFalhaDeAutenticacao`) and the
 * event defers. A read that neither reads the order nor refuses the credential
 * (a 404, a 3xx or 4xx, a body off its schema, a 429, a 5xx, a timeout)
 * concludes nothing: it throws, on every pass, and the row's cap reports it
 * (`tentativas-esgotadas`). The read fine ⇒ on any try but a `failed` row's LAST hot pass,
 * one WARNING `recusada-retentativa` and {@link EscritaRecusadaLiError} (the
 * whole job retries from a fresh read, never the write alone, and no situação is
 * written meanwhile: a later code write that lands moves the order and e-mails
 * by itself); on that last pass, the aviso `escrita-recusada` — and a refused
 * code still lets 11 be written from the second read.
 *
 * ## The outcomes
 *
 * "Deterministic outcomes RETURN, transient failures THROW" — the shared core's
 * one contract. A transient failure is the ORIGINAL error; a refusal of our own
 * input (`ZodError`, a body off its schema, the package's own refusal of a route
 * or a body) parks with ONE ERROR line. The `LiError` base is never tested
 * (root `CLAUDE.md` rule 6): `LiConfigError` of our own misconfiguration stays
 * loud.
 *
 * ## Rule 7 — class
 *
 * Serialised by the writes queue (one dispatch at a time, one instance —
 * narrowed, not absolute: an abandoned dispatch or a rare duplicate delivery can
 * overlap, and no write starts past the task deadline); ONE write per run, each
 * decided by its own fresh read; every guard re-derived from the attempt's own
 * read, never from anything an earlier attempt captured; a situação overwritten
 * in the gap between the deciding read and the write is REPORTED by the history
 * check (`situacao-sobrescrita`); a tracking code typed in the painel inside that
 * gap is overwritten undetected (Loja Integrada keeps no history of it — an
 * accepted residual). So is a situação move in the gap before our code lands on
 * an order the deciding read saw ALREADY at 11 (a delivery or a cancellation
 * request the code's own move to 11 then overwrites): the history check anchors
 * on the codigo the deciding read saw, and with that codigo equal to the one
 * the move writes it has no anchor to judge from, so it is not run there — an
 * accepted residual. There is no Loja Integrada precondition to use: the writes
 * take no version. Firestore: only the aviso (tier 2, the event clock) and the
 * park (tier 1); pedidos are never written.
 *
 * ⚠️ This module must never name the Admin SDK's multi-document read-and-write
 * call — not even in a comment (`estrutura.test.ts`) — and never reads the
 * process environment: `deps.ambiente` is the environment, passed in.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { ZodError } from 'zod';
import { pedidoCollection } from '@delfrance/data/admin/collections';
import {
  type CodigoSituacaoEscritaLi,
  LiAuthError,
  LiConfigError,
  LiHttpError,
  LiSchemaError,
  LiThrottleError,
  type MotivoConfigLi,
} from '@delfrance/integrations-loja-integrada';
import {
  CODIGO_SITUACAO_LI,
  MOTIVO_RASTREIO_DIVERGENTE_LI,
  type EstadoRastreioLi,
  type MotivoRastreioDivergenteLi,
} from '@delfrance/schemas';

import { lerContaEmCache } from '../core/contaCache';
import {
  type ContextoEscritaLojaIntegrada,
  loadLojaIntegradaContextoEscrita,
} from '../core/contextoEscrita';
import {
  EscritaRecusadaLiError,
  LiChamadasDesligadasError,
  LiContaInativaError,
  LiContaNaoEncontradaError,
  LiContaParadaError,
  LiCredencialAusenteError,
  LiCredencialInvalidaError,
} from '../core/erros';
import {
  type BaseEscritaLi,
  type BaseLidaLi,
  CAMPO_DO_TIPO_ESCRITA_LI,
  type DestinoEscritaLi,
  type FalhaContidaLi,
  LEITURA_PREVIA_LI,
  type MotorEscritaLi,
  type PayloadEscritaLi,
  type ResultadoEscritaLi,
  type TipoEscritaLi,
  conferirEscritaLi,
  confirmarCredencialLi,
  criarMotorEscritaLi,
  escreverLi,
  iniciarEscritaLi,
  lerBaseLi,
  lerDeVoltaLi,
  lerHistoricoSituacaoParaConferenciaLi,
} from '../core/escrita';
import { type TratarFalhaDeps, tratarFalhaDeAutenticacao } from '../core/estacionamento';
import {
  type OpcoesObservadorLi,
  type OpcoesRegistroLi,
  type ResultadoEscritaLogLi,
  registrarEscritaLi,
  registrarEventoLi,
} from '../core/log';
import {
  type AlvoLi,
  type AmbienteLi,
  type DecisaoAlvoLi,
  FLUXO_LI,
  MODO_LI,
  chaveDoAlvo,
  decidirAlvo,
} from '../core/valvulas';
import {
  type AvisoRastreioLi,
  type PedidoDoAvisoRastreioLi,
  avisarRastreioDivergenteLi,
  resolverRastreioDivergenteLi,
} from './avisosRastreio';
import { envioDoPedidoLi, numeroConfereLi, pedidoRastreioLi } from './identidadeRastreio';
import {
  type ConferenciaHistoricoLi,
  type MotivoSuperadoLi,
  type SequenciaRastreioLi,
  conferirHistoricoLi,
  decidirSequenciaRastreioLi,
  decidirSituacaoRastreioLi,
  eventoSuperadoLi,
} from './planoRastreio';

const C = CODIGO_SITUACAO_LI;
const M = MOTIVO_RASTREIO_DIVERGENTE_LI;

/* -------------------------------------------------------------------------- */
/*                           The event, the deps, the outcomes                */
/* -------------------------------------------------------------------------- */

/**
 * Whether this run is a row's LAST pass in its lane (derived from the failure
 * row, never persisted): `quente` = the hot lane's parking pass, `adiada` = the
 * deferred lane's. `null` for a task attempt and every other pass.
 */
export type PassagemFinalLi = 'quente' | 'adiada' | null;

/** What one run is about: the task payload's ids, plus the pass it runs on. */
export interface EventoRastreioLi {
  readonly contaId: string;
  /** The order `numero`, canonical decimal. */
  readonly numero: string;
  readonly pedidoId: string;
  /** The event's own id (the failure document's id). */
  readonly evento: string;
  readonly estado: EstadoRastreioLi;
  /** The event's own stamp, in MILLISECONDS: the aviso's clock. */
  readonly eventoEmMs: number;
  readonly passagemFinal: PassagemFinalLi;
  /**
   * Whether this run may come LESS than an hour after an earlier run of the
   * same event landed a write (derived, never persisted): every Cloud Tasks
   * attempt, and a `failed` row the deferred lane just sent back. Such a run
   * never writes 11 over our code Loja Integrada has not acted on yet — the
   * move may still be on its way (module header).
   */
  readonly escritaRecentePossivel: boolean;
}

/** The run's ONE logger: the park's lines, the deterministic refusals, the sweep's warnings. */
export interface LoggerEscritaLi {
  warn(msg: string, meta?: Record<string, unknown>): void;
  error?(msg: string, meta?: Record<string, unknown>): void;
}

/** What the logger adds to each line of a run (the conta, the flow and the event id are the run's). */
export type RegistroEscritaLi = Omit<OpcoesObservadorLi, 'conta' | 'fluxo' | 'idNotificacao'>;

export interface DepsEscritaLi extends TratarFalhaDeps {
  /** The process environment, from the entry point: the valve, the canary, the read switch. */
  readonly ambiente: AmbienteLi;
  /** The sleep the writes pacer is bound to (`setTimeout` in production). */
  readonly esperar: (ms: number) => Promise<void>;
  /** When the task's dispatch began, in ms: no write starts past the engine's deadline after it. */
  readonly inicioDaTarefaMs: number;
  /** The Cloud Tasks attempt and task id (`null` in a sweep), a test sink. */
  readonly registro: RegistroEscritaLi;
  readonly logger?: LoggerEscritaLi;
  /** Test seam, forwarded to the context's clients. */
  readonly fetch?: typeof globalThis.fetch;
}

/** Why an event waits in the deferred lane: a precondition a human (or the window) clears. */
export const MOTIVO_ADIAMENTO_ESCRITA_LI = {
  chamadasDesligadas: 'chamadas-desligadas',
  contaInativa: 'conta-inativa',
  credencialAusente: 'credencial-ausente',
  credencialInvalida: 'credencial-invalida',
  contaParada: 'conta-parada',
  dryRun: 'dry-run',
  foraDoCanario: 'fora-do-canario',
  semCanario: 'sem-canario',
} as const;
export type MotivoAdiamentoEscritaLi =
  (typeof MOTIVO_ADIAMENTO_ESCRITA_LI)[keyof typeof MOTIVO_ADIAMENTO_ESCRITA_LI];

/** The class a deterministic refusal names — never a body. */
export type ClasseRecusaEscritaLi =
  | 'alvo-invalido'
  | 'LiHttpError'
  | 'LiSchemaError'
  | 'ZodError'
  | 'LiConfigError';

/** What a parcial write left open: the move not seen yet, the read-back failed, a 202. */
export type EfeitoParcialLi = 'efeito-pendente' | 'nao-verificado' | 'aceito';

/**
 * Every outcome of one run. A kind added later stops the pipeline's
 * `toDispositionEscritaLi` from compiling until it is mapped.
 */
export type ResultadoRastreioLi =
  /** A write landed and was read back as written. */
  | { readonly kind: 'escrito' }
  /** Loja Integrada already showed everything: nothing to write. */
  | { readonly kind: 'ja-refletido' }
  /** A write landed; its read-back could not be made. */
  | { readonly kind: 'escrito-sem-conferencia' }
  | { readonly kind: 'superado'; readonly motivo: MotivoSuperadoLi }
  | { readonly kind: 'pedido-inexistente' }
  | { readonly kind: 'pedido-nao-li' }
  | { readonly kind: 'conta-inexistente' }
  /** The valve is `off`: nothing was read. */
  | { readonly kind: 'desligado' }
  | {
      readonly kind: 'adiado';
      readonly motivo: MotivoAdiamentoEscritaLi;
      /** What `on` would refuse with, when it would. */
      readonly recusa: MotivoRastreioDivergenteLi | null;
    }
  /** Nothing written; the aviso was raised. */
  | {
      readonly kind: 'recusado';
      readonly motivo: MotivoRastreioDivergenteLi;
      readonly status: number | null;
    }
  /** A write landed, and an aviso was raised. */
  | { readonly kind: 'escrito-com-aviso'; readonly motivo: MotivoRastreioDivergenteLi }
  | { readonly kind: 'parcial'; readonly efeito: EfeitoParcialLi }
  | {
      readonly kind: 'recusa-deterministica';
      readonly classe: ClasseRecusaEscritaLi;
      readonly detalhe: string | null;
    };

const adiado = (
  motivo: MotivoAdiamentoEscritaLi,
  recusa: MotivoRastreioDivergenteLi | null = null,
): ResultadoRastreioLi => ({ kind: 'adiado', motivo, recusa });

const deterministica = (
  classe: ClasseRecusaEscritaLi,
  detalhe: string | null,
): ResultadoRastreioLi => ({ kind: 'recusa-deterministica', classe, detalhe });

/* -------------------------------------------------------------------------- */
/*                                The classifier                              */
/* -------------------------------------------------------------------------- */

/**
 * The package's refusals of an operation's own INPUT: refused again with no
 * request, so a retry is pointless — they park (with an ERROR line), like a
 * `ZodError`. Every other `LiConfigError` motivo is our own misconfiguration
 * and stays loud.
 */
const MOTIVOS_RECUSA_DA_OPERACAO_LI: ReadonlySet<MotivoConfigLi> = new Set<MotivoConfigLi>([
  'corpo',
  'codigo-nao-permitido',
  'caminho',
  'rota-nao-permitida',
]);

/**
 * A deterministic refusal, or `null` to rethrow: a non-transient HTTP refusal
 * (not a 401/403, not a 429), a body off its schema, a Zod failure, the
 * package's refusal of an operation's input. Narrowed class by class, the
 * `LiHttpError` subclasses first; the `LiError` base never tested. Pure.
 */
export function classificarRecusaEscritaLi(err: unknown): ResultadoRastreioLi | null {
  if (err instanceof LiAuthError || err instanceof LiThrottleError) return null;
  if (err instanceof LiHttpError) {
    return err.transitorio ? null : deterministica('LiHttpError', String(err.status));
  }
  if (err instanceof LiSchemaError) return deterministica('LiSchemaError', String(err.status));
  if (err instanceof ZodError) return deterministica('ZodError', null);
  if (err instanceof LiConfigError && MOTIVOS_RECUSA_DA_OPERACAO_LI.has(err.motivo)) {
    return deterministica('LiConfigError', err.motivo);
  }
  return null;
}

/** The store name for a park or an aviso: the conta's `nome`, else its id. */
function lojaNomeDe(contexto: ContextoEscritaLojaIntegrada): string {
  return contexto.conta.nome === '' ? contexto.integracaoId : contexto.conta.nome;
}

/**
 * A 401/403 the conta's credential earned: park the conta, then answer by what
 * the park found — `null` = rethrow (the 401 was for an older token, or there is
 * no usable ref).
 */
async function classificarRecusaDeCredencial(
  db: Firestore,
  err: LiAuthError,
  contexto: ContextoEscritaLojaIntegrada | null,
  deps: DepsEscritaLi,
): Promise<ResultadoRastreioLi | null> {
  if (contexto === null) return null;
  let tratamento: Awaited<ReturnType<typeof tratarFalhaDeAutenticacao>>;
  try {
    tratamento = await tratarFalhaDeAutenticacao(
      db,
      { integracaoId: contexto.integracaoId, lojaNome: lojaNomeDe(contexto) },
      err,
      deps,
    );
  } catch (falha) {
    if (falha instanceof LiCredencialInvalidaError) {
      return adiado(MOTIVO_ADIAMENTO_ESCRITA_LI.credencialInvalida);
    }
    throw falha;
  }
  const estacionamento = tratamento.estacionamento;
  if (estacionamento === null) return null;
  switch (estacionamento.tipo) {
    case 'estacionado':
    case 'ja-estacionado':
      return adiado(MOTIVO_ADIAMENTO_ESCRITA_LI.contaParada);
    case 'sem-credencial':
      return adiado(MOTIVO_ADIAMENTO_ESCRITA_LI.credencialAusente);
    case 'credencial-substituida':
      return null;
  }
}

/**
 * Error → outcome for a READ of the run (the context, a deciding read, a
 * confirming read): the context's and the getter's refusals defer, a conta gone
 * drops, a 401/403 parks the conta, the deterministic refusals park. `null` =
 * rethrow the ORIGINAL error (429, 5xx, network, the pin, gRPC, unknown).
 */
async function classificarFalhaDeLeituraLi(
  db: Firestore,
  err: unknown,
  contexto: ContextoEscritaLojaIntegrada | null,
  deps: DepsEscritaLi,
): Promise<ResultadoRastreioLi | null> {
  if (err instanceof LiChamadasDesligadasError) {
    return adiado(MOTIVO_ADIAMENTO_ESCRITA_LI.chamadasDesligadas);
  }
  if (err instanceof LiContaNaoEncontradaError) return { kind: 'conta-inexistente' };
  if (err instanceof LiContaInativaError) return adiado(MOTIVO_ADIAMENTO_ESCRITA_LI.contaInativa);
  if (err instanceof LiCredencialAusenteError) {
    return adiado(MOTIVO_ADIAMENTO_ESCRITA_LI.credencialAusente);
  }
  if (err instanceof LiCredencialInvalidaError) {
    return adiado(MOTIVO_ADIAMENTO_ESCRITA_LI.credencialInvalida);
  }
  if (err instanceof LiContaParadaError) return adiado(MOTIVO_ADIAMENTO_ESCRITA_LI.contaParada);
  if (err instanceof LiAuthError) return classificarRecusaDeCredencial(db, err, contexto, deps);
  return classificarRecusaEscritaLi(err);
}

/* -------------------------------------------------------------------------- */
/*                                 One run                                    */
/* -------------------------------------------------------------------------- */

/** One run's state, past the target decision. */
interface ExecucaoLi {
  readonly db: Firestore;
  readonly evento: EventoRastreioLi;
  readonly deps: DepsEscritaLi;
  readonly alvo: AlvoLi;
  readonly registro: OpcoesRegistroLi;
  readonly contexto: ContextoEscritaLojaIntegrada;
  readonly motor: MotorEscritaLi;
  /** The pedido's stored tracking code and envio id. */
  readonly codRastreio: unknown;
  readonly externalId: unknown;
  /** The ONE aviso this run raises at its end (`null`: none). */
  aviso: AvisoRastreioLi | null;
  /** A 401/403 refusal was already confirmed in this run (the last pass's fallback reuses it). */
  confirmado: boolean;
}

/** The dry-run reason of a target decision that is not `on`. */
function motivoDoAdiamento(
  decisao: DecisaoAlvoLi & { readonly modo: 'dry-run' },
): MotivoAdiamentoEscritaLi {
  switch (decisao.motivo) {
    case 'valvula':
    case 'alvo-invalido':
      return MOTIVO_ADIAMENTO_ESCRITA_LI.dryRun;
    case 'sem-canario':
      return MOTIVO_ADIAMENTO_ESCRITA_LI.semCanario;
    case 'fora-do-canario':
      return MOTIVO_ADIAMENTO_ESCRITA_LI.foraDoCanario;
  }
}

/** The pedido as the aviso names it. */
function pedidoDoAviso(evento: EventoRastreioLi, lojaNome: string): PedidoDoAvisoRastreioLi {
  return {
    integracaoId: evento.contaId,
    lojaNome,
    pedidoId: evento.pedidoId,
    numero: evento.numero,
    eventoEmMs: evento.eventoEmMs,
  };
}

/**
 * One write-back run, start to finish (module header). Deterministic outcomes
 * RETURN; everything else rethrows the ORIGINAL error.
 */
export async function processarRastreioLi(
  db: Firestore,
  evento: EventoRastreioLi,
  deps: DepsEscritaLi,
): Promise<ResultadoRastreioLi> {
  const registro: OpcoesRegistroLi = {
    ...deps.registro,
    conta: evento.contaId,
    fluxo: FLUXO_LI.rastreio,
    idNotificacao: evento.evento,
  };

  // 1. The valve FIRST.
  const inicio = iniciarEscritaLi(FLUXO_LI.rastreio, deps.ambiente, {
    ...deps.registro,
    conta: evento.contaId,
    idNotificacao: evento.evento,
  });
  if (inicio.kind === 'desligado') return { kind: 'desligado' };

  // 2. ONE raw pedido read, and the identity proof.
  const snap = await pedidoCollection.docRef(db, {}, evento.pedidoId).get();
  if (!snap.exists) return { kind: 'pedido-inexistente' };
  const pedido = pedidoRastreioLi(evento.pedidoId, snap.data());
  if (pedido === null || pedido.contaId !== evento.contaId || pedido.numero !== evento.numero) {
    return { kind: 'pedido-nao-li' };
  }

  // 3. Freshness.
  const superado = eventoSuperadoLi(evento.estado, pedido.estadoFrete);
  if (superado !== null) {
    registrarEventoLi(
      'superado',
      'INFO',
      {
        recurso: Number(evento.numero),
        pedidoId: evento.pedidoId,
        estadoEvento: evento.estado,
        estadoAtual: typeof pedido.estadoFrete === 'string' ? pedido.estadoFrete : null,
        motivo: superado,
      },
      registro,
    );
    return { kind: 'superado', motivo: superado };
  }

  // 4. The target decision.
  const alvo: AlvoLi = { contaId: evento.contaId, recurso: Number(evento.numero) };
  const resultado =
    chaveDoAlvo(alvo) === null
      ? deterministica('alvo-invalido', null)
      : await depoisDaDecisao(db, evento, deps, inicio, alvo, registro, pedido);

  if (resultado.kind === 'recusa-deterministica') {
    registrarRecusaDeterministica(evento, deps, resultado, 'estacionada');
  }
  return resultado;
}

/**
 * The line of a deterministic refusal — ids and the class only, never a body or
 * a message: ERROR when it parks the event, WARNING when a decision that is not
 * `on` defers it (it is replayed, and parks only under `on`).
 */
function registrarRecusaDeterministica(
  evento: EventoRastreioLi,
  deps: DepsEscritaLi,
  r: ResultadoRastreioLi & { readonly kind: 'recusa-deterministica' },
  desfecho: 'estacionada' | 'adiada',
): void {
  const linha = `[loja-integrada] escrita ${desfecho}: recusa determinística`;
  const ids = {
    integracaoId: evento.contaId,
    numero: evento.numero,
    evento: evento.evento,
    classe: r.classe,
    detalhe: r.detalhe,
  };
  if (desfecho === 'adiada') {
    if (deps.logger === undefined) console.warn(linha, ids);
    else deps.logger.warn(linha, ids);
    return;
  }
  if (deps.logger?.error === undefined) console.error(linha, ids);
  else deps.logger.error(linha, ids);
}

/** Steps 5–9, then the last pass's own aviso. */
async function depoisDaDecisao(
  db: Firestore,
  evento: EventoRastreioLi,
  deps: DepsEscritaLi,
  inicio: ReturnType<typeof iniciarEscritaLi> & { readonly kind: 'ativo' },
  alvo: AlvoLi,
  registro: OpcoesRegistroLi,
  pedido: { readonly codRastreio: unknown; readonly externalId: unknown },
): Promise<ResultadoRastreioLi> {
  const decisao = decidirAlvo(inicio.valvula, alvo);
  const ligado = decisao.modo === MODO_LI.on;

  // 5–6. The context, the motor and the deciding read — the only failures
  // classified here. A write's own failures are sorted where it is sent, and
  // anything after a write propagates as it was thrown.
  let contexto: ContextoEscritaLojaIntegrada | null = null;
  let preparo: { readonly e: ExecucaoLi; readonly base: BaseEscritaLi } | null = null;
  let r: ResultadoRastreioLi | null = null;
  try {
    contexto = await loadLojaIntegradaContextoEscrita(db, evento.contaId, {
      ambiente: deps.ambiente,
      esperar: deps.esperar,
      registro: { ...deps.registro, fluxo: FLUXO_LI.rastreio, idNotificacao: evento.evento },
      fetch: deps.fetch,
    });
    const motor = criarMotorEscritaLi({
      inicio,
      contexto,
      agora: deps.agoraMs,
      inicioDaTarefaMs: deps.inicioDaTarefaMs,
      registro: { ...deps.registro, idNotificacao: evento.evento },
    });
    const base = await lerBaseLi(motor, alvo, LEITURA_PREVIA_LI['situacao-pedido'].leitura);
    preparo = {
      base,
      e: {
        db,
        evento,
        deps,
        alvo,
        registro,
        contexto,
        motor,
        codRastreio: pedido.codRastreio,
        externalId: pedido.externalId,
        aviso: null,
        confirmado: false,
      },
    };
  } catch (err) {
    r = await classificarFalhaDeLeituraLi(db, err, contexto, deps);
    if (r === null) throw err;
    // Not `on`: a refusal for good defers like every other outcome, so the flip
    // to `on` replays it — only a run under `on` parks it.
    if (r.kind === 'recusa-deterministica' && decisao.modo === MODO_LI.dryRun) {
      registrarRecusaDeterministica(evento, deps, r, 'adiada');
      r = adiado(motivoDoAdiamento(decisao));
    }
  }
  if (preparo !== null) {
    switch (decisao.modo) {
      case MODO_LI.on:
        r = await executarLigado(preparo.e, preparo.base);
        break;
      case MODO_LI.dryRun:
        r = await executarSemEscrever(preparo.e, preparo.base, motivoDoAdiamento(decisao));
        break;
      case MODO_LI.off:
        // A motor never runs with the valve off: `iniciarEscritaLi` answered `desligado`.
        throw new TypeError('rastreio: decisão `off` sob uma válvula ligada');
    }
  }
  if (r === null) throw new TypeError('rastreio: a execução terminou sem desfecho');

  // The last pass of a returned outcome that parks silently otherwise.
  const ultimaPassagem =
    (r.kind === 'parcial' && evento.passagemFinal === 'quente') ||
    (r.kind === 'adiado' && evento.passagemFinal === 'adiada');
  if (ligado && ultimaPassagem) {
    const lojaNome =
      contexto === null
        ? ((await lerContaEmCache(db, evento.contaId))?.nome ?? '') || evento.contaId
        : lojaNomeDe(contexto);
    await avisarRastreioDivergenteLi(
      db,
      pedidoDoAviso(evento, lojaNome),
      { motivo: M.tentativasEsgotadas },
      { increment: deps.increment, nowMs: deps.agoraMs(), logger: deps.logger },
    );
  }
  return r;
}

/* -------------------------------------------------------------------------- */
/*                   Step 8: a decision that is not `on` defers               */
/* -------------------------------------------------------------------------- */

/** The guard read is about THIS order, or `null` (`pedido-ausente`). */
function baseDoPedido(e: ExecucaoLi, base: BaseEscritaLi): BaseLidaLi | null {
  if (base.kind !== 'lida') return null;
  return numeroConfereLi(base.pedido.numero, e.evento.numero) ? base : null;
}

/** The plan over a deciding read. */
function planejar(e: ExecucaoLi, base: BaseLidaLi): SequenciaRastreioLi {
  return decidirSequenciaRastreioLi({
    estado: e.evento.estado,
    codigo: base.pedido.situacao.codigo,
    envio: envioDoPedidoLi(base.pedido.envios, e.externalId),
    nosso: e.codRastreio,
  });
}

async function executarSemEscrever(
  e: ExecucaoLi,
  base0: BaseEscritaLi,
  motivo: MotivoAdiamentoEscritaLi,
): Promise<ResultadoRastreioLi> {
  const base = baseDoPedido(e, base0);
  if (base === null) return adiado(motivo, M.pedidoAusente);
  const seq = planejar(e, base);
  switch (seq.kind) {
    case 'recusar':
      return adiado(motivo, seq.motivo);
    case 'nada':
      return seq.aviso === null ? { kind: 'ja-refletido' } : adiado(motivo, seq.aviso);
    case 'objeto':
      // The diff line of what `on` would write.
      await escreverLi(
        e.motor,
        { tipo: 'objeto-envio', alvo: e.alvo, envioId: seq.envioId },
        { campo: 'objeto', valor: seq.valor },
        base,
      );
      return adiado(motivo, base.restauracao ? null : M.restauracaoIndisponivel);
    case 'situacao':
      await escreverLi(
        e.motor,
        { tipo: 'situacao-pedido', alvo: e.alvo },
        { campo: 'codigo', valor: seq.codigo },
        base,
      );
      return adiado(motivo, base.restauracao ? seq.aviso : M.restauracaoIndisponivel);
  }
}

/* -------------------------------------------------------------------------- */
/*                         Step 9: `on`, one write per run                    */
/* -------------------------------------------------------------------------- */

/**
 * How serious a motivo is, for the run's ONE aviso. Highest first: a situação
 * overwritten in the gap; then what the order itself says — a situação a
 * deciding read refuses, a read-back that differs, an order gone, unreadable
 * or not matching; then a write Loja Integrada refused; last, what only the
 * tracking code met (it is never a statement about the situação). Exhaustive:
 * a motivo added later does not compile until it is ranked.
 */
function pesoDoMotivo(motivo: MotivoRastreioDivergenteLi): number {
  switch (motivo) {
    case M.situacaoSobrescrita:
      return 3;
    case M.situacaoBloqueada:
    case M.situacaoNaoPaga:
    case M.situacaoDesconhecida:
    case M.transicaoLateral:
    case M.deriva:
    case M.pedidoAusente:
    case M.pedidoDivergente:
    case M.restauracaoIndisponivel:
    case M.tentativasEsgotadas:
      return 2;
    case M.escritaRecusada:
      return 1;
    case M.objetoDivergente:
    case M.objetoInvalido:
    case M.envioDivergente:
      return 0;
  }
}

/** Set the run's ONE aviso: a later motivo replaces an earlier one only when it ranks higher. */
function definirAviso(e: ExecucaoLi, aviso: AvisoRastreioLi): void {
  if (e.aviso === null || pesoDoMotivo(aviso.motivo) > pesoDoMotivo(e.aviso.motivo)) {
    e.aviso = aviso;
  }
}

/** The aviso of a refusal by the situação, with the params its wording reads. */
function avisoDaSituacao(
  e: ExecucaoLi,
  motivo: MotivoRastreioDivergenteLi,
  codigo: string,
): AvisoRastreioLi {
  switch (motivo) {
    case M.transicaoLateral:
    case M.situacaoNaoPaga:
      return { motivo, situacao: codigo, estado: e.evento.estado };
    case M.situacaoBloqueada:
    case M.situacaoDesconhecida:
      return { motivo, situacao: codigo };
    // The identity refusal reads no situação; the others are never a refusal of the plan.
    case M.pedidoDivergente:
    case M.situacaoSobrescrita:
    case M.objetoDivergente:
    case M.objetoInvalido:
    case M.envioDivergente:
    case M.pedidoAusente:
    case M.restauracaoIndisponivel:
    case M.escritaRecusada:
    case M.deriva:
    case M.tentativasEsgotadas:
      return { motivo };
  }
}

/** The run's end under `on`: the ONE aviso raised, or a clean run's clocked resolve. */
async function finalizar(e: ExecucaoLi, r: ResultadoRastreioLi): Promise<ResultadoRastreioLi> {
  const pedido = pedidoDoAviso(e.evento, lojaNomeDe(e.contexto));
  const deps = { increment: e.deps.increment, nowMs: e.deps.agoraMs(), logger: e.deps.logger };
  if (e.aviso !== null) {
    await avisarRastreioDivergenteLi(e.db, pedido, e.aviso, deps);
  } else if (r.kind === 'escrito' || r.kind === 'ja-refletido') {
    await resolverRastreioDivergenteLi(e.db, pedido, deps);
  }
  return r;
}

/** Nothing was written: the aviso's refusal, or already reflected. */
function semEscrita(e: ExecucaoLi): ResultadoRastreioLi {
  return e.aviso === null
    ? { kind: 'ja-refletido' }
    : { kind: 'recusado', motivo: e.aviso.motivo, status: e.aviso.status ?? null };
}

/** A write landed: with the aviso, read back, or not. */
function comEscrita(e: ExecucaoLi, conferido: boolean): ResultadoRastreioLi {
  if (e.aviso !== null) return { kind: 'escrito-com-aviso', motivo: e.aviso.motivo };
  return conferido ? { kind: 'escrito' } : { kind: 'escrito-sem-conferencia' };
}

/** What sending one write did. */
type TentativaLi =
  | {
      readonly kind: 'enviado';
      readonly resultado: ResultadoEscritaLi & { readonly kind: 'enviado' };
    }
  /** No restore line: nothing sent. */
  | { readonly kind: 'sem-restauracao' }
  /** Refused with 3xx/4xx (not 401/403/429): nothing landed. */
  | { readonly kind: 'recusada'; readonly status: number }
  /** Refused with 401/403. */
  | { readonly kind: 'auth'; readonly erro: LiAuthError }
  /** A getter's refusal or a deterministic refusal: the run's outcome. */
  | { readonly kind: 'resultado'; readonly resultado: ResultadoRastreioLi };

/** Send one write through the engine and sort its failure (module header). */
async function tentarEscrita(
  e: ExecucaoLi,
  destino: DestinoEscritaLi,
  valor: PayloadEscritaLi,
  base: BaseLidaLi,
): Promise<TentativaLi> {
  let resultado: ResultadoEscritaLi;
  try {
    resultado = await escreverLi(e.motor, destino, valor, base);
  } catch (err) {
    if (err instanceof LiAuthError) return { kind: 'auth', erro: err };
    // A 429 and a 5xx may have landed: the retry's own read decides.
    if (err instanceof LiThrottleError) throw err;
    if (err instanceof LiHttpError) {
      if (err.transitorio) throw err;
      return { kind: 'recusada', status: err.status };
    }
    if (
      err instanceof LiContaParadaError ||
      err instanceof LiCredencialAusenteError ||
      err instanceof LiCredencialInvalidaError
    ) {
      const r = await classificarFalhaDeLeituraLi(e.db, err, e.contexto, e.deps);
      if (r === null) throw err;
      return { kind: 'resultado', resultado: r };
    }
    const r = classificarRecusaEscritaLi(err);
    if (r === null) throw err;
    return { kind: 'resultado', resultado: r };
  }
  switch (resultado.kind) {
    case 'enviado':
      return { kind: 'enviado', resultado };
    case 'sem-restauracao':
      return { kind: 'sem-restauracao' };
    case 'nao-enviado':
      // Under `on` the engine decides the same target the run did.
      throw new TypeError('rastreio: a escrita não foi enviada sob `on`');
  }
}

/** One `escrita` line of the sequence's own outcomes. */
function registrarSequencia(
  e: ExecucaoLi,
  tipo: TipoEscritaLi,
  resultado: ResultadoEscritaLogLi,
  resposta: {
    readonly status: number;
    readonly aplicada: string;
    readonly leituraEco: string;
  } | null,
  status: number | null = null,
): void {
  registrarEscritaLi(
    {
      recurso: e.alvo.recurso,
      tipo,
      campo: CAMPO_DO_TIPO_ESCRITA_LI[tipo],
      resultado,
      status: resposta?.status ?? status,
      aplicada: resposta?.aplicada ?? null,
      leituraEco: resposta?.leituraEco ?? null,
    },
    e.registro,
  );
}

/** A read after a write that failed with a contained 401/403: park the conta (a permitted throw). */
async function conterFalhaDeLeitura(e: ExecucaoLi, falha: FalhaContidaLi): Promise<void> {
  if (!(falha.erro instanceof LiAuthError)) return;
  await tratarFalhaDeAutenticacao(
    e.db,
    { integracaoId: e.contexto.integracaoId, lojaNome: lojaNomeDe(e.contexto) },
    falha.erro,
    e.deps,
  );
}

/**
 * The situação-history check after a situação change we caused: one line,
 * and the aviso `situacao-sobrescrita` when the table would have refused the
 * overwritten codigo. Never throws for the read itself (contained). Answers
 * the verdict, or `null` when the history could not be read.
 */
async function conferirHistorico(
  e: ExecucaoLi,
  codigoAntes: string,
  codigoEscrito: CodigoSituacaoEscritaLi,
): Promise<ConferenciaHistoricoLi | null> {
  const historico = await lerHistoricoSituacaoParaConferenciaLi(e.motor, e.alvo);
  const campos = { recurso: e.alvo.recurso, codigoAntes, codigoEscrito };
  if (!historico.lida) {
    await conterFalhaDeLeitura(e, historico);
    registrarEventoLi(
      'conferencia-historico',
      'WARNING',
      { ...campos, resultado: 'ilegivel', classe: historico.classe },
      e.registro,
    );
    return null;
  }
  const v = conferirHistoricoLi(historico.linhas, {
    numero: e.alvo.recurso,
    codigoAntes,
    codigoEscrito,
  });
  const resultado = v.kind === 'duplicado' ? 'escrita-duplicada' : v.kind;
  registrarEventoLi(
    'conferencia-historico',
    v.kind === 'conferido' || v.kind === 'intermediaria-compativel' ? 'INFO' : 'WARNING',
    {
      ...campos,
      resultado,
      codigoSobrescrito: v.kind === 'sobrescrito' ? v.codigo : null,
      codigosIntermediarios: v.kind === 'intermediaria-compativel' ? v.codigos.join(',') : null,
    },
    e.registro,
  );
  if (v.kind === 'sobrescrito') {
    definirAviso(e, { motivo: M.situacaoSobrescrita, situacao: v.codigo, critico: v.critico });
  }
  return v;
}

/**
 * Whether a verdict holds the row of the move we caused, after the anchor —
 * that move happened, whatever came after it. Exhaustive: a verdict added
 * later does not compile until it is decided.
 */
function historicoMostraNossaMudanca(v: ConferenciaHistoricoLi): boolean {
  switch (v.kind) {
    case 'conferido':
    case 'intermediaria-compativel':
    case 'sobrescrito':
    case 'duplicado':
      return true;
    // No row of ours yet; no anchor, or our row with no previous situação.
    case 'sem-linha':
    case 'inconclusivo':
      return false;
  }
}

/** A deciding read made AFTER a refused write (its own restore line), or the run's outcome. */
async function segundaBase(
  e: ExecucaoLi,
): Promise<{ readonly base: BaseEscritaLi } | { readonly resultado: ResultadoRastreioLi }> {
  try {
    return { base: await lerBaseLi(e.motor, e.alvo, LEITURA_PREVIA_LI['situacao-pedido'].leitura) };
  } catch (err) {
    const r = await classificarFalhaDeLeituraLi(e.db, err, e.contexto, e.deps);
    if (r === null) throw err;
    return { resultado: r };
  }
}

async function executarLigado(e: ExecucaoLi, base0: BaseEscritaLi): Promise<ResultadoRastreioLi> {
  const base = baseDoPedido(e, base0);
  if (base === null) {
    definirAviso(e, { motivo: M.pedidoAusente });
    return finalizar(e, semEscrita(e));
  }
  const seq = planejar(e, base);
  const codigo = base.pedido.situacao.codigo;
  switch (seq.kind) {
    case 'recusar':
      definirAviso(e, avisoDaSituacao(e, seq.motivo, codigo));
      return finalizar(e, semEscrita(e));
    case 'nada':
      if (seq.aviso !== null) definirAviso(e, { motivo: seq.aviso });
      return finalizar(e, semEscrita(e));
    case 'objeto':
    case 'situacao':
      break;
  }
  if (!base.restauracao) {
    definirAviso(e, { motivo: M.restauracaoIndisponivel });
    return finalizar(e, semEscrita(e));
  }
  if (seq.kind === 'objeto') return escreverObjeto(e, base, seq);
  if (seq.objetoSemEfeito && e.evento.escritaRecentePossivel) {
    // LI holds our code but has not moved, and that code may have landed less
    // than an hour ago: the 11 waits for a later run (module header).
    registrarSequencia(e, 'objeto-envio', 'efeito-pendente', null);
    return { kind: 'parcial', efeito: 'efeito-pendente' };
  }
  if (seq.aviso !== null) definirAviso(e, { motivo: seq.aviso });
  return escreverSituacao(e, base, seq.codigo, seq);
}

/**
 * A write that landed but whose effect this run did not see (its read-back
 * failed, a 202): the move it may have made is still checked against the
 * situação history — never when the deciding read already showed the codigo
 * written (module header, the residual). An overwrite found there is reported
 * (and parks); otherwise the run stays `parcial`.
 */
async function parcialConferido(
  e: ExecucaoLi,
  codigoAntes: string,
  codigoEscrito: CodigoSituacaoEscritaLi,
  efeito: EfeitoParcialLi,
): Promise<ResultadoRastreioLi> {
  if (codigoAntes !== codigoEscrito) await conferirHistorico(e, codigoAntes, codigoEscrito);
  if (e.aviso?.motivo === M.situacaoSobrescrita) return finalizar(e, comEscrita(e, false));
  return { kind: 'parcial', efeito };
}

/** The tracking code ALONE (module header). */
async function escreverObjeto(
  e: ExecucaoLi,
  base: BaseLidaLi,
  seq: SequenciaRastreioLi & { readonly kind: 'objeto' },
): Promise<ResultadoRastreioLi> {
  const destino: DestinoEscritaLi = { tipo: 'objeto-envio', alvo: e.alvo, envioId: seq.envioId };
  const valor: PayloadEscritaLi = { campo: 'objeto', valor: seq.valor };
  const tentativa = await tentarEscrita(e, destino, valor, base);
  switch (tentativa.kind) {
    case 'resultado':
      return tentativa.resultado;
    case 'sem-restauracao':
      definirAviso(e, { motivo: M.restauracaoIndisponivel });
      return finalizar(e, semEscrita(e));
    case 'recusada':
      // Refused with nothing landed: the aviso, then a SECOND deciding read decides 11.
      definirAviso(e, { motivo: M.escritaRecusada, status: tentativa.status });
      return situacaoAposRecusa(e, await segundaBase(e));
    case 'auth':
      return confirmarRecusaDoObjeto(e, destino, tentativa.erro);
    case 'enviado':
      break;
  }

  // The code LANDED: from here on, no other write in this run.
  const resposta = tentativa.resultado.resposta;
  const codigoAntes = base.pedido.situacao.codigo;
  if (resposta.aplicada === 'pendente') {
    return parcialConferido(e, codigoAntes, C.pedidoEnviado, 'aceito');
  }
  const volta = await lerDeVoltaLi(e.motor, e.alvo, 'objeto-envio');
  if (!volta.verificado) {
    await conterFalhaDeLeitura(e, volta);
    return parcialConferido(e, codigoAntes, C.pedidoEnviado, 'nao-verificado');
  }
  if (conferirEscritaLi(e.motor, destino, valor, volta) === 'deriva') {
    definirAviso(e, { motivo: M.deriva });
    // Another code read back does not prove LI never moved: the move our code
    // may have made is still checked (a sobrescrita outranks the deriva).
    if (codigoAntes !== C.pedidoEnviado) {
      await conferirHistorico(e, codigoAntes, C.pedidoEnviado);
    }
    return finalizar(e, comEscrita(e, true));
  }
  const codigoDeVolta = volta.pedido.situacao.codigo;
  if (codigoDeVolta !== C.pedidoEnviado) {
    // Read back at a THIRD codigo, the order moved during the run, and LI's
    // move to 11 may be one of those moves: the history says whether it was
    // (never when the deciding read was already at 11 — the residual). A row of
    // our move is the move SEEN: done, or the overwrite it reveals.
    if (codigoDeVolta !== codigoAntes && codigoAntes !== C.pedidoEnviado) {
      const v = await conferirHistorico(e, codigoAntes, C.pedidoEnviado);
      if (v !== null && historicoMostraNossaMudanca(v)) {
        registrarSequencia(e, destino.tipo, 'efeito-observado', resposta);
        return finalizar(e, comEscrita(e, true));
      }
    }
    // LI did not move (yet): a run at least an hour later decides from a fresh read.
    registrarSequencia(e, destino.tipo, 'efeito-pendente', resposta);
    return { kind: 'parcial', efeito: 'efeito-pendente' };
  }
  if (codigoAntes !== C.pedidoEnviado) {
    registrarSequencia(e, destino.tipo, 'efeito-observado', resposta);
    await conferirHistorico(e, codigoAntes, C.pedidoEnviado);
  }
  return finalizar(e, comEscrita(e, true));
}

/**
 * A 401/403 on the tracking code: the SECOND deciding read is the
 * confirming read, on the same pinned credential.
 */
async function confirmarRecusaDoObjeto(
  e: ExecucaoLi,
  destino: DestinoEscritaLi,
  erro: LiAuthError,
): Promise<ResultadoRastreioLi> {
  const segunda = await segundaBase(e);
  if ('resultado' in segunda) {
    // Neither read the order nor refused the credential: nothing to conclude — retry.
    if (segunda.resultado.kind === 'recusa-deterministica') {
      throw new EscritaRecusadaLiError(e.evento.contaId, destino.tipo, erro.status);
    }
    return segunda.resultado;
  }
  // Not found right after a read that found it: nothing to conclude — retry.
  if (segunda.base.kind !== 'lida') {
    throw new EscritaRecusadaLiError(e.evento.contaId, destino.tipo, erro.status);
  }
  e.confirmado = true;
  if (e.evento.passagemFinal !== 'quente') {
    registrarSequencia(e, destino.tipo, 'recusada-retentativa', null, erro.status);
    throw new EscritaRecusadaLiError(e.evento.contaId, destino.tipo, erro.status);
  }
  definirAviso(e, { motivo: M.escritaRecusada, status: erro.status });
  return situacaoAposRecusa(e, segunda);
}

/**
 * After a refused code: 11 from the SECOND deciding read, never from the
 * first. A situação that read refuses is the aviso the operator sees (it
 * outranks the refused code); a second read refused for good still reports the
 * refused code, and parks.
 */
async function situacaoAposRecusa(
  e: ExecucaoLi,
  segunda: { readonly base: BaseEscritaLi } | { readonly resultado: ResultadoRastreioLi },
): Promise<ResultadoRastreioLi> {
  if ('resultado' in segunda) {
    if (segunda.resultado.kind !== 'recusa-deterministica') return segunda.resultado;
    registrarRecusaDeterministica(e.evento, e.deps, segunda.resultado, 'estacionada');
    return finalizar(e, semEscrita(e));
  }
  const base = baseDoPedido(e, segunda.base);
  if (base === null || !base.restauracao) return finalizar(e, semEscrita(e));
  const codigo = base.pedido.situacao.codigo;
  const celula = decidirSituacaoRastreioLi(codigo, C.pedidoEnviado);
  switch (celula.acao) {
    case 'recusar':
      definirAviso(e, avisoDaSituacao(e, celula.motivo, codigo));
      return finalizar(e, semEscrita(e));
    case 'pular':
      return finalizar(e, semEscrita(e));
    case 'escrever':
      return escreverSituacao(e, base, C.pedidoEnviado, {
        objetoSemEfeito: false,
        objetoNaoEnviado: false,
      });
  }
}

/** One situação write, its read-back and the history check. */
async function escreverSituacao(
  e: ExecucaoLi,
  base: BaseLidaLi,
  codigo: CodigoSituacaoEscritaLi,
  flags: { readonly objetoSemEfeito: boolean; readonly objetoNaoEnviado: boolean },
): Promise<ResultadoRastreioLi> {
  const destino: DestinoEscritaLi = { tipo: 'situacao-pedido', alvo: e.alvo };
  const valor: PayloadEscritaLi = { campo: 'codigo', valor: codigo };
  const tentativa = await tentarEscrita(e, destino, valor, base);
  switch (tentativa.kind) {
    case 'resultado':
      return tentativa.resultado;
    case 'sem-restauracao':
      definirAviso(e, { motivo: M.restauracaoIndisponivel });
      return finalizar(e, semEscrita(e));
    case 'recusada':
      definirAviso(e, { motivo: M.escritaRecusada, status: tentativa.status });
      return finalizar(e, semEscrita(e));
    case 'auth':
      return confirmarRecusaDaSituacao(e, destino, tentativa.erro);
    case 'enviado':
      break;
  }

  // The situação LANDED: from here on, no other write in this run.
  const resposta = tentativa.resultado.resposta;
  if (flags.objetoSemEfeito) registrarSequencia(e, destino.tipo, 'objeto-sem-efeito', resposta);
  // A delivery never sends the code: said once, when LI lacks a valid one.
  if (flags.objetoNaoEnviado) registrarSequencia(e, 'objeto-envio', 'objeto-nao-enviado', null);
  if (resposta.aplicada === 'pendente') {
    return parcialConferido(e, base.pedido.situacao.codigo, codigo, 'aceito');
  }
  const volta = await lerDeVoltaLi(e.motor, e.alvo, 'situacao-pedido');
  let conferido = true;
  if (volta.verificado) {
    if (conferirEscritaLi(e.motor, destino, valor, volta) === 'deriva') {
      definirAviso(e, { motivo: M.deriva });
    }
  } else {
    conferido = false;
    await conterFalhaDeLeitura(e, volta);
    e.deps.logger?.warn('[loja-integrada] escrita sem conferência: a leitura de volta falhou', {
      integracaoId: e.evento.contaId,
      numero: e.evento.numero,
      evento: e.evento.evento,
      classe: volta.classe,
    });
  }
  await conferirHistorico(e, base.pedido.situacao.codigo, codigo);
  return finalizar(e, comEscrita(e, conferido));
}

/** A 401/403 on a situação write: one paced confirming read, unless this run already did. */
async function confirmarRecusaDaSituacao(
  e: ExecucaoLi,
  destino: DestinoEscritaLi,
  erro: LiAuthError,
): Promise<ResultadoRastreioLi> {
  if (!e.confirmado) {
    try {
      await confirmarCredencialLi(e.motor, e.alvo);
    } catch (err) {
      const r = await classificarFalhaDeLeituraLi(e.db, err, e.contexto, e.deps);
      if (r === null) throw err;
      // Neither read the order nor refused the credential (a 404, a 3xx or 4xx,
      // a body off its schema): nothing to conclude — retry, on every pass.
      if (r.kind === 'recusa-deterministica') {
        throw new EscritaRecusadaLiError(e.evento.contaId, destino.tipo, erro.status);
      }
      return r;
    }
    e.confirmado = true;
    if (e.evento.passagemFinal !== 'quente') {
      registrarSequencia(e, destino.tipo, 'recusada-retentativa', null, erro.status);
      throw new EscritaRecusadaLiError(e.evento.contaId, destino.tipo, erro.status);
    }
  }
  definirAviso(e, { motivo: M.escritaRecusada, status: erro.status });
  return finalizar(e, semEscrita(e));
}
