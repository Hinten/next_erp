/**
 * The ONE global stagger slot of the stock queue's BULK producers (master plan step 12, PR 12-f):
 * `reconcileEstoqueLojaIntegrada/atual.proximoSlotMs`, the next free instant at which a bulk send
 * may be scheduled. The `estoque-kits` fan-out (`processarKitsEstoque.ts`) takes it today, the
 * nightly reconcile's queue phase later; both enqueue with `naoAntesDeMs` at the instants reserved
 * here (`agendadorEstoque.ts`, "A bulk enqueue"), so a burst of kit sends is spread over time
 * instead of landing on the single-file stock queue at once.
 *
 * ## The interval, and what it buys
 *
 * {@link INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS} = the FLOOR of one bulk run (a kit or reconcile send:
 * two pacer intervals before its deciding read, then the read and the PUT, no read-back) PLUS the
 * floor of one event run (two intervals before its deciding read, two before its read-back, three
 * calls): 6 × `RITMO_ESCRITA_LI_MS` = 12 s, the calls themselves absorbed by the headroom
 * (`slotEstoqueLi.test.ts` pins the arithmetic against the pacer, so a pacer change moves it).
 * One event run fits between two bulk runs, so a fan-out keeps the queue about half busy. A
 * 2 000-kit fan-out spans about 6.7 h at 12 s (3.3 h at the 6 s a bulk run alone would take, with
 * the queue then fully busy).
 *
 * ⚠️ Pacing is the ONLY latency control here. Cloud Tasks guarantees no order among tasks that
 * are ready together, so once a backlog exists — a burst of event tasks, an oversubscribed slot —
 * neither an event task nor a kit send has any latency bound beyond the backlog's drain. The
 * fan-out logs the reserved horizon (`proximoSlotMs − now`) on its queue line: that is the signal.
 *
 * ## The reservation ({@link reservarSlotsLi}, pure)
 *
 *  - **The floor** ({@link pisoDoSlotEstoqueLi}): `(⌊now / 60 s⌋ + 3) · 60 s + 30 s` — one whole
 *    window past the latest instant any task of the current window can be scheduled at
 *    (`agendamentoEstoqueLi`), so a reserved instant always beats the window's own schedule, and
 *    every task is scheduled at EXACTLY its reserved instant.
 *  - **Within the horizon** (the stored slot at most {@link HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS} ahead of
 *    now): the run starts at the later of the floor and the stored slot, one interval apart, and
 *    advances the slot past its last instant.
 *  - **Beyond the horizon** (saturated): the run starts at the FLOOR, ahead of the backlog, and
 *    writes `max(stored, floor + n · interval)`, so the slot never moves back. The caller logs one
 *    ERROR line: the queue is oversubscribed, and `LOJA_INTEGRADA_ESTOQUE_KITS_IMEDIATO_MAX=0` is
 *    the lever. A stored value past Cloud Tasks' 30-day schedule limit lands here too.
 *  - **A retried attempt** (`doPiso`): starts at the floor too and writes `max(stored, floor +
 *    n · interval)`. Its sends are named by the fan-out's window, so the ones the first attempt
 *    enqueued meet their own tasks (already-exists: their schedules stand) and only the ones that
 *    failed get the new, early instants — instead of a second range of n instants after the
 *    first, a phantom gap of hours.
 *  - A stored value that is not a non-negative safe integer reads as none: a malformed run
 *    document never blocks the fan-out (fail open).
 *
 * Latency of a zero-crossing kit: about min(stored horizon, the bound) + its index × the interval.
 *
 * ## The write ({@link reservarSlotGlobalEstoqueLi}; root `CLAUDE.md` rule 7, tier 1)
 *
 * The schema's contract for this writer (`reconcileEstoqueLojaIntegrada.ts`): it holds NO lease
 * and writes ONLY `proximoSlotMs` — `create` when the document is absent, otherwise `update` with
 * `lastUpdateTime` = its own read's `updateTime`, advance-only. A 9 (a concurrent writer moved
 * the document) or a 6 (someone created it first) re-reads and re-derives everything from the new
 * read, the clock read AFTER that read; at most {@link MAX_TENTATIVAS_SLOT_ESTOQUE_LI} attempts,
 * then {@link LiSlotEstoqueEmConflitoError} and the task retries.
 *
 * ⚠️ A write that LANDED and lost only its reply comes back as a 9 (the SDK retried the commit
 * with the same precondition) or a 6 (a retried create): the re-read then finds EXACTLY the value
 * this attempt wrote, and that is counted as written — never advanced a second time
 * (`guardaOPatchLi`'s precedent in the import). The residual: another writer that derived the same
 * value from the same read is taken for ours, and the two runs share their instants — pacing only,
 * never a lost send.
 *
 * No transaction (the inventory guard greps for the API's name, so it is never written here).
 */
