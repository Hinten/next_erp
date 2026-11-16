/**
 * The feed LEASE's pure state machine (step 12a, PR 12-b): who may hold
 * `feedsAmazonEmCurso/{fluxo}-{contaId}`, what a batch that meets a held lease
 * does instead, and the exact field patch of every lease write. Unwired in
 * 12-b: the send, result and uncertain handlers of 12-c are the callers. No
 * Firestore here: every input is the parsed lease (`null` = no document yet),
 * our clock in MILLISECONDS and the run's ids; every output is a verdict. The
 * caller writes each patch under a native precondition on the very read it
 * handed in, and on a lost precondition re-reads and asks again.
 *
 * ## The lifecycle
 *
 * `livre → montando → enviando → enviado → livre`. `montando` and `enviando`
 * expire {@link VALIDADE_VEZ_MS} after their write (longer than one send
 * dispatch); `enviado` expires {@link VALIDADE_VEZ_ENVIADO_MS} after
 * `antesDoEnvioMs` (past the 48-h abandonment, so the feed's own last rung
 * releases it first and only a dead chain is adopted). A lease is EXPIRED at
 * `agoraMs >= ateMs`, so the uncertain outcome's `ateMs = agora` reads expired
 * to every other run at once.
 *
 * ## The phase: a known `feedId` is never submitted over
 *
 * A `livre` lease is free, whatever else it holds (every release clears the
 * in-flight fields). Otherwise a `feedId` is the durable fact that Amazon
 * accepted a feed, so the lease behaves as `enviado` whenever it names one, and
 * as `enviando` (maybe submitted, id unknown) when it is `enviando` or
 * `enviado` without one ({@link faseDaVez}). The transitions never write either
 * crossing; the rule only makes a hand-edited or torn lease land on the side
 * that never submits a second feed.
 *
 * ## Taking the lease ({@link decidirTomadaDaVez})
 *
 *  - THIS run's own lease resumes its own state, expired or not: `montando` ⇒
 *    `retomar` (nothing was posted), `enviando` ⇒ `garantir-incerto` (never a
 *    second `createFeed`), `enviado` ⇒ `retomar-consulta`.
 *  - Free, no document, or another run's EXPIRED `montando` ⇒ `tomar`, unless
 *    the submission floor answers `aguardar-espaco` (below).
 *  - Another run's unexpired `montando` or `enviando` ⇒ `ocupada`.
 *  - Another run's known feed, unexpired, by its age from `antesDoEnvioMs`:
 *    under {@link ESPERA_MAXIMA_ATRAS_DE_FEED_MS} ⇒ `ocupada`; from then until
 *    the feed's 12-h deadline ⇒ `ocupada-lenta` (healthy but slow); at or past
 *    the deadline ⇒ `ocupada-vencida`. Expired ⇒ `adotar-resultado`.
 *  - Another run's maybe-submitted feed, expired: before `antesDoEnvioMs` +
 *    12 h ⇒ `incerta-aguardar` (never taken over: the first feed may still be
 *    pending at Amazon); at or past it ⇒ `incerta-recuperar`.
 *
 * Every boundary is INCLUSIVE on the later answer.
 *
 * ## A batch the lease turns away ({@link destinoDoLoteRecusado})
 *
 * Three batch classes ({@link classeDoLote}): a BLOCK batch; a TICK-born window
 * batch (no commit filter: its keep rule IS its start, so recording the start
 * loses nothing); a RECOVERY-born window batch (a commit filter that forces the
 * SKUs committed after its predecessor's snapshot, which a bare start cannot
 * express, so it is never recorded).
 *
 * | Classification | Tick-born window | Recovery-born window | Block |
 * |---|---|---|---|
 * | `ocupada` | `registrar-pendente` | `aguardar` until `esperaAteMs`, then patches | `aguardar` until `esperaAteMs`, then `lote-expirado` |
 * | `ocupada-lenta`, `incerta-aguardar`, `ocupada-vencida`, `adotar-resultado` | patches | patches | as on `ocupada` |
 * | `incerta-recuperar` | `registrar-pendente` (the uncertain path folds it) | patches | as on `ocupada` |
 * | `tomar`, breaker open | patches, no lease write | patches, no lease write | `tomar` (a probe) |
 * | `tomar`, breaker half-open | `tomar` (THE probe) | `tomar` (THE probe) | `tomar` |
 * | `aguardar-espaco` | `aguardar` the remainder | the same | the same |
 *
 * A window batch the breaker refuses goes per SKU even inside the floor: it
 * submits no feed, and the floor spaces feed submissions only.
 *
 * ## The breaker ({@link estadoDoDisjuntor})
 *
 * `falhasSeguidas` counts the consecutive releases that raised the fluxo's
 * feed-failure aviso; at {@link MAX_FALHAS_SEGUIDAS_FEED} it is open and a
 * window batch that would take the lease goes per SKU instead. It is half-open
 * {@link ESPERA_SONDA_DISJUNTOR_MS} after the last failure: one window batch
 * then takes the lease as the probe (one at a time, since the take holds the
 * lease); its completed feed resets the count, its failure re-stamps the
 * hour. A block batch is never refused.
 *
 * ## The submission floor
 *
 * A take less than {@link ESPACO_MINIMO_ENTRE_FEEDS_MS} after `ultimoEnvioMs`
 * answers `aguardar-espaco` with the remainder in WHOLE seconds, rounded UP.
 * Only a take: a run resuming its own lease, and every release, ignore it.
 *
 * ## The transitions
 *
 * Each builder checks its source state and its HOLDER — the `execucaoId` while
 * `montando`/`enviando`, the `feedId` once the feed is known — and refuses
 * (writing nothing) otherwise: {@link tomarVez}, {@link marcarEnviandoVez}
 * (also the refresh re-entry `enviando → enviando` of the SAME attempt: the
 * run's own stamp, the lease still live),
 * {@link marcarEnviadoVez}, {@link expirarIncertoVez} (the uncertain outcome,
 * expired in place), {@link voltarParaMontandoVez} (a 429: not processed), and
 * every release through {@link decidirLiberacao}.
 *
 * ## The pending start
 *
 * `pendenteDesdeMs` is the earliest window start of the tick-born window
 * batches turned away while the lease was held: MIN-merged
 * ({@link registrarPendenteVez}), kept by a take, and CONSUMED from the READ by
 * the next release, the uncertain outcome, the slow and overdue rungs, a
 * repasse to patches, or the check of an expired `montando`
 * ({@link consumirPendenteVez}). Every consuming write answers the start it
 * read as `vezPara`: the caller enqueues the named `vez` recovery for it BEFORE
 * the write, unless the start was already folded into its own recovery (the
 * feed's tail, the uncertain path), so a crash between the two re-runs a named
 * enqueue instead of losing the start.
 *
 * ## The consecutive-failure count ({@link REGRA_DA_LIBERACAO})
 *
 * A closed table over every release kind: a completed feed resets it to 0;
 * exactly the releases that raise the fluxo's feed-failure aviso add 1 and
 * stamp `ultimaFalhaEmMs`; every other release keeps both. Every release of a
 * feed that may have applied (any tail or uncertain-path release but
 * `cancelado`) stamps `ultimoFeedConcluidoEmMs`. `ultimoEnvioMs` is written
 * only by {@link marcarEnviandoVez}.
 */
