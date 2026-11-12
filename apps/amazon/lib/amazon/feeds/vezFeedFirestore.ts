/**
 * The feed LEASE's I/O (step 12a, PR 12-c): every read and write of
 * `feedsAmazonEmCurso/{fluxo}-{contaId}`, through `vezFeedAmazonCollection`.
 * Every decision is the pure state machine's (`./vezFeed`); this module only
 * reads, hands the read to it, and writes the exact patch it answered.
 *
 * ## Root rule 7: tier 1, and nothing else
 *
 * Each operation is ONE read-decide-write loop:
 *
 *  1. read the lease (`get`: the parsed document, its `updateTime`, the read's
 *     `readTime`);
 *  2. ask the pure decision, with our clock read NOW (never captured across
 *     attempts);
 *  3. write what it answered: `create` (a missing document, the take only), or
 *     `update(patch, { lastUpdateTime })` on THIS attempt's read;
 *  4. FAILED_PRECONDITION (9), NOT_FOUND (5) or ALREADY_EXISTS (6, a lost
 *     `create`) ⇒ back to 1: re-read and RE-DECIDE — the losing patch is never
 *     re-applied. At most {@link MAX_TENTATIVAS_VEZ_FEED} attempts, then
 *     {@link AmazonVezFeedEmConflitoError} (retryable: the queue retries the
 *     dispatch, which resumes its own lease state).
 *
 * A decision that writes nothing (`recusado`: another holder, another state;
 * `nada`: nothing to record) is answered with the read it was made on, and
 * NOTHING is written. No multi-document atomic write is opened here (said
 * without the API's identifier: the inventory guard greps every source file).
 *
 * ## The pending start, consumed before the write
 *
 * Every write that consumes `pendenteDesdeMs` — a release, the uncertain
 * outcome's expiry, a rung past the slow bound, a repasse, the check of a dead
 * `montando` — answers the start its READ held as `vezPara`. When it is
 * non-null, the caller's `enfileirarVez` runs FIRST, with the NAMED `vez`
 * recovery this module derives from the same read
 * ({@link recuperacaoVezFeed}), and only then the write; so a crash between the
 * two re-runs a named enqueue (ALREADY_EXISTS) instead of losing the start, and
 * an enqueue that throws leaves the lease UNTOUCHED. A re-read after a lost
 * precondition that finds a SMALLER start (a batch turned away meanwhile) hands
 * that one to its own `vez`; the start a release's caller already folded into
 * its own recovery (`pendenteDobrado`: the tail, the uncertain path) is not
 * handed again.
 *
 * ## The operations, shaped for the handlers
 *
 *  - {@link lerVezFeed} — the read alone.
 *  - {@link entrarNaVezFeed} — a `feed-enviar`'s E4: its own lease resumed
 *    (`propria`, no write), the lease TAKEN (`tomada`: `livre → montando`, or
 *    the document created), its start RECORDED behind a held lease
 *    (`pendente-registrado`: the MIN-merge, never an overwrite), or the batch
 *    turned away with its route (`recusada`: to patches, a wait, or expired —
 *    no write; the handler acts).
 *  - {@link marcarEnviandoVezFeed} — `montando → enviando` and the refresh
 *    re-entry; the caller's `antesDaEscrita` (the named uncertain-wait
 *    enqueue) runs BEFORE the first write attempt, and only once.
 *  - {@link marcarEnviadoVezFeed}, {@link voltarParaMontandoVezFeed},
 *    {@link expirarIncertoVezFeed} — the other transitions.
 *  - {@link liberarVezFeed} — every release, holder-checked by the pure
 *    `decidirLiberacao` (the run's `execucaoId`, or the feed's `feedId`).
 *  - {@link consumirPendenteVezFeed} — the start consumed without a release.
 *
 * ⚠️ Every stamp is MILLISECONDS (the lease's schema). The `Timestamp`s here
 * are Firestore's own — a read's `readTime` (the send side's aviso clock, as
 * `avisos/avisos.ts` converts it), a write's `writeTime` — never compared with a
 * ms stamp.
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { vezFeedAmazonCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import {
  type FluxoFeedAmazon,
  type VezFeedAmazon,
  idVezFeedAmazon,
  vezFeedAmazonSchema,
} from '@delfrance/schemas';

import {
  DESFECHO_RECUPERACAO_FEED_AMAZON,
  TIPO_TAREFA_LOTE_AMAZON,
  type TarefaEnviarFeedAmazon,
  type TarefaRecuperarFeedAmazon,
  VERSAO_TAREFA_LOTE_AMAZON,
  nomeRecuperacaoFeed,
  referenciaDaRecuperacaoFeed,
  tarefaRecuperarFeedAmazonSchema,
} from './tarefaLote';
import {
  type ConsumidorDoPendenteFeed,
  type ConsumoDaVez,
  DESTINO_DO_LOTE,
  type DestinoDoLoteFeed,
  type DonoDaVezFeed,
  type EnvioDaVez,
  type LiberacaoDaVez,
  type LiberacaoVezFeed,
  type MotivoRecusaDaVez,
  type PatchVezFeed,
  type TOMADA_DA_VEZ,
  type TomadaDaVezFeed,
  consumirPendenteVez,
  decidirLiberacao,
  decidirTomadaDaVez,
  destinoDoLoteRecusado,
  disjuntorDaVez,
  ehTomadaPropria,
  expirarIncertoVez,
  marcarEnviadoVez,
  marcarEnviandoVez,
  registrarPendenteVez,
  tomarVez,
  voltarParaMontandoVez,
} from './vezFeed';

/** Read-decide-write attempts of one operation before giving up. */
export const MAX_TENTATIVAS_VEZ_FEED = 3;

