import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  assertSafeTpAmb,
  assertSafeTpAmbForTransport,
  NFeProductionGuardError,
  tpAmbFromAmbiente,
} from '../../src/safety/index';

describe('assertSafeTpAmb', () => {
  beforeEach(() => {
    // Vitest sets NODE_ENV='test' by default. The guard's "test passthrough"
    // branch is exercised in its own test below; here we want to verify the
    // explicit-opt-in branch in isolation, so we mask the NODE_ENV signal.
    vi.stubEnv('NODE_ENV', '');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows tpAmb='2' (homologação) unconditionally", () => {
    expect(() => assertSafeTpAmb('2')).not.toThrow();
  });

  it("rejects tpAmb='1' (produção) by default", () => {
    expect(() => assertSafeTpAmb('1')).toThrow(NFeProductionGuardError);
  });

  it("allows tpAmb='1' when NFE_ALLOW_PRODUCAO=true", () => {
    vi.stubEnv('NFE_ALLOW_PRODUCAO', 'true');
    expect(() => assertSafeTpAmb('1')).not.toThrow();
  });

  it("rejects tpAmb='1' when NFE_ALLOW_PRODUCAO is any other value", () => {
    for (const v of ['1', 'yes', 'TRUE', '']) {
      vi.stubEnv('NFE_ALLOW_PRODUCAO', v);
      expect(() => assertSafeTpAmb('1')).toThrow(NFeProductionGuardError);
    }
  });

  it("allows tpAmb='1' when NODE_ENV='test' (Vitest passthrough)", () => {
    vi.stubEnv('NODE_ENV', 'test');
    expect(() => assertSafeTpAmb('1')).not.toThrow();
  });

  it('error message points at the right env var', () => {
    try {
      assertSafeTpAmb('1');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeProductionGuardError);
      expect((err as Error).message).toContain('NFE_ALLOW_PRODUCAO');
      expect((err as Error).message).toContain("tpAmb='1'");
    }
  });
});

/**
 * The transport-boundary guard. Everything here is about ONE difference from
 * `assertSafeTpAmb`: there is no `NODE_ENV='test'` escape.
 *
 * ⚠️ These tests deliberately do NOT stub `NODE_ENV`. Vitest sets it to `'test'`,
 * and that ambient value IS the condition under test — the `nfe-live` CI job runs
 * the live homologação suites through Vitest against the real SEFAZ endpoints, so
 * for the whole of that job `NODE_ENV='test'` holds while real requests go out. A
 * test that masked it would be asserting against an environment CI never has.
 */
describe('assertSafeTpAmbForTransport', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("allows tpAmb='2' (homologação) unconditionally", () => {
    expect(() => assertSafeTpAmbForTransport('2')).not.toThrow();
  });

  it("rejects tpAmb='1' under Vitest, where assertSafeTpAmb would let it through", () => {
    // The regression, stated as a comparison so the difference cannot be optimised
    // away by "simplifying" one into the other.
    expect(process.env.NODE_ENV).toBe('test');
    expect(() => assertSafeTpAmb('1')).not.toThrow();
    expect(() => assertSafeTpAmbForTransport('1')).toThrow(NFeProductionGuardError);
  });

  it("still allows tpAmb='1' when NFE_ALLOW_PRODUCAO=true", () => {
    vi.stubEnv('NFE_ALLOW_PRODUCAO', 'true');
    expect(() => assertSafeTpAmbForTransport('1')).not.toThrow();
  });

  it("rejects tpAmb='1' when NFE_ALLOW_PRODUCAO is any other value", () => {
    for (const v of ['1', 'yes', 'TRUE', 'false', '']) {
      vi.stubEnv('NFE_ALLOW_PRODUCAO', v);
      expect(() => assertSafeTpAmbForTransport('1'), `NFE_ALLOW_PRODUCAO=${v}`).toThrow(
        NFeProductionGuardError,
      );
    }
  });

  it('says out loud that NODE_ENV=test does not clear it', () => {
    // The error is the only place a confused caller will look.
    try {
      assertSafeTpAmbForTransport('1');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(NFeProductionGuardError);
      expect((err as Error).message).toContain('NFE_ALLOW_PRODUCAO');
      expect((err as Error).message).toContain('NODE_ENV=test');
    }
  });
});

/**
 * Wiring: the SOAP layer must use the TRANSPORT variant at every POST.
 *
 * Without this the two functions above can both be correct while `soap/index.ts`
 * still calls the permissive one, which is exactly the state this change found.
 */
describe('the SOAP layer is wired to the transport guard', () => {
  it('calls assertSafeTpAmbForTransport before every POST, and never the generator guard', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../src/soap/index.ts'), 'utf8');

    const code = src
      .split('\n')
      .filter((l) => !/^\s*(\*|\/\*|\/\/)/.test(l))
      .join('\n');

    const transport = code.match(/assertSafeTpAmbForTransport\(/g) ?? [];
    expect(transport.length, 'expected one guard per POST boundary').toBe(2);
    // `assertSafeTpAmb(` also matches the transport name as a prefix, so anchor on
    // the call shape that is NOT the transport one.
    expect(code).not.toMatch(/assertSafeTpAmb\(/);
  });
});

describe('tpAmbFromAmbiente', () => {
  it("maps 'producao' → '1'", () => {
    expect(tpAmbFromAmbiente('producao')).toBe('1');
  });

  it("maps 'homologacao' → '2'", () => {
    expect(tpAmbFromAmbiente('homologacao')).toBe('2');
  });
});
