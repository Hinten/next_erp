/**
 * The feed's UNCERTAIN PATH (step 12a, PR 12-c): what happens to a
 * `createFeed` whose answer was lost. `createFeed` has no idempotency key, so
 * a call that was cut, answered 5xx, or answered a body that failed its schema
 * MAY HAVE LANDED, and is never repeated. The send handler expired its lease in
 * place (still `enviando`, this run's `execucaoId`, no `feedId`), and the
 * NAMED `feed-incerto` it enqueued BEFORE that lease turned `enviando` waits
 * here for the feed's 12-h deadline (Amazon processes a feed within 8 h).
 *
 * Two entries, ONE path ({@link percorrerCaminhoIncertoFeed}):
 *
 *  - the task `tipo: 'feed-incerto'` ({@link processarIncertoFeedAmazon}), which
 *    writes its own dispatch line;
 *  - the send handler's E4, when ANOTHER run's batch reads the lease as
 *    `incerta-recuperar` (expired, no `feedId`, at or past the 12 h).
 *
 * ## The path, in this exact order
 *
 *  1. ONE read of the lease. It acts only when the lease is still `enviando`,
 *     held by THIS `execucaoId`, with no `feedId`; anything else is another
 *     state's to answer (the feed was recorded, the lease was released, a later
 *     run took it): INFO, nothing written.
 *  2. Before `antesDoEnvioMs` + 12 h (a forced refresh re-runs the submission
 *     and re-stamps it, so the NAMED task can fire early): the task re-enqueues
 *     ITSELF, UNNAMED (a tombstone would refuse the next one), for the
 *     remainder in WHOLE seconds, and ends. E4's entry never waits.
 *  3. The recovery, `feed-recuperar` `desfecho: 'incerto'`, NAMED
 *     `nomeRecuperacaoFeed(conta, execucaoId, the start this read shows)`, with
 *     the lease's `snapshotEmMs` and `janela` and that start FOLDED in: the
 *     batches the lease turned away ride this recovery.
 *  4. The fluxo's feed-failure aviso (`motivoFalha`), clocked by step 1's
 *     `readTime`. A seam with no provider raises none (logged).
 *  5. The release, `enviando → livre`, holder-checked by the `execucaoId`
 *     (`decidirLiberacao`, kind `incerto`: `falhasSeguidas` + 1 with
 *     `ultimaFalhaEmMs`, `ultimoFeedConcluidoEmMs`, the start cleared). A lost
 *     precondition re-reads; a start SMALLER than the folded one (a batch
 *     turned away after step 1's read) gets its own NAMED `vez` recovery BEFORE
 *     the write.
 *
 * Every step is idempotent, so a crash anywhere re-runs the path from step 1:
 * the recovery's name dedupes while the start is unchanged, the aviso drops an
 * equal clock, and the release is holder-checked. No `getFeeds` lookup and no
 * adoption: a `getFeeds` listing cannot tell this conta's stock feed from its
 * price feed.
 *
 * ⚠️ Every lease stamp is MILLISECONDS; the aviso clock is a Firestore
 * `readTime`, converted only by `avisos/avisos.ts`; Cloud Tasks delays are
 * WHOLE SECONDS.
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  ESTADO_VEZ_FEED_AMAZON,
  type FluxoFeedAmazon,
  type MotivoContaAmazon,
  type TimestampLike,
} from '@delfrance/schemas';

import { sincronizarAvisosDaContaAmazon } from '../avisos/avisos';
import { EVENTO_DO_LOTE_AMAZON } from '../core/escrita';
import { type CamposLogAmazon, type LoggerAmazon, registrarEventoAmazon } from '../core/log';
import type { FluxoComLoteAmazon } from '../core/valvulas';
import type { AgendadorLotesAmazon, ResultadoEnfileiramentoLoteAmazon } from './agendadorLotes';
import type { ProvedorLoteAmazon } from './provedorLote';
import { PRAZO_FEED_MS, prazoDoFeed } from './registroFeed';
import {
  DESFECHO_RECUPERACAO_FEED_AMAZON,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaIncertoFeedAmazon,
  VERSAO_TAREFA_LOTE_AMAZON,
  nomeRecuperacaoFeed,
  referenciaDaRecuperacaoFeed,
  tarefaIncertoFeedAmazonSchema,
  tarefaRecuperarFeedAmazonSchema,
} from './tarefaLote';
import { LIBERACAO_VEZ_FEED, type MotivoRecusaDaVez } from './vezFeed';
import {
  type AlvoVezFeed,
  type EnfileirarVezFeed,
  lerVezFeed,
  liberarVezFeed,
} from './vezFeedFirestore';

/* ------------------------------ the shared deps ------------------------------ */

