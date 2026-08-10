import { describe, expect, it } from 'vitest';

import { reduzirContagem } from './aplicarBalanco';
import { BALANCO_MAX_ATTEMPTS, BALANCO_QUEUE } from './balancoTasks';

/**
 * `reduzirContagem` is the only code the pipeline aggregate and the classic
 * fallback share, and the pipeline path never runs in an emulator — so this is
 * the one place its row handling is exercised.
 */
describe('reduzirContagem', () => {
  it('folds aggregate rows into produtoId → total', () => {
    const contagem = reduzirContagem([
      { produtoId: 'p1', total: 5 },
      { produtoId: 'p2', total: 12 },
    ]);
    expect([...contagem]).toEqual([
      ['p1', 5],
      ['p2', 12],
    ]);
  });

  it('accumulates rather than overwrites when a produto appears twice', () => {
    // One produto should only ever produce one group, but a `set` here would
    // silently drop a second — the same trap the ML sweep hit when its group
    // key came back in two encodings.
    expect(
      reduzirContagem([
        { produtoId: 'p1', total: 5 },
        { produtoId: 'p1', total: 2 },
      ]).get('p1'),
    ).toBe(7);
  });

  it('drops rows with no usable produtoId', () => {
    // The classic path reads `produtoId` straight off the doc, and an error
    // movimento carries null there. Such rows are filtered out by the query,
    // but a null group key must never become the string "null".
    const contagem = reduzirContagem([
      { produtoId: null, total: 5 },
      { produtoId: '', total: 5 },
      { total: 5 },
      { produtoId: 42, total: 5 },
    ]);
    expect(contagem.size).toBe(0);
  });

  it('drops rows whose total is not a finite number', () => {
    const contagem = reduzirContagem([
      { produtoId: 'p1', total: Number.NaN },
      { produtoId: 'p2', total: Number.POSITIVE_INFINITY },
      { produtoId: 'p3', total: '5' },
      { produtoId: 'p4', total: null },
    ]);
    expect(contagem.size).toBe(0);
  });

  it('keeps a genuine zero', () => {
    // Counted-and-found-empty is real information; it must not be filtered out
    // with the junk above.
    expect(reduzirContagem([{ produtoId: 'p1', total: 0 }]).get('p1')).toBe(0);
  });

  it('keeps a negative total (a correcting lançamento)', () => {
    expect(reduzirContagem([{ produtoId: 'p1', total: -2 }]).get('p1')).toBe(-2);
  });
});

describe('queue wiring', () => {
  it('names the queue exactly as the deployed export', () => {
    // Firebase task queues resolve by function name — a rename on one side
    // only makes every enqueue 404 at runtime, with nothing failing at build.
    expect(BALANCO_QUEUE).toBe('processarBalanco');
  });

  it('keeps the retry budget in sync with what the worker checks', () => {
    // The worker parks the balanço on `retryCount === BALANCO_MAX_ATTEMPTS - 1`;
    // if this drifts below the deployed `retryConfig.maxAttempts` the job parks
    // early, and above it the doc is left stuck in `finalizando` forever.
    expect(BALANCO_MAX_ATTEMPTS).toBe(5);
  });
});
