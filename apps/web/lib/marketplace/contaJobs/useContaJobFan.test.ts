import { describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

import { useContaJobFan } from './useContaJobFan';
import type { ContaRef, JobErrorDescription } from './types';

/**
 * The hook had no test of its own while it lived in
 * `canais/mercado-livre/_components/` — it was covered only transitively by the
 * two ML action hooks. #1430 made it shared, so it earns one: the sequence it
 * exists to protect (commit, THEN rethrow) is now a contract for every channel.
 */

class ErroDeCanal extends Error {}

const describeError = (err: unknown): JobErrorDescription | null =>
  err instanceof ErroDeCanal ? { color: 'yellow', message: err.message } : null;

const A: ContaRef = { id: 'a', nome: 'Conta A' };
const B: ContaRef = { id: 'b', nome: 'Conta B' };

describe('useContaJobFan', () => {
  it('records one entry per conta and clears busy when the fan-out ends', async () => {
    const { result } = renderHook(() => useContaJobFan(describeError));
    expect(result.current.busy).toBe(false);

    await act(async () => {
      await result.current.run([A, B], (id) => Promise.resolve({ jobId: `job-${id}` }));
    });

    expect(result.current.entries).toEqual([
      { kind: 'started', conta: A, jobId: 'job-a' },
      { kind: 'started', conta: B, jobId: 'job-b' },
    ]);
    expect(result.current.busy).toBe(false);
  });

  /**
   * ⚠️ The sequence the module exists for. An unrecognised throwable must reach
   * the caller (rule 6), but ONLY after the started jobs are committed — the
   * `jobId` is the single handle the UI has on a job that really is running, so
   * a throw that jumps the commit strands it with no progress view.
   */
  it('commits the outcomes BEFORE rethrowing what it did not recognise', async () => {
    const { result } = renderHook(() => useContaJobFan(describeError));
    const boom = new TypeError('undefined is not a function');

    await act(async () => {
      await expect(
        result.current.run([A, B], (id) => {
          if (id === 'b') return Promise.reject(boom);
          return Promise.resolve({ jobId: 'job-a' });
        }),
      ).rejects.toBe(boom);
    });

    // The near-miss: a hook that rethrew first would leave this empty.
    expect(result.current.entries).toEqual([{ kind: 'started', conta: A, jobId: 'job-a' }]);
    expect(result.current.busy).toBe(false);
  });

  it('keeps a recognised failure out of the rethrow and in the ledger', async () => {
    const { result } = renderHook(() => useContaJobFan(describeError));

    await act(async () => {
      await result.current.run([A], () => Promise.reject(new ErroDeCanal('Já em andamento.')));
    });

    expect(result.current.entries).toEqual([
      { kind: 'error', conta: A, color: 'yellow', message: 'Já em andamento.' },
    ]);
  });

  it('swaps a conta card on re-run instead of stacking a stale one next to it', async () => {
    const { result } = renderHook(() => useContaJobFan(describeError));

    await act(async () => {
      await result.current.run([A], () => Promise.resolve({ jobId: 'job-1' }));
    });
    await act(async () => {
      await result.current.run([A], () => Promise.reject(new ErroDeCanal('Já em andamento.')));
    });

    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0]).toMatchObject({ kind: 'error', conta: A });
  });

  it('appends a conta the ledger has not seen, keeping the ones it has', async () => {
    const { result } = renderHook(() => useContaJobFan(describeError));

    await act(async () => {
      await result.current.run([A], () => Promise.resolve({ jobId: 'job-a' }));
    });
    await act(async () => {
      await result.current.run([B], () => Promise.resolve({ jobId: 'job-b' }));
    });

    expect(result.current.entries.map((e) => e.conta.id)).toEqual(['a', 'b']);
  });

  it('dismisses exactly one conta', async () => {
    const { result } = renderHook(() => useContaJobFan(describeError));

    await act(async () => {
      await result.current.run([A, B], (id) => Promise.resolve({ jobId: `job-${id}` }));
    });
    act(() => {
      result.current.dismiss('a');
    });

    expect(result.current.entries.map((e) => e.conta.id)).toEqual(['b']);
  });

  it('reports busy while a fan-out is in flight', async () => {
    const { result } = renderHook(() => useContaJobFan(describeError));
    let release: (() => void) | null = null;
    const start = vi.fn(
      () =>
        new Promise<{ jobId: string }>((resolve) => {
          release = () => {
            resolve({ jobId: 'job-a' });
          };
        }),
    );

    let pending: Promise<void> | null = null;
    act(() => {
      pending = result.current.run([A], start);
    });
    await waitFor(() => {
      expect(result.current.busy).toBe(true);
    });

    await act(async () => {
      release?.();
      await pending;
    });
    expect(result.current.busy).toBe(false);
  });
});