/** The queue dispatch a run is: its 0-based attempt and its task id. */
export interface RegistroLoteAmazon {
  readonly tentativa: number;
  readonly idTarefa: string | null;
}

/** What the uncertain path needs — bound by the jobs root, doubles in the tests. */
export interface DepsIncertoFeedAmazon {
  /** Now, in MILLISECONDS. Read per decision, never captured. */
  readonly agora: () => number;
  readonly logger: LoggerAmazon;
  /** `(by) => FieldValue.increment(by)` — the aviso counter. */
  readonly increment: (by: number) => unknown;
  /** The jobs queue's producer — built only when an enqueue is due. */
  readonly agendador: () => AgendadorLotesAmazon;
  /** The fluxo's provider, read from the seam per run; `null` while the row is empty. */
  readonly provedor: ProvedorLoteAmazon<FluxoComLoteAmazon, unknown> | null;
  readonly registro: RegistroLoteAmazon;
}

/**
 * The `vez` enqueue every consuming lease write runs BEFORE its write: the
 * jobs producer, NAMED by the recovery (`ja-enfileirada` is success).
 */
export function enfileirarVezPeloAgendador(
  agendador: () => AgendadorLotesAmazon,
): EnfileirarVezFeed {
  return async (recuperacao) => {
    await agendador().enfileirarLote(recuperacao.tarefa, { nome: recuperacao.nome });
  };
}

/**
 * Raise a per-conta aviso of the feed core (the fluxo's `motivoFalha`, or the
 * `aviso` a provider's abort named), clocked by `relogio` — a Firestore
 * `readTime` the DISPATCH read, converted by `avisos/avisos.ts` (an equal clock
 * is dropped there, so a retry writes nothing new).
 */
export async function avisarContaDoLoteAmazon(
  db: Firestore,
  deps: Pick<DepsIncertoFeedAmazon, 'agora' | 'increment' | 'logger'>,
  contaId: string,
  motivo: MotivoContaAmazon,
  relogio: TimestampLike,
): Promise<void> {
  await sincronizarAvisosDaContaAmazon(
    db,
    { increment: deps.increment, nowMs: deps.agora(), logger: deps.logger },
    { integracaoId: contaId, levantar: [motivo], resolver: [], relogio },
  );
}

/**
 * The whole seconds from `agoraMs` to the feed's 12-h deadline counted from
 * `antesDoEnvioMs`, rounded UP (a task that fires a fraction early would only
 * re-enqueue itself once more); never negative.
 */
export function atrasoAtePrazoDoFeedS(antesDoEnvioMs: number, agoraMs: number): number {
  return Math.max(0, Math.ceil((antesDoEnvioMs + PRAZO_FEED_MS - agoraMs) / 1000));
}

/* --------------------------------- the path ---------------------------------- */

/** The send run whose lost answer the path recovers. */
export interface AlvoIncertoFeed extends AlvoVezFeed {
  readonly execucaoId: string;
}