import type { Firestore } from 'firebase-admin/firestore';
import { reconcileEstoqueLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import { isAlreadyExists, isFailedPrecondition } from '@delfrance/data/admin/grpcErrors';
import { ID_RECONCILE_ESTOQUE_LI } from '@delfrance/schemas';

import { DISPERSAO_ESTOQUE_LI_MS, JANELA_ESTOQUE_LI_MS, janelaEstoqueLi } from './agendadorEstoque';

/** The spacing of two bulk sends on the slot, in ms (module header, "The interval"). */
export const INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS = 12_000;

/**
 * How far ahead of now the stored slot may be before a fan-out stops queueing behind it, in ms
 * (module header, "Beyond the horizon"): 4 h, inside the nightly reconcile's 24 h bound.
 */
export const HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS = 4 * 60 * 60_000;

/** Attempts of one reservation's write before {@link LiSlotEstoqueEmConflitoError}. */
export const MAX_TENTATIVAS_SLOT_ESTOQUE_LI = 3;

/** The slot lost {@link MAX_TENTATIVAS_SLOT_ESTOQUE_LI} writes in a row: the task retries. */
export class LiSlotEstoqueEmConflitoError extends Error {
  readonly tentativas: number;

  constructor(tentativas: number) {
    super(
      `O slot global da fila de estoque mudou a cada leitura: ${String(tentativas)} escritas ` +
        'seguidas perdidas — a tarefa tenta de novo',
    );
    this.name = 'LiSlotEstoqueEmConflitoError';
    this.tentativas = tentativas;
  }
}

/** The earliest instant a bulk send reserved at `agoraMs` may start at (module header, "The floor"). */
export function pisoDoSlotEstoqueLi(agoraMs: number): number {
  return (janelaEstoqueLi(agoraMs) + 3) * JANELA_ESTOQUE_LI_MS + DISPERSAO_ESTOQUE_LI_MS;
}

/** What one reservation decided. */
export interface ReservaDeSlotsLi {
  /** The instant of each send, in order, one interval apart. */
  readonly inicios: readonly number[];
  /** The slot after the reservation: never below the stored one. */
  readonly proximoMs: number;
  /** The slot as read (`null`: absent or not a valid instant). */
  readonly armazenadoMs: number | null;
  /** The stored slot was more than the horizon ahead of now: the run started at the floor. */
  readonly saturado: boolean;
}

/** The stored slot as an instant, or `null` (module header: fail open). */
function instanteValido(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * The reservation of `quantidade` sends at `agoraMs` over the stored slot `armazenadoMs` (module
 * header, "The reservation"). Pure. Throws `RangeError` for a `quantidade` below 1 — a caller with
 * nothing to send reserves nothing.
 */
export function reservarSlotsLi(args: {
  readonly agoraMs: number;
  readonly armazenadoMs: number | null;
  readonly quantidade: number;
  /** A retried attempt: start at the floor (module header). */
  readonly doPiso: boolean;
  readonly intervaloMs?: number;
  readonly horizonteMaxMs?: number;
}): ReservaDeSlotsLi {
  const intervalo = args.intervaloMs ?? INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS;
  const horizonteMax = args.horizonteMaxMs ?? HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS;
  if (!Number.isSafeInteger(args.quantidade) || args.quantidade < 1) {
    throw new RangeError('reservarSlotsLi: quantidade precisa ser um inteiro positivo');
  }
  const armazenado = instanteValido(args.armazenadoMs);
  const piso = pisoDoSlotEstoqueLi(args.agoraMs);
  const saturado = armazenado !== null && armazenado - args.agoraMs > horizonteMax;
  const base = armazenado === null || saturado || args.doPiso ? piso : Math.max(piso, armazenado);
  const inicios = Array.from({ length: args.quantidade }, (_, i) => base + i * intervalo);
  const fim = base + args.quantidade * intervalo;
  return {
    inicios,
    proximoMs: armazenado === null ? fim : Math.max(armazenado, fim),
    armazenadoMs: armazenado,
    saturado,
  };
}

/** What one reservation of the global slot did. */
export interface ReservaGravadaLi extends ReservaDeSlotsLi {
  /** `false` when the stored slot already covered it (nothing to advance): no write was sent. */
  readonly escrito: boolean;
  /** The clock read after the deciding read, in ms: the reservation's own now. */
  readonly agoraMs: number;
}

/**
 * Reserve `quantidade` sends on the global slot and write its advance (module header, "The
 * write"). `db` a parameter, the admin handle, the RAW stored field (only `proximoSlotMs` is read).
 * Rejects with {@link LiSlotEstoqueEmConflitoError} after the attempts, and rethrows any other
 * failure as thrown.
 */
export async function reservarSlotGlobalEstoqueLi(
  db: Firestore,
  args: {
    readonly quantidade: number;
    /** Read AFTER each read of the slot, never before. */
    readonly agoraMs: () => number;
    readonly doPiso: boolean;
  },
): Promise<ReservaGravadaLi> {
  const ref = reconcileEstoqueLojaIntegradaCollection.docRef(db, {}, ID_RECONCILE_ESTOQUE_LI);
  let tentada: ReservaGravadaLi | null = null;
  // Up to MAX writes; one read before each, and one after the last loss (it may have landed).
  for (let escritas = 0; ; escritas += 1) {
    const snap = await ref.get();
    const dados: unknown = snap.exists ? snap.data() : undefined;
    const armazenado = instanteValido(
      typeof dados === 'object' && dados !== null && Object.hasOwn(dados, 'proximoSlotMs')
        ? Reflect.get(dados, 'proximoSlotMs')
        : undefined,
    );
    // A lost reply: the previous attempt's write is what the re-read found (module header).
    if (tentada !== null && armazenado === tentada.proximoMs) return tentada;
    if (escritas === MAX_TENTATIVAS_SLOT_ESTOQUE_LI) {
      throw new LiSlotEstoqueEmConflitoError(MAX_TENTATIVAS_SLOT_ESTOQUE_LI);
    }
    const agoraMs = args.agoraMs();
    const reserva = reservarSlotsLi({
      agoraMs,
      armazenadoMs: armazenado,
      quantidade: args.quantidade,
      doPiso: args.doPiso,
    });
    if (snap.exists && reserva.proximoMs === armazenado) {
      return { ...reserva, escrito: false, agoraMs };
    }
    const patch = reconcileEstoqueLojaIntegradaCollection.parseMerge({
      proximoSlotMs: reserva.proximoMs,
    });
    tentada = { ...reserva, escrito: true, agoraMs };
    try {
      if (snap.exists) await ref.update(patch, { lastUpdateTime: snap.updateTime });
      else await ref.create(patch);
      return tentada;
    } catch (err) {
      if (!isFailedPrecondition(err) && !isAlreadyExists(err)) throw err;
    }
  }
}
