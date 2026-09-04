import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';
import { z } from 'zod';

import {
  MERCADO_LIVRE_NOTIFICATION_QUEUE,
  TASK_MAX_ATTEMPTS,
} from '@/lib/marketplace/notificacoes/notificacao';

/**
 * `processNotification.ts` had no test at all (#823). Its BEHAVIOUR is covered
 * one layer down, by `lib/marketplace/notificacoes/notificacao.test.ts`'s
 * `handleNotificationTask` suites — this file covers only the declared options,
 * which nothing asserted and which fail silently in production:
 *
 *  - `retryConfig.maxAttempts` must equal `TASK_MAX_ATTEMPTS`. The handler
 *    persists-instead-of-throws on `retryCount === TASK_MAX_ATTEMPTS - 1`, so
 *    if the queue is configured to give up EARLIER the last attempt is never
 *    delivered and the notification is dropped with no failure doc; if LATER,
 *    the queue keeps re-delivering a payload the handler has already recorded.
 *  - both ML secrets must be bound, or every doc throws `MercadoLivreConfigError`
 *    (the #778 failure mode, which parked the whole store in ~2.5h).
 *
 * `onTaskDispatched` records its options onto `func.__endpoint` at import time
 * without running the handler, so this is a pure config assertion — the same
 * shape as the sibling `index.test.ts`, including its FUNCTIONS_REGION stub and
 * the deliberate TOP-LEVEL import.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalMlTasksRegion = process.env.MERCADO_LIVRE_TASKS_REGION;
process.env.MERCADO_LIVRE_TASKS_REGION = 'us-central1';
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';

// Isolate the log wiring from the disposition + the admin singleton (both have
// their own coverage). `importOriginal` keeps the two constants this file already
// imports REAL while replacing only the handler.
const channel = vi.hoisted(() => ({
  handleNotificationTask: vi.fn(
    async (): Promise<Record<string, unknown>> => ({ outcome: 'done' }),
  ),
}));
vi.mock('@/lib/marketplace/notificacoes/notificacao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/marketplace/notificacoes/notificacao')>()),
  handleNotificationTask: channel.handleNotificationTask,
}));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

// ⚠️ Keep at the TOP LEVEL — see index.test.ts for why a hook would flake.
const { processMercadoLivreNotification } = await import('./processNotification');

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.MERCADO_LIVRE_TASKS_REGION = originalMlTasksRegion;
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

function endpoint(): Record<string, unknown> {
  return (processMercadoLivreNotification as unknown as { __endpoint: Record<string, unknown> })
    .__endpoint;
}

describe('processMercadoLivreNotification (#823)', () => {
  it('caps queue retries at TASK_MAX_ATTEMPTS, matching the handler’s persist-on-final-attempt rule', () => {
    const taskQueueTrigger = endpoint().taskQueueTrigger as
      | { retryConfig?: { maxAttempts?: number }; rateLimits?: Record<string, number> }
      | undefined;

    expect(taskQueueTrigger?.retryConfig?.maxAttempts).toBe(TASK_MAX_ATTEMPTS);
    // Present at all — an unbounded dispatch rate against the ML API is how a
    // notification burst turns into a 429 storm.
    expect(taskQueueTrigger?.rateLimits).toBeDefined();
  });

  it('carries the deploy-time invoker list onto taskQueueTrigger (#1133)', () => {
    // The option is what makes `firebase deploy` grant roles/run.invoker on this
    // service and roles/cloudtasks.enqueuer on its queue, instead of a human
    // remembering a gcloud command per project per function. `tasksInvoker.test.ts`
    // covers the value; this asserts it actually reaches the endpoint manifest,
    // which is the only thing firebase-tools reads.
    const taskQueueTrigger = endpoint().taskQueueTrigger as { invoker?: string[] };

    expect(taskQueueTrigger.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });

  it('binds both ML app secrets (#778 — without them every doc parks as a false transient)', () => {
    const serialized = JSON.stringify(endpoint());
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_ID');
    expect(serialized).toContain('MERCADO_LIVRE_CLIENT_SECRET');
  });

  it('is exported under the exact name the receiver enqueues against', () => {
    // `index.ts` already throws at module load on drift, which is the real
    // guard — but that runs as an import SIDE EFFECT, so nothing named it and a
    // reader could not tell it was covered. This makes it a visible assertion.
    // The hazard it guards is silent: the Admin SDK happily enqueues onto a
    // queue path that does not exist, and the task simply never arrives.
    expect(processMercadoLivreNotification).toBeDefined();
    expect(MERCADO_LIVRE_NOTIFICATION_QUEUE).toBe('processMercadoLivreNotification');
  });
});

/* ------------------------------- the log line ----------------------------- */