/* ---------------------------------- the errors ---------------------------------- */

/**
 * Every attempt of one lease operation lost its precondition (or its `create`):
 * the lease kept moving under it. Nothing of the losing attempts was written.
 * Retryable: the queue re-runs the dispatch, which re-reads and resumes.
 */
export class AmazonVezFeedEmConflitoError extends Error {
  readonly fluxo: FluxoFeedAmazon;
  readonly contaId: string;
  readonly tentativas: number;

  constructor(alvo: AlvoVezFeed, tentativas: number) {
    super(
      `A vez de feed ${alvo.fluxo} da conta da Amazon ${alvo.contaId} mudou durante as ` +
        `${String(tentativas)} tentativas de gravá-la.`,
    );
    this.name = 'AmazonVezFeedEmConflitoError';
    this.fluxo = alvo.fluxo;
    this.contaId = alvo.contaId;
    this.tentativas = tentativas;
  }
}

/**
 * A stored lease no longer parses: only a hand edit can make one (every write
 * here goes through the schema). Nothing is written until a person fixes it;
 * the message names the broken top-level FIELDS, never a value.
 */
export class AmazonVezFeedInvalidaError extends Error {
  readonly fluxo: FluxoFeedAmazon;
  readonly contaId: string;
  /** The top-level field names Zod blamed. */
  readonly campos: readonly string[];

  constructor(alvo: AlvoVezFeed, campos: readonly string[]) {
    super(
      `A vez de feed ${alvo.fluxo} da conta da Amazon ${alvo.contaId} não é válida ` +
        `(campos: ${campos.join(', ')}).`,
    );
    this.name = 'AmazonVezFeedInvalidaError';
    this.fluxo = alvo.fluxo;
    this.contaId = alvo.contaId;
    this.campos = campos;
  }
}

/* ----------------------------------- the read ----------------------------------- */

/** Whose lease: one per (fluxo, conta). */
export interface AlvoVezFeed {
  readonly fluxo: FluxoFeedAmazon;
  readonly contaId: string;
}

/** One read of the lease. */
export interface LeituraVezFeed {
  /** The parsed lease; `null` when no document exists yet. */
  readonly vez: VezFeedAmazon | null;
  /** The document's `updateTime`: the precondition of a write decided on this read. */
  readonly updateTime: Timestamp | null;
  /** The read's own `readTime`: the send side's aviso clock. */
  readonly readTime: Timestamp;
}

function refDaVez(db: Firestore, alvo: AlvoVezFeed): DocumentReference {
  return vezFeedAmazonCollection.docRef(db, {}, idVezFeedAmazon(alvo.fluxo, alvo.contaId));
}

