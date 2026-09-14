import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions/v2';

const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';

const sweeps = vi.hoisted(() => ({
  hot: vi.fn(async () => ({ processed: 1, outcomes: { done: 1 }, errors: [] })),
  deferred: vi.fn(async () => ({
    processed: 2,
    outcomes: { deferred: 2 },
    errors: [{ docId: 'row-1', message: 'still blocked' }],
  })),
}));

vi.mock('../../lib/freight/notificacao', () => ({
  MELHOR_ENVIO_NOTIFICATION_QUEUE: 'processMelhorEnvioNotification',
  reprocessNotifications: sweeps.hot,
  reprocessDeferredNotifications: sweeps.deferred,
}));
vi.mock('./processNotification', () => ({ processMelhorEnvioNotification: vi.fn() }));
vi.mock('./lib/admin', () => ({ getDb: () => ({ __fake: 'db' }) }));
vi.mock('@delfrance/data/admin/cache', () => ({
  readCacheMark: vi.fn(() => ({ mark: true })),
  readCacheDelta: vi.fn(() => ({ hits: 1, misses: 0, loads: 0 })),
}));

const { reprocessMelhorEnvioNotifications } = await import('./index');

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
});

let info: ReturnType<typeof vi.spyOn>;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

describe('reprocessMelhorEnvioNotifications', () => {
  it('binds exactly the OAuth secrets and a sequential-label timeout', () => {
    const endpoint = (
      reprocessMelhorEnvioNotifications as unknown as { __endpoint: Record<string, unknown> }
    ).__endpoint;
    const names = (endpoint.secretEnvironmentVariables as { key?: string }[] | undefined)?.map(
      (secret) => secret.key,
    );
    expect(names).toEqual(['MELHOR_ENVIO_CLIENT_ID', 'MELHOR_ENVIO_CLIENT_SECRET']);
    expect(endpoint.timeoutSeconds).toBe(540);
  });

  it('runs and logs the hot and deferred lanes separately', async () => {
    await (
      reprocessMelhorEnvioNotifications as unknown as { run(event: unknown): Promise<void> }
    ).run({});

    expect(sweeps.hot).toHaveBeenCalledTimes(1);
    expect(sweeps.deferred).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenNthCalledWith(
      1,
      '[melhor-envio] hot reprocess sweep',
      expect.objectContaining({
        processed: 1,
        outcomes: { done: 1 },
        readCache: expect.anything(),
      }),
    );
    expect(info).toHaveBeenNthCalledWith(
      2,
      '[melhor-envio] deferred reprocess sweep',
      expect.objectContaining({
        processed: 2,
        outcomes: { deferred: 2 },
        readCache: expect.anything(),
      }),
    );
    expect(warn).toHaveBeenCalledWith(
      '[melhor-envio] deferred reprocess sweep had per-doc failures',
      { errors: [{ docId: 'row-1', message: 'still blocked' }] },
    );
  });
});