import {
  DESFECHO_FEED_AMAZON,
  ESTADO_VEZ_FEED_AMAZON,
  type EstadoVezFeedAmazon,
  FEED_ID_REGISTRO_AMAZON_REGEX,
  ID_LOTE_FEED_AMAZON_REGEX,
  type JanelaFeedAmazon,
  TIPO_LOTE_FEED_AMAZON,
  type VezFeedAmazon,
} from '@delfrance/schemas';

import {
  ESPACO_MINIMO_ENTRE_FEEDS_MS,
  ESPERA_LOTE_EM_VEZ_S,
  ESPERA_MAXIMA_ATRAS_DE_FEED_MS,
  ESPERA_SONDA_DISJUNTOR_MS,
  MAX_FALHAS_SEGUIDAS_FEED,
  MOTIVO_ABORTO_LOTE,
} from './provedorLote';
import { prazoDoFeed } from './registroFeed';
import type { LoteFeedAmazon, TarefaEnviarFeedAmazon } from './tarefaLote';

/* --------------------------------- the clocks --------------------------------- */

const HORA_MS = 3_600_000;

/** How long a `montando` or `enviando` lease holds after its write (10 min). */
export const VALIDADE_VEZ_MS = 600_000;

/** An `enviado` lease expires this long after `antesDoEnvioMs` (49 h). */
export const VALIDADE_VEZ_ENVIADO_MS = 49 * HORA_MS;

/** A ms instant: a non-negative safe integer, or a `RangeError` (a programming error). */
function exigirMs(nome: string, valor: number): number {
  if (!Number.isSafeInteger(valor) || valor < 0) {
    throw new RangeError(`vezFeed.ts: ${nome} não é um instante em ms`);
  }
  return valor;
}

/** A count of at least one, or a `RangeError`. */
function exigirPositivo(nome: string, valor: number): number {
  if (!Number.isSafeInteger(valor) || valor < 1) {
    throw new RangeError(`vezFeed.ts: ${nome} não é um inteiro positivo`);
  }
  return valor;
}

/** An id under its grammar, or a `RangeError` naming the grammar (never the value). */
function exigirId(regex: RegExp, nome: string, valor: string): string {
  if (typeof valor !== 'string' || !regex.test(valor)) {
    throw new RangeError(`vezFeed.ts: ${nome} fora da gramática`);
  }
  return valor;
}

/* --------------------------------- the phase ---------------------------------- */

/**
 * The state the lease BEHAVES as (module header): `livre` as stored; else
 * `enviado` whenever it names a `feedId`; else `montando` or, for `enviando`
 * and an `enviado` without a `feedId`, `enviando`.
 */
export function faseDaVez(vez: VezFeedAmazon): EstadoVezFeedAmazon {
  if (vez.estado === ESTADO_VEZ_FEED_AMAZON.livre) return ESTADO_VEZ_FEED_AMAZON.livre;
  if (vez.feedId !== null) return ESTADO_VEZ_FEED_AMAZON.enviado;
  if (vez.estado === ESTADO_VEZ_FEED_AMAZON.montando) return ESTADO_VEZ_FEED_AMAZON.montando;
  return ESTADO_VEZ_FEED_AMAZON.enviando;
}

/* ------------------------------ the classification ---------------------------- */

/** What a run that reads the lease may do (module header). */
export const TOMADA_DA_VEZ = {
  tomar: 'tomar',
  retomar: 'retomar',
  garantirIncerto: 'garantir-incerto',
  retomarConsulta: 'retomar-consulta',
  ocupada: 'ocupada',
  ocupadaLenta: 'ocupada-lenta',
  ocupadaVencida: 'ocupada-vencida',
  incertaAguardar: 'incerta-aguardar',
  incertaRecuperar: 'incerta-recuperar',
  adotarResultado: 'adotar-resultado',
  aguardarEspaco: 'aguardar-espaco',
} as const;
export type TipoTomadaDaVez = (typeof TOMADA_DA_VEZ)[keyof typeof TOMADA_DA_VEZ];

/** The three answers about the run's OWN lease. */
type TipoTomadaPropria =
  | typeof TOMADA_DA_VEZ.retomar
  | typeof TOMADA_DA_VEZ.garantirIncerto
  | typeof TOMADA_DA_VEZ.retomarConsulta;

export type TomadaDaVezFeed =
  | { readonly tipo: Exclude<TipoTomadaDaVez, typeof TOMADA_DA_VEZ.aguardarEspaco> }
  | {
      readonly tipo: typeof TOMADA_DA_VEZ.aguardarEspaco;
      /** Whole seconds until the floor allows the take, rounded UP: at least 1. */
      readonly restanteS: number;
    };

/** Whether a classification is about the run's OWN lease (never a turned-away batch). */
export function ehTomadaPropria(
  tomada: TomadaDaVezFeed,
): tomada is { readonly tipo: TipoTomadaPropria } {
  return (
    tomada.tipo === TOMADA_DA_VEZ.retomar ||
    tomada.tipo === TOMADA_DA_VEZ.garantirIncerto ||
    tomada.tipo === TOMADA_DA_VEZ.retomarConsulta
  );
}

/** `tomar`, or `aguardar-espaco` when the floor since `ultimoEnvioMs` has not passed. */
function tomarOuEsperar(ultimoEnvioMs: number | null, agoraMs: number): TomadaDaVezFeed {
  if (ultimoEnvioMs !== null && agoraMs < ultimoEnvioMs + ESPACO_MINIMO_ENTRE_FEEDS_MS) {
    const restanteMs = ultimoEnvioMs + ESPACO_MINIMO_ENTRE_FEEDS_MS - agoraMs;
    // Capped at the floor itself: a stamp from a clock ahead of ours never asks
    // for a longer wait than one floor.
    const restanteS = Math.min(Math.ceil(restanteMs / 1000), ESPACO_MINIMO_ENTRE_FEEDS_MS / 1000);
    return { tipo: TOMADA_DA_VEZ.aguardarEspaco, restanteS };
  }
  return { tipo: TOMADA_DA_VEZ.tomar };
}

/**
 * How the run `execucaoId` reading `armazenada` at `agoraMs` stands towards the
 * lease (module header). `null` is a lease with no document yet: `tomar`.
 *
 * @throws {RangeError} a clock that is not a ms instant, or an `execucaoId`
 *   outside its grammar (a programming error).
 */