/** A snapshot, strictly parsed (module header). */
function lerDoSnapshot(snap: DocumentSnapshot, alvo: AlvoVezFeed): LeituraVezFeed {
  if (!snap.exists) return { vez: null, updateTime: null, readTime: snap.readTime };
  const updateTime = snap.updateTime;
  if (updateTime === undefined) {
    throw new TypeError('feedsAmazonEmCurso: documento existente sem updateTime');
  }
  const lido = vezFeedAmazonSchema.safeParse(snap.data());
  if (!lido.success) {
    const campos = new Set(lido.error.issues.map((i) => String(i.path[0] ?? '(raiz)')));
    throw new AmazonVezFeedInvalidaError(alvo, [...campos].sort());
  }
  return { vez: lido.data, updateTime, readTime: snap.readTime };
}

/**
 * The lease as it stands, or `vez: null` when it has no document yet.
 *
 * @throws {AmazonVezFeedInvalidaError} a stored lease that no longer parses.
 */
export async function lerVezFeed(db: Firestore, alvo: AlvoVezFeed): Promise<LeituraVezFeed> {
  return lerDoSnapshot(await refDaVez(db, alvo).get(), alvo);
}

/* ------------------------------ the `vez` recovery ------------------------------ */

/** The NAMED `vez` recovery a consuming write hands to the caller's enqueue. */
export interface RecuperacaoVezFeed {
  readonly tarefa: TarefaRecuperarFeedAmazon;
  /** Its task name: `nomeRecuperacaoFeed` of the payload's own reference and start. */
  readonly nome: string;
}

/** The caller's enqueue of a `vez` recovery (named: `ALREADY_EXISTS` is success). */
export type EnfileirarVezFeed = (recuperacao: RecuperacaoVezFeed) => Promise<void>;

/**
 * The `vez` recovery of the start `pendenteDesdeMs`, released (or consumed) by
 * the lease's HOLDER as `vez` reads it: its reference is the holder's `feedId`
 * when the feed is known, else its run's `execucaoId` — so every attempt of the
 * same consumption derives the SAME name.
 *
 * @throws {RangeError} a lease with no holder run (a hand edit), or a start
 *   outside the ms grammar (the payload refuses it).
 */
export function recuperacaoVezFeed(
  alvo: AlvoVezFeed,
  vez: VezFeedAmazon,
  pendenteDesdeMs: number,
): RecuperacaoVezFeed {
  if (vez.execucaoId === null) {
    throw new RangeError('vezFeedFirestore.ts: a vez não nomeia o run que a segura');
  }
  const tarefa = tarefaRecuperarFeedAmazonSchema.parse({
    v: VERSAO_TAREFA_LOTE_AMAZON,
    tipo: TIPO_TAREFA_LOTE_AMAZON.recuperar,
    fluxo: alvo.fluxo,
    contaId: alvo.contaId,
    desfecho: DESFECHO_RECUPERACAO_FEED_AMAZON.vez,
    feedId: vez.feedId,
    execucaoId: vez.execucaoId,
    snapshotEmMs: null,
    pendenteDesdeMs,
    janela: null,
  });
  return {
    tarefa,
    nome: nomeRecuperacaoFeed(alvo.contaId, referenciaDaRecuperacaoFeed(tarefa), pendenteDesdeMs),
  };
}

/* ------------------------------- the write loop -------------------------------- */

/** What a write sends: a whole new document, or a patch under the read's precondition. */
type EscritaVez =
  | { readonly tipo: 'criar'; readonly documento: VezFeedAmazon }
  | { readonly tipo: 'atualizar'; readonly patch: PatchVezFeed };

/** One attempt's decision. */
type DecisaoVez<R> =
  | {
      readonly tipo: 'escrever';
      readonly escrita: EscritaVez;
      /** Runs BEFORE this attempt's write; a throw leaves the lease untouched. */
      readonly antes?: () => Promise<void>;
      readonly depois: (estado: VezFeedAmazon, writeTime: Timestamp) => R;
    }
  | { readonly tipo: 'parar'; readonly resultado: R };

/** The lease after a write, as this attempt computed it (the read merged with the patch). */
function estadoApos(lida: LeituraVezFeed, escrita: EscritaVez): VezFeedAmazon {
  if (escrita.tipo === 'criar') return escrita.documento;
  if (lida.vez === null) throw new TypeError('vezFeedFirestore.ts: patch sobre uma vez ausente');
  return { ...lida.vez, ...escrita.patch };
}

