import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('defaults the region to us-east1 when nothing is configured', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    // Truly unset (not empty) so the `?? default` chain falls through.
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createMlMassImportScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east1/functions/processMercadoLivreMassImport',
    );
  });

  it('treats blank MERCADO_LIVRE_TASKS_REGION as unset and falls through to default', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', '');
    vi.stubEnv('FUNCTIONS_REGION', undefined);
    const scheduler = createMlMassImportScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east1/functions/processMercadoLivreMassImport',
    );
  });

  it('IGNORES FUNCTIONS_REGION — the two are configured independently', async () => {
    // The two normally agree, but only MERCADO_LIVRE_TASKS_REGION is read by the
    // App Hosting backend, so a fallback would paper over a genuine mismatch
    // instead of failing on it. That is what it did before: pointed at a region
    // without Cloud Tasks (us-east5 has none), every enqueue resolved a queue
    // that cannot exist and the Admin SDK silently targeted us-central1. #1108
    // fixed the notification scheduler and left this one behind.
    vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'us-east5');
    const scheduler = createMlMassImportScheduler();
    await scheduler.enqueue(payload);
    expect(h.taskQueue).toHaveBeenCalledWith(
      'locations/us-east1/functions/processMercadoLivreMassImport',
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
