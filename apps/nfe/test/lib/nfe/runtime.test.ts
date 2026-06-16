/**
 * `getNFeRuntime` is the cert-OPTIONAL base runtime: the process must boot with
 * NO env cert (per-filial signing). These tests pass an explicit `env` so they
 * never touch the real `NFE_CERT_*` — they only read the vendored SP-homologação
 * TLS chain off disk (cert-free, the boot-time guard).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { __resetNFeRuntimeForTests, getNFeRuntime } from '@/lib/nfe/runtime';

beforeEach(() => {
  __resetNFeRuntimeForTests();
});

afterEach(() => {
  __resetNFeRuntimeForTests();
});

// A clean env with NO `NFE_CERT_*` so the lazy env runtime resolves to null.
const env = (extra: Record<string, string>): NodeJS.ProcessEnv =>
  extra as unknown as NodeJS.ProcessEnv;

describe('getNFeRuntime — cert-optional boot', () => {
  it('boots with no env cert; envRuntime() resolves to null', () => {
    const base = getNFeRuntime(env({ NFE_AMBIENTE: 'homologacao', NFE_UF: 'SP' }));
    expect(base.ambiente).toBe('homologacao');
    expect(base.uf).toBe('SP');
    expect(base.tpAmb).toBe('2');
    // No NFE_CERT_* in the passed env → the lazy env runtime is null, not a throw.
    expect(base.envRuntime()).toBeNull();
  });

  it('throws on an invalid NFE_AMBIENTE', () => {
    expect(() => getNFeRuntime(env({ NFE_AMBIENTE: 'banana' }))).toThrow(/NFE_AMBIENTE/);
  });

  it('caches the base singleton across calls', () => {
    const a = getNFeRuntime(env({ NFE_AMBIENTE: 'homologacao', NFE_UF: 'SP' }));
    const b = getNFeRuntime();
    expect(b).toBe(a);
  });
});
