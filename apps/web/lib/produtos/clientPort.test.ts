import { describe, it, expect } from 'vitest';
import { deriveItensNoKit } from './clientPort';

describe('deriveItensNoKit', () => {
  it('derives itensNoKit from kit composition when left blank', () => {
    const componentesKit = {
      'comp-1': { quantidade: 3, limitarEstoque: true, timestamp: null },
      'comp-2': { quantidade: 2, limitarEstoque: true, timestamp: null },
    };

    const result = deriveItensNoKit(null, true, componentesKit);

    expect(result).toBe(5);
  });

  it('preserves user-provided itensNoKit value', () => {
    const componentesKit = {
      'comp-1': { quantidade: 3, limitarEstoque: true, timestamp: null },
    };

    const result = deriveItensNoKit(10, true, componentesKit);

    expect(result).toBe(10);
  });

  it('does not derive itensNoKit for non-kit produtos', () => {
    const result = deriveItensNoKit(null, false, null);

    expect(result).toBe(null);
  });

  it('does not derive itensNoKit when kit has no components', () => {
    const result = deriveItensNoKit(null, true, null);

    expect(result).toBe(null);
  });

  it('does not derive itensNoKit when componentesKit is empty', () => {
    const result = deriveItensNoKit(null, true, {});

    expect(result).toBe(null);
  });

  it('defaults component quantidade to 1 when missing', () => {
    const componentesKit = {
      'comp-1': { quantidade: undefined, limitarEstoque: true, timestamp: null } as any,
    };

    const result = deriveItensNoKit(null, true, componentesKit);

    expect(result).toBe(1);
  });

  it('handles zero as a user-provided value', () => {
    const componentesKit = {
      'comp-1': { quantidade: 5, limitarEstoque: true, timestamp: null },
    };

    const result = deriveItensNoKit(0, true, componentesKit);

    expect(result).toBe(0);
  });

  it('returns null for undefined itensNoKit on non-kit', () => {
    const result = deriveItensNoKit(undefined, false, null);

    expect(result).toBe(null);
  });

  it('skips null entries and counts valid objects (defaulting missing quantidade to 1)', () => {
    const componentesKit = {
      'comp-1': { quantidade: 3, limitarEstoque: true, timestamp: null },
      'comp-2': null as any,
      'comp-3': { quantidade: -1, limitarEstoque: true, timestamp: null },
      'comp-4': { limitarEstoque: true, timestamp: null } as any,
    };

    const result = deriveItensNoKit(null, true, componentesKit);

    // comp-1: 3, comp-2: skipped (null), comp-3: skipped (negative), comp-4: 1 (default)
    expect(result).toBe(4);
  });

  it('returns null when no valid kit components exist', () => {
    const componentesKit = {
      'comp-1': null as any,
      'comp-2': { quantidade: -1, limitarEstoque: true, timestamp: null },
      'comp-3': { quantidade: 0, limitarEstoque: true, timestamp: null },
    };

    const result = deriveItensNoKit(null, true, componentesKit);

    // comp-1: skipped (null), comp-2: skipped (negative), comp-3: skipped (zero)
    expect(result).toBe(null);
  });

  it('defaults missing quantidade to 1 for legacy docs without explicit quantities', () => {
    const componentesKit = {
      'comp-1': { limitarEstoque: true, timestamp: null } as any,
      'comp-2': { limitarEstoque: true, timestamp: null } as any,
    };

    const result = deriveItensNoKit(null, true, componentesKit);

    // Both entries default quantidade to 1
    expect(result).toBe(2);
  });
});
