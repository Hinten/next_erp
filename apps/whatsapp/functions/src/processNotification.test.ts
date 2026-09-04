import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { logger } from 'firebase-functions';

import { WHATSAPP_NOTIFICATION_QUEUE, TASK_MAX_ATTEMPTS } from '../../lib/whatsapp/notificacao';

/**
 * `processNotification.ts` had no test at all, and the thing it does is exactly
 * the thing that failed silently on Mercado Livre's first live run (#1087): the
 * handler reported a bare success for every delivery while nothing was being
 * written, because `outcome: 'done'` is a DISPOSITION and no other field could
 * say what had happened.
 *
 * The `kind`/`detail` contract itself is asserted one layer down, in
 * `lib/whatsapp/notificacao.test.ts`. What is asserted HERE is the part that
 * lives only in this file — the shape of the log line — because deleting a field
 * from it silently restores the blindness and reds nothing else in the repo.
 *
 * ⚠️ One assertion below is a PRIVACY guard, not an observability one: the raw
 * change `value` carries message content, and the handler must never widen its
 * narrow `req.data` cast into a spread.
 *
 * `tasksInvoker.ts` reads `TASKS_INVOKER_SA` at module scope, so stub it before
 * the dynamic import and restore it afterwards so it cannot leak into other
 * files sharing this vitest project. Mirrors the sibling pattern in
 * `sendOutbound.test.ts`.
 */
const originalFunctionsRegion = process.env.FUNCTIONS_REGION;
process.env.FUNCTIONS_REGION = 'us-central1';
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA =
  'apphosting@p.iam.gserviceaccount.com,1-compute@developer.gserviceaccount.com';

afterAll(() => {
  process.env.FUNCTIONS_REGION = originalFunctionsRegion;
  process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

// Isolate the log wiring from the disposition + the admin singleton (both have
// their own coverage).
const channel = vi.hoisted(() => ({
  handleNotificationTask: vi.fn(
    async (): Promise<Record<string, unknown>> => ({
      outcome: 'done',
    }),
  ),
}));
vi.mock('../../lib/whatsapp/notificacao', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/whatsapp/notificacao')>()),
  handleNotificationTask: channel.handleNotificationTask,
}));

const admin = vi.hoisted(() => ({ db: { __fake: 'db' } }));
vi.mock('./lib/admin', () => ({ getDb: () => admin.db }));

const { processWhatsappNotification } = await import('./processNotification');

type RunnableTask = { data: unknown; retryCount?: number };

function run(req: RunnableTask): Promise<unknown> {
  return (processWhatsappNotification as unknown as { run(r: RunnableTask): Promise<unknown> }).run(
    req,
  );
}

/** The single `logger.info` payload the handler emitted. */
function loggedPayload(spy: ReturnType<typeof vi.spyOn>): Record<string, unknown> {
  expect(spy).toHaveBeenCalledTimes(1);
  return (spy.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
}

const RAW = {
  field: 'messages',
  messageId: 'wamid.A',
  phoneNumberId: 'PNID1',
  value: { messages: [{ from: '5511999999999', text: { body: 'segredo do cliente' } }] },
};

let info: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  info = vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
});

