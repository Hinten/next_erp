import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertSafeTpAmb, NFeProductionGuardError, tpAmbFromAmbiente } from './index';

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

describe('tpAmbFromAmbiente', () => {
  it("maps 'producao' → '1'", () => {
    expect(tpAmbFromAmbiente('producao')).toBe('1');
  });

  it("maps 'homologacao' → '2'", () => {
    expect(tpAmbFromAmbiente('homologacao')).toBe('2');
  });
});
