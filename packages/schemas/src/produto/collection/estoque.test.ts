import { describe, expect, it } from 'vitest';
import { estoqueDisponivel, estoqueProdutoSchema, makeEstoqueUid, reservaEfetiva } from './estoque';

describe('reservaEfetiva', () => {
  it('passes a non-negative reservation through untouched', () => {
    expect(reservaEfetiva(0)).toBe(0);
    expect(reservaEfetiva(4)).toBe(4);
    expect(reservaEfetiva(2.5)).toBe(2.5);
  });

  it('⚠️ FLOORS a negative reservation at 0 — the whole point (#931)', () => {
    expect(reservaEfetiva(-2)).toBe(0);
    expect(reservaEfetiva(-0.5)).toBe(0);
  });

  it('reads a missing reservation as 0', () => {
    expect(reservaEfetiva(null)).toBe(0);
    expect(reservaEfetiva(undefined)).toBe(0);
  });

  it('reads a non-finite reservation as 0 instead of propagating NaN', () => {
    // Callers that pre-coerced with `finiteNumber(x) ?? 0` are unchanged; the
    // ones that did not (publish.ts, the web estoque tab) stop sending a NaN
    // quantity to Mercado Livre.
    expect(reservaEfetiva(Number.NaN)).toBe(0);
    expect(reservaEfetiva(Number.POSITIVE_INFINITY)).toBe(0);
    expect(reservaEfetiva(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('estoqueProdutoSchema — a negative reservation must still PARSE (#931)', () => {
  // Regression for the `.min(0)` this field used to carry. `parseSoftRead`
  // safeParses the WHOLE object, so one out-of-range field failed the document
  // and returned the raw data — silently discarding every default below.
  it('accepts a stored negative and preserves it as evidence', () => {
    const parsed = estoqueProdutoSchema.safeParse({
      quantidade: 8,
      quantidadeReservada: -2,
      depositoOuterRef: 'documents/depositos/dep1',
    });

    expect(parsed.success).toBe(true);
    expect(parsed.data?.quantidadeReservada).toBe(-2);
  });

  it('still applies every default on a document that holds a negative', () => {
    // The failure mode: with `.min(0)` these came back `undefined`, and a doc
    // with no `quantidade` (ADR 0014 §2 writes exactly that shape) made
    // `estoqueDisponivel` return NaN.
    const parsed = estoqueProdutoSchema.parse({
      quantidadeReservada: -2,
      depositoOuterRef: 'documents/depositos/dep1',
    });

    expect(parsed.quantidade).toBe(0);
    expect(parsed.parentId).toBeNull();
    expect(parsed.localizacao).toBeNull();
    expect(parsed.ultimaModificacao).toBeNull();
    expect(estoqueDisponivel(parsed)).toBe(0);
  });
});

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

  it('does not propagate a non-finite reservation into the result', () => {
    expect(estoqueDisponivel({ quantidade: 8, quantidadeReservada: Number.NaN })).toBe(8);
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
