/**
 * The daily stock reconcile's RUN DOCUMENT `reconcileEstoqueLojaIntegrada/atual` (master plan step
 * 12, PR 12-g): which slice may run ({@link decidirSliceReconcileLi}, pure), the lease's take
 * ({@link assumirLeaseReconcileLi}) and every later write of the run, each one a BATCH that updates
 * this document under the slice's own chained precondition ({@link gravarLoteReconcileLi}). The
 * contract — the document, its phases, its lease — is `packages/schemas/src/
 * reconcileEstoqueLojaIntegrada.ts`; this module orders the reads and guards the writes.
 * Next-free, `db` a parameter, no environment, no clock of its own (`agoraMs` is handed in).
 *
 * ## Which slice runs (root rule 7, tier 1)
 *
 * A slice carries `{ execucaoId, seq }`; the stored document decides, in this order:
 *
 *  - the SAME run (`execucaoId` equal):
 *    - `seq` equal and the lease held (`emExecucaoAteMs ≠ 0`) ⇒ `executar` — an expired lease of
 *      our own run still runs: expiry only lets ANOTHER run take it;
 *    - `seq` ONE behind and the lease held ⇒ `continuacao`: an earlier attempt of this slice wrote
 *      its end-of-slice checkpoint and its hand-off may have failed — the slice only re-enqueues
 *      the stored `seq` (the import's repair, `importacao/job.ts`);
 *    - anything else ⇒ `nada` (a stale chain, or a late duplicate of a run already released: the
 *      release bumps `seq`).
 *  - ANOTHER run: only its first slice (`seq` 0) may start one; any other ⇒ `nada`. Then:
 *    - a document that does not parse ⇒ `assumir`, abandoned (ONE ERROR line; the take writes
 *      every reconcile field, never `proximoSlotMs`);
 *    - no run ever (a document the kit fan-out created for its slot alone) ⇒ `assumir`;
 *    - the stored run STARTED in the same minute window ⇒ `adiar`: the slice throws
 *      {@link LiReconcileEstoqueAdiadoError} and the queue retries it a minute later. Two runs never
 *      share a window, so a reconcile send — named by its run's window (`agendadorEstoque.ts`) — can
 *      never meet another run's task that already dispatched;
 *    - the lease free (`0`) ⇒ `assumir`; expired ⇒ `assumir`, abandoned; held by a run that
 *      started more than {@link ABANDONO_RECONCILE_ESTOQUE_LI_MS} ago ⇒ `assumir`, abandoned (ONE
 *      WARNING each); otherwise `ocupado`: the running chain wins.
 *
 * ## Every write rides the run document's precondition
 *
 * {@link gravarLoteReconcileLi} commits ONE batch: `update(patch, { lastUpdateTime })` of this
 * document on the stamp of the slice's previous write (its read's, first), plus the slice's writes
 * of the per-conta documents (`sincEstoqueLojaIntegrada.ts`, "Writers"). Every patch moves
 * `emExecucaoAteMs` or `seq` strictly forward, so no two patches of a run are equal. On a lost
 * precondition (9 — or 6/5 from a per-conta document) the document is re-read RAW, and:
 *
 *  - it holds the patch whole ⇒ OUR batch landed and only its reply was lost (the Admin SDK retries
 *    a commit with the same precondition, and the retry meets its own stamp): written, and the
 *    per-conta stamps are re-read;
 *  - every field but `proximoSlotMs` is as this slice last left it ⇒ only the kit fan-out moved —
 *    its ONE field, the global slot — and the SAME batch is re-applied on the new stamp (at most
 *    {@link MAX_TENTATIVAS_ESCRITA_RECONCILE_LI} times). This is where the reconcile departs from
 *    the import, which never re-applies a lost checkpoint: the import's only other writers (the
 *    cancel, a terminal stamp) change what its progress means, while the slot's writer, by the
 *    schema's contract, touches nothing a slice derived anything from;
 *  - the lease is no longer this slice's (another run, another `seq`, released) ⇒ `parar`:
 *    nothing written, no throw;
 *  - otherwise another dispatch of the SAME slice wrote it ⇒ {@link LiReconcileEstoqueConcorrenteError}
 *    and the queue's retry resumes from what is stored.
 *
 * Both comparisons are `guardaOPatchLi` (`importacao/job.ts`): the RAW stored fields, through the
 * app's one JSON comparator, which folds key order and nothing else.
 *
 * ⚠️ Never name the Admin SDK's multi-document read-and-write call here — not even in a comment
 * (`estrutura.test.ts`).
 */