/** The read-decide-write loop (module header). */
async function comPrecondicao<R>(
  db: Firestore,
  alvo: AlvoVezFeed,
  decidir: (lida: LeituraVezFeed) => DecisaoVez<R>,
): Promise<R> {
  const ref = refDaVez(db, alvo);
  for (let tentativa = 1; tentativa <= MAX_TENTATIVAS_VEZ_FEED; tentativa += 1) {
    const lida = lerDoSnapshot(await ref.get(), alvo);
    const decisao = decidir(lida);
    if (decisao.tipo === 'parar') return decisao.resultado;
    const { escrita } = decisao;
    // The state computed BEFORE any I/O: a pure function of this read.
    const estado = estadoApos(lida, escrita);
    if (decisao.antes !== undefined) await decisao.antes();
    try {
      let writeTime: Timestamp;
      if (escrita.tipo === 'criar') {
        ({ writeTime } = await ref.create(vezFeedAmazonCollection.parse(escrita.documento)));
      } else {
        if (lida.updateTime === null) {
          throw new TypeError('vezFeedFirestore.ts: patch sem a precondição da leitura');
        }
        ({ writeTime } = await ref.update(
          vezFeedAmazonCollection.parseMerge({ ...escrita.patch }) as Record<string, unknown>,
          { lastUpdateTime: lida.updateTime },
        ));
      }
      return decisao.depois(estado, writeTime);
    } catch (err) {
      // Rule 6: only a lost precondition, a document gone since the read, or a
      // lost `create` is re-decided; anything else propagates.
      if (!isFailedPrecondition(err) && !isNotFound(err) && !isAlreadyExists(err)) throw err;
    }
  }
  throw new AmazonVezFeedEmConflitoError(alvo, MAX_TENTATIVAS_VEZ_FEED);
}

/** A write the pure decision refused: nothing written, the read it was made on. */
export interface RecusaVezFeed {
  readonly tipo: 'recusado';
  readonly motivo: MotivoRecusaDaVez;
  readonly lida: LeituraVezFeed;
}

/** A write that landed: the lease as it now stands and the write's own time. */
export interface EscritaVezFeed {
  readonly tipo: 'escrito';
  readonly vez: VezFeedAmazon;
  readonly writeTime: Timestamp;
}

/**
 * The enqueue that must precede a consuming write: the caller's, with the
 * `vez` recovery of the start `vezPara`; `undefined` when there is none.
 */
function vezAntes(
  alvo: AlvoVezFeed,
  vez: VezFeedAmazon | null,
  vezPara: number | null,
  enfileirarVez: EnfileirarVezFeed,
): (() => Promise<void>) | undefined {
  if (vezPara === null) return undefined;
  if (vez === null) throw new TypeError('vezFeedFirestore.ts: um início pendente sem vez');
  const recuperacao = recuperacaoVezFeed(alvo, vez, vezPara);
  return () => enfileirarVez(recuperacao);
}

/* ---------------------------------- the take ----------------------------------- */

/** What a `feed-enviar`'s entry into the lease came to (module header). */
export type EntradaNaVezFeed =
  /** Taken: this run now holds the lease `montando`. */
  | {
      readonly tipo: 'tomada';
      /** The breaker was not closed: this take probes it. */
      readonly sonda: boolean;
      readonly lida: LeituraVezFeed;
      readonly vez: VezFeedAmazon;
      readonly writeTime: Timestamp;
    }
  /** The run's OWN lease: resumed from its state, nothing written. */
  | {
      readonly tipo: 'propria';
      readonly tomada: {
        readonly tipo:
          | typeof TOMADA_DA_VEZ.retomar
          | typeof TOMADA_DA_VEZ.garantirIncerto
          | typeof TOMADA_DA_VEZ.retomarConsulta;
      };
      readonly lida: LeituraVezFeed;
    }
  /** A tick-born window batch behind a held lease: its start recorded (MIN-merged). */
  | {
      readonly tipo: 'pendente-registrado';
      readonly tomada: TomadaDaVezFeed;
      /** The stored start after the merge. */
      readonly pendenteDesdeMs: number;
      /** `false` when the stored start already covered this batch's (nothing written). */
      readonly escrito: boolean;
      readonly lida: LeituraVezFeed;
    }
  /** Turned away with its route; nothing written, the handler acts. */
  | {
      readonly tipo: 'recusada';
      readonly tomada: TomadaDaVezFeed;
      readonly destino: Exclude<
        DestinoDoLoteFeed,
        { readonly tipo: typeof DESTINO_DO_LOTE.tomar | typeof DESTINO_DO_LOTE.registrarPendente }
      >;
      readonly lida: LeituraVezFeed;
    };

