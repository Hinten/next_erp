import { describe, expect, it } from 'vitest';

import { CONTA_DESCONECTADA, diasParaExpirar, shopeeContaStatusSchema } from './status';

const DIA = 24 * 60 * 60 * 1000;
const AGORA = 1_700_000_000_000;

describe('diasParaExpirar', () => {
  it('floors the remaining whole days', () => {
    expect(diasParaExpirar(AGORA + 3 * DIA + DIA / 2, AGORA)).toBe(3);
  });

  it('reads 0 on the LAST day, not 1', () => {
    // The near miss: an operator told "1 day left" on the morning it expires
    // plans for tomorrow. `Math.ceil` would say 1 here.
    expect(diasParaExpirar(AGORA + DIA - 1, AGORA)).toBe(0);
  });

  it('is exact on a whole-day boundary', () => {
    expect(diasParaExpirar(AGORA + 7 * DIA, AGORA)).toBe(7);
  });

  it('goes negative past the expiry — a real state, not an error', () => {
    // The authorization is gone but the conta document still names the shop.
    expect(diasParaExpirar(AGORA - DIA - 1, AGORA)).toBe(-2);
    expect(diasParaExpirar(AGORA - 1, AGORA)).toBe(-1);
  });
});

describe('shopeeContaStatusSchema', () => {
  it('parses the disconnected answer', () => {
    expect(shopeeContaStatusSchema.parse(CONTA_DESCONECTADA)).toEqual(CONTA_DESCONECTADA);
  });

  it('parses a connected answer carrying BOTH clocks', () => {
    const status = {
      connected: true,
      shopId: 111,
      mainAccountId: null,
      authTime: AGORA,
      expireTime: AGORA + 30 * DIA,
      diasParaExpirar: 30,
      loja: { shopName: 'Loja BR', region: 'BR', status: 'NORMAL' },
      // The OTHER clock: the access token can be dead while the authorization
      // has a month left.
      credencial: { expiraEm: AGORA - 1, expirada: true },
    };
    expect(shopeeContaStatusSchema.parse(status)).toEqual(status);
  });

  it('rejects a shop lifecycle state Shopee does not document', () => {
    // ⚠️ Strict on purpose: a tolerant fallback to NORMAL would report a BANNED
    // shop as healthy while nothing can be sold.
    expect(() =>
      shopeeContaStatusSchema.parse({
        ...CONTA_DESCONECTADA,
        loja: { shopName: null, region: null, status: 'SUSPENDED' },
      }),
    ).toThrow();
  });
});
