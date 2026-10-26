/**
 * The Loja Integrada WRITES-queue pipeline (master plan step 7, PR 7-d): this
 * channel's second binding of the shared failures-only core in
 * `@delfrance/data/admin/notifications` — the writes-queue task, the two sweep
 * lanes run ON that queue (the varredura), and the producer's persist.
 *
 * ## What an event is here
 *
 * `{ tipo, contaId, numero, pedidoId, evento, estado, eventoEmMs }` — "this
 * pedido's freight reached this estado" — ids and one enum (the shapes are
 * `packages/schemas/src/notificacaoEscritaLojaIntegrada.ts`). The run re-reads
 * the pedido and Loja Integrada before deciding anything
 * (`processarRastreio.ts`).
 *
 * ## The queue
 *
 * ONE writes queue, {@link FILA_ESCRITA_LI} (= the function name), at one
 * dispatch at a time — every write to Loja Integrada of this channel goes
 * through it, its sweep included, so retries stay single-file. The function and
 * its scheduler live in the functions codebase (master plan step 7, PR 7-e).
 *
 * ## Dispositions ({@link toDispositionEscritaLi}, phase-independent)
 *
 * | outcome | disposition |
 * | --- | --- |
 * | `escrito`, `ja-refletido`, `escrito-sem-conferencia`, `superado` | resolve |
 * | `pedido-inexistente`, `pedido-nao-li`, `conta-inexistente` | drop |
 * | `desligado` (the valve at `off`) | defer — `off` keeps what was recorded |
 * | `adiado/<motivo>[:<would-be motivo>]` | defer |
 * | `recusado/<motivo>[/<status>]`, `escrito-com-aviso/<motivo>` | park (an aviso was raised) |
 * | `recusa-deterministica/<classe>[/<detalhe>]` | park (an ERROR line instead) |
 * | `parcial/<efeito>` | fail: the hot lane re-runs it at least an hour later |
 * | thrown | queue backoff, then `failed`; at the hot cap, an ERROR line and the aviso |
 *
 * ## Exhaustion, honestly
 *
 * The core signals only a THROWN failure that parks at its cap
 * (`onRetriesExhausted`, bound to {@link sinalizarEsgotamentoEscritaLi}: an ERROR
 * line, and the aviso `tentativas-esgotadas` when the write decision is `on`). A
 * RETURNED `fail` or `defer` parks silently, so {@link passagemFinalDoDocLi}
 * derives — never persists — whether a swept row is on its LAST pass of its
 * lane, and the run raises `tentativas-esgotadas` itself on exactly that pass
 * (and decides a write refusal with a live token only on a `failed` row's last
 * hot pass). A deferred row whose run THROWS graduates to the hot lane with a
 * fresh budget (`graduateDeferredTransientErrors`).
 *
 * ## The varredura ({@link varrerEscritasLi})
 *
 * The shared sweep runs `process` inline, so it may never run outside the
 * writes queue: a scheduler only enqueues a `varredura` task, and that task
 * runs both lanes inside the queue's single dispatch slot. It reads the valve
 * FIRST (`off` ⇒ one line, neither lane touched — `off` keeps the backlog);
 * then the hot lane, then the deferred one, ONE row per `reprocess` call with a
 * fixed `now`, until the budget runs out or the lane is empty. A row the core
 * could neither settle nor re-mark keeps its old `processedAt` and would be
 * picked again: after any per-row failure the row is read once, and a row still
 * pickable ends that lane with ONE WARNING — so it costs at most one run per
 * varredura.
 *
 * ## No transaction anywhere
 *
 * Every write here is the shared store's: `create` (ALREADY_EXISTS ignored),
 * `mark` (a merge), `redrive` (`mergeIfExists`), `remove`. Every one of them
 * but the producer's `create` runs on the single-dispatch writes queue, which is
 * why a removed row cannot be resurrected by a `mark`. This module never names
 * the multi-document atomic-write API — not even here (`estrutura.test.ts`).
 *
 * ⚠️ The process environment is never read here: `deps.ambiente` is the
 * environment, passed in by the functions codebase's composition root.
 */
