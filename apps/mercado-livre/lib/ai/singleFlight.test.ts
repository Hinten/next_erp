import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AlreadyRunningError, runSingleFlight, __resetSingleFlight } from './singleFlight';

beforeEach(() => {
  __resetSingleFlight();
});

describe('runSingleFlight', () => {
  it('runs the task and returns its value', async () => {
    await expect(runSingleFlight('uid-1', async () => 'ok')).resolves.toBe('ok');
  });

  it('rejects a second call from the same operator while one is out', async () => {
    // Every one of these is a billed model call, so the double-click case is
    // the one worth stopping.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = runSingleFlight('uid-1', async () => {
      await gate;
      return 'first';
    });

    await expect(runSingleFlight('uid-1', async () => 'second')).rejects.toBeInstanceOf(
      AlreadyRunningError,
    );

    release();
    await expect(first).resolves.toBe('first');
  });

  it('does not block a DIFFERENT operator', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const first = runSingleFlight('uid-1', async () => {
      await gate;
      return 'first';
    });

    await expect(runSingleFlight('uid-2', async () => 'other')).resolves.toBe('other');
    release();
    await first;
  });

  it('frees the slot after the task settles', async () => {
    await runSingleFlight('uid-1', async () => 'ok');
    await expect(runSingleFlight('uid-1', async () => 'again')).resolves.toBe('again');
  });

  it('frees the slot after a FAILURE too', async () => {
    // Without the `finally`, one failed call would lock the operator out until
    // the instance recycled.
    await expect(
      runSingleFlight('uid-1', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = vi.fn(async () => 'recovered');
    await expect(runSingleFlight('uid-1', after)).resolves.toBe('recovered');
    expect(after).toHaveBeenCalledOnce();
  });
});
