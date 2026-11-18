import { describe, expect, it } from 'vitest';

import { AGUARDAR_KIT_INCERTO_SHOPEE_MS } from '../../shopeeAcaoSugerida';
import {
  CRIACAO_KIT_SHOPEE_TTL_MS,
  ESPERA_MAXIMA_CRIACAO_KIT_SHOPEE_MS,
  FOLGA_RELOGIO_CRIACAO_KIT_SHOPEE_MS,
  criacaoKitShopeeSchema,
  estadoDaCriacaoDeKitShopee,
  type CriacaoKitShopee,
} from './kitCriacaoShopee';
import { PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS } from './shopeeRascunho';

const DESDE = 1_760_000_000_000;
const ATE = DESDE + CRIACAO_KIT_SHOPEE_TTL_MS;

function lease(over: Partial<CriacaoKitShopee> = {}): CriacaoKitShopee {
  return {
    v: 1,
    integracaoId: 'int-1',
    produtoId: 'kit-k',
    arma: 'kit-criar',
    token: 'tok-a',
    desdeMs: DESDE,
    ateMs: ATE,
    enviadoEmMs: null,
    sku: null,
    ...over,
  };
}

const carimbado = (): CriacaoKitShopee => lease({ enviadoEmMs: DESDE + 10_000, sku: 'KIT-1' });

describe('the constants — aliases, never second numbers (#1369)', () => {
  it('the TTL is the draft lock TTL; the longest wait is TTL + the post-send grace', () => {
    expect(CRIACAO_KIT_SHOPEE_TTL_MS).toBe(PUBLICACAO_EM_CURSO_SHOPEE_TTL_MS);
    expect(ESPERA_MAXIMA_CRIACAO_KIT_SHOPEE_MS).toBe(
      CRIACAO_KIT_SHOPEE_TTL_MS + AGUARDAR_KIT_INCERTO_SHOPEE_MS,
    );
  });
});

describe('estadoDaCriacaoDeKitShopee — the ONE reading of a kit create lease', () => {
  it('no document ⇒ livre', () => {
    expect(estadoDaCriacaoDeKitShopee(null, DESDE)).toEqual({ tipo: 'livre' });
    expect(estadoDaCriacaoDeKitShopee(undefined, DESDE)).toEqual({ tipo: 'livre' });
  });

  it('UNSTAMPED: held until ateMs (exclusive), free AT ateMs — its holder never sent', () => {
    expect(estadoDaCriacaoDeKitShopee(lease(), DESDE)).toEqual({
      tipo: 'em-andamento',
      token: 'tok-a',
      enviado: false,
      aguardarMs: CRIACAO_KIT_SHOPEE_TTL_MS,
    });
    expect(estadoDaCriacaoDeKitShopee(lease(), ATE - 1)).toMatchObject({
      tipo: 'em-andamento',
      aguardarMs: 1,
    });
    expect(estadoDaCriacaoDeKitShopee(lease(), ATE)).toEqual({ tipo: 'livre' });
  });

  it('STAMPED: held through the post-send grace — ateMs + AGUARDAR − 1 held, ateMs + AGUARDAR free', () => {
    // ⚠️ NEAR-MISS of the unstamped boundary: AT ateMs a stamped lease is still held.
    expect(estadoDaCriacaoDeKitShopee(carimbado(), ATE)).toEqual({
      tipo: 'em-andamento',
      token: 'tok-a',
      enviado: true,
      aguardarMs: AGUARDAR_KIT_INCERTO_SHOPEE_MS,
    });
    expect(
      estadoDaCriacaoDeKitShopee(carimbado(), ATE + AGUARDAR_KIT_INCERTO_SHOPEE_MS - 1),
    ).toMatchObject({ tipo: 'em-andamento', aguardarMs: 1 });
    expect(estadoDaCriacaoDeKitShopee(carimbado(), ATE + AGUARDAR_KIT_INCERTO_SHOPEE_MS)).toEqual({
      tipo: 'livre',
    });
  });

  it('(condition 3) a corrupt lease reads as NO lease: bad shape, a foreign key, a TTL that is not the TTL', () => {
    expect(estadoDaCriacaoDeKitShopee({ token: 'x' }, DESDE)).toEqual({ tipo: 'livre' });
    expect(estadoDaCriacaoDeKitShopee({ ...lease(), extra: 1 }, DESDE)).toEqual({ tipo: 'livre' });
    expect(estadoDaCriacaoDeKitShopee({ ...lease(), desdeMs: '1' }, DESDE)).toEqual({
      tipo: 'livre',
    });
    expect(estadoDaCriacaoDeKitShopee(lease({ ateMs: ATE + 1 }), DESDE)).toEqual({
      tipo: 'livre',
    });
    // A lease that claims to last for ever is the one this guard exists for.
    expect(estadoDaCriacaoDeKitShopee(lease({ ateMs: Number.MAX_SAFE_INTEGER }), DESDE)).toEqual({
      tipo: 'livre',
    });
  });

  it('(condition 3) a desdeMs implausibly far AHEAD reads as no lease; within the clock slack it holds', () => {
    const agora = DESDE - FOLGA_RELOGIO_CRIACAO_KIT_SHOPEE_MS;
    expect(estadoDaCriacaoDeKitShopee(lease(), agora)).toMatchObject({ tipo: 'em-andamento' });
    expect(estadoDaCriacaoDeKitShopee(lease(), agora - 1)).toEqual({ tipo: 'livre' });
  });

  it('⚠️ an invalid clock NEVER frees a lease (stamped or not); its wait falls back to the whole span', () => {
    expect(estadoDaCriacaoDeKitShopee(lease(), Number.NaN)).toEqual({
      tipo: 'em-andamento',
      token: 'tok-a',
      enviado: false,
      aguardarMs: CRIACAO_KIT_SHOPEE_TTL_MS,
    });
    expect(estadoDaCriacaoDeKitShopee(carimbado(), Number.NaN)).toMatchObject({
      tipo: 'em-andamento',
      enviado: true,
      aguardarMs: ESPERA_MAXIMA_CRIACAO_KIT_SHOPEE_MS,
    });
    // NEAR-MISS: with no document there is nothing to keep.
    expect(estadoDaCriacaoDeKitShopee(null, Number.NaN)).toEqual({ tipo: 'livre' });
  });

  it('the stored schema is strict and every clock is a non-negative integer', () => {
    expect(criacaoKitShopeeSchema.safeParse(lease()).success).toBe(true);
    expect(criacaoKitShopeeSchema.safeParse(carimbado()).success).toBe(true);
    expect(criacaoKitShopeeSchema.safeParse(lease({ desdeMs: 1.5 })).success).toBe(false);
    expect(criacaoKitShopeeSchema.safeParse(lease({ enviadoEmMs: -1 })).success).toBe(false);
    expect(
      criacaoKitShopeeSchema.safeParse({ ...lease(), arma: 'kit-atualizar' as never }).success,
    ).toBe(false);
  });
});