export function decidirTomadaDaVez(
  armazenada: VezFeedAmazon | null,
  agoraMs: number,
  execucaoId: string,
): TomadaDaVezFeed {
  exigirMs('agoraMs', agoraMs);
  exigirId(ID_LOTE_FEED_AMAZON_REGEX, 'execucaoId', execucaoId);
  if (armazenada === null) return { tipo: TOMADA_DA_VEZ.tomar };
  const fase = faseDaVez(armazenada);
  if (fase === ESTADO_VEZ_FEED_AMAZON.livre) {
    return tomarOuEsperar(armazenada.ultimoEnvioMs, agoraMs);
  }
  if (armazenada.execucaoId === execucaoId) {
    switch (fase) {
      case ESTADO_VEZ_FEED_AMAZON.montando:
        return { tipo: TOMADA_DA_VEZ.retomar };
      case ESTADO_VEZ_FEED_AMAZON.enviando:
        return { tipo: TOMADA_DA_VEZ.garantirIncerto };
      case ESTADO_VEZ_FEED_AMAZON.enviado:
        return { tipo: TOMADA_DA_VEZ.retomarConsulta };
    }
  }
  const vencida = agoraMs >= armazenada.ateMs;
  const antes = armazenada.antesDoEnvioMs;
  switch (fase) {
    case ESTADO_VEZ_FEED_AMAZON.montando:
      return vencida
        ? tomarOuEsperar(armazenada.ultimoEnvioMs, agoraMs)
        : { tipo: TOMADA_DA_VEZ.ocupada };
    case ESTADO_VEZ_FEED_AMAZON.enviando:
      if (!vencida) return { tipo: TOMADA_DA_VEZ.ocupada };
      // Without its stamp the wait cannot be measured: never taken over.
      if (antes === null || agoraMs < prazoDoFeed(antes)) {
        return { tipo: TOMADA_DA_VEZ.incertaAguardar };
      }
      return { tipo: TOMADA_DA_VEZ.incertaRecuperar };
    case ESTADO_VEZ_FEED_AMAZON.enviado:
      if (vencida) return { tipo: TOMADA_DA_VEZ.adotarResultado };
      // Without its stamp the holder's age is unknown: treated as overdue.
      if (antes === null) return { tipo: TOMADA_DA_VEZ.ocupadaVencida };
      if (agoraMs < antes + ESPERA_MAXIMA_ATRAS_DE_FEED_MS) return { tipo: TOMADA_DA_VEZ.ocupada };
      if (agoraMs < prazoDoFeed(antes)) return { tipo: TOMADA_DA_VEZ.ocupadaLenta };
      return { tipo: TOMADA_DA_VEZ.ocupadaVencida };
  }
}

/* -------------------------------- the breaker --------------------------------- */

/** The breaker's inputs, read from the lease. */
export interface DisjuntorFeed {
  readonly falhasSeguidas: number;
  readonly ultimaFalhaEmMs: number | null;
}

/** The breaker of a lease read (`null`: no document, closed). */
export function disjuntorDaVez(armazenada: VezFeedAmazon | null): DisjuntorFeed {
  return armazenada === null
    ? { falhasSeguidas: 0, ultimaFalhaEmMs: null }
    : {
        falhasSeguidas: armazenada.falhasSeguidas,
        ultimaFalhaEmMs: armazenada.ultimaFalhaEmMs,
      };
}

export const ESTADO_DO_DISJUNTOR = {
  fechado: 'fechado',
  aberto: 'aberto',
  /** Open, but past the wait since the last failure: one window batch may probe. */
  sonda: 'sonda',
} as const;
export type EstadoDoDisjuntorFeed = (typeof ESTADO_DO_DISJUNTOR)[keyof typeof ESTADO_DO_DISJUNTOR];

/**
 * The breaker at `agoraMs` (module header). An open breaker with no failure
 * stamp is half-open: a count without its clock must not latch it open.
 */
export function estadoDoDisjuntor(
  disjuntor: DisjuntorFeed,
  agoraMs: number,
): EstadoDoDisjuntorFeed {
  exigirMs('agoraMs', agoraMs);
  if (disjuntor.falhasSeguidas < MAX_FALHAS_SEGUIDAS_FEED) return ESTADO_DO_DISJUNTOR.fechado;
  const ultima = disjuntor.ultimaFalhaEmMs;
  if (ultima === null || agoraMs >= ultima + ESPERA_SONDA_DISJUNTOR_MS) {
    return ESTADO_DO_DISJUNTOR.sonda;
  }
  return ESTADO_DO_DISJUNTOR.aberto;
}

/* ------------------------------ the turned-away batch ------------------------- */

/** The three batch classes the routing tells apart (module header). */
export const CLASSE_DO_LOTE = {
  blocos: 'blocos',
  janelaDoTick: 'janela-tick',
  janelaDaRecuperacao: 'janela-recuperacao',
} as const;
export type ClasseDoLoteFeed = (typeof CLASSE_DO_LOTE)[keyof typeof CLASSE_DO_LOTE];

/**
 * A batch's class: a block batch; a window batch WITHOUT a commit filter
 * (tick-born); one WITH it (recovery-born).
 */
export function classeDoLote(lote: LoteFeedAmazon): ClasseDoLoteFeed {
  if (lote.tipo === TIPO_LOTE_FEED_AMAZON.blocos) return CLASSE_DO_LOTE.blocos;
  return lote.commitAposMs === null
    ? CLASSE_DO_LOTE.janelaDoTick
    : CLASSE_DO_LOTE.janelaDaRecuperacao;
}

/** What a batch does about the lease. */
export const DESTINO_DO_LOTE = {
  tomar: 'tomar',
  registrarPendente: 'registrar-pendente',
  repassarParaPatches: 'repassar-para-patches',
  aguardar: 'aguardar',
  loteExpirado: 'lote-expirado',
} as const;

/** Why a window batch went per SKU: the holder's classification, the breaker, or its own wait. */
export const MOTIVO_REPASSE_LOTE = {
  ocupadaLenta: TOMADA_DA_VEZ.ocupadaLenta,
  incertaAguardar: TOMADA_DA_VEZ.incertaAguardar,
  ocupadaVencida: TOMADA_DA_VEZ.ocupadaVencida,
  adotarResultado: TOMADA_DA_VEZ.adotarResultado,
  incertaRecuperar: TOMADA_DA_VEZ.incertaRecuperar,
  disjuntor: 'disjuntor',
  esperaEsgotada: 'espera-esgotada',
} as const;
export type MotivoRepasseLote = (typeof MOTIVO_REPASSE_LOTE)[keyof typeof MOTIVO_REPASSE_LOTE];

