import { afterEach, describe, expect, it, vi } from 'vitest';

import { safeMlUserId } from './mlUserId';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('safeMlUserId', () => {
  it('passes a normal ML user id straight through', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(safeMlUserId(301110805, 'pedido', { orderId: 1 })).toBe(301110805);
    expect(warn).not.toHaveBeenCalled();
  });

  it('treats an absent id as absence, not as an error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(safeMlUserId(null, 'pedido', { orderId: 1 })).toBeNull();
    expect(safeMlUserId(undefined, 'pedido', { orderId: 1 })).toBeNull();
    // A payload that carries no buyer id is not a fault — it is a caller with
    // no evidence, and the cascade already has a null leg for that.
    expect(warn).not.toHaveBeenCalled();
  });

  it('refuses an id outside the safe integer range, and says which import hit it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(safeMlUserId(Number.MAX_SAFE_INTEGER + 2, 'pedido', { orderId: 7 })).toBeNull();
    expect(warn).toHaveBeenCalledWith(
      '[mercado-livre] pedido: id de comprador fora do alcance seguro',
      expect.objectContaining({ orderId: 7, buyerId: Number.MAX_SAFE_INTEGER + 2 }),
    );
  });

  it('keeps the question path’s emitted warn byte-identical', () => {
    // `questionBuyerId` delegated to this helper in #1087. Its log line is the
    // one an operator greps for, so the scope parameter exists precisely to
    // reproduce the old string rather than unify the two under a new one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    safeMlUserId(Number.MAX_SAFE_INTEGER + 2, 'pergunta', { questionId: 5 });

    expect(warn).toHaveBeenCalledWith(
      '[mercado-livre] pergunta: id de comprador fora do alcance seguro',
      expect.objectContaining({ questionId: 5 }),
    );
  });

  it('the hazard is real: two DIFFERENT ML ids parse to ONE number', () => {
    // This is the whole reason the refusal exists, and it is worth pinning
    // rather than asserting in a comment. `JSON.parse` has no integer type — it
    // rounds to the nearest double — so past 2^53 two distinct marketplace
    // accounts arrive indistinguishable, and `String(...)` afterwards cannot
    // recover the digits. Stamping that as `cliente.idMercadoLivre` would merge
    // two people, which is the one failure that key exists to prevent.
    const a = (JSON.parse('{"id":9007199254740993}') as { id: number }).id;
    const b = (JSON.parse('{"id":9007199254740992}') as { id: number }).id;

    expect(a).toBe(b);
    expect(String(a)).toBe(String(b));
    expect(Number.isSafeInteger(a)).toBe(false);

    // So both are refused, rather than both becoming the same cliente.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(safeMlUserId(a, 'pedido', {})).toBeNull();
    expect(safeMlUserId(b, 'pedido', {})).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