import type {
  DocumentReference,
  DocumentSnapshot,
  Firestore,
  Timestamp,
} from 'firebase-admin/firestore';
import { reconcileEstoqueLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import {
  isAlreadyExists,
  isFailedPrecondition,
  isNotFound,
} from '@delfrance/data/admin/grpcErrors';
import {
  FASE_RECONCILE_ESTOQUE_LI,
  ID_RECONCILE_ESTOQUE_LI,
  type ReconcileEstoqueLojaIntegrada,
  type TarefaReconcileEstoqueLi,
  reconcileEstoqueLojaIntegradaSchema,
} from '@delfrance/schemas';

import { guardaOPatchLi } from '../../importacao/job';
import { janelaEstoqueLi } from '../agendadorEstoque';

/**
 * How far each write of a slice pushes the lease, in ms: one hour — more than the next slice's
 * whole retry ladder on the reads queue (3 × 300 s + 2 × 300 s = 1 500 s) plus its waits behind
 * co-tenants. It is also how long a crashed chain blocks a new run.
 */
export const LEASE_RECONCILE_ESTOQUE_LI_MS = 60 * 60_000;

/** A run that started longer ago than this is abandoned by the next one (48 h). */
export const ABANDONO_RECONCILE_ESTOQUE_LI_MS = 48 * 60 * 60_000;

/** Commits of one batch before {@link LiReconcileEstoqueConcorrenteError}. */
export const MAX_TENTATIVAS_ESCRITA_RECONCILE_LI = 5;

/** The writes one batch may carry beside the run document (Firestore's 500, with room). */
export const MAX_ESCRITAS_LOTE_RECONCILE_LI = 400;

/**
 * Another dispatch of the SAME slice wrote the run document (module header), or a batch lost its
 * precondition {@link MAX_TENTATIVAS_ESCRITA_RECONCILE_LI} times: nothing more is written, and the
 * task throws so the queue's retry resumes from what is stored. Transient by definition.
 */
export class LiReconcileEstoqueConcorrenteError extends Error {
  readonly execucaoId: string;
  readonly seq: number;

  constructor(execucaoId: string, seq: number) {
    super(
      `Outra execução do reconcile ${execucaoId} (despacho ${String(seq)}) gravou o documento ` +
        'da execução ao mesmo tempo; nada desta foi gravado por cima.',
    );
    this.name = 'LiReconcileEstoqueConcorrenteError';
    this.execucaoId = execucaoId;
    this.seq = seq;
  }
}

/**
 * A run's first slice found another run started in the same minute window (module header,
 * `adiar`): the queue retries it, and the next window takes the lease. Transient by definition.
 */
export class LiReconcileEstoqueAdiadoError extends Error {
  readonly execucaoId: string;

  constructor(execucaoId: string) {
    super(
      `O reconcile ${execucaoId} começa na mesma janela de um minuto que a execução anterior — ` +
        'a tarefa tenta de novo',
    );
    this.name = 'LiReconcileEstoqueAdiadoError';
    this.execucaoId = execucaoId;
  }
}

/** The run document as read. */
export interface RunLidoLi {
  readonly existe: boolean;
  /** The RAW stored fields (`{}` when absent): what `guardaOPatchLi` compares. */
  readonly dados: Readonly<Record<string, unknown>>;
  /** Parsed with the REFINED schema; `null` when absent or off it. */
  readonly run: ReconcileEstoqueLojaIntegrada | null;
  /** The read's `updateTime`; `null` when absent. */
  readonly versao: Timestamp | null;
}

/** The run document's ref. */
export function refRunReconcileLi(db: Firestore): DocumentReference {
  return reconcileEstoqueLojaIntegradaCollection.docRef(db, {}, ID_RECONCILE_ESTOQUE_LI);
}

function runDoSnapshot(snap: DocumentSnapshot): RunLidoLi {
  if (!snap.exists) return { existe: false, dados: {}, run: null, versao: null };
  const dados: Record<string, unknown> = snap.data() ?? {};
  const lido = reconcileEstoqueLojaIntegradaSchema.safeParse(dados);
  return {
    existe: true,
    dados,
    run: lido.success ? lido.data : null,
    versao: snap.updateTime ?? null,
  };
}

/** One read of the run document, by id. */
export async function lerRunReconcileLi(db: Firestore): Promise<RunLidoLi> {
  return runDoSnapshot(await refRunReconcileLi(db).get());
}

/** Why a take found the stored run abandoned (module header). */
export type AbandonoReconcileLi = 'fora-do-formato' | 'lease-vencido' | 'mais-de-48h';

/** What a slice may do with the run document as stored (module header). */
export type DecisaoSliceReconcileLi =
  | { readonly tipo: 'executar' }
  /** Re-enqueue the stored `seq` and stop. */
  | { readonly tipo: 'continuacao'; readonly seq: number }
  | { readonly tipo: 'nada' }
  | { readonly tipo: 'ocupado' }
  | { readonly tipo: 'adiar' }
  | { readonly tipo: 'assumir'; readonly abandonada: AbandonoReconcileLi | null };

/** The decision (module header, "Which slice runs"). Pure. */
export function decidirSliceReconcileLi(
  lido: Pick<RunLidoLi, 'existe' | 'run'>,
  tarefa: Pick<TarefaReconcileEstoqueLi, 'execucaoId' | 'seq'>,
  agoraMs: number,
): DecisaoSliceReconcileLi {
  const { run } = lido;
  if (run !== null && run.execucaoId === tarefa.execucaoId) {
    if (run.emExecucaoAteMs !== 0 && tarefa.seq === run.seq) return { tipo: 'executar' };
    if (run.emExecucaoAteMs !== 0 && tarefa.seq + 1 === run.seq) {
      return { tipo: 'continuacao', seq: run.seq };
    }
    return { tipo: 'nada' };
  }
  if (tarefa.seq !== 0) return { tipo: 'nada' };
  if (lido.existe && run === null) return { tipo: 'assumir', abandonada: 'fora-do-formato' };
  if (run === null || run.execucaoId === null) return { tipo: 'assumir', abandonada: null };
  if (run.iniciadoEmMs !== null && janelaEstoqueLi(agoraMs) === janelaEstoqueLi(run.iniciadoEmMs)) {
    return { tipo: 'adiar' };
  }
  if (run.emExecucaoAteMs === 0) return { tipo: 'assumir', abandonada: null };
  if (run.emExecucaoAteMs < agoraMs) return { tipo: 'assumir', abandonada: 'lease-vencido' };
  if (run.iniciadoEmMs === null || agoraMs - run.iniciadoEmMs > ABANDONO_RECONCILE_ESTOQUE_LI_MS) {
    return { tipo: 'assumir', abandonada: 'mais-de-48h' };
  }
  return { tipo: 'ocupado' };
}

/** Where a slice writes: its run, its `seq`, and its chained precondition. */
export interface EstadoEscritaReconcileLi {
  readonly execucaoId: string;
  readonly seq: number;
  /** The stamp of this slice's previous write of the run document (its read's, first). */
  versaoRun: Timestamp;
  /** The RAW document as this slice last left it (its read, then each landed patch). */
  runEsperado: Readonly<Record<string, unknown>>;
}

/** One write of a per-conta document, in a batch beside the run document. */
export type EscritaSincLi =
  /** `create` when `versao` is `null` (absent when read), else `update` under it. Whole fields. */
  | {
      readonly tipo: 'gravar';
      readonly ref: DocumentReference;
      readonly dados: Readonly<Record<string, unknown>>;
      readonly versao: Timestamp | null;
    }
  /** The whole document, `set` with no precondition: a kits header or shard. */
  | {
      readonly tipo: 'sobrescrever';
      readonly ref: DocumentReference;
      readonly dados: Readonly<Record<string, unknown>>;
    }
  | { readonly tipo: 'apagar'; readonly ref: DocumentReference };

/** How a batch ended. */
export type ResultadoLoteReconcileLi =
  /** Written: each per-conta document's new stamp, by path (`null` once deleted). */
  | { readonly tipo: 'gravado'; readonly versoes: ReadonlyMap<string, Timestamp | null> }
  /** Not written, and the slice STOPS: the lease is no longer its own (`lido`, the fresh read). */
  | { readonly tipo: 'parar'; readonly lido: RunLidoLi };

/** The document without the slot: what the kit fan-out may change under a slice. */
function semSlot(dados: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const { proximoSlotMs: _slot, ...resto } = dados;
  return resto;
}

/** Whether the lost write still belongs to this slice's lease (module header). */
function aindaDoSlice(lido: RunLidoLi, estado: EstadoEscritaReconcileLi): boolean {
  const run = lido.run;
  return (
    run !== null &&
    run.execucaoId === estado.execucaoId &&
    run.seq === estado.seq &&
    run.emExecucaoAteMs !== 0
  );
}

/**
 * The patch of the run document a slice writes, validated: the handle's `parseMerge` (the shape),
 * then the REFINED schema over the document it would leave (a bug never ships a document every
 * later read refuses). `proximoSlotMs` is not ours and is left out of that check.
 */
function patchValidado(
  esperado: Readonly<Record<string, unknown>>,
  patch: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const validado: Record<string, unknown> = reconcileEstoqueLojaIntegradaCollection.parseMerge({
    ...patch,
  });
  if (Object.hasOwn(validado, 'proximoSlotMs')) {
    throw new TypeError('reconcile: um slice nunca grava proximoSlotMs');
  }
  reconcileEstoqueLojaIntegradaSchema.parse({ ...semSlot(esperado), ...validado });
  return validado;
}

/** Each written per-conta document's stamp after a landed batch. */
function versoesDoLote(
  escritas: readonly EscritaSincLi[],
  writeTime: Timestamp,
): Map<string, Timestamp | null> {
  return new Map(escritas.map((e) => [e.ref.path, e.tipo === 'apagar' ? null : writeTime]));
}

/**
 * One batch of a slice (module header, "Every write rides the run document's precondition"). On
 * `gravado`, `estado` already carries the new stamp and the document as left.
 */
export async function gravarLoteReconcileLi(
  db: Firestore,
  estado: EstadoEscritaReconcileLi,
  runPatch: Readonly<Record<string, unknown>>,
  escritas: readonly EscritaSincLi[] = [],
): Promise<ResultadoLoteReconcileLi> {
  if (escritas.length > MAX_ESCRITAS_LOTE_RECONCILE_LI) {
    throw new RangeError('reconcile: escritas demais num lote');
  }
  const patch = patchValidado(estado.runEsperado, runPatch);
  const ref = refRunReconcileLi(db);
  for (let tentativa = 1; ; tentativa += 1) {
    const lote = db.batch();
    lote.update(ref, patch, { lastUpdateTime: estado.versaoRun });
    for (const e of escritas) {
      if (e.tipo === 'apagar') lote.delete(e.ref);
      else if (e.tipo === 'sobrescrever') lote.set(e.ref, { ...e.dados });
      else if (e.versao === null) lote.create(e.ref, { ...e.dados });
      else lote.update(e.ref, { ...e.dados }, { lastUpdateTime: e.versao });
    }
    try {
      const [resultado] = await lote.commit();
      if (resultado === undefined) throw new TypeError('reconcile: commit sem resultado');
      estado.versaoRun = resultado.writeTime;
      estado.runEsperado = { ...estado.runEsperado, ...patch };
      return { tipo: 'gravado', versoes: versoesDoLote(escritas, resultado.writeTime) };
    } catch (err) {
      if (!isFailedPrecondition(err) && !isAlreadyExists(err) && !isNotFound(err)) throw err;
    }
    const relido = await lerRunReconcileLi(db);
    if (relido.versao === null) return { tipo: 'parar', lido: relido };
    // OUR batch landed, its reply lost: written; the per-conta stamps are read again.
    if (aindaDoSliceOuSeuFim(relido, estado) && guardaOPatchLi(relido.dados, patch)) {
      estado.versaoRun = relido.versao;
      estado.runEsperado = relido.dados;
      return { tipo: 'gravado', versoes: await versoesRelidas(db, escritas) };
    }
    if (!aindaDoSlice(relido, estado)) return { tipo: 'parar', lido: relido };
    // Only the global slot moved: the SAME batch again, on the new stamp.
    if (guardaOPatchLi(relido.dados, semSlot(estado.runEsperado))) {
      if (tentativa >= MAX_TENTATIVAS_ESCRITA_RECONCILE_LI) {
        throw new LiReconcileEstoqueConcorrenteError(estado.execucaoId, estado.seq);
      }
      estado.versaoRun = relido.versao;
      estado.runEsperado = { ...estado.runEsperado, proximoSlotMs: relido.dados.proximoSlotMs };
      continue;
    }
    throw new LiReconcileEstoqueConcorrenteError(estado.execucaoId, estado.seq);
  }
}

/** The same run — at this slice's `seq`, or the next one its own end-of-slice patch wrote. */
function aindaDoSliceOuSeuFim(lido: RunLidoLi, estado: EstadoEscritaReconcileLi): boolean {
  const run = lido.run;
  return run !== null && run.execucaoId === estado.execucaoId;
}

/** The stamps of the per-conta documents of a batch that landed with its reply lost. */
async function versoesRelidas(
  db: Firestore,
  escritas: readonly EscritaSincLi[],
): Promise<Map<string, Timestamp | null>> {
  const versoes = new Map<string, Timestamp | null>();
  if (escritas.length === 0) return versoes;
  const snaps = await db.getAll(...escritas.map((e) => e.ref));
  snaps.forEach((snap) => {
    versoes.set(snap.ref.path, snap.exists ? (snap.updateTime ?? null) : null);
  });
  return versoes;
}

/** One conta of a new run, and the stamp of the read of its root (`null` = absent). */
export interface RaizParaAssumirLi {
  readonly contaId: string;
  readonly depositoId: string;
  readonly ref: DocumentReference;
  readonly versao: Timestamp | null;
}

/** How a take ended. */
export type ResultadoAssumirLi =
  | { readonly tipo: 'assumido'; readonly estado: EstadoEscritaReconcileLi }
  /** Another writer moved the document first: re-read and decide again. */
  | { readonly tipo: 'perdido' };

/**
 * The take of the lease by `tarefa`'s run (module header), on `lido` — `create` when the document
 * is absent, else `update` under its read: every reconcile field written (`contas` in the given
 * order, the phase `erp` at `seq` 0 with the lease for {@link LEASE_RECONCILE_ESTOQUE_LI_MS}),
 * NEVER `proximoSlotMs`; and, in the same batch, each conta's root `execucao` (the depósito the run
 * fixes now). With NO conta the run is released at once (`fim`, lease 0, `seq` 1) and nothing else
 * is written. A lost race (6 or 9) is `perdido` unless the document holds this very patch (a lost
 * reply).
 */
export async function assumirLeaseReconcileLi(
  db: Firestore,
  args: {
    readonly lido: RunLidoLi;
    readonly tarefa: Pick<TarefaReconcileEstoqueLi, 'execucaoId' | 'seq'>;
    readonly agoraMs: number;
    readonly raizes: readonly RaizParaAssumirLi[];
  },
): Promise<ResultadoAssumirLi> {
  const vazio = args.raizes.length === 0;
  const patch = patchValidado(
    {},
    {
      execucaoId: args.tarefa.execucaoId,
      iniciadoEmMs: args.agoraMs,
      emExecucaoAteMs: vazio ? 0 : args.agoraMs + LEASE_RECONCILE_ESTOQUE_LI_MS,
      seq: vazio ? 1 : 0,
      fase: vazio ? FASE_RECONCILE_ESTOQUE_LI.fim : FASE_RECONCILE_ESTOQUE_LI.erp,
      contas: args.raizes.map((r) => r.contaId),
      idxConta: 0,
      walk: null,
      candidatos: [],
      contadores: {},
    },
  );
  const ref = refRunReconcileLi(db);
  const lote = db.batch();
  if (args.lido.versao === null) lote.create(ref, patch);
  else lote.update(ref, patch, { lastUpdateTime: args.lido.versao });
  for (const raiz of args.raizes) {
    const dados = {
      execucao: {
        execucaoId: args.tarefa.execucaoId,
        depositoId: raiz.depositoId,
        vistos: [],
        amostras: {},
        mapa: null,
      },
    };
    if (raiz.versao === null) lote.create(raiz.ref, dados);
    else lote.update(raiz.ref, dados, { lastUpdateTime: raiz.versao });
  }
  try {
    const [resultado] = await lote.commit();
    if (resultado === undefined) throw new TypeError('reconcile: commit sem resultado');
    return {
      tipo: 'assumido',
      estado: {
        execucaoId: args.tarefa.execucaoId,
        seq: args.tarefa.seq,
        versaoRun: resultado.writeTime,
        runEsperado: { ...args.lido.dados, ...patch },
      },
    };
  } catch (err) {
    if (!isFailedPrecondition(err) && !isAlreadyExists(err) && !isNotFound(err)) throw err;
  }
  const relido = await lerRunReconcileLi(db);
  if (relido.versao !== null && guardaOPatchLi(relido.dados, patch)) {
    return {
      tipo: 'assumido',
      estado: {
        execucaoId: args.tarefa.execucaoId,
        seq: args.tarefa.seq,
        versaoRun: relido.versao,
        runEsperado: relido.dados,
      },
    };
  }
  return { tipo: 'perdido' };
}
