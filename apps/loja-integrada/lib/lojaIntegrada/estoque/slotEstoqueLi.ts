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
 * {@link INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS} = one bulk run (a kit or reconcile send: two pacer
 * intervals, then the deciding GET and the PUT, no read-back) PLUS one event run (two intervals,
 * the GET and the PUT, two more intervals, the read-back): 6 × `RITMO_ESCRITA_LI_MS` of sleeps
 * and 5 calls at {@link ORCAMENTO_POR_CHAMADA_SLOT_ESTOQUE_LI_MS} each = 17 s — the step plan's own
 * run estimates (6 s for a two-call run, 11 s for a three-call one, margin included). The pacer
 * sleeps BEFORE each call, so a call's time comes on top of its interval, never inside it
 * (`slotEstoqueLi.test.ts` pins the arithmetic against the pacer, so a pacer change moves it).
 * One event run fits between two bulk sends, so a fan-out keeps the queue about two-thirds busy.
 * A 2 000-kit fan-out spans about 9.4 h.
 *
 * ⚠️ The per-call budget is an ESTIMATE, not a bound: a call may take up to its 20 s deadline,
 * and the ERP reads, the credential re-reads and the dispatch itself add to every run. When a
 * real bulk-plus-event pair takes longer than the interval, an event run no longer fits between
 * two bulk sends and the event backlog grows for as long as a fan-out lasts. The owner's staging
 * measurement of a run's duration confirms or corrects it before the window.
 *
 * ⚠️ Pacing is the ONLY latency control here. Cloud Tasks guarantees no order among tasks that
 * are ready together, so once a backlog exists — a burst of event tasks, a long slot — neither an
 * event task nor a kit send has any latency bound beyond the backlog's drain. The fan-out logs
 * the reserved horizon (`proximoSlotMs − now`, this run's reservation included) on its queue
 * line: that is the signal.
 *
 * ## The reservation ({@link reservarSlotsLi}, pure)
 *
 *  - **The floor** ({@link pisoDoSlotEstoqueLi}): `(⌊now / 60 s⌋ + 3) · 60 s + 30 s` — one whole
 *    window past the latest instant any task of the current window can be scheduled at
 *    (`agendamentoEstoqueLi`), so a reserved instant always beats the window's own schedule, and
 *    every task is scheduled at EXACTLY its reserved instant.
 *  - **Always behind the stored slot, never double-booked**: the run starts at the later of the
 *    floor and the stored slot, one interval apart, and the slot advances past its last instant.
 *    Two reservations never share an instant, so the queue never carries more than one bulk send
 *    per interval, whatever the backlog — event runs keep their place between bulk sends.
 *  - **The backlog signal** (saturated: the stored slot more than
 *    {@link HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS} ahead of now — 12 h, more than one planned 2 000-kit
 *    fan-out): the caller logs ONE ERROR line, and the run still queues behind the backlog, so
 *    every bulk send waits longer — a zero-crossing kit waits about (stored − now) + its index ×
 *    the interval. No setting relieves it today. The eager ceiling does NOT: a ceiling of 0 moves
 *    the small components' kits onto this slot too, which adds to it (that lever is for eager
 *    sends crowding the queue). What would is a pre-filter on the fan-out (it re-sends the kits
 *    already at 0, once per firing) or another interval — both the owner's decisions.
 *  - **The schedule limit** ({@link LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS}, 29 days: one day inside
 *    Cloud Tasks' 30-day limit on a schedule): a run whose last instant would land beyond it is
 *    `excedeLimite`, and NOTHING is reserved or written — Cloud Tasks would refuse its tail, and a
 *    retry would only push the slot further. The caller logs ONE ERROR and enqueues nothing; those
 *    kits wait for the nightly reconcile. Only a backlog of weeks, or a hand-edited value, gets
 *    there (`functions/DEPLOY.md`).
 *  - **A retried attempt reserves like a first one.** The sends an earlier attempt enqueued meet
 *    their own names (already-exists: their schedules stand), the rest take new instants behind
 *    the stored slot, and the earlier attempt's instants of the sends that now exist stay reserved
 *    but unused: a gap of at most n × the interval on the slot. Later bulk sends wait longer; the
 *    queue never carries more. An attempt that failed BEFORE its reservation (an incomplete map, a
 *    lost slot race, a failed read) leaves no gap.
 *  - A stored value that is not a non-negative safe integer reads as none: a malformed run
 *    document never blocks the fan-out (fail open).
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

/** The time budgeted to ONE store call on top of its pacer interval, in ms (module header, "The interval"). */
export const ORCAMENTO_POR_CHAMADA_SLOT_ESTOQUE_LI_MS = 1_000;

/** The spacing of two bulk sends on the slot, in ms (module header, "The interval"). */
export const INTERVALO_SLOT_ESTOQUE_LOTE_LI_MS = 17_000;

/**
 * How far ahead of now the stored slot may be before a fan-out logs ONE ERROR line, in ms (module
 * header, "The backlog signal"): 12 h, more than the 9.4 h of one planned 2 000-kit fan-out. The
 * run queues behind it either way.
 */
export const HORIZONTE_MAX_SLOT_ESTOQUE_LI_MS = 12 * 60 * 60_000;

/**
 * The latest a reservation's last instant may land after now, in ms (module header, "The schedule
 * limit"): 29 days, one day inside Cloud Tasks' 30-day limit on a task's schedule.
 */
export const LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS = 29 * 24 * 60 * 60_000;

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
  /** The instant of each send, in order, one interval apart, all at or after the stored slot. */
  readonly inicios: readonly number[];
  /** The slot after the reservation: one interval past the last instant, above the stored one. */
  readonly proximoMs: number;
  /** The slot as read (`null`: absent or not a valid instant). */
  readonly armazenadoMs: number | null;
  /** The stored slot was more than the horizon ahead of now: ONE ERROR line, and still behind it. */
  readonly saturado: boolean;
  /** The last instant would land past the schedule limit: NOTHING may be reserved or enqueued. */
  readonly excedeLimite: boolean;
}

