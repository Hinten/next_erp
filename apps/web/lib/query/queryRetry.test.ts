import { describe, expect, it, vi } from 'vitest';

import { type RetryableQuery, queryRetry } from './queryRetry';

function q(over: Partial<RetryableQuery> = {}): RetryableQuery {
  return { error: null, isFetching: false, refetch: vi.fn(), ...over } as RetryableQuery;
}

describe('queryRetry', () => {
  it('reports no failure when every query is healthy', () => {
    const r = queryRetry(q(), q());
    expect(r.error).toBeNull();
    expect(r.retrying).toBe(false);
  });

  it('surfaces the first error in the order given', () => {
    const first = new Error('first');
    const second = new Error('second');
    expect(queryRetry(q({ error: first }), q({ error: second })).error).toBe(first);
    expect(queryRetry(q(), q({ error: second })).error).toBe(second);
  });

  // The whole point for a chained load: refetching everything would run the
  // downstream queryFn with the very inputs its `enabled` guard withholds,
  // because refetch() bypasses `enabled` entirely. Do not "simplify" this.
  it('refetches ONLY the queries that failed', () => {
    const failed = q({ error: new Error('boom') });
    const healthy = q();
    queryRetry(failed, healthy).retry();
    expect(failed.refetch).toHaveBeenCalledTimes(1);
    expect(healthy.refetch).not.toHaveBeenCalled();
  });

  it('refetches every failed query when several are down', () => {
    const a = q({ error: new Error('a') });
    const b = q({ error: new Error('b') });
    queryRetry(a, b).retry();
    expect(a.refetch).toHaveBeenCalledTimes(1);
    expect(b.refetch).toHaveBeenCalledTimes(1);
  });

  it('is retrying only while a FAILED query is fetching', () => {
    expect(queryRetry(q({ error: new Error('x'), isFetching: true })).retrying).toBe(true);
    // A healthy sibling loading is ordinary progress, not a retry in flight.
    expect(queryRetry(q({ error: new Error('x') }), q({ isFetching: true })).retrying).toBe(false);
  });

  it('is a no-op with no queries at all', () => {
    const r = queryRetry();
    expect(r.error).toBeNull();
    expect(() => {
      r.retry();
    }).not.toThrow();
  });
});
