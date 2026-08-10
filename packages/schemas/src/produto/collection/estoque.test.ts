import { describe, expect, it } from 'vitest';
import { estoqueDisponivel, makeEstoqueUid } from './estoque';

describe('estoqueDisponivel', () => {
  it('subtracts the reservation from the quantity', () => {
    expect(estoqueDisponivel({ quantidade: 10, quantidadeReservada: 2 })).toBe(8);
    expect(estoqueDisponivel({ quantidade: 10, quantidadeReservada: 0 })).toBe(10);
  });

  it('⚠️ FLOORS a negative reservation at 0 instead of letting it INVENT stock', () => {
    // The whole point: without the floor this returns 8 − (−2) = 10, i.e. two
    // units that do not exist — which the ML sweep would publish and Mercado
    // Livre would sell. Failing toward "less available" is the safe direction.
    expect(estoqueDisponivel({ quantidade: 8, quantidadeReservada: -2 })).toBe(8);
    expect(estoqueDisponivel({ quantidade: 0, quantidadeReservada: -50 })).toBe(0);
  });

  it('still reports a NEGATIVE disponivel when the reservation legitimately exceeds stock', () => {
    // Not the same case: 5 really are reserved against 2 in stock, so −3 is
    // real information. Only the reservation itself is floored, never the result.
    expect(estoqueDisponivel({ quantidade: 2, quantidadeReservada: 5 })).toBe(-3);
  });

  it('handles fractional quantities (the wire type is a double)', () => {
    expect(estoqueDisponivel({ quantidade: 2.5, quantidadeReservada: 0.5 })).toBe(2);
  });
});

describe('makeEstoqueUid', () => {
  it('builds the deterministic doc id', () => {
    expect(makeEstoqueUid('PROD-1', 'DEP-1')).toBe('est-PROD-1-DEP-1');
  });

  it('keeps hyphens inside both ids intact', () => {
    expect(makeEstoqueUid('a-b', 'c-d')).toBe('est-a-b-c-d');
  });
});