describe('processWhatsappNotification log line', () => {
  it('reports what the change actually did, in ONE call', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'processed',
      detail: 'mensagens',
      field: 'messages',
      contaId: 'conta-1',
    });

    await run({ data: RAW, retryCount: 2 });

    // ONE call on purpose — the fields land in `jsonPayload` and are filterable,
    // so more fields beat more lines.
    expect(loggedPayload(info)).toEqual({
      queue: WHATSAPP_NOTIFICATION_QUEUE,
      outcome: 'done',
      kind: 'processed',
      detail: 'mensagens',
      field: 'messages',
      messageId: 'wamid.A',
      phoneNumberId: 'PNID1',
      contaId: 'conta-1',
      retryCount: 2,
      readCache: expect.anything(),
    });
  });

  it('⚠️ NEVER logs the change `value` — it carries message content', async () => {
    await run({ data: RAW, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload).not.toHaveProperty('value');
    // Belt and braces: the customer's text must not reach the log under ANY key.
    expect(JSON.stringify(payload)).not.toContain('segredo do cliente');
    expect(JSON.stringify(payload)).not.toContain('5511999999999');
  });

  it('a change that did nothing is distinguishable from one that wrote a mensagem', async () => {
    channel.handleNotificationTask.mockResolvedValueOnce({
      outcome: 'done',
      kind: 'processed',
      detail: 'vazio',
      field: 'messages',
      contaId: 'conta-1',
    });

    await run({ data: RAW, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.outcome).toBe('done');
    expect(payload.detail).toBe('vazio');
  });

  it('absent TaskResult fields log as null, never as a vanished key', async () => {
    // Cloud Logging DROPS `undefined` keys, so a key that is filterable-as-absent
    // beats one that disappears from `jsonPayload` entirely.
    channel.handleNotificationTask.mockResolvedValueOnce({ outcome: 'dropped' });

    await run({ data: RAW, retryCount: 0 });

    const payload = loggedPayload(info);
    for (const key of ['kind', 'detail', 'field', 'contaId']) {
      expect(payload).toHaveProperty(key, null);
    }
  });

  it('the wire ids come off the RAW payload, so they survive a schema-parse drop', async () => {
    // The shared pipeline's parse drop returns neither a validated payload nor a
    // channel result — the very delivery whose ids you most need named.
    channel.handleNotificationTask.mockResolvedValueOnce({ outcome: 'dropped' });

    await run({ data: RAW, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.messageId).toBe('wamid.A');
    expect(payload.phoneNumberId).toBe('PNID1');
    expect(payload.kind).toBeNull();
  });

  it('non-string wire ids degrade to null, never a cast', async () => {
    await run({ data: { messageId: 42, phoneNumberId: null }, retryCount: 0 });

    const payload = loggedPayload(info);
    expect(payload.messageId).toBeNull();
    expect(payload.phoneNumberId).toBeNull();
  });
});

describe('processWhatsappNotification declared options', () => {
  /**
   * `retryConfig.maxAttempts` must equal `TASK_MAX_ATTEMPTS`. The handler
   * persists-instead-of-throws on `retryCount === TASK_MAX_ATTEMPTS - 1`, so a
   * queue configured to give up EARLIER never delivers the last attempt and the
   * notification is dropped with no failure doc; configured LATER, the queue
   * keeps re-delivering a payload the handler has already recorded.
   */
  const endpoint = (
    processWhatsappNotification as unknown as { __endpoint: Record<string, unknown> }
  ).__endpoint;

  it('gives up exactly when the handler starts persisting', () => {
    const trigger = endpoint.taskQueueTrigger as { retryConfig?: { maxAttempts?: number } };
    expect(trigger.retryConfig?.maxAttempts).toBe(TASK_MAX_ATTEMPTS);
  });

  it('declares the invoker, the leg whose absence fails invisibly (#1133)', () => {
    const trigger = endpoint.taskQueueTrigger as { invoker?: string[] };
    expect(trigger.invoker).toEqual([
      'apphosting@p.iam.gserviceaccount.com',
      '1-compute@developer.gserviceaccount.com',
    ]);
  });

  it('the export name IS the queue name — a half-applied rename cannot ship', () => {
    // `__endpoint.id` is filled in by Firebase's codebase analysis from the
    // EXPORT name, which is not running here — so pin the constant against the
    // literal instead, as the Mercado Livre sibling does. The hazard it guards is
    // silent: the Admin SDK happily enqueues onto a queue path that does not
    // exist, and the task simply never arrives.
    expect(processWhatsappNotification).toBeDefined();
    expect(WHATSAPP_NOTIFICATION_QUEUE).toBe('processWhatsappNotification');
  });
});