/** A builder disagreeing with the classification it shares: a bug, never a route. */
function divergencia(): never {
  throw new TypeError('vezFeedFirestore.ts: o construtor da vez discordou da classificação');
}

/**
 * A `feed-enviar`'s E4 on the lease (module header): classified on a FRESH
 * read with our clock, then taken, recorded behind the holder, resumed, or
 * routed away. Tier 1, ≤ {@link MAX_TENTATIVAS_VEZ_FEED} attempts.
 */
export function entrarNaVezFeed(
  db: Firestore,
  tarefa: TarefaEnviarFeedAmazon,
  opcoes: { readonly agora: () => number },
): Promise<EntradaNaVezFeed> {
  const alvo: AlvoVezFeed = { fluxo: tarefa.fluxo, contaId: tarefa.contaId };
  return comPrecondicao<EntradaNaVezFeed>(db, alvo, (lida) => {
    const agoraMs = opcoes.agora();
    const tomada = decidirTomadaDaVez(lida.vez, agoraMs, tarefa.execucaoId);
    if (ehTomadaPropria(tomada))
      return { tipo: 'parar', resultado: { tipo: 'propria', tomada, lida } };
    const destino = destinoDoLoteRecusado(tomada, tarefa.lote, disjuntorDaVez(lida.vez), agoraMs);
    switch (destino.tipo) {
      case DESTINO_DO_LOTE.tomar: {
        const tomar = tomarVez(lida.vez, agoraMs, tarefa);
        if (tomar.tipo === 'recusado') return divergencia();
        const escrita: EscritaVez =
          tomar.tipo === 'criar'
            ? { tipo: 'criar', documento: tomar.documento }
            : { tipo: 'atualizar', patch: tomar.escrever };
        return {
          tipo: 'escrever',
          escrita,
          depois: (vez, writeTime) => ({
            tipo: 'tomada',
            sonda: destino.sonda,
            lida,
            vez,
            writeTime,
          }),
        };
      }
      case DESTINO_DO_LOTE.registrarPendente: {
        const registro = registrarPendenteVez(lida.vez, agoraMs, tarefa);
        if (registro.tipo === 'recusado') return divergencia();
        const { pendenteDesdeMs } = registro;
        if (registro.tipo === 'nada') {
          return {
            tipo: 'parar',
            resultado: {
              tipo: 'pendente-registrado',
              tomada,
              pendenteDesdeMs,
              escrito: false,
              lida,
            },
          };
        }
        return {
          tipo: 'escrever',
          escrita: { tipo: 'atualizar', patch: registro.escrever },
          depois: () => ({
            tipo: 'pendente-registrado',
            tomada,
            pendenteDesdeMs,
            escrito: true,
            lida,
          }),
        };
      }
      case DESTINO_DO_LOTE.repassarParaPatches:
      case DESTINO_DO_LOTE.aguardar:
      case DESTINO_DO_LOTE.loteExpirado:
        return { tipo: 'parar', resultado: { tipo: 'recusada', tomada, destino, lida } };
    }
  });
}

/* ------------------------------- the transitions -------------------------------- */

/** A plain transition: the builder's answer, written or refused. */
function transicao(
  db: Firestore,
  alvo: AlvoVezFeed,
  construir: (
    lida: LeituraVezFeed,
    agoraMs: number,
  ) =>
    | { readonly tipo: 'atualizar'; readonly escrever: PatchVezFeed }
    | { readonly tipo: 'recusado'; readonly motivo: MotivoRecusaDaVez },
  opcoes: { readonly agora: () => number; readonly antes?: () => Promise<void> },
): Promise<EscritaVezFeed | RecusaVezFeed> {
  return comPrecondicao<EscritaVezFeed | RecusaVezFeed>(db, alvo, (lida) => {
    const decisao = construir(lida, opcoes.agora());
    if (decisao.tipo === 'recusado') {
      return { tipo: 'parar', resultado: { tipo: 'recusado', motivo: decisao.motivo, lida } };
    }
    return {
      tipo: 'escrever',
      escrita: { tipo: 'atualizar', patch: decisao.escrever },
      antes: opcoes.antes,
      depois: (vez, writeTime) => ({ tipo: 'escrito', vez, writeTime }),
    };
  });
}