/** The stored slot as an instant, or `null` (module header: fail open). */
function instanteValido(v: unknown): number | null {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
}

/**
 * The reservation of `quantidade` sends at `agoraMs` over the stored slot `armazenadoMs` (module
 * header, "The reservation"): always behind the stored slot, never sharing an instant with it.
 * Pure. Throws `RangeError` for a `quantidade` below 1 — a caller with nothing to send reserves
 * nothing.
 */
export function reservarSlotsLi(args: {
  readonly agoraMs: number;
  readonly armazenadoMs: number | null;
  readonly quantidade: number;
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
  const base = armazenado === null ? piso : Math.max(piso, armazenado);
  const inicios = Array.from({ length: args.quantidade }, (_, i) => base + i * intervalo);
  const proximoMs = base + args.quantidade * intervalo;
  return {
    inicios,
    proximoMs,
    armazenadoMs: armazenado,
    saturado: armazenado !== null && armazenado - args.agoraMs > horizonteMax,
    excedeLimite: proximoMs - args.agoraMs > LIMITE_AGENDAMENTO_SLOT_ESTOQUE_LI_MS,
  };
}

/** What one reservation of the global slot did. */
export interface ReservaGravadaLi extends ReservaDeSlotsLi {
  /** `false` exactly when the reservation exceeds the schedule limit: no write was sent. */
  readonly escrito: boolean;
  /** The clock read after the deciding read, in ms: the reservation's own now. */
  readonly agoraMs: number;
}

/**
 * Reserve `quantidade` sends on the global slot and write its advance (module header, "The
 * write"). `db` a parameter, the admin handle, the RAW stored field (only `proximoSlotMs` is read).
 * A reservation past the schedule limit writes nothing (`escrito: false`, `excedeLimite`). Rejects
 * with {@link LiSlotEstoqueEmConflitoError} after the attempts, and rethrows any other failure as
 * thrown.
 */
export async function reservarSlotGlobalEstoqueLi(
  db: Firestore,
  args: {
    readonly quantidade: number;
    /** Read AFTER each read of the slot, never before. */
    readonly agoraMs: () => number;
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
    });
    if (reserva.excedeLimite) return { ...reserva, escrito: false, agoraMs };
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
