/**
 * The drift backstop for the ML task queue region.
 *
 * Every ML enqueuer resolves ONE region, because every ML `onTaskDispatched`
 * function is deployed into one (`TASKS_SCHEDULER_REGION`). Before this test
 * the resolver was copy-pasted into all five schedulers, #1108 fixed exactly
 * one of the copies, and nothing went red: the four stale copies had their own
 * tests pinning the stale default. Four queues therefore pointed at `us-east5`,
 * where Cloud Tasks does not exist at all.
 *
 * So this asserts the property the per-file tests structurally cannot — that
 * the five agree — by driving every scheduler through the same mocked
 * transport and comparing the `locations/<region>/` segment each one produced.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  enqueue: vi.fn(async (_payload: unknown) => {}),
  taskQueue: vi.fn(),
}));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: () => ({ taskQueue: h.taskQueue }),
}));

vi.mock('../firebase/admin', () => ({ getAdminApp: () => ({ __app: true }) }));

const { createMlTaskScheduler } = await import('./mlTasks');
const { createMlMassImportScheduler } = await import('./mlMassImportTasks');
const { createMlStockTaskScheduler } = await import('./mlStockTasks');
const { createMlPriceSyncScheduler } = await import('./mlPriceSyncTasks');
const { createMlNfeUploadScheduler } = await import('./mlNfeUploadTasks');
const { mlTasksRegion, mlQueuePath } = await import('./mlTasksRegion');

/**
 * One entry per ML queue. The payloads are shaped enough to satisfy each
 * scheduler's parameter type; none of them reaches the (mocked) transport, and
 * none of them can influence the queue path under test.
 */
const ENQUEUERS = [
  {
    queue: 'processMercadoLivreNotification',
    run: () =>
      createMlTaskScheduler().enqueue({
        id: null,
        topic: 'items',
        resource: '/items/MLB1',
        user_id: 1,
        application_id: null,
        attempts: null,
        sent: null,
        received: null,
        actions: null,
      }),
  },
  {
    queue: 'processMercadoLivreMassImport',
    run: () => createMlMassImportScheduler().enqueue({ jobId: 'j', integracaoId: 'i' }),
  },
  {
    queue: 'sendMercadoLivreStock',
    run: () => createMlStockTaskScheduler().enqueue({}),
  },
  {
    queue: 'processMercadoLivrePriceSync',
    run: () => createMlPriceSyncScheduler().enqueue({ jobId: 'j', integracaoId: 'i' }),
  },
  {
    queue: 'processMercadoLivreNfeUpload',
    run: () => createMlNfeUploadScheduler().enqueue({ pedidoId: 'p', nfeId: 'n' }),
  },
] as const;

/** The `locations/<region>/` segment the scheduler actually asked the SDK for. */
async function regionUsedBy(run: () => Promise<void>): Promise<string> {
  h.taskQueue.mockClear();
  await run();
  const path = h.taskQueue.mock.calls[0]?.[0];
  if (typeof path !== 'string') throw new Error('taskQueue was not called with a queue path');
  const region = /^locations\/([^/]+)\/functions\//.exec(path)?.[1];
  if (!region) throw new Error(`queue path is not region-qualified: ${path}`);
  return region;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
  vi.stubEnv('MERCADO_LIVRE_TASKS_DISABLED', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('mlTasksRegion', () => {
  it('defaults to us-east1 — Cloud Tasks does not exist in the codebase region', () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'us-east5');
    expect(mlTasksRegion()).toBe('us-east1');
  });

  it('treats a blank value as unset', () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', '   ');
    expect(mlTasksRegion()).toBe('us-east1');
  });

  it('builds a region-qualified queue path', () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', 'southamerica-east1');
    expect(mlQueuePath('someQueue')).toBe('locations/southamerica-east1/functions/someQueue');
  });
});

describe('every ML enqueuer resolves the SAME region', () => {
  it('agrees on the default when nothing is configured', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', undefined);

    const seen: Record<string, string> = {};
    for (const { queue, run } of ENQUEUERS) seen[queue] = await regionUsedBy(run);

    // Asserted as a whole object so a failure names WHICH queue drifted.
    expect(seen).toEqual({
      processMercadoLivreNotification: 'us-east1',
      processMercadoLivreMassImport: 'us-east1',
      sendMercadoLivreStock: 'us-east1',
      processMercadoLivrePriceSync: 'us-east1',
      processMercadoLivreNfeUpload: 'us-east1',
    });
  });

  it('agrees when MERCADO_LIVRE_TASKS_REGION is set', async () => {
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', 'us-central1');
    vi.stubEnv('FUNCTIONS_REGION', 'us-east5');

    const regions = new Set<string>();
    for (const { run } of ENQUEUERS) regions.add(await regionUsedBy(run));

    expect([...regions]).toEqual(['us-central1']);
  });

  it('none of them honours FUNCTIONS_REGION', async () => {
    // The exact failure #1108 half-fixed: a backend whose FUNCTIONS_REGION
    // names the DATA region silently aimed four of the five queues at a region
    // with no Cloud Tasks service.
    vi.stubEnv('MERCADO_LIVRE_TASKS_REGION', undefined);
    vi.stubEnv('FUNCTIONS_REGION', 'us-east5');

    for (const { queue, run } of ENQUEUERS) {
      expect(`${queue}:${await regionUsedBy(run)}`).toBe(`${queue}:us-east1`);
    }
  });
});