export type DestinoDoLoteFeed =
  | {
      readonly tipo: typeof DESTINO_DO_LOTE.tomar;
      /** The breaker was not closed: this take probes it. */
      readonly sonda: boolean;
    }
  | { readonly tipo: typeof DESTINO_DO_LOTE.registrarPendente }
  | {
      readonly tipo: typeof DESTINO_DO_LOTE.repassarParaPatches;
      readonly motivo: MotivoRepasseLote;
    }
  | {
      readonly tipo: typeof DESTINO_DO_LOTE.aguardar;
      /** Whole seconds before the same payload is re-enqueued, UNNAMED. */
      readonly atrasoS: number;
    }
  | { readonly tipo: typeof DESTINO_DO_LOTE.loteExpirado };

function repassar(motivo: MotivoRepasseLote): DestinoDoLoteFeed {
  return { tipo: DESTINO_DO_LOTE.repassarParaPatches, motivo };
}

/**
 * A block or recovery-born batch behind a held lease: re-enqueued every
 * {@link ESPERA_LOTE_EM_VEZ_S} while `agoraMs < esperaAteMs`; then a block
 * batch expires (the next daily run re-walks) and a recovery-born one goes
 * per SKU (its forced SKUs are recorded nowhere else).
 */
function esperarPelaVez(lote: LoteFeedAmazon, agoraMs: number): DestinoDoLoteFeed {
  // A recovery-born batch always carries its bound (the payload pairs it with
  // the commit filter); one without it has no wait left.
  const esperaAteMs = lote.esperaAteMs ?? 0;
  if (agoraMs < esperaAteMs)
    return { tipo: DESTINO_DO_LOTE.aguardar, atrasoS: ESPERA_LOTE_EM_VEZ_S };
  return lote.tipo === TIPO_LOTE_FEED_AMAZON.blocos
    ? { tipo: DESTINO_DO_LOTE.loteExpirado }
    : repassar(MOTIVO_REPASSE_LOTE.esperaEsgotada);
}

/**
 * What the batch `lote` does about a lease ANOTHER run's classification
 * `tomada` describes, at `agoraMs`, under `disjuntor` (the module header's
 * table).
 *
 * @throws {RangeError} a classification of the run's OWN lease (never a
 *   turned-away batch), or a clock that is not a ms instant.
 */
export function destinoDoLoteRecusado(
  tomada: TomadaDaVezFeed,
  lote: LoteFeedAmazon,
  disjuntor: DisjuntorFeed,
  agoraMs: number,
): DestinoDoLoteFeed {
  exigirMs('agoraMs', agoraMs);
  const classe = classeDoLote(lote);
  const janela = classe !== CLASSE_DO_LOTE.blocos;
  switch (tomada.tipo) {
    case TOMADA_DA_VEZ.retomar:
    case TOMADA_DA_VEZ.garantirIncerto:
    case TOMADA_DA_VEZ.retomarConsulta:
      throw new RangeError('vezFeed.ts: a vez do próprio run não recusa o lote');
    case TOMADA_DA_VEZ.tomar: {
      const estado = estadoDoDisjuntor(disjuntor, agoraMs);
      if (janela && estado === ESTADO_DO_DISJUNTOR.aberto) {
        return repassar(MOTIVO_REPASSE_LOTE.disjuntor);
      }
      return { tipo: DESTINO_DO_LOTE.tomar, sonda: estado !== ESTADO_DO_DISJUNTOR.fechado };
    }
    case TOMADA_DA_VEZ.aguardarEspaco:
      if (janela && estadoDoDisjuntor(disjuntor, agoraMs) === ESTADO_DO_DISJUNTOR.aberto) {
        return repassar(MOTIVO_REPASSE_LOTE.disjuntor);
      }
      return { tipo: DESTINO_DO_LOTE.aguardar, atrasoS: tomada.restanteS };
    case TOMADA_DA_VEZ.ocupada:
      if (classe === CLASSE_DO_LOTE.janelaDoTick)
        return { tipo: DESTINO_DO_LOTE.registrarPendente };
      return esperarPelaVez(lote, agoraMs);
    case TOMADA_DA_VEZ.ocupadaLenta:
    case TOMADA_DA_VEZ.incertaAguardar:
    case TOMADA_DA_VEZ.ocupadaVencida:
    case TOMADA_DA_VEZ.adotarResultado:
      return janela ? repassar(tomada.tipo) : esperarPelaVez(lote, agoraMs);
    case TOMADA_DA_VEZ.incertaRecuperar:
      if (classe === CLASSE_DO_LOTE.janelaDoTick)
        return { tipo: DESTINO_DO_LOTE.registrarPendente };
      return janela ? repassar(tomada.tipo) : esperarPelaVez(lote, agoraMs);
  }
}

/* ------------------------------- the writes ----------------------------------- */

/** Why a builder wrote nothing. */
export const RECUSA_DA_VEZ = {
  /** No holder: the lease is free (or has no document). */
  livre: 'livre',
  /** Another holder: another `execucaoId`, or another `feedId`. */
  outroDono: 'outro-dono',
  /** This holder, but not in the state the write starts from. */
  outroEstado: 'outro-estado',
  /** The write's own clock has not come yet. */
  cedoDemais: 'cedo-demais',
  /** The batch's route is not this write's. */
  outraRota: 'outra-rota',
} as const;
export type MotivoRecusaDaVez = (typeof RECUSA_DA_VEZ)[keyof typeof RECUSA_DA_VEZ];

/** The exact fields one lease write sets (the rest are kept). */
export type PatchVezFeed = Readonly<Partial<VezFeedAmazon>>;

export interface RecusaDaVez {
  readonly tipo: 'recusado';
  readonly motivo: MotivoRecusaDaVez;
}

export interface AtualizacaoDaVez {
  readonly tipo: 'atualizar';
  readonly escrever: PatchVezFeed;
}

/** A write that may CONSUME the pending start: the start it read, and the one a `vez` recovery must carry. */
export interface ConsumoDaVez extends AtualizacaoDaVez {
  /** The start this write's READ held (never the write's own result). */
  readonly pendenteDesdeMs: number | null;
  /** The start to hand to a named `vez` recovery BEFORE the write; `null` when none. */
  readonly vezPara: number | null;
}

function recusa(motivo: MotivoRecusaDaVez): RecusaDaVez {
  return { tipo: 'recusado', motivo };
}

/** The holder check of a write keyed by `execucaoId`: the lease when it passes. */
function conferirExecutor(
  armazenada: VezFeedAmazon | null,
  execucaoId: string,
): { readonly vez: VezFeedAmazon } | RecusaDaVez {
  exigirId(ID_LOTE_FEED_AMAZON_REGEX, 'execucaoId', execucaoId);
  if (armazenada === null || faseDaVez(armazenada) === ESTADO_VEZ_FEED_AMAZON.livre) {
    return recusa(RECUSA_DA_VEZ.livre);
  }
  return armazenada.execucaoId === execucaoId
    ? { vez: armazenada }
    : recusa(RECUSA_DA_VEZ.outroDono);
}

