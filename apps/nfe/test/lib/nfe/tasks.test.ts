/**
 * Unit tests for the Cloud Tasks scheduler config (`createTaskScheduler`).
 * Covers the fail-fast contract: disabled → no-op, incomplete → throw,
 * complete → a usable scheduler. The actual REST enqueue is integration-tested
 * in staging (no emulator for Cloud Tasks).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createTaskScheduler,
  NFeTasksConfigError,
  noopTaskScheduler,
} from '../../../lib/nfe/tasks';

const KEYS = ['NFE_TASKS_DISABLED', 'NFE_TASKS_QUEUE', 'NFE_TASKS_ENDPOINT', 'NFE_TASK_RUNNER_SA'];
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
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

  it('throws NFeTasksConfigError when config is incomplete (fail-fast)', () => {
    process.env.NFE_TASKS_QUEUE = 'projects/p/locations/us-east1/queues/q';
    // endpoint + runner SA missing
    expect(() => createTaskScheduler()).toThrow(NFeTasksConfigError);
    try {
      createTaskScheduler();
    } catch (e) {
      if (!(e instanceof NFeTasksConfigError)) throw e;
      expect(e.missing).toEqual(['NFE_TASKS_ENDPOINT', 'NFE_TASK_RUNNER_SA']);
    }
  });

  it('returns a real scheduler when fully configured', () => {
    process.env.NFE_TASKS_QUEUE = 'projects/p/locations/us-east1/queues/q';
    process.env.NFE_TASKS_ENDPOINT = 'https://nfe.example/api/nfe/reconciliar';
    process.env.NFE_TASK_RUNNER_SA = 'runner@p.iam.gserviceaccount.com';
    const scheduler = createTaskScheduler();
    expect(scheduler).not.toBe(noopTaskScheduler);
    expect(typeof scheduler.enqueueConsulta).toBe('function');
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
