import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';

// Mock the transport seams: the Functions SDK (queue/enqueue) and the admin app
// binding. The scheduler's own env-driven wiring runs real. Mirrors
// mlTasks.test.ts's pattern.
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

vi.mock('../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

const { createMlStockTaskScheduler } = await import('./mlStockTasks');
const { MlTasksDisabledError } = await import('./mlTasks');

// A representative stock send-task payload (carries sweep-computed quantities —
// the schema itself lives in estoqueSend.ts; the scheduler treats it opaquely).
const payload = {
  integracaoId: 'integ-1',
  produtoId: 'prod-1',
  itemId: 'MLB123',
  kind: 'item',
  variacaoProdutoId: null,
  sweepId: 'sweep-1',
  reenqueues: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createMlStockTaskScheduler', () => {
  it('enqueues onto the region-qualified sendMercadoLivreStock queue', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', 'southamerica-east1');
    const scheduler = createMlStockTaskScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/sendMercadoLivreStock',
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload, undefined);
  });

  it('REFUSES to enqueue when nothing is configured', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createMlStockTaskScheduler();

    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('falls through to FUNCTIONS_REGION when only that is set', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'us-central1');
    const scheduler = createMlStockTaskScheduler();
    await scheduler.enqueue(payload);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-central1/functions/sendMercadoLivreStock',
    );
  });

  it('treats a blank MERCADO_LIVRE_TASKS_REGION as unset, and unset now throws', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', '');
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createMlStockTaskScheduler();

    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
  });

  it('passes scheduleDelaySeconds through to the underlying queue.enqueue (429 pause re-enqueue)', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', 'us-central1');
    const scheduler = createMlStockTaskScheduler();
    await scheduler.enqueue(payload, { scheduleDelaySeconds: 300 });
    expect(h.enqueue).toHaveBeenCalledWith(payload, { scheduleDelaySeconds: 300 });
  });

  it('the disabled valve throws the shared MlTasksDisabledError instead of enqueuing', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '1');
    const scheduler = createMlStockTaskScheduler();
    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MlTasksDisabledError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
