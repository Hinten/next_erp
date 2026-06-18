/**
 * Unit tests for the Firebase task-queue scheduler (`createTaskScheduler`).
 * `NFE_TASKS_DISABLED=1` → no-op (sweep-only); otherwise a real scheduler that
 * enqueues the `consulta-lote` payload onto the region-qualified `reconciliarNfe`
 * queue via `firebase-admin`'s `getFunctions().taskQueue().enqueue()`. The actual
 * dispatch is integration-tested in staging (no emulator parity asserted here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn(async (_data: unknown, _opts?: { scheduleTime?: Date }) => {});
const taskQueue = vi.fn(() => ({ enqueue }));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: vi.fn(() => ({ taskQueue })),
}));
vi.mock('@/lib/firebase/admin', () => ({
  getAdminApp: vi.fn(() => ({})),
}));

import { createTaskScheduler, noopTaskScheduler } from '../../../lib/nfe/tasks';

const KEYS = ['NFE_TASKS_DISABLED', 'NFE_TASKS_REGION'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  enqueue.mockClear();
  taskQueue.mockClear();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('createTaskScheduler', () => {
  it('NFE_TASKS_DISABLED=1 → no-op scheduler (sweep-only)', () => {
    process.env.NFE_TASKS_DISABLED = '1';
    expect(createTaskScheduler()).toBe(noopTaskScheduler);
  });

  it('returns a real Firebase task-queue scheduler otherwise', () => {
    const scheduler = createTaskScheduler();
    expect(scheduler).not.toBe(noopTaskScheduler);
    expect(typeof scheduler.enqueueConsulta).toBe('function');
  });

  it('enqueues the consulta-lote payload onto the region-qualified reconciliarNfe queue', async () => {
    process.env.NFE_TASKS_REGION = 'southamerica-east1';
    const at = 1_700_000_000_000;
    await createTaskScheduler().enqueueConsulta({
      filialId: 'F1',
      nRec: 'R1',
      tpEmis: 1,
      attempt: 2,
      scheduleAtMs: at,
    });
    expect(taskQueue).toHaveBeenCalledWith('locations/southamerica-east1/functions/reconciliarNfe');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [payload, opts] = enqueue.mock.calls[0]!;
    expect(payload).toEqual({
      kind: 'consulta-lote',
      filialId: 'F1',
      nRec: 'R1',
      tpEmis: 1,
      attempt: 2,
    });
    expect(opts?.scheduleTime).toBeInstanceOf(Date);
    expect(opts?.scheduleTime?.getTime()).toBe(at);
  });

  it('defaults the queue region to us-east1 when NFE_TASKS_REGION is unset', async () => {
    await createTaskScheduler().enqueueConsulta({
      filialId: 'F',
      nRec: 'R',
      tpEmis: 6,
      attempt: 0,
      scheduleAtMs: Date.now(),
    });
    expect(taskQueue).toHaveBeenCalledWith('locations/us-east1/functions/reconciliarNfe');
  });

  it('noopTaskScheduler.enqueueConsulta resolves without side effects', async () => {
    await expect(
      noopTaskScheduler.enqueueConsulta({
        filialId: 'F-1',
        nRec: 'REC-1',
        tpEmis: 1,
        attempt: 0,
        scheduleAtMs: Date.now(),
      }),
    ).resolves.toBeUndefined();
  });
});