/**
 * `montando → enviando` (or the refresh re-entry of the SAME attempt: the
 * stamp this dispatch's previous call wrote, `null` on its first). The
 * caller's `antesDaEscrita` — the named uncertain-wait enqueue — runs before
 * the first write attempt the decision allows, and ONCE: a throw there leaves
 * the lease as it was (`montando`: nothing was posted). A refusal runs it not
 * at all.
 */
export function marcarEnviandoVezFeed(
  db: Firestore,
  alvo: AlvoVezFeed,
  envio: {
    readonly execucaoId: string;
    readonly envio: EnvioDaVez;
    readonly antesDoEnvioAnteriorMs: number | null;
  },
  opcoes: { readonly agora: () => number; readonly antesDaEscrita: () => Promise<void> },
): Promise<EscritaVezFeed | RecusaVezFeed> {
  let preparado = false;
  return transicao(
    db,
    alvo,
    (lida, agoraMs) =>
      marcarEnviandoVez(
        lida.vez,
        agoraMs,
        envio.execucaoId,
        envio.envio,
        envio.antesDoEnvioAnteriorMs,
      ),
    {
      agora: opcoes.agora,
      antes: async () => {
        if (preparado) return;
        await opcoes.antesDaEscrita();
        preparado = true;
      },
    },
  );
}

/** `enviando → enviado`, naming the `feedId` Amazon answered (the holder `execucaoId` only). */
export function marcarEnviadoVezFeed(
  db: Firestore,
  alvo: AlvoVezFeed,
  envio: { readonly execucaoId: string; readonly feedId: string },
  opcoes: { readonly agora: () => number },
): Promise<EscritaVezFeed | RecusaVezFeed> {
  return transicao(
    db,
    alvo,
    (lida, agoraMs) => marcarEnviadoVez(lida.vez, agoraMs, envio.execucaoId, envio.feedId),
    opcoes,
  );
}

/** `enviando → montando` after a 429 (not processed); the release (`limitado`) follows. */
export function voltarParaMontandoVezFeed(
  db: Firestore,
  alvo: AlvoVezFeed,
  execucaoId: string,
  opcoes: { readonly agora: () => number },
): Promise<EscritaVezFeed | RecusaVezFeed> {
  return transicao(
    db,
    alvo,
    (lida, agoraMs) => voltarParaMontandoVez(lida.vez, agoraMs, execucaoId),
    opcoes,
  );
}

/** A consuming write that landed: what it consumed, besides the lease and its time. */
export interface ConsumoVezFeed extends EscritaVezFeed {
  /** The start the winning read held (`null` when none). */
  readonly pendenteDesdeMs: number | null;
  /** The start handed to the `vez` recovery before the write (`null` when none). */
  readonly vezPara: number | null;
}

/** A consuming write (module header, "The pending start"): `vez` first, then the write. */
function consumo<C extends ConsumoDaVez, R>(
  db: Firestore,
  alvo: AlvoVezFeed,
  construir: (
    lida: LeituraVezFeed,
    agoraMs: number,
  ) =>
    | C
    | { readonly tipo: 'recusado'; readonly motivo: MotivoRecusaDaVez }
    | { readonly tipo: 'nada' },
  opcoes: { readonly agora: () => number; readonly enfileirarVez: EnfileirarVezFeed },
  resultado: (c: C, vez: VezFeedAmazon, writeTime: Timestamp) => R,
): Promise<R | RecusaVezFeed | { readonly tipo: 'nada'; readonly lida: LeituraVezFeed }> {
  return comPrecondicao<
    R | RecusaVezFeed | { readonly tipo: 'nada'; readonly lida: LeituraVezFeed }
  >(db, alvo, (lida) => {
    const decisao = construir(lida, opcoes.agora());
    if (decisao.tipo === 'recusado') {
      return { tipo: 'parar', resultado: { tipo: 'recusado', motivo: decisao.motivo, lida } };
    }
    if (decisao.tipo === 'nada') return { tipo: 'parar', resultado: { tipo: 'nada', lida } };
    return {
      tipo: 'escrever',
      escrita: { tipo: 'atualizar', patch: decisao.escrever },
      antes: vezAntes(alvo, lida.vez, decisao.vezPara, opcoes.enfileirarVez),
      depois: (vez, writeTime) => resultado(decisao, vez, writeTime),
    };
  });
}

