import { afterAll, describe, expect, it } from 'vitest';

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
process.env.FUNCTIONS_REGION = 'us-east5';
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';

// ⚠️ Keep at the TOP LEVEL — see index.test.ts for why a hook would flake.
const { processMercadoLivreNotification } = await import('./processNotification');

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
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
