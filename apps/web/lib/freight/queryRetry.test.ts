import { describe, expect, it } from 'vitest';

import {
  FreightNetworkError,
  FreightServerError,
  FreightTimeoutError,
} from '@delfrance/integrations-freight-br/http-client';

import { QUERY_DEFAULT_OPTIONS } from '@/lib/query/QueryProvider';
import { FREIGHT_QUERY_MAX_RETRIES, freightQueryRetry } from './queryRetry';

const timeout = new FreightTimeoutError('t', {
  origem: 'prazo',
  timeoutMs: 60_000,
  operacao: 'agencias',
});

describe('freightQueryRetry (#1094)', () => {
  it('never retries a timeout — its budget is already spent', () => {
    expect(freightQueryRetry(0, timeout)).toBe(false);
  });

  it('near-miss: a plain network error keeps the default single retry', () => {
    expect(freightQueryRetry(0, new FreightNetworkError('reset'))).toBe(true);
    expect(freightQueryRetry(1, new FreightNetworkError('reset'))).toBe(false);
  });

  it('keeps the default for a server error', () => {
    expect(freightQueryRetry(0, new FreightServerError('boom', 500, null))).toBe(true);
  });

  it('restates the app default, so overriding it changes only the timeout case', () => {
    expect(QUERY_DEFAULT_OPTIONS.queries?.retry).toBe(FREIGHT_QUERY_MAX_RETRIES);
  });
});