/**
 * The uncertain outcome: the holder's `enviando` expired IN PLACE (`ateMs =
 * agora`), its start consumed — the `vez` recovery first.
 */
export async function expirarIncertoVezFeed(
  db: Firestore,
  alvo: AlvoVezFeed,
  execucaoId: string,
  opcoes: { readonly agora: () => number; readonly enfileirarVez: EnfileirarVezFeed },
): Promise<ConsumoVezFeed | RecusaVezFeed> {
  const r = await consumo(
    db,
    alvo,
    (lida, agoraMs) => expirarIncertoVez(lida.vez, agoraMs, execucaoId),
    opcoes,
    (c, vez, writeTime): ConsumoVezFeed => ({
      tipo: 'escrito',
      vez,
      writeTime,
      pendenteDesdeMs: c.pendenteDesdeMs,
      vezPara: c.vezPara,
    }),
  );
  // `expirarIncertoVez` never answers `nada`.
  if (r.tipo === 'nada') return divergencia();
  return r;
}

/** A release that landed: the pure decision's answer, the lease and the write's time. */
export interface LiberadaVezFeed extends EscritaVezFeed {
  readonly liberacao: LiberacaoDaVez;
}

/**
 * A release of the lease by `dono`, of kind `liberacao` (module header), through
 * the pure `decidirLiberacao`: refused — nothing written — when the lease is
 * held by another run or feed, or is in another phase. `pendenteDobrado` is the
 * start the caller already folded into its OWN recovery (the tail, the
 * uncertain path), else `null`; `antesDoEnvioAnteriorMs` is the stamp this
 * dispatch's own `marcarEnviando` wrote (the document kinds from `enviando`).
 */
export async function liberarVezFeed(
  db: Firestore,
  alvo: AlvoVezFeed,
  dono: DonoDaVezFeed,
  liberacao: LiberacaoVezFeed,
  opcoes: {
    readonly agora: () => number;
    readonly pendenteDobrado: number | null;
    readonly antesDoEnvioAnteriorMs?: number | null;
    readonly enfileirarVez: EnfileirarVezFeed;
  },
): Promise<LiberadaVezFeed | RecusaVezFeed> {
  const r = await consumo(
    db,
    alvo,
    (lida, agoraMs) =>
      decidirLiberacao(lida.vez, dono, liberacao, {
        agoraMs,
        pendenteDobrado: opcoes.pendenteDobrado,
        antesDoEnvioAnteriorMs: opcoes.antesDoEnvioAnteriorMs ?? null,
      }),
    opcoes,
    (c: LiberacaoDaVez, vez, writeTime): LiberadaVezFeed => ({
      tipo: 'escrito',
      vez,
      writeTime,
      liberacao: c,
    }),
  );
  // `decidirLiberacao` never answers `nada`.
  if (r.tipo === 'nada') return divergencia();
  return r;
}

/**
 * The pending start consumed WITHOUT a release (a rung past the slow bound, a
 * repasse to patches, the check of a dead `montando`): the `vez` recovery
 * first, then the start cleared. `nada` when the read holds no start.
 */
export async function consumirPendenteVezFeed(
  db: Firestore,
  alvo: AlvoVezFeed,
  consumidor: ConsumidorDoPendenteFeed,
  opcoes: { readonly agora: () => number; readonly enfileirarVez: EnfileirarVezFeed },
): Promise<
  ConsumoVezFeed | RecusaVezFeed | { readonly tipo: 'nada'; readonly lida: LeituraVezFeed }
> {
  return consumo(
    db,
    alvo,
    (lida, agoraMs) => consumirPendenteVez(lida.vez, consumidor, agoraMs),
    opcoes,
    (c, vez, writeTime): ConsumoVezFeed => ({
      tipo: 'escrito',
      vez,
      writeTime,
      pendenteDesdeMs: c.pendenteDesdeMs,
      vezPara: c.vezPara,
    }),
  );
}
