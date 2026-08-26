import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MlTaskScheduler } from '../notificacoes/mlTasks';
import {
  BOOTSTRAP_SCHEDULE_DELAY_SECONDS,
  agendarBootstrapPedido,
  buildBootstrapOrderPayload,
} from './pendingOrderBootstrap';
import { decidirBootstrapPedido, pedidoBootstrapMaxAgeMs } from './orderPaymentImport';

/** A scheduler that only COUNTS — the loop guard's whole instrument. */
function fakeScheduler() {
  const enqueue = vi.fn<MlTaskScheduler['enqueue']>(async () => {});
  return { scheduler: { enqueue } satisfies MlTaskScheduler, enqueue };
}

const HORA_US = 3_600_000_000;

beforeEach(() => {
  delete process.env.MERCADO_LIVRE_TASKS_DISABLED;
  delete process.env.MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H;
});
afterEach(() => {
  delete process.env.MERCADO_LIVRE_TASKS_DISABLED;
  delete process.env.MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H;
  vi.restoreAllMocks();
});

describe('buildBootstrapOrderPayload', () => {
  it('addresses the ORDER topic, so orderImport stays the only pedido creator', () => {
    expect(buildBootstrapOrderPayload({ orderId: 424242, userId: 55 })).toMatchObject({
      topic: 'orders_v2',
      resource: '/orders/424242',
      user_id: 55,
    });
  });

  it('carries id: null — the derived doc id is what keys the dedup ON THE ORDER', () => {
    // ⚠️ Load-bearing, exactly as in `orderBackfill.ts`. No ML event stands behind
    // a synthesised notification, so claiming an id would be a lie — AND the
    // pipeline's `docIdOf` is `p.id ?? derivedDocId(p)`, so a synthesised id would
    // key the failure doc on the PAYMENT (which ML redelivers, and of which one
    // order can have several) instead of on the order. Every delivery for one
    // order must collapse onto `orders_v2:_orders_<id>`.
    const a = buildBootstrapOrderPayload({ orderId: 99, userId: 55 });
    const b = buildBootstrapOrderPayload({ orderId: 99, userId: 55 });
    expect(a.id).toBeNull();
    expect(a.resource).toBe(b.resource);
    expect(a.topic).toBe(b.topic);
  });

  it('carries no ML delivery metadata it did not receive', () => {
    const p = buildBootstrapOrderPayload({ orderId: 1, userId: null });
    expect(p).toMatchObject({ application_id: null, attempts: null, sent: null, actions: null });
    expect(p.received).toBeNull();
    expect(buildBootstrapOrderPayload({ orderId: 1, userId: 1, recebidoMs: 123 }).received).toBe(
      123,
    );
  });
});

describe('agendarBootstrapPedido', () => {
  it('enqueues once, with the delay', async () => {
    const { scheduler, enqueue } = fakeScheduler();
    const r = await agendarBootstrapPedido({ orderId: 7, userId: 55 }, { scheduler });
    expect(r).toBe('agendado');
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ topic: 'orders_v2', resource: '/orders/7' }),
      { scheduleDelaySeconds: BOOTSTRAP_SCHEDULE_DELAY_SECONDS },
    );
  });

  it('pins the delay STATICALLY — no lane can observe it', () => {
    // The tasks emulator's dispatch loop is pure FIFO with no `scheduleTime`
    // predicate (`firebase-tools#8254`, open), so the round-trip lane runs this
    // value without ever exercising it. A static pin is the only guard there is.
    //
    // 60s, not 0 and not minutes: the receiver already delays the order family
    // 10s, so on an ordinary paid order the real `orders_v2` lands first and this
    // bootstrap degrades to a no-op. Longer only widens the window in which the
    // unit is unreserved.
    expect(BOOTSTRAP_SCHEDULE_DELAY_SECONDS).toBe(60);
  });

  it('degrades (never throws) when the tasks valve is off — sweep-only mode still works', async () => {
    process.env.MERCADO_LIVRE_TASKS_DISABLED = '1';
    // No injected scheduler: this exercises the REAL `createMlTaskScheduler`,
    // which is what makes the valve observable at all.
    await expect(agendarBootstrapPedido({ orderId: 7, userId: 55 })).resolves.toBe(
      'tasks-desabilitado',
    );
  });

  it('propagates any OTHER enqueue failure — transient, the queue must retry', async () => {
    const enqueue = vi.fn<MlTaskScheduler['enqueue']>(async () => {
      throw new Error('DEADLINE_EXCEEDED');
    });
    await expect(
      agendarBootstrapPedido({ orderId: 7, userId: 55 }, { scheduler: { enqueue } }),
    ).rejects.toThrow('DEADLINE_EXCEEDED');
  });
});

