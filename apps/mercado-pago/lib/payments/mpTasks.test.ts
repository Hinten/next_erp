import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';

// Mock the transport seams: the Functions SDK (queue/enqueue) and the admin app
// binding. The scheduler's own env-driven wiring runs real.
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown) => {}),
  taskQueue: vi.fn(),
  getFunctions: vi.fn(),
}));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: (...args: unknown[]) => {
    h.getFunctions(...args);
    return { taskQueue: h.taskQueue };
  },
}));

vi.mock('../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

const { createMpTaskScheduler, MpTasksDisabledError } = await import('./mpTasks');

const payload = {
  id: 'N1',
  paymentId: '123',
  topic: 'payment',
  collectorUserId: 55,
  liveMode: true,
  dateCreated: 1_700_000_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createMpTaskScheduler', () => {
  it('enqueues onto the region-qualified processMercadoPagoNotification queue', async () => {
    vi.stubEnv('MERCADO_PAGO_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_PAGO_TASKS_REGION', 'southamerica-east1');
    const scheduler = createMpTaskScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/processMercadoPagoNotification',
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload);
  });

  it('REFUSES to enqueue when no region is configured', async () => {
    vi.stubEnv('MERCADO_PAGO_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_PAGO_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createMpTaskScheduler();

    // There is deliberately no default. The old one (us-east5) produced a
    // well-formed path to a queue that does not exist, and the Admin SDK then
    // resolved us-central1 and DROPPED the task while this call resolved
    // successfully. A throw is the only visible outcome available.
    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('treats a blank MERCADO_PAGO_TASKS_REGION as unset, not as a value', async () => {
    vi.stubEnv('MERCADO_PAGO_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_PAGO_TASKS_REGION', '');
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createMpTaskScheduler();

    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
  });

  it('falls through to FUNCTIONS_REGION when only that is set', async () => {
    vi.stubEnv('MERCADO_PAGO_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_PAGO_TASKS_REGION', '');
    vi.stubEnv('FUNCTIONS_REGION', 'us-central1');
    const scheduler = createMpTaskScheduler();
    await scheduler.enqueue(payload);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-central1/functions/processMercadoPagoNotification',
    );
  });

  it('the disabled valve throws MpTasksDisabledError instead of enqueuing', async () => {
    vi.stubEnv('MERCADO_PAGO_TASKS_DISABLED', '1');
    const scheduler = createMpTaskScheduler();
    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MpTasksDisabledError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
