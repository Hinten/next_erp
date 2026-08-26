/**
 * Pedido bootstrap for a payment whose order the ERP has not discovered yet
 * (#1087).
 *
 * ML fires `orders_v2` only for *"vendas confirmadas"*, and the seller-scoped
 * `/orders/search` filters on `hidden_for_seller`. So a `payment_in_process`
 * order — which EXISTS — notifies nothing and searches empty, while its Mercado
 * Pago payment notifies immediately. Before this module the payment was dropped
 * (`pedido-nao-encontrado`, acked `done`), so there was no pedido, therefore no
 * stock reservation, while the buyer held the unit.
 *
 * ⚠️ **This module creates no pedido.** It enqueues a SYNTHETIC `orders_v2`
 * notification for `/orders/{orderId}`, so `orderImport.ts` stays the single
 * pedido creator. The payload shape is the one `notificacoes/orderBackfill.ts`
 * already produces — including `id: null`, which is deliberate in both places:
 * no ML event stands behind a synthesised notification, and claiming an id would
 * be a lie.
 *
 * ## Why routing through `orders_v2` IS the retry design
 *
 * Every bound this needs is inherited rather than invented — no parallel counter:
 *
 *  - **Attempts are bounded.** The synthetic is an ordinary notification task:
 *    `TASK_MAX_ATTEMPTS` queue attempts, then a `failed` doc the hot sweep
 *    re-drives up to `MAX_TENTATIVAS` times, then `parked`.
 *  - **Deduped ON THE ORDER, not the payment.** ML redelivers a payment
 *    repeatedly (two deliveries four minutes apart in the #1087 evidence) and one
 *    order can carry several payments. The synthetic carries no ML id, so the
 *    pipeline's `docIdOf` falls back to `derivedDocId` = `orders_v2:_orders_<id>`
 *    — every delivery for one order collapses onto ONE failure doc, and
 *    `store.create` swallows the `ALREADY_EXISTS`.
 *  - **No cycle can exist.** The `orders_v2` handler cannot re-enter the
 *    `payments` branch, so a synthetic can never enqueue another synthetic. The
 *    only producer is a fresh `payments` delivery, and those are themselves
 *    bounded by the guards in `orderPaymentImport.ts`.
 *  - **It terminates on success.** Once the pedido exists,
 *    `resolvePedidoIdByOrderId` finds it and this path is never reached again.
 *
 * ## The delay
 *
 * {@link BOOTSTRAP_SCHEDULE_DELAY_SECONDS} is 60s, not 0 and not minutes. The
 * receiver already delays the whole order family 10s
 * (`REFETCH_SCHEDULE_DELAY_SECONDS`), so on an ORDINARY paid order the real
 * `orders_v2` has landed well inside a minute and this bootstrap degrades to a
 * no-op instead of a redundant import. Longer would only widen the window in
 * which the unit is unreserved — and in the case this exists for, `orders_v2`
 * never arrives at all, so waiting buys nothing.
 *
 * ⚠️ The tasks emulator ignores `scheduleDelaySeconds` entirely (its dispatch
 * loop is pure FIFO with no `scheduleTime` predicate — `firebase-tools#8254`,
 * open), so the round-trip lane can never observe this value. It is pinned by a
 * STATIC assertion in `pendingOrderBootstrap.test.ts`, the same way
 * `mlTasks.test.ts` and the receiver's route test pin theirs.
 *
 * Race discipline (root `CLAUDE.md` rule 7): **tier 0 — the race is made
 * impossible.** The synthetic and a real `orders_v2` both enter
 * `discoverPedidoMercadoLivre`, which reads the deterministic target ref INSIDE
 * its own transaction and branches create/update off that read. OCC validates the
 * read set, so the loser re-runs and takes the update branch. The doc id is
 * `sha256(mercadoLivre{contaId}-{packId ?? orderId})` — identical from either
 * entry point. This module runs no transaction of its own.
 */
import type { MlNotificationPayload } from '../notificacoes/notificacao';
import {
  MlTasksDisabledError,
  createMlTaskScheduler,
  type MlTaskScheduler,
} from '../notificacoes/mlTasks';

/**
 * Delay before the synthetic `orders_v2` is first attempted. See the module doc
 * for why 60s, and why no lane can observe it.
 */
export const BOOTSTRAP_SCHEDULE_DELAY_SECONDS = 60;

export interface PendingOrderBootstrapDeps {
  /**
   * The notification-queue enqueue seam. Defaults to the real Cloud Tasks
   * scheduler, built PER CALL like every other scheduler use in this app, so the
   * `MERCADO_LIVRE_TASKS_DISABLED` valve is read at call time rather than at
   * module load. A test substitutes a counting fake.
   */
  scheduler?: MlTaskScheduler;
}

export interface PendingOrderBootstrapArgs {
  /** The ML order key the payment resolved to (`external_reference ?? order_id`). */
  orderId: number;
  /** The ML seller — the synthetic must resolve back to the same conta. */
  userId: number | null;
  /** ML's `received` stamp, in ms, when the originating payload carried one. */
  recebidoMs?: number | null;
}

/**
 * The synthetic `orders_v2` payload. Kept separate from the enqueue so a test can
 * assert its shape without a scheduler, and so the `id: null` decision sits in
 * one readable place.
 *
 * ⚠️ `id: null` is load-bearing — see the module doc. Do not "fix" it to a
 * synthesised id: the pipeline's `derivedDocId` fallback is what keys the dedup
 * on the ORDER, and an invented id would key it on nothing.
 */
export function buildBootstrapOrderPayload(args: PendingOrderBootstrapArgs): MlNotificationPayload {
  return {
    id: null,
    resource: `/orders/${args.orderId}`,
    topic: 'orders_v2',
    user_id: args.userId,
    application_id: null,
    attempts: null,
    sent: null,
    received: args.recebidoMs ?? null,
    // Synthesised here, so there is no ML subtopic array to carry.
    actions: null,
  };
}

/** What {@link agendarBootstrapPedido} did. */
export type BootstrapAgendamento = 'agendado' | 'tasks-desabilitado';

/**
 * Enqueue the synthetic `orders_v2` that will create the pedido.
 *
 * Returns `'tasks-desabilitado'` rather than throwing when the
 * `MERCADO_LIVRE_TASKS_DISABLED` valve is on: in sweep-only mode there is no
 * queue to enqueue onto, and turning that into a thrown error would burn the
 * payment notification's whole retry budget over a deployment mode. Every other
 * failure PROPAGATES, per this channel's throw-on-transient discipline.
 */
export async function agendarBootstrapPedido(
  args: PendingOrderBootstrapArgs,
  deps: PendingOrderBootstrapDeps = {},
): Promise<BootstrapAgendamento> {
  const payload = buildBootstrapOrderPayload(args);
  const scheduler = deps.scheduler ?? createMlTaskScheduler();
  try {
    await scheduler.enqueue(payload, {
      scheduleDelaySeconds: BOOTSTRAP_SCHEDULE_DELAY_SECONDS,
    });
  } catch (err) {
    if (err instanceof MlTasksDisabledError) {
      console.warn(
        '[mercado-livre] bootstrap do pedido não enfileirado — MERCADO_LIVRE_TASKS_DISABLED',
        { orderId: args.orderId, userId: args.userId },
      );
      return 'tasks-desabilitado';
    }
    throw err;
  }
  console.warn('[mercado-livre] pedido ausente para a order — bootstrap agendado', {
    orderId: args.orderId,
    userId: args.userId,
    atrasoSegundos: BOOTSTRAP_SCHEDULE_DELAY_SECONDS,
  });
  return 'agendado';
}
