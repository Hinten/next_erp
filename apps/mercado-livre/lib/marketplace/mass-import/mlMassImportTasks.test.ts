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

vi.mock('../../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

const { createMlMassImportScheduler, MlMassImportTasksDisabledError } =
  await import('./mlMassImportTasks');

const payload = { jobId: 'job-1', integracaoId: 'integ-1' };

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('createMlMassImportScheduler', () => {
  it('enqueues onto the region-qualified processMercadoLivreMassImport queue', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', 'southamerica-east1');
    const scheduler = createMlMassImportScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/southamerica-east1/functions/processMercadoLivreMassImport',
    );
    expect(h.enqueue).toHaveBeenCalledWith(payload);
  });

  it('REFUSES to enqueue when nothing is configured', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createMlMassImportScheduler();

    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('falls through to FUNCTIONS_REGION when only that is set', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'us-central1');
    const scheduler = createMlMassImportScheduler();
    await scheduler.enqueue(payload);

    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-central1/functions/processMercadoLivreMassImport',
    );
  });

  it('the disabled valve throws MlMassImportTasksDisabledError instead of enqueuing', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '1');
    const scheduler = createMlMassImportScheduler();
    await expect(scheduler.enqueue(payload)).rejects.toBeInstanceOf(MlMassImportTasksDisabledError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