import type { Firestore } from 'firebase-admin/firestore';
import { z } from 'zod';
import { notificacaoEscritaLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import {
  MAX_TENTATIVAS,
  MAX_TENTATIVAS_DEFERRED,
  type NotificationDisposition,
  type NotificationPipelineConfig,
  type NotificationTaskResult,
  ONE_DAY_MS,
  ONE_HOUR_MS,
  type ReprocessResult,
  defineNotificationPipeline,
} from '@delfrance/data/admin/notifications';
import {
  MOTIVO_RASTREIO_DIVERGENTE_LI,
  NOTIFICACAO_RESILIENCIA_STATUS,
  camposNotificacaoEscritaLi,
  notificacaoEscritaLojaIntegradaSchema,
} from '@delfrance/schemas';

import { lerContaEmCache } from '../core/contaCache';
import {
  FLUXO_LI,
  MODO_LI,
  chaveDoAlvo,
  decidirAlvo,
  lerValvula,
  registrarValvulaLi,
} from '../core/valvulas';
import { avisarRastreioDivergenteLi } from './avisosRastreio';
import {
  type DepsEscritaLi,
  type EventoRastreioLi,
  type PassagemFinalLi,
  type ResultadoRastreioLi,
  processarRastreioLi,
} from './processarRastreio';

/**
 * The writes queue: the deployed `onTaskDispatched` function name, which is ALSO
 * its auto-provisioned Cloud Tasks queue name — the producer's root builds the
 * region-qualified queue path from it, and the functions codebase's export must
 * be named exactly this. Fixed at the first deploy.
 */
export const FILA_ESCRITA_LI = 'filaEscritaLojaIntegrada';

/** The log prefix the shared core renders as `[loja-integrada] …`. */
export const CANAL_LOG_ESCRITA_LI = 'loja-integrada';

/* -------------------------------------------------------------------------- */
/*                              The task payload                              */
/* -------------------------------------------------------------------------- */

/**
 * The writes-queue task payload: the persisted document's wire fields, shared
 * with `@delfrance/schemas` so the two cannot drift. STRIPS unknown keys.
 *
 * ⚠️ Every field added later must be optional or defaulted: tasks in flight
 * survive a deploy, and a payload that no longer parses is DROPPED.
 */
export const tarefaEscritaLiSchema = z.object(camposNotificacaoEscritaLi());
export type PayloadTarefaEscritaLi = z.infer<typeof tarefaEscritaLiSchema>;

/** The pipeline's payload: the wire fields, plus the pass a swept row runs on (never persisted). */
export type PayloadEscritaRastreioLi = PayloadTarefaEscritaLi & {
  readonly passagemFinal: PassagemFinalLi;
};

/** The task's own schema: a task attempt is never a row's last pass. */
const tarefaComPassagemSchema = tarefaEscritaLiSchema.transform(
  (p): PayloadEscritaRastreioLi => ({ ...p, passagemFinal: null }),
);

/** The failure document's id: the event's own digest. Valid by construction. */
export function docIdEscritaLi(p: Pick<PayloadTarefaEscritaLi, 'evento'>): string {
  return p.evento;
}

/** The sweep's in-run dedup key: the event. */
export function dedupKeyEscritaLi(p: Pick<PayloadTarefaEscritaLi, 'evento'>): string {
  return p.evento;
}

/** The wire fields written onto a failure document — named one by one, never a spread. */
export function camposDoDocumentoEscritaLi(p: PayloadTarefaEscritaLi): Record<string, unknown> {
  return {
    tipo: p.tipo,
    contaId: p.contaId,
    numero: p.numero,
    pedidoId: p.pedidoId,
    evento: p.evento,
    estado: p.estado,
    eventoEmMs: p.eventoEmMs,
  };
}

/**
 * Whether a swept row is on its LAST pass of its lane (module header): a
 * `failed` row whose next count reaches `MAX_TENTATIVAS` is the hot lane's
 * parking pass (`quente`); a `deferred` one reaching `MAX_TENTATIVAS_DEFERRED`
 * the deferred lane's (`adiada`). The same arithmetic as the shared sweep's.
 */
export function passagemFinalDoDocLi(doc: {
  readonly status: unknown;
  readonly tentativas: unknown;
}): PassagemFinalLi {
  const tentativas = typeof doc.tentativas === 'number' ? doc.tentativas : 0;
  if (doc.status === NOTIFICACAO_RESILIENCIA_STATUS.failed) {
    return tentativas + 1 >= MAX_TENTATIVAS ? 'quente' : null;
  }
  if (doc.status === NOTIFICACAO_RESILIENCIA_STATUS.deferred) {
    return tentativas + 1 >= MAX_TENTATIVAS_DEFERRED ? 'adiada' : null;
  }
  return null;
}

/** A row, rehydrated STRICTLY: a row that no longer parses throws (the sweep marks it). */
function doDocumento(raw: Record<string, unknown>): PayloadEscritaRastreioLi {
  const doc = notificacaoEscritaLojaIntegradaSchema.parse(raw);
  return {
    tipo: doc.tipo,
    contaId: doc.contaId,
    numero: doc.numero,
    pedidoId: doc.pedidoId,
    evento: doc.evento,
    estado: doc.estado,
    eventoEmMs: doc.eventoEmMs,
    passagemFinal: passagemFinalDoDocLi(doc),
  };
}

/** The run's view of a payload. */
function eventoDe(p: PayloadEscritaRastreioLi): EventoRastreioLi {
  return {
    contaId: p.contaId,
    numero: p.numero,
    pedidoId: p.pedidoId,
    evento: p.evento,
    estado: p.estado,
    eventoEmMs: p.eventoEmMs,
    passagemFinal: p.passagemFinal,
  };
}

/* -------------------------------------------------------------------------- */
/*                               Dispositions                                 */
/* -------------------------------------------------------------------------- */

/**
 * The ONE outcome → disposition table (module header). Phase-independent. An
 * exhaustive `switch` with no `default`, so an outcome kind added later fails to
 * compile until it is mapped.
 */
export function toDispositionEscritaLi(r: ResultadoRastreioLi): NotificationDisposition {
  switch (r.kind) {
    case 'escrito':
    case 'ja-refletido':
    case 'escrito-sem-conferencia':
    case 'superado':
      return { kind: 'resolve', label: r.kind };
    case 'pedido-inexistente':
    case 'pedido-nao-li':
    case 'conta-inexistente':
      return { kind: 'drop', reason: r.kind, label: r.kind };
    case 'desligado':
      return { kind: 'defer', reason: r.kind };
    case 'adiado':
      return {
        kind: 'defer',
        reason: `adiado/${r.motivo}${r.recusa === null ? '' : `:${r.recusa}`}`,
      };
    case 'recusado':
      return {
        kind: 'park',
        reason: `recusado/${r.motivo}${r.status === null ? '' : `/${String(r.status)}`}`,
      };
    case 'escrito-com-aviso':
      return { kind: 'park', reason: `escrito-com-aviso/${r.motivo}` };
    case 'recusa-deterministica':
      return {
        kind: 'park',
        reason: `recusa-deterministica/${r.classe}${r.detalhe === null ? '' : `/${r.detalhe}`}`,
      };
    case 'parcial':
      return { kind: 'fail', reason: `parcial/${r.efeito}` };
  }
}

/* -------------------------------------------------------------------------- */
/*                         The pipeline and its signal                        */
/* -------------------------------------------------------------------------- */

/** Never called: the storage-only pipeline below only persists. */
function processoIndisponivel(): Promise<ResultadoRastreioLi> {
  return Promise.reject(
    new TypeError(
      'pipeline de armazenamento das escritas da Loja Integrada: process não é chamado',
    ),
  );
}

/**
 * The shared-core config. ⚠️ `collection` is written EXPLICITLY: guard B
 * (`notificationGuardrails.test.ts`) ignores the shorthand form on purpose.
 */
function configEscritaLi(
  processar: (db: Firestore, p: PayloadEscritaRastreioLi) => Promise<ResultadoRastreioLi>,
  aoEsgotar?: (db: Firestore, p: PayloadEscritaRastreioLi, err: Error) => Promise<void>,
): NotificationPipelineConfig<PayloadEscritaRastreioLi, ResultadoRastreioLi> {
  return {
    ...(aoEsgotar === undefined ? {} : { onRetriesExhausted: aoEsgotar }),
    channel: CANAL_LOG_ESCRITA_LI,
    collection: notificacaoEscritaLojaIntegradaCollection,
    taskSchema: tarefaComPassagemSchema,
    docIdOf: docIdEscritaLi,
    dedupKeyOf: dedupKeyEscritaLi,
    toDocFields: camposDoDocumentoEscritaLi,
    // STRICT, from the raw document, deriving the last-pass flag (module header).
    fromDoc: (_parsed, raw) => doDocumento(raw),
    process: processar,
    toDisposition: (resultado) => toDispositionEscritaLi(resultado),
    // A deferred row whose precondition cleared and whose run then THREW returns
    // to the hot lane with a fresh budget — a write refusal with a live token
    // included, so it never concludes on the deferred lane's last pass.
    graduateDeferredTransientErrors: true,
  };
}

/**
 * The pipeline, built PER CALL so this run's deps (the clock, the attempt, the
 * task's dispatch start) reach the run: the shared `process(db, payload)`
 * carries none of them.
 */
export function criarPipelineEscritaLi(deps: DepsEscritaLi) {
  return defineNotificationPipeline(
    configEscritaLi(
      (db, p) => processarRastreioLi(db, eventoDe(p), deps),
      (db, p, err) => sinalizarEsgotamentoEscritaLi(db, p, err, deps),
    ),
  );
}

/**
 * A THROWN failure the sweep just parked at its cap (module header): ONE ERROR
 * line — ids and the error's class, never its message — first, then, when the
 * write decision for this target is `on`, the aviso `tentativas-esgotadas`. A
 * failed aviso write rethrows; the shared core contains it.
 */
export async function sinalizarEsgotamentoEscritaLi(
  db: Firestore,
  payload: PayloadEscritaRastreioLi,
  err: Error,
  deps: Pick<DepsEscritaLi, 'ambiente' | 'increment' | 'agoraMs' | 'logger'>,
): Promise<void> {
  const linha = `[${CANAL_LOG_ESCRITA_LI}] escrita estacionada: tentativas esgotadas, pedido não refletido`;
  const ids = {
    integracaoId: payload.contaId,
    numero: payload.numero,
    evento: payload.evento,
    estado: payload.estado,
    classe: err.name,
  };
  if (deps.logger?.error === undefined) console.error(linha, ids);
  else deps.logger.error(linha, ids);

  const alvo = { contaId: payload.contaId, recurso: Number(payload.numero) };
  if (chaveDoAlvo(alvo) === null) return;
  if (decidirAlvo(lerValvula(FLUXO_LI.rastreio, deps.ambiente), alvo).modo !== MODO_LI.on) return;
  const conta = await lerContaEmCache(db, payload.contaId);
  const lojaNome = conta === null || conta.nome === '' ? payload.contaId : conta.nome;
  await avisarRastreioDivergenteLi(
    db,
    {
      integracaoId: payload.contaId,
      lojaNome,
      pedidoId: payload.pedidoId,
      numero: payload.numero,
      eventoEmMs: payload.eventoEmMs,
    },
    { motivo: MOTIVO_RASTREIO_DIVERGENTE_LI.tentativasEsgotadas },
    { increment: deps.increment, nowMs: deps.agoraMs(), logger: deps.logger },
  );
}

/** Persist only — the write that needs no `process`. */
const armazenamentoEscritaLi = defineNotificationPipeline(configEscritaLi(processoIndisponivel));

/**
 * Persist an event as `failed`, for a producer whose ENQUEUE failed transiently
 * (or while the queue is switched off): the varredura drains it. The doc id is
 * the event's digest, so a redelivery never forks.
 */
export function persistirFalhaEscritaLi(
  db: Firestore,
  payload: PayloadTarefaEscritaLi,
  erro: string,
): Promise<void> {
  return armazenamentoEscritaLi.persistFailure(db, { ...payload, passagemFinal: null }, erro);
}

/* -------------------------------------------------------------------------- */
/*                                  The task                                  */
/* -------------------------------------------------------------------------- */

/** What one dispatch reports, for the functions codebase's ONE log line. */
export interface ResultadoTarefaEscritaLi {
  readonly outcome: NotificationTaskResult<
    PayloadEscritaRastreioLi,
    ResultadoRastreioLi
  >['outcome'];
  /** The run's outcome kind; `null` when the payload never parsed. */
  readonly kind: ResultadoRastreioLi['kind'] | null;
}

/**
 * The writes-queue body for a `rastreio` task: parse, run, dispose.
 * `retryCount` is the 0-based Cloud Tasks attempt; on the last one a transient
 * failure is persisted as `failed` instead of rethrown.
 */
export async function tratarTarefaEscritaLi(
  db: Firestore,
  dados: unknown,
  retryCount: number,
  deps: DepsEscritaLi,
): Promise<ResultadoTarefaEscritaLi> {
  const r = await criarPipelineEscritaLi(deps).handleTask(db, dados, retryCount);
  return { outcome: r.outcome, kind: r.result?.kind ?? null };
}

/* -------------------------------------------------------------------------- */
/*                         The varredura (on the queue)                       */
/* -------------------------------------------------------------------------- */

/** Why a lane stopped. */
export type ParadaLaneEscritaLi = 'vazia' | 'orcamento' | 'repetida' | 'desligado';

/** One lane of one varredura. */
export interface ResumoLaneEscritaLi {
  readonly processadas: number;
  readonly erros: number;
  readonly parada: ParadaLaneEscritaLi;
  readonly desfechos: Readonly<Record<string, number>>;
}

export interface ResultadoVarreduraEscritaLi {
  /** The valve was `off`: neither lane was touched. */
  readonly desligado: boolean;
  readonly quente: ResumoLaneEscritaLi;
  readonly adiada: ResumoLaneEscritaLi;
}

const LANE_DESLIGADA: ResumoLaneEscritaLi = {
  processadas: 0,
  erros: 0,
  parada: 'desligado',
  desfechos: {},
};

type LaneEscritaLi = 'quente' | 'adiada';

/**
 * Whether a row that just failed in the sweep is still pickable by this
 * varredura (its re-mark failed too): one read by id.
 */
async function linhaPresa(
  db: Firestore,
  docId: string,
  lane: LaneEscritaLi,
  inicio: number,
): Promise<boolean> {
  const snap = await notificacaoEscritaLojaIntegradaCollection.docRef(db, {}, docId).get();
  if (!snap.exists) return false;
  const raw = snap.data() as Record<string, unknown>;
  const status =
    lane === 'quente'
      ? NOTIFICACAO_RESILIENCIA_STATUS.failed
      : NOTIFICACAO_RESILIENCIA_STATUS.deferred;
  const corte = inicio - (lane === 'quente' ? ONE_HOUR_MS : ONE_DAY_MS);
  return raw.status === status && typeof raw.processedAt === 'number' && raw.processedAt < corte;
}

async function drenar(
  db: Firestore,
  deps: DepsEscritaLi,
  lane: LaneEscritaLi,
  inicio: number,
  orcamentoMs: number,
): Promise<ResumoLaneEscritaLi> {
  const pipeline = criarPipelineEscritaLi(deps);
  let processadas = 0;
  let erros = 0;
  const desfechos: Record<string, number> = {};
  const resumo = (parada: ParadaLaneEscritaLi): ResumoLaneEscritaLi => ({
    processadas,
    erros,
    parada,
    desfechos,
  });
  for (;;) {
    if (deps.agoraMs() - inicio >= orcamentoMs) return resumo('orcamento');
    const r: ReprocessResult =
      lane === 'quente'
        ? await pipeline.reprocess(db, { limit: 1, now: inicio })
        : await pipeline.reprocessDeferred(db, { limit: 1, now: inicio });
    processadas += r.processed;
    erros += r.errors.length;
    for (const [rotulo, n] of Object.entries(r.outcomes)) {
      desfechos[rotulo] = (desfechos[rotulo] ?? 0) + n;
    }
    if (r.processed === 0 && r.errors.length === 0) return resumo('vazia');
    for (const falha of r.errors) {
      if (await linhaPresa(db, falha.docId, lane, inicio)) {
        deps.logger?.warn(
          `[${CANAL_LOG_ESCRITA_LI}] varredura de escritas: linha não pôde ser marcada — fila encerrada nesta passada`,
          { docId: falha.docId, lane },
        );
        return resumo('repetida');
      }
    }
  }
}

/**
 * The varredura task's body (module header): the valve FIRST, then the hot lane
 * and the deferred one, one row per call, inside `orcamentoMs`.
 */
export async function varrerEscritasLi(
  db: Firestore,
  deps: DepsEscritaLi,
  orcamentoMs: number,
): Promise<ResultadoVarreduraEscritaLi> {
  const valvula = lerValvula(FLUXO_LI.rastreio, deps.ambiente);
  if (valvula.modo === MODO_LI.off) {
    registrarValvulaLi(valvula, { ...deps.registro, conta: null });
    return { desligado: true, quente: LANE_DESLIGADA, adiada: LANE_DESLIGADA };
  }
  const inicio = deps.agoraMs();
  const quente = await drenar(db, deps, 'quente', inicio, orcamentoMs);
  const adiada = await drenar(db, deps, 'adiada', inicio, orcamentoMs);
  return { desligado: false, quente, adiada };
}