type RunnableTask = { data: unknown; retryCount?: number };

function run(req: RunnableTask): Promise<unknown> {
  return (
    processMercadoLivreNotification as unknown as { run(r: RunnableTask): Promise<unknown> }
  ).run(req);
}

function loggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

const RAW = { resource: '/items/MLB1', user_id: 55 };

let info: ReturnType<typeof vi.spyOn>;
let error: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
  error = vi.spyOn(logger, 'error').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  error.mockRestore();
});

/**
 * The log line was the ONE thing this file did not cover, and nothing else in
 * this app spies on `logger` — which is exactly how `topic:` came to be the only
 * field in that object without a `?? null` while `kind`, `detail` and
 * `integracaoId` all had one. `topic` is absent precisely on the shared
 * pipeline's schema-parse drop, so the key VANISHED from `jsonPayload` on the
 * delivery whose identity an operator most needs.
 *
 * Mirrors the Mercado Pago / WhatsApp copies, so all three channels are pinned
 * the same way — plus two assertions only this channel can make, since it is the
 * only one that logs a validation failure before rethrowing.
 */
describe('processMercadoLivreNotification log line', () => {
  it('reports what the delivery actually did, in ONE call', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'done',
      detail: 'no-link',
      topic: 'items',
      integracaoId: 'conta-A',
    });

    await run({ data: RAW, retryCount: 1 });

    expect(loggedPayload(info)).toEqual({
      queue: MERCADO_LIVRE_NOTIFICATION_QUEUE,
      outcome: 'done',
      kind: 'done',
      detail: 'no-link',
      topic: 'items',
      resource: '/items/MLB1',
      user_id: 55,
      integracaoId: 'conta-A',
      retryCount: 1,
      readCache: expect.anything(),
    });
  });

  it('absent TaskResult fields log as null, never as a vanished key', async () => {
    // ⚠️ THE REGRESSION THIS FILE EXISTS FOR. `topic` used to be logged bare, so
    // on the schema-parse drop below its key disappeared from `jsonPayload`
    // instead of reading as absent — Cloud Logging drops `undefined` keys.
    //
    // It must be `toHaveProperty(key, null)`, NOT the `toEqual` above: `toEqual`
    // treats an `undefined`-valued key as equal to an absent one, so the exact
    // match cannot catch a dropped `?? null`.
    channel.handleNotificationTask.mockResolvedValueOnce({ outcome: 'dropped' });

    await run({ data: RAW, retryCount: 0 });

    const payload = loggedPayload(info);
    for (const key of ['kind', 'detail', 'topic', 'integracaoId']) {
      expect(payload).toHaveProperty(key, null);
    }
  });

  it('the wire ids come off the RAW payload, so they survive a schema-parse drop', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({ outcome: 'dropped' });

    await run({ data: RAW, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.resource).toBe('/items/MLB1');
    expect(payload.user_id).toBe(55);
    expect(payload.kind).toBeNull();
  });

  it('a non-string resource / non-number user_id degrade to null, never a cast', async () => {
    await run({ data: { resource: 42, user_id: '55' }, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.resource).toBeNull();
    expect(payload.user_id).toBeNull();
  });

  it('a schema failure NAMES the fields and still rethrows', async () => {
    // #1087: `util.inspect` depth 2 swallowed the Zod `path`, so the operator saw
    // a validation error that did not say which field.
    const zodErr = z.number().safeParse('x').error!;
    channel.handleNotificationTask.mockRejectedValueOnce(zodErr);

    await expect(run({ data: RAW, retryCount: 0 })).rejects.toThrow();

    expect(error).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
    const payload = (error.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
    expect(payload.resource).toBe('/items/MLB1');
    expect(payload.user_id).toBe(55);
    expect(payload.campos).toBeTruthy();
  });

  it('a NON-validation error rethrows without inventing a campos log', async () => {
    channel.handleNotificationTask.mockRejectedValueOnce(new Error('boom'));

    await expect(run({ data: RAW, retryCount: 0 })).rejects.toThrow('boom');

    expect(error).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });
});
