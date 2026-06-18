/**
 * Unit tests for `serviceAudience` — derives the OIDC audience the reconcile
 * Cloud Functions must target (`${NFE_BASE_URL}${path}`), and returns undefined
 * when unconfigured so `verifyServiceCaller` fails loud instead of accepting an
 * unbound audience.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { serviceAudience } from '../../../lib/nfe/auth';

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.NFE_BASE_URL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.NFE_BASE_URL;
  else process.env.NFE_BASE_URL = saved;
});

describe('serviceAudience', () => {
  it('joins NFE_BASE_URL with the route path', () => {
    process.env.NFE_BASE_URL = 'https://nfe.example.app';
    expect(serviceAudience('/api/nfe/reconciliar')).toBe(
      'https://nfe.example.app/api/nfe/reconciliar',
    );
    expect(serviceAudience('/api/nfe/processar-pendentes')).toBe(
      'https://nfe.example.app/api/nfe/processar-pendentes',
    );
  });

  it('returns undefined when NFE_BASE_URL is unset (verifyServiceCaller then 500s)', () => {
    delete process.env.NFE_BASE_URL;
    expect(serviceAudience('/api/nfe/reconciliar')).toBeUndefined();
  });
});