/** What the path came to (module header). */
export type DesfechoCaminhoIncertoFeed =
  /** The lease is not this run's maybe-submitted one: nothing written. */
  | { readonly tipo: 'sem-vez' }
  /** This run's maybe-submitted lease, but without its stamps (a hand edit): nothing written. */
  | { readonly tipo: 'vez-incompleta' }
  /** Before the deadline: re-enqueued for the remainder (the task only). */
  | { readonly tipo: 'cedo'; readonly atrasoS: number; readonly reenfileirado: boolean }
  | {
      readonly tipo: 'recuperado';
      /** The start this path folded into its recovery (its read's). */
      readonly pendenteDesdeMs: number | null;
      readonly recuperacao: ResultadoEnfileiramentoLoteAmazon;
      /** Whether the fluxo's aviso was raised (no provider: none). */
      readonly aviso: boolean;
      /** The release landed, or why it wrote nothing. */
      readonly liberacao: 'liberada' | MotivoRecusaDaVez;
      /** A smaller start the release found and handed to its own `vez` recovery. */
      readonly vezPara: number | null;
    };

/**
 * The uncertain path of the run `alvo.execucaoId` (module header). The task
 * passes `reenfileirarSeCedo: true`; the send handler's E4, which only ever
 * reaches it at or past the deadline, `false`.
 */
export async function percorrerCaminhoIncertoFeed(
  db: Firestore,
  alvo: AlvoIncertoFeed,
  deps: DepsIncertoFeedAmazon,
  opcoes: { readonly reenfileirarSeCedo: boolean },
): Promise<DesfechoCaminhoIncertoFeed> {
  const vezAlvo: AlvoVezFeed = { fluxo: alvo.fluxo, contaId: alvo.contaId };

  // 1. The lease: this run's `enviando`, no feed id — or nothing to do.
  const lida = await lerVezFeed(db, vezAlvo);
  const vez = lida.vez;
  if (
    vez === null ||
    vez.estado !== ESTADO_VEZ_FEED_AMAZON.enviando ||
    vez.execucaoId !== alvo.execucaoId ||
    vez.feedId !== null
  ) {
    return { tipo: 'sem-vez' };
  }
  const antes = vez.antesDoEnvioMs;
  const snapshotEmMs = vez.snapshotEmMs;
  if (antes === null || snapshotEmMs === null) return { tipo: 'vez-incompleta' };

  // 2. Before the deadline: wait the remainder (the task), unnamed.
  const agoraMs = deps.agora();
  if (agoraMs < prazoDoFeed(antes)) {
    const atrasoS = atrasoAtePrazoDoFeedS(antes, agoraMs);
    if (!opcoes.reenfileirarSeCedo) return { tipo: 'cedo', atrasoS, reenfileirado: false };
    await deps.agendador().enfileirarLote(tarefaIncertoFeed(alvo), { atrasoS });
    return { tipo: 'cedo', atrasoS, reenfileirado: true };
  }

  // 3. The recovery, NAMED, with the start this read shows folded in.
  const pendenteDesdeMs = vez.pendenteDesdeMs;
  const tarefa = tarefaRecuperarFeedAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.recuperar,
    fluxo: alvo.fluxo,
    contaId: alvo.contaId,
    desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.incerto,
    feedId: null,
    execucaoId: alvo.execucaoId,
    snapshotEmMs,
    pendenteDesdeMs,
    janela: vez.janela,
  });
  const recuperacao = await deps.agendador().enfileirarLote(tarefa, {
    nome: nomeRecuperacaoFeed(alvo.contaId, referenciaDaRecuperacaoFeed(tarefa), pendenteDesdeMs),
  });

  // 4. The fluxo's feed-failure aviso, clocked by this dispatch's lease read.
  const provedor = deps.provedor;
  if (provedor !== null) {
    await avisarContaDoLoteAmazon(db, deps, alvo.contaId, provedor.motivoFalha, lida.readTime);
  }

  // 5. The release, holder-checked; a smaller start found on a re-read gets its own `vez`.
  const liberada = await liberarVezFeed(
    db,
    vezAlvo,
    { execucaoId: alvo.execucaoId },
    LIBERACAO_VEZ_FEED.incerto,
    {
      agora: deps.agora,
      pendenteDobrado: pendenteDesdeMs,
      enfileirarVez: enfileirarVezPeloAgendador(deps.agendador),
    },
  );
  return {
    tipo: 'recuperado',
    pendenteDesdeMs,
    recuperacao,
    aviso: provedor !== null,
    liberacao: liberada.tipo === 'escrito' ? 'liberada' : liberada.motivo,
    vezPara: liberada.tipo === 'escrito' ? liberada.liberacao.vezPara : null,
  };
}

