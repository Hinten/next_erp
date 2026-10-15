/**
 * Unit tests for the Firebase task-queue scheduler (`createTaskScheduler`).
 * `NFE_TASKS_DISABLED=1` → no-op (sweep-only); otherwise a real scheduler that
 * enqueues the `consulta-lote` payload onto the region-qualified `reconciliarNfe`
 * queue via `firebase-admin`'s `getFunctions().taskQueue().enqueue()`. The actual
 * dispatch is integration-tested in staging (no emulator parity asserted here).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn(async (_data: unknown, _opts?: { scheduleTime?: Date }) => {});
const taskQueue = vi.fn(() => ({ enqueue }));

vi.mock('firebase-admin/functions', () => ({
  getFunctions: vi.fn(() => ({ taskQueue })),
}));

import { AppErrorCode, FirebaseAppError } from 'firebase-admin/app';
import { gaxios } from 'google-auth-library';

import {
  createTaskScheduler,
  NFeTasksEnqueueError,
  noopTaskScheduler,
  type TaskScheduler,
} from '../../../lib/nfe/tasks';
import { MissingRegionError } from '@delfrance/core/region';

const KEYS = ['NFE_TASKS_DISABLED', 'NFE_TASKS_REGION'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
  enqueue.mockClear();
  taskQueue.mockClear();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('createTaskScheduler', () => {
  it('NFE_TASKS_DISABLED=1 → no-op scheduler (sweep-only)', () => {
    process.env.NFE_TASKS_DISABLED = '1';
    expect(createTaskScheduler()).toBe(noopTaskScheduler);
  });

  it('returns a real Firebase task-queue scheduler otherwise', () => {
    const scheduler = createTaskScheduler();
    expect(scheduler).not.toBe(noopTaskScheduler);
    expect(typeof scheduler.enqueueConsulta).toBe('function');
  });

  it('enqueues the consulta-lote payload onto the region-qualified reconciliarNfe queue', async () => {
    process.env.NFE_TASKS_REGION = 'southamerica-east1';
    const at = 1_700_000_000_000;
    await createTaskScheduler().enqueueConsulta({
      filialId: 'F1',
      nRec: 'R1',
      tpEmis: 1,
      attempt: 2,
      scheduleAtMs: at,
    });
    expect(taskQueue).toHaveBeenCalledWith('locations/southamerica-east1/functions/reconciliarNfe');
    expect(enqueue).toHaveBeenCalledTimes(1);
    const [payload, opts] = enqueue.mock.calls[0]!;
    expect(payload).toEqual({
      kind: 'consulta-lote',
      filialId: 'F1',
      nRec: 'R1',
      tpEmis: 1,
      attempt: 2,
    });
    expect(opts?.scheduleTime).toBeInstanceOf(Date);
    expect(opts?.scheduleTime?.getTime()).toBe(at);
  });

  it('REFUSES to enqueue when NFE_TASKS_REGION is unset', async () => {
    // No default, and deliberately no FUNCTIONS_REGION fall-through either:
    // apps/nfe's backend has no region of its own to borrow, so guessing would
    // enqueue into a queue that does not exist and drop the reconcile silently.
    await expect(
      createTaskScheduler().enqueueConsulta({
        filialId: 'F',
        nRec: 'R',
        tpEmis: 6,
        attempt: 0,
        scheduleAtMs: Date.now(),
      }),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(taskQueue).not.toHaveBeenCalled();
  });

  it('treats a blank NFE_TASKS_REGION as unset, and unset now throws', async () => {
    process.env.NFE_TASKS_REGION = '';
    await expect(
      createTaskScheduler().enqueueConsulta({
        filialId: 'F',
        nRec: 'R',
        tpEmis: 6,
        attempt: 0,
        scheduleAtMs: Date.now(),
      }),
    ).rejects.toBeInstanceOf(MissingRegionError);
  });

  it('noopTaskScheduler.enqueueConsulta resolves without side effects', async () => {
    await expect(
      noopTaskScheduler.enqueueConsulta({
        filialId: 'F-1',
        nRec: 'REC-1',
        tpEmis: 1,
        attempt: 0,
        scheduleAtMs: Date.now(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe('a failed enqueue (#1654)', () => {
  const consulta = {
    filialId: 'F1',
    nRec: 'R1',
    tpEmis: 1 as const,
    attempt: 0,
    scheduleAtMs: 1_700_000_000_000,
  };
  const cce = {
    pedidoId: 'P1',
    nfeId: 'N1',
    cceId: 'C1',
    nSeqEvento: 1,
    attempt: 0,
    scheduleAtMs: 1_700_000_000_000,
  };
  const url = 'http://169.254.169.254/computeMetadata/v1/instance/service-accounts/default/email';
  /** What the Admin SDK rethrows raw when the metadata server's lookup fails. */
  const falhaDoMetadata = () =>
    new gaxios.GaxiosError(
      `request to ${url} failed, reason: connect ETIMEDOUT`,
      { url: new URL(url), headers: new Headers() } as never,
      undefined,
      Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    );

  beforeEach(() => {
    process.env.NFE_TASKS_REGION = 'southamerica-east1';
  });

  it.each([
    ['enqueueConsulta', (s: TaskScheduler) => s.enqueueConsulta(consulta), 'consulta-lote'],
    ['enqueueCceVinculo', (s: TaskScheduler) => s.enqueueCceVinculo(cce), 'cce-vinculo'],
  ] as const)(
    '%s: a GaxiosError the SDK let through raw becomes NFeTasksEnqueueError, cause kept',
    async (_metodo, enfileirar, kind) => {
      const falha = falhaDoMetadata();
      enqueue.mockRejectedValueOnce(falha);
      const err = await enfileirar(createTaskScheduler()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(NFeTasksEnqueueError);
      expect((err as NFeTasksEnqueueError).cause).toBe(falha);
      expect((err as Error).message).toContain(falha.message);
      expect((err as Error).message).toContain(kind);
    },
  );

  it('recognises a GaxiosError of ANOTHER gaxios copy — where `instanceof` misses it', async () => {
    // Same brand key, another version: what the functions bundle meets when the
    // cloud-installed firebase-admin resolves a different gaxios than its own.
    const outraCopia = Object.assign(new Error('metadata lookup failed'), {
      [Symbol.for('gaxios-gaxios-error')]: '6.7.1',
    });
    expect(outraCopia instanceof gaxios.GaxiosError).toBe(false);
    enqueue.mockRejectedValueOnce(outraCopia);
    await expect(createTaskScheduler().enqueueConsulta(consulta)).rejects.toBeInstanceOf(
      NFeTasksEnqueueError,
    );
  });

  it.each<[string, () => Promise<Error>]>([
    [
      'FirebaseFunctionsError',
      async () => {
        const { FirebaseFunctionsError } = await vi.importActual<
          typeof import('firebase-admin/functions')
        >('firebase-admin/functions');
        return new FirebaseFunctionsError({ code: 'unavailable', message: 'fila indisponível' });
      },
    ],
    [
      'FirebaseAppError',
      async () =>
        new FirebaseAppError({ code: AppErrorCode.NETWORK_ERROR, message: 'socket hang up' }),
    ],
    ['a TypeError (a bug)', async () => new TypeError('Cannot read properties of undefined')],
    ['a plain Error', async () => new Error('sem marca')],
  ])('%s propagates unchanged — only the gaxios brand is converted', async (_caso, criar) => {
    const falha = await criar();
    enqueue.mockRejectedValueOnce(falha);
    await expect(createTaskScheduler().enqueueConsulta(consulta)).rejects.toBe(falha);
  });
});