/** Whether the lease is exactly `enviando` with no `feedId`: the shape `marcarEnviando` writes. */
function ehEnviandoSemFeed(vez: VezFeedAmazon): boolean {
  return vez.estado === ESTADO_VEZ_FEED_AMAZON.enviando && vez.feedId === null;
}

/** A window batch's own window as the lease stores it; `null` for a block batch. */
function janelaDoLote(lote: LoteFeedAmazon): JanelaFeedAmazon | null {
  if (lote.tipo === TIPO_LOTE_FEED_AMAZON.blocos) return null;
  return {
    desdeMs: lote.desdeMs,
    ateMs: lote.ateMs,
    manterDesdeMs: lote.manterDesdeMs,
    commitAposMs: lote.commitAposMs,
    depositoId: lote.depositoId,
  };
}

/** The in-flight fields a free lease carries: all cleared. */
const SEM_ENVIO = {
  feedId: null,
  snapshotEmMs: null,
  antesDoEnvioMs: null,
  mensagens: null,
  bytes: null,
} as const;

/**
 * `livre → montando` (or a document's creation, or the take of another run's
 * expired `montando`): ONLY when the batch's route is `tomar`. The patch sets
 * the in-flight fields and NEVER the five that outlive each feed
 * (`pendenteDesdeMs`, `falhasSeguidas`, `ultimaFalhaEmMs`, `ultimoEnvioMs`,
 * `ultimoFeedConcluidoEmMs`), so the take keeps them; a new document starts
 * them empty.
 */
export function tomarVez(
  armazenada: VezFeedAmazon | null,
  agoraMs: number,
  tarefa: TarefaEnviarFeedAmazon,
): { readonly tipo: 'criar'; readonly documento: VezFeedAmazon } | AtualizacaoDaVez | RecusaDaVez {
  const tomada = decidirTomadaDaVez(armazenada, agoraMs, tarefa.execucaoId);
  if (ehTomadaPropria(tomada)) return recusa(RECUSA_DA_VEZ.outraRota);
  const destino = destinoDoLoteRecusado(tomada, tarefa.lote, disjuntorDaVez(armazenada), agoraMs);
  if (destino.tipo !== DESTINO_DO_LOTE.tomar) return recusa(RECUSA_DA_VEZ.outraRota);
  const emCurso = {
    estado: ESTADO_VEZ_FEED_AMAZON.montando,
    execucaoId: tarefa.execucaoId,
    ...SEM_ENVIO,
    ateMs: agoraMs + VALIDADE_VEZ_MS,
    atualizadoEmMs: agoraMs,
    origem: tarefa.origem,
    tipoLote: tarefa.lote.tipo,
    janela: janelaDoLote(tarefa.lote),
  };
  if (armazenada === null) {
    return {
      tipo: 'criar',
      documento: {
        ...emCurso,
        pendenteDesdeMs: null,
        falhasSeguidas: 0,
        ultimaFalhaEmMs: null,
        ultimoEnvioMs: null,
        ultimoFeedConcluidoEmMs: null,
      },
    };
  }
  return { tipo: 'atualizar', escrever: emCurso };
}

/** The stored pending start MIN-merged with a turned-away batch's `desdeMs`. */
export function mesclarPendente(armazenado: number | null, desdeMs: number): number {
  exigirMs('desdeMs', desdeMs);
  return armazenado === null ? desdeMs : Math.min(armazenado, desdeMs);
}

/**
 * A turned-away TICK-born window batch records its start: ONLY when its route
 * is `registrar-pendente`. MIN-merged, never overwritten; `nada` when the
 * stored start already covers it (nothing to write).
 */
export function registrarPendenteVez(
  armazenada: VezFeedAmazon | null,
  agoraMs: number,
  tarefa: TarefaEnviarFeedAmazon,
):
  | (AtualizacaoDaVez & { readonly pendenteDesdeMs: number })
  | { readonly tipo: 'nada'; readonly pendenteDesdeMs: number }
  | RecusaDaVez {
  const tomada = decidirTomadaDaVez(armazenada, agoraMs, tarefa.execucaoId);
  if (armazenada === null || ehTomadaPropria(tomada)) return recusa(RECUSA_DA_VEZ.outraRota);
  const destino = destinoDoLoteRecusado(tomada, tarefa.lote, disjuntorDaVez(armazenada), agoraMs);
  const lote = tarefa.lote;
  if (
    destino.tipo !== DESTINO_DO_LOTE.registrarPendente ||
    lote.tipo !== TIPO_LOTE_FEED_AMAZON.janela
  ) {
    return recusa(RECUSA_DA_VEZ.outraRota);
  }
  const pendenteDesdeMs = mesclarPendente(armazenada.pendenteDesdeMs, lote.desdeMs);
  if (pendenteDesdeMs === armazenada.pendenteDesdeMs) return { tipo: 'nada', pendenteDesdeMs };
  return {
    tipo: 'atualizar',
    escrever: { pendenteDesdeMs, atualizadoEmMs: agoraMs },
    pendenteDesdeMs,
  };
}

/** What `marcarEnviando` stamps: the batch's snapshot, our clock before `createFeed`, the document's size. */
export interface EnvioDaVez {
  readonly snapshotEmMs: number;
  readonly antesDoEnvioMs: number;
  readonly mensagens: number;
  readonly bytes: number;
}

/**
 * `montando → enviando` for the holder `execucaoId`, and the refresh re-entry
 * `enviando → enviando` of the SAME run (still no `feedId`: a forced refresh
 * re-runs the whole submission and re-stamps `antesDoEnvioMs`). Refused for
 * another run. Also stamps `ultimoEnvioMs = antesDoEnvioMs`, the submission
 * floor's clock.
 *
 * The re-entry is keyed on the ATTEMPT, not only on the run: every copy of one
 * payload carries the same `execucaoId`, and a copy must never submit over a
 * feed another copy may have submitted. `antesDoEnvioAnteriorMs` is the stamp
 * THIS dispatch's previous `marcarEnviando` wrote (`null` on its first call):
 * the take from `montando` needs `null`; the re-entry needs the stored stamp
 * to be exactly that one AND the lease still live. So a copy that never
 * stamped, or any call after the uncertain outcome expired the lease in
 * place, writes nothing (and never reaches `createFeed`). The re-entry always
 * runs inside the dispatch that stamped, well within {@link VALIDADE_VEZ_MS}.
 */