/**
 * THE LOOP GUARD.
 *
 * A payment whose order never becomes visible must not re-enqueue forever. This
 * composes the two real halves of the production path — the guard in
 * `decidirBootstrapPedido` and the enqueue in `agendarBootstrapPedido` — and
 * drives them through the never-appears scenario with a scheduler that only
 * counts.
 *
 * ⚠️ Mutation-proven: making `decidirBootstrapPedido` always return `'bootstrap'`
 * turns the bounded counts below into one enqueue per delivery, forever.
 */
describe('the bootstrap chain is bounded (#1087 loop guard)', () => {
  const T0 = Date.parse('2026-08-24T19:00:00.000Z') * 1000;

  /** One `payments` delivery for an order that never appears. */
  async function entregar(deps: {
    scheduler: MlTaskScheduler;
    nowUs: number;
    statusMl?: string;
  }): Promise<void> {
    const veredito = decidirBootstrapPedido({
      criadoUs: T0,
      statusMl: deps.statusMl ?? 'pending',
      nowUs: deps.nowUs,
    });
    if (veredito !== 'bootstrap') return;
    // Always the SAME order — that is the point of keying the dedup on it.
    await agendarBootstrapPedido({ orderId: 424242, userId: 55 }, { scheduler: deps.scheduler });
  }

  it('stops enqueuing once the payment ages out — an order that NEVER appears', async () => {
    const { scheduler, enqueue } = fakeScheduler();
    const maxAgeUs = pedidoBootstrapMaxAgeMs() * 1000;

    // 400 deliveries at 30-minute intervals — ML redeliveries, hot-sweep
    // re-drives and `missed_feeds` replays all folded together. That spans well
    // past the 72h horizon.
    let enfileiradasDentroDaJanela = 0;
    for (let i = 0; i < 400; i += 1) {
      const nowUs = T0 + i * 1800 * 1_000_000;
      if (nowUs - T0 <= maxAgeUs) enfileiradasDentroDaJanela += 1;
      await entregar({ scheduler, nowUs });
    }

    expect(enqueue).toHaveBeenCalledTimes(enfileiradasDentroDaJanela);
    // The bound is real, not just "fewer than 400".
    expect(enqueue.mock.calls.length).toBeLessThan(400);

    // And it STAYS stopped — the guard is not a rate limiter.
    const antes = enqueue.mock.calls.length;
    await entregar({ scheduler, nowUs: T0 + maxAgeUs * 10 });
    expect(enqueue).toHaveBeenCalledTimes(antes);
  });

  it('stops immediately when ML reports the payment dead — terminate on death', async () => {
    const { scheduler, enqueue } = fakeScheduler();
    for (let i = 0; i < 20; i += 1) {
      await entregar({ scheduler, nowUs: T0 + i * 60 * 1_000_000, statusMl: 'cancelled' });
    }
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('every enqueue in a chain addresses ONE order, so the failure docs collapse', async () => {
    const { scheduler, enqueue } = fakeScheduler();
    for (let i = 0; i < 5; i += 1) {
      await entregar({ scheduler, nowUs: T0 + i * 60 * 1_000_000 });
    }
    const resources = new Set(
      enqueue.mock.calls.map(([p]) => `${p.topic}:${p.resource}:${String(p.id)}`),
    );
    expect(enqueue.mock.calls.length).toBe(5);
    expect(resources.size).toBe(1);
  });

  it('a shorter horizon shortens the chain — the bound IS the constant', async () => {
    process.env.MERCADO_LIVRE_PEDIDO_BOOTSTRAP_MAX_AGE_H = '1';
    const { scheduler, enqueue } = fakeScheduler();
    for (let i = 0; i < 400; i += 1) {
      await entregar({ scheduler, nowUs: T0 + i * 1800 * 1_000_000 });
    }
    // 1h horizon at 30-min steps: offsets 0 and 1800s both qualify.
    expect(enqueue).toHaveBeenCalledTimes(3);
  });
});
