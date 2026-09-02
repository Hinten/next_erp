import { describe, expect, it, vi } from 'vitest';

import { startJobsForContas } from './startJobsForContas';
import type { ContaRef, JobErrorDescription } from './types';

/**
 * Channel-neutral on purpose since #1430 moved this out of
 * `canais/mercado-livre/_components/`. The fan-out's contract is about the
 * SHAPE of `describeError` — recognised failure vs `null` — not about any one
 * channel's error classes, and a `lib/` test reaching back into `app/` for
 * fixtures would re-couple exactly what the move separated. Mercado Livre's own
 * narrowing keeps its test in `mercadoLivreJobErrors.test.ts`, and the two
 * action hooks exercise the pair end to end.
 */

/** Stands for "a failure this channel's error map recognises". */
class ErroDeCanal extends Error {
  constructor(
    message: string,
    readonly color: JobErrorDescription['color'],
  ) {
    super(message);
    this.name = 'ErroDeCanal';
  }
}

/** The port: recognised → a description, anything else → `null` (rule 6). */
function describeError(err: unknown): JobErrorDescription | null {
  return err instanceof ErroDeCanal ? { color: err.color, message: err.message } : null;
}

const CONTAS: ContaRef[] = [
  { id: 'a', nome: 'Conta A' },
  { id: 'b', nome: 'Conta B' },
  { id: 'c', nome: 'Conta C' },
];

describe('startJobsForContas', () => {
  it('starts one job per conta and reports them in selection order', async () => {
    const start = vi.fn(async (id: string) => ({ jobId: `job-${id}` }));

    const { outcomes, unexpected } = await startJobsForContas({
      contas: CONTAS,
      start,
      describeError,
    });

    expect(start.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
    expect(outcomes).toEqual([
      { kind: 'started', conta: CONTAS[0], jobId: 'job-a' },
      { kind: 'started', conta: CONTAS[1], jobId: 'job-b' },
      { kind: 'started', conta: CONTAS[2], jobId: 'job-c' },
    ]);
    expect(unexpected).toEqual([]);
  });

  it('a contained failure on ONE conta does not cost the others their jobId', async () => {
    // The whole point of #816's multi-select: a single toast could never say
    // WHICH of four accounts already had a job running.
    const start = vi.fn(async (id: string) => {
      if (id === 'b') throw new ErroDeCanal('Já existe uma importação em andamento.', 'yellow');
      return { jobId: `job-${id}` };
    });

    const { outcomes, unexpected } = await startJobsForContas({
      contas: CONTAS,
      start,
      describeError,
    });

    expect(outcomes).toEqual([
      { kind: 'started', conta: CONTAS[0], jobId: 'job-a' },
      {
        kind: 'error',
        conta: CONTAS[1],
        color: 'yellow',
        message: 'Já existe uma importação em andamento.',
      },
      { kind: 'started', conta: CONTAS[2], jobId: 'job-c' },
    ]);
    expect(unexpected).toEqual([]);
  });

  it('resolves (never rejects) when every conta fails with a known client error', async () => {
    const start = vi.fn(async () => {
      throw new ErroDeCanal('Falha de rede ao iniciar a importação.', 'red');
    });

    const { outcomes, unexpected } = await startJobsForContas({
      contas: CONTAS,
      start,
      describeError,
    });

    expect(outcomes).toHaveLength(3);
    expect(outcomes.every((o) => o.kind === 'error' && o.color === 'red')).toBe(true);
    expect(unexpected).toEqual([]);
  });

  it('collects an unrecognised throwable while still returning the siblings that started', async () => {
    // The caller commits these outcomes BEFORE rethrowing — a started jobId is
    // the only handle on a running job.
    const boom = new TypeError('undefined is not a function');
    const start = vi.fn(async (id: string) => {
      if (id === 'b') throw boom;
      return { jobId: `job-${id}` };
    });

    const { outcomes, unexpected } = await startJobsForContas({
      contas: CONTAS,
      start,
      describeError,
    });

    expect(outcomes).toEqual([
      { kind: 'started', conta: CONTAS[0], jobId: 'job-a' },
      { kind: 'started', conta: CONTAS[2], jobId: 'job-c' },
    ]);
    expect(unexpected).toEqual([boom]);
  });

  it('fans out in parallel — every conta is started before the first resolves', async () => {
    // Pins `Promise.allSettled` against a future "let's make it sequential"
    // edit: with a sequential loop, only conta A would have been called.
    const release: Array<() => void> = [];
    const start = vi.fn(
      (id: string) =>
        new Promise<{ jobId: string }>((resolve) => {
          release.push(() => {
            resolve({ jobId: `job-${id}` });
          });
        }),
    );

    const pending = startJobsForContas({ contas: CONTAS, start, describeError });
    await Promise.resolve();

    expect(start).toHaveBeenCalledTimes(3);
    release.forEach((fn) => {
      fn();
    });
    const { outcomes } = await pending;
    expect(outcomes).toHaveLength(3);
  });

  it('an empty selection is a no-op', async () => {
    const start = vi.fn();
    const result = await startJobsForContas({ contas: [], start, describeError });
    expect(result).toEqual({ outcomes: [], unexpected: [] });
    expect(start).not.toHaveBeenCalled();
  });
});