export function marcarEnviandoVez(
  armazenada: VezFeedAmazon | null,
  agoraMs: number,
  execucaoId: string,
  envio: EnvioDaVez,
  antesDoEnvioAnteriorMs: number | null,
): AtualizacaoDaVez | RecusaDaVez {
  exigirMs('agoraMs', agoraMs);
  exigirMs('snapshotEmMs', envio.snapshotEmMs);
  exigirMs('antesDoEnvioMs', envio.antesDoEnvioMs);
  exigirPositivo('mensagens', envio.mensagens);
  exigirPositivo('bytes', envio.bytes);
  if (antesDoEnvioAnteriorMs !== null) exigirMs('antesDoEnvioAnteriorMs', antesDoEnvioAnteriorMs);
  const conferida = conferirExecutor(armazenada, execucaoId);
  if ('motivo' in conferida) return conferida;
  const { vez } = conferida;
  const tomada =
    vez.estado === ESTADO_VEZ_FEED_AMAZON.montando &&
    vez.feedId === null &&
    antesDoEnvioAnteriorMs === null;
  const reentrada =
    ehEnviandoSemFeed(vez) &&
    antesDoEnvioAnteriorMs !== null &&
    vez.antesDoEnvioMs === antesDoEnvioAnteriorMs &&
    agoraMs < vez.ateMs;
  if (!tomada && !reentrada) return recusa(RECUSA_DA_VEZ.outroEstado);
  return {
    tipo: 'atualizar',
    escrever: {
      estado: ESTADO_VEZ_FEED_AMAZON.enviando,
      snapshotEmMs: envio.snapshotEmMs,
      antesDoEnvioMs: envio.antesDoEnvioMs,
      mensagens: envio.mensagens,
      bytes: envio.bytes,
      ateMs: agoraMs + VALIDADE_VEZ_MS,
      atualizadoEmMs: agoraMs,
      ultimoEnvioMs: envio.antesDoEnvioMs,
    },
  };
}

/**
 * `enviando → enviado` for the holder `execucaoId`, naming the `feedId` Amazon
 * returned; the lease then holds until `antesDoEnvioMs` +
 * {@link VALIDADE_VEZ_ENVIADO_MS}.
 */
export function marcarEnviadoVez(
  armazenada: VezFeedAmazon | null,
  agoraMs: number,
  execucaoId: string,
  feedId: string,
): AtualizacaoDaVez | RecusaDaVez {
  exigirMs('agoraMs', agoraMs);
  exigirId(FEED_ID_REGISTRO_AMAZON_REGEX, 'feedId', feedId);
  const conferida = conferirExecutor(armazenada, execucaoId);
  if ('motivo' in conferida) return conferida;
  const { vez } = conferida;
  const antes = vez.antesDoEnvioMs;
  if (!ehEnviandoSemFeed(vez) || antes === null) return recusa(RECUSA_DA_VEZ.outroEstado);
  return {
    tipo: 'atualizar',
    escrever: {
      estado: ESTADO_VEZ_FEED_AMAZON.enviado,
      feedId,
      ateMs: antes + VALIDADE_VEZ_ENVIADO_MS,
      atualizadoEmMs: agoraMs,
    },
  };
}

/**
 * The uncertain outcome (a `createFeed` whose answer was lost): the holder's
 * `enviando` lease EXPIRED IN PLACE (`ateMs = agora`, still `enviando`, still
 * no `feedId`: the uncertain path's key), so every other run reads
 * `incerta-aguardar` at once, and the pending start consumed (`vezPara`).
 */
export function expirarIncertoVez(
  armazenada: VezFeedAmazon | null,
  agoraMs: number,
  execucaoId: string,
): ConsumoDaVez | RecusaDaVez {
  exigirMs('agoraMs', agoraMs);
  const conferida = conferirExecutor(armazenada, execucaoId);
  if ('motivo' in conferida) return conferida;
  const { vez } = conferida;
  if (!ehEnviandoSemFeed(vez)) return recusa(RECUSA_DA_VEZ.outroEstado);
  return {
    tipo: 'atualizar',
    escrever: { ateMs: agoraMs, atualizadoEmMs: agoraMs, pendenteDesdeMs: null },
    pendenteDesdeMs: vez.pendenteDesdeMs,
    vezPara: vez.pendenteDesdeMs,
  };
}

/**
 * `enviando → montando` for the holder `execucaoId` after a 429 (`createFeed`
 * did not process it): the submission's fields cleared, `ultimoEnvioMs` kept
 * (the re-enqueue waits the floor). The release follows as `limitado`.
 */
export function voltarParaMontandoVez(
  armazenada: VezFeedAmazon | null,
  agoraMs: number,
  execucaoId: string,
): AtualizacaoDaVez | RecusaDaVez {
  exigirMs('agoraMs', agoraMs);
  const conferida = conferirExecutor(armazenada, execucaoId);
  if ('motivo' in conferida) return conferida;
  if (!ehEnviandoSemFeed(conferida.vez)) return recusa(RECUSA_DA_VEZ.outroEstado);
  return {
    tipo: 'atualizar',
    escrever: {
      estado: ESTADO_VEZ_FEED_AMAZON.montando,
      ...SEM_ENVIO,
      ateMs: agoraMs + VALIDADE_VEZ_MS,
      atualizadoEmMs: agoraMs,
    },
  };
}

/* ------------------------------- the releases --------------------------------- */

/**
 * Every release kind, CLOSED: the five feed outcomes, the three build aborts,
 * and the send side's own ends.
 */
export const LIBERACAO_VEZ_FEED = {
  ...DESFECHO_FEED_AMAZON,
  ...MOTIVO_ABORTO_LOTE,
  /** `createFeed` refused for good: a non-auth 4xx, or a 401/403 after the refresh. */
  recusaDefinitiva: 'recusa-definitiva',
  /** The document or its upload failed deterministically: nothing submitted. */
  documentoFalhou: 'documento-falhou',
  /** The document or its upload failed transiently: nothing submitted, the queue retries. */
  documentoTransitorio: 'documento-transitorio',
  /** The valve was `on` but nothing differed: zero messages. */
  semEscrita: 'sem-escrita',
  /** `dry-run`: built and logged, never posted. */
  simulado: 'simulado',
  /** The valve was `off`. */
  desligado: 'desligado',
  /** A canary list: the members went per SKU. */
  soPatches: 'so-patches',
  /** `createFeed` answered 429: not processed. */
  limitado: 'limitado',
} as const;
export type LiberacaoVezFeed = (typeof LIBERACAO_VEZ_FEED)[keyof typeof LIBERACAO_VEZ_FEED];

/** What a release does to the consecutive-failure count. */
export const EFEITO_NAS_FALHAS = {
  zerar: 'zerar',
  somar: 'somar',
  manter: 'manter',
} as const;
export type EfeitoNasFalhasFeed = (typeof EFEITO_NAS_FALHAS)[keyof typeof EFEITO_NAS_FALHAS];

/** A phase a release can start from: every phase but `livre`. */
export type FaseEmCursoVezFeed = Exclude<EstadoVezFeedAmazon, typeof ESTADO_VEZ_FEED_AMAZON.livre>;

