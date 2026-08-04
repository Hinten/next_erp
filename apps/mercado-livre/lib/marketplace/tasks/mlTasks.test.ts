import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the transport seams: the Functions SDK (queue/enqueue) and the admin app
// binding. The scheduler's own env-driven wiring runs real. Mirrors
// mlMassImportTasks.test.ts's pattern.
const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown, _opts?: unknown) => {}),
  taskQueue: vi.fn(),
  getFunctions: vi.fn(),
}));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: (...args: unknown[]) => {
    h.getFunctions(...args);
    return { taskQueue: h.taskQueue };
  },
}));

vi.mock('../../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

const { createMlTaskScheduler, MlTasksDisabledError } = await import('./mlTasks');

const payload = {
  id: 'N1',
  resource: '/orders/123',
  topic: 'orders_v2',
  user_id: 55,
  application_id: 999,
  attempts: 1,
  sent: 1_700_000_000_000,
  received: 1_700_000_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createMlTaskScheduler', () => {
  it('enqueues onto the region-qualified processMercadoLivreNotification queue', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', 'southamerica-east1');
    const scheduler = createMlTaskScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/processMercadoLivreNotification',
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload, undefined);
  });

  it('defaults the region to us-east5 when nothing is configured', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    // Truly unset (not empty) so the `?? default` chain falls through.
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createMlTaskScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east5/functions/processMercadoLivreNotification',
    );
  });

  it('passes scheduleDelaySeconds through to the underlying queue.enqueue (order-family delay, Step 9)', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    const scheduler = createMlTaskScheduler();
    await scheduler.enqueue(payload, { scheduleDelaySeconds: 10 });
    expect(h.enqueue).toHaveBeenCalledWith(payload, { scheduleDelaySeconds: 10 });
  });

  it('the disabled valve throws MlTasksDisabledError instead of enqueuing', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '1');
    const scheduler = createMlTaskScheduler();
    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MlTasksDisabledError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