/** The `feed-incerto` payload of one send run, through the strict schema. */
export function tarefaIncertoFeed(alvo: AlvoIncertoFeed): TarefaIncertoFeedAmazon {
  return tarefaIncertoFeedAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.incerto,
    fluxo: alvo.fluxo,
    contaId: alvo.contaId,
    execucaoId: alvo.execucaoId,
  });
}

/* --------------------------------- the task ---------------------------------- */

/** One `feed-incerto` dispatch's result, logged once ({@link registrarDespachoIncertoFeedAmazon}). */
export interface ResultadoIncertoFeedAmazon {
  readonly fluxo: FluxoFeedAmazon;
  readonly contaId: string;
  readonly desfecho: DesfechoCaminhoIncertoFeed;
}

/** The campos of a path's outcome: closed tokens, ms stamps and counts only. */
export function camposDoCaminhoIncerto(d: DesfechoCaminhoIncertoFeed): CamposLogAmazon {
  switch (d.tipo) {
    case 'sem-vez':
    case 'vez-incompleta':
      return { caminhoIncerto: d.tipo };
    case 'cedo':
      return { caminhoIncerto: d.tipo, atrasoS: d.atrasoS, reenfileirado: d.reenfileirado };
    case 'recuperado':
      return {
        caminhoIncerto: d.tipo,
        pendenteDesdeMs: d.pendenteDesdeMs,
        recuperacao: d.recuperacao,
        avisoFalha: d.aviso,
        liberacao: d.liberacao,
        vezPara: d.vezPara,
      };
  }
}

/** The ONE `feed-incerto` line: WARNING when the path recovered or found a broken lease. */
export function registrarDespachoIncertoFeedAmazon(
  logger: LoggerAmazon,
  r: ResultadoIncertoFeedAmazon,
  registro: RegistroLoteAmazon,
): void {
  const severidade =
    r.desfecho.tipo === 'recuperado' || r.desfecho.tipo === 'vez-incompleta' ? 'WARNING' : 'INFO';
  registrarEventoAmazon(
    logger,
    EVENTO_DO_LOTE_AMAZON[r.fluxo],
    severidade,
    `[amazon] feed ${r.fluxo}: incerto (${r.desfecho.tipo})`,
    { fase: 'incerto', ...camposDoCaminhoIncerto(r.desfecho) },
    {
      conta: r.contaId,
      fluxo: r.fluxo,
      tentativa: registro.tentativa,
      idTarefa: registro.idTarefa,
    },
  );
}

/**
 * The `feed-incerto` task (module header): the path with its early re-enqueue,
 * and its one line. Throws only what the queue must retry (a Firestore or Cloud
 * Tasks failure, the lease's own conflict and corruption classes): every step
 * before the failure is idempotent, so the retry re-runs the path.
 */
export async function processarIncertoFeedAmazon(
  db: Firestore,
  t: TarefaIncertoFeedAmazon,
  deps: DepsIncertoFeedAmazon,
): Promise<ResultadoIncertoFeedAmazon> {
  if (deps.provedor !== null && deps.provedor.fluxo !== t.fluxo) {
    throw new TypeError('incertoFeed.ts: o provedor e a tarefa nomeiam fluxos diferentes');
  }
  const desfecho = await percorrerCaminhoIncertoFeed(
    db,
    { fluxo: t.fluxo, contaId: t.contaId, execucaoId: t.execucaoId },
    deps,
    { reenfileirarSeCedo: true },
  );
  const r: ResultadoIncertoFeedAmazon = { fluxo: t.fluxo, contaId: t.contaId, desfecho };
  registrarDespachoIncertoFeedAmazon(deps.logger, r, deps.registro);
  return r;
}