export interface RegraDaLiberacaoFeed {
  /** The phases the lease may be in, held by the releaser. */
  readonly fases: readonly FaseEmCursoVezFeed[];
  readonly falhas: EfeitoNasFalhasFeed;
  /** A feed that may have applied ended: stamps `ultimoFeedConcluidoEmMs`. */
  readonly feedPodeTerAplicado: boolean;
}

const { montando: MONTANDO, enviando: ENVIANDO, enviado: ENVIADO } = ESTADO_VEZ_FEED_AMAZON;
const { zerar: ZERAR, somar: SOMAR, manter: MANTER } = EFEITO_NAS_FALHAS;

/**
 * The release table, TOTAL over {@link LiberacaoVezFeed} (module header): `+1`
 * for exactly the releases that raise the fluxo's feed-failure aviso. The two
 * document kinds also start from `enviando`: a 401/403 on `createFeed` (not
 * processed) re-runs the whole submission under the lease the first
 * `marcarEnviando` already wrote, so a document or upload failure of that
 * re-run is still a release with nothing submitted — by that attempt alone
 * ({@link decidirLiberacao}).
 */
export const REGRA_DA_LIBERACAO: Readonly<Record<LiberacaoVezFeed, RegraDaLiberacaoFeed>> = {
  [LIBERACAO_VEZ_FEED.concluido]: { fases: [ENVIADO], falhas: ZERAR, feedPodeTerAplicado: true },
  [LIBERACAO_VEZ_FEED.falhou]: { fases: [ENVIADO], falhas: SOMAR, feedPodeTerAplicado: true },
  [LIBERACAO_VEZ_FEED.cancelado]: { fases: [ENVIADO], falhas: SOMAR, feedPodeTerAplicado: false },
  [LIBERACAO_VEZ_FEED.abandonado]: { fases: [ENVIADO], falhas: SOMAR, feedPodeTerAplicado: true },
  [LIBERACAO_VEZ_FEED.incerto]: { fases: [ENVIANDO], falhas: SOMAR, feedPodeTerAplicado: true },
  [LIBERACAO_VEZ_FEED.recusaDefinitiva]: {
    fases: [ENVIANDO],
    falhas: SOMAR,
    feedPodeTerAplicado: false,
  },
  [LIBERACAO_VEZ_FEED.documentoFalhou]: {
    fases: [MONTANDO, ENVIANDO],
    falhas: SOMAR,
    feedPodeTerAplicado: false,
  },
  [LIBERACAO_VEZ_FEED.documentoTransitorio]: {
    fases: [MONTANDO, ENVIANDO],
    falhas: MANTER,
    feedPodeTerAplicado: false,
  },
  [LIBERACAO_VEZ_FEED.snapshotLento]: {
    fases: [MONTANDO],
    falhas: SOMAR,
    feedPodeTerAplicado: false,
  },
  [LIBERACAO_VEZ_FEED.depositoMudou]: {
    fases: [MONTANDO],
    falhas: MANTER,
    feedPodeTerAplicado: false,
  },
  [LIBERACAO_VEZ_FEED.janelaGrande]: {
    fases: [MONTANDO],
    falhas: MANTER,
    feedPodeTerAplicado: false,
  },
  [LIBERACAO_VEZ_FEED.semEscrita]: {
    fases: [MONTANDO],
    falhas: MANTER,
    feedPodeTerAplicado: false,
  },
  [LIBERACAO_VEZ_FEED.simulado]: { fases: [MONTANDO], falhas: MANTER, feedPodeTerAplicado: false },
  [LIBERACAO_VEZ_FEED.desligado]: { fases: [MONTANDO], falhas: MANTER, feedPodeTerAplicado: false },
  [LIBERACAO_VEZ_FEED.soPatches]: { fases: [MONTANDO], falhas: MANTER, feedPodeTerAplicado: false },
  [LIBERACAO_VEZ_FEED.limitado]: { fases: [MONTANDO], falhas: MANTER, feedPodeTerAplicado: false },
};

/** The releaser: the run while `montando`/`enviando`, the feed once it is known. */
export type DonoDaVezFeed = { readonly execucaoId: string } | { readonly feedId: string };

/** A release's answer: the patch and the counts it sets, plus the start it consumed. */
export interface LiberacaoDaVez extends ConsumoDaVez {
  readonly falhasSeguidas: number;
  readonly ultimaFalhaEmMs: number | null;
}

/** The start a consuming write must hand to a `vez` recovery: the read's, unless already folded. */
function vezPara(lido: number | null, dobrado: number | null): number | null {
  if (lido === null) return null;
  return dobrado === null || lido < dobrado ? lido : null;
}

/**
 * A release of the lease by `dono`, of kind `liberacao`, at `agoraMs`
 * (module header). Holder-checked: a lease in another phase, or held by
 * another `execucaoId`/`feedId`, writes nothing. An `incerto` release waits
 * the feed's 12-h deadline. A document kind from `enviando` needs the lease
 * live AND the ATTEMPT that stamped it: `antesDoEnvioAnteriorMs` is the stamp
 * THIS dispatch's own `marcarEnviando` wrote (absent or `null` when it never
 * stamped), and it must equal the stored one — every copy of a payload shares
 * the run's `execucaoId`, and a copy whose own document failed before it ever
 * stamped must never free a lease another copy is submitting under (the same
 * key as {@link marcarEnviandoVez}'s re-entry).
 *
 * The answer's `pendenteDesdeMs` is the start the READ held; `vezPara` is the
 * start the caller hands to the named `vez` recovery BEFORE the write:
 * the read's start, unless `pendenteDobrado` (the start the caller already
 * folded into its own recovery: the tail, the uncertain path; else `null`)
 * covers it — a start found SMALLER than the folded one (a batch turned away
 * after the fold's read) still needs its own.
 *
 * @throws {RangeError} a `dono` keyed for another phase than the kind's, an
 *   unknown kind, or a clock that is not a ms instant.
 */
export function decidirLiberacao(
  armazenada: VezFeedAmazon | null,
  dono: DonoDaVezFeed,
  liberacao: LiberacaoVezFeed,
  opcoes: {
    readonly agoraMs: number;
    readonly pendenteDobrado: number | null;
    readonly antesDoEnvioAnteriorMs?: number | null;
  },
): LiberacaoDaVez | RecusaDaVez {
  const { agoraMs, pendenteDobrado } = opcoes;
  const antesDoEnvioAnteriorMs = opcoes.antesDoEnvioAnteriorMs ?? null;
  exigirMs('agoraMs', agoraMs);
  if (pendenteDobrado !== null) exigirMs('pendenteDobrado', pendenteDobrado);
  if (antesDoEnvioAnteriorMs !== null) exigirMs('antesDoEnvioAnteriorMs', antesDoEnvioAnteriorMs);
  if (!Object.hasOwn(REGRA_DA_LIBERACAO, liberacao)) {
    throw new RangeError('vezFeed.ts: liberação fora do conjunto fechado');
  }
  const regra = REGRA_DA_LIBERACAO[liberacao];
  const porFeed = 'feedId' in dono;
  if (porFeed !== regra.fases.includes(ENVIADO)) {
    throw new RangeError('vezFeed.ts: o dono desta liberação é a chave errada');
  }
  if (porFeed) exigirId(FEED_ID_REGISTRO_AMAZON_REGEX, 'feedId', dono.feedId);
  else exigirId(ID_LOTE_FEED_AMAZON_REGEX, 'execucaoId', dono.execucaoId);

  if (armazenada === null) return recusa(RECUSA_DA_VEZ.livre);
  const fase = faseDaVez(armazenada);
  if (fase === ESTADO_VEZ_FEED_AMAZON.livre) return recusa(RECUSA_DA_VEZ.livre);
  const doDono = porFeed
    ? armazenada.feedId === dono.feedId
    : armazenada.execucaoId === dono.execucaoId;
  if (!doDono) return recusa(RECUSA_DA_VEZ.outroDono);
  if (!regra.fases.includes(fase)) return recusa(RECUSA_DA_VEZ.outroEstado);
  // A document kind from `enviando` is the refresh re-run's own failure, inside
  // the dispatch that stamped the lease: only for THAT attempt's stamp, and
  // only while the lease is LIVE. An expired `enviando` is the uncertain
  // outcome's, released only by `incerto`.
  if (
    fase === ENVIANDO &&
    regra.fases.includes(MONTANDO) &&
    (antesDoEnvioAnteriorMs === null ||
      armazenada.antesDoEnvioMs !== antesDoEnvioAnteriorMs ||
      agoraMs >= armazenada.ateMs)
  ) {
    return recusa(RECUSA_DA_VEZ.outroEstado);
  }
  if (liberacao === LIBERACAO_VEZ_FEED.incerto) {
    const antes = armazenada.antesDoEnvioMs;
    if (antes === null || agoraMs < prazoDoFeed(antes)) return recusa(RECUSA_DA_VEZ.cedoDemais);
  }

  let falhasSeguidas = armazenada.falhasSeguidas;
  let ultimaFalhaEmMs = armazenada.ultimaFalhaEmMs;
  let contagem: PatchVezFeed = {};
  switch (regra.falhas) {
    case ZERAR:
      falhasSeguidas = 0;
      contagem = { falhasSeguidas };
      break;
    case SOMAR:
      falhasSeguidas = armazenada.falhasSeguidas + 1;
      ultimaFalhaEmMs = agoraMs;
      contagem = { falhasSeguidas, ultimaFalhaEmMs };
      break;
    case MANTER:
      break;
  }
  const pendenteDesdeMs = armazenada.pendenteDesdeMs;
  return {
    tipo: 'atualizar',
    escrever: {
      estado: ESTADO_VEZ_FEED_AMAZON.livre,
      ...SEM_ENVIO,
      origem: null,
      tipoLote: null,
      janela: null,
      ateMs: agoraMs,
      atualizadoEmMs: agoraMs,
      pendenteDesdeMs: null,
      ...contagem,
      ...(regra.feedPodeTerAplicado ? { ultimoFeedConcluidoEmMs: agoraMs } : {}),
    },
    pendenteDesdeMs,
    vezPara: vezPara(pendenteDesdeMs, pendenteDobrado),
    falhasSeguidas,
    ultimaFalhaEmMs,
  };
}

/* --------------------------- consuming without a release ---------------------- */

/** Who consumes the pending start WITHOUT releasing the lease. */
export const CONSUMO_DO_PENDENTE = {
  /**
   * A result rung of the holder's feed at or past `antesDoEnvioMs` +
   * {@link ESPERA_MAXIMA_ATRAS_DE_FEED_MS} (the slow-holder rung, and the 12-h
   * deadline rung after it): the lease stays `enviado`.
   */
  rodada: 'rodada',
  /** The check of another run's EXPIRED `montando` (a holder that died building releases nothing). */
  montandoVencida: 'montando-vencida',
  /** A window batch handed to patches that found a start a holder left behind. */
  repasse: 'repasse',
} as const;

export type ConsumidorDoPendenteFeed =
  | { readonly tipo: typeof CONSUMO_DO_PENDENTE.rodada; readonly feedId: string }
  | { readonly tipo: typeof CONSUMO_DO_PENDENTE.montandoVencida }
  | { readonly tipo: typeof CONSUMO_DO_PENDENTE.repasse };

/**
 * The pending start consumed by a write that does not release the lease
 * (module header): `{ pendenteDesdeMs: null }` with `vezPara` = the read's
 * start, or `nada` when the read holds none. A rung must be the known feed's
 * and past the slow-holder bound; the `montando` check needs an expired
 * `montando`; a repasse takes whatever start the read shows.
 */
export function consumirPendenteVez(
  armazenada: VezFeedAmazon | null,
  consumidor: ConsumidorDoPendenteFeed,
  agoraMs: number,
): ConsumoDaVez | { readonly tipo: 'nada' } | RecusaDaVez {
  exigirMs('agoraMs', agoraMs);
  switch (consumidor.tipo) {
    case CONSUMO_DO_PENDENTE.rodada: {
      exigirId(FEED_ID_REGISTRO_AMAZON_REGEX, 'feedId', consumidor.feedId);
      if (armazenada === null || faseDaVez(armazenada) === ESTADO_VEZ_FEED_AMAZON.livre) {
        return recusa(RECUSA_DA_VEZ.livre);
      }
      if (armazenada.feedId !== consumidor.feedId) return recusa(RECUSA_DA_VEZ.outroDono);
      const antes = armazenada.antesDoEnvioMs;
      if (antes === null || agoraMs < antes + ESPERA_MAXIMA_ATRAS_DE_FEED_MS) {
        return recusa(RECUSA_DA_VEZ.cedoDemais);
      }
      break;
    }
    case CONSUMO_DO_PENDENTE.montandoVencida:
      if (armazenada === null || faseDaVez(armazenada) === ESTADO_VEZ_FEED_AMAZON.livre) {
        return recusa(RECUSA_DA_VEZ.livre);
      }
      if (faseDaVez(armazenada) !== ESTADO_VEZ_FEED_AMAZON.montando) {
        return recusa(RECUSA_DA_VEZ.outroEstado);
      }
      if (agoraMs < armazenada.ateMs) return recusa(RECUSA_DA_VEZ.cedoDemais);
      break;
    case CONSUMO_DO_PENDENTE.repasse:
      if (armazenada === null) return { tipo: 'nada' };
      break;
  }
  const pendenteDesdeMs = armazenada.pendenteDesdeMs;
  if (pendenteDesdeMs === null) return { tipo: 'nada' };
  return {
    tipo: 'atualizar',
    escrever: { pendenteDesdeMs: null, atualizadoEmMs: agoraMs },
    pendenteDesdeMs,
    vezPara: pendenteDesdeMs,
  };
}
