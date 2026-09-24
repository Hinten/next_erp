import { describe, expect, it } from 'vitest';

import { shopeePriceInfoSchema, type ShopeePriceInfo } from '@delfrance/integrations-shopee';

import { PRECO_MINIMO, precoBrlDe, precoDePrateleiraDe } from './mapeamento';

/**
 * `precoDePrateleiraDe` — the shelf-price reader promoted out of `precoBrlDe`
 * for step 13 (#1521). `mapeamento.test.ts` stays byte-unedited as the proof
 * that `precoBrlDe` did not move; THIS file pins the new reader's own contract,
 * which is wider than `precoBrlDe`'s (no currency pick, no minimum).
 *
 * It is a fold — its output is the number the price push compares against —
 * so every rule below has an EQUAL pair and a NEAR-MISS (root `CLAUDE.md`).
 */

/** A COMPLETE `price_info` entry, through the wire schema, as the reader sees it. */
function entrada(parcial: Record<string, unknown>): ShopeePriceInfo {
  return shopeePriceInfoSchema.parse(parcial);
}

describe('precoDePrateleiraDe — o original vence sempre que é um preço', () => {
  it('⚠️ QUASE-IGUAL (M18) — original 10 e current 8 ⇒ 10, NUNCA o preço promocional', () => {
    expect(precoDePrateleiraDe(entrada({ original_price: 10, current_price: 8 }))).toBe(10);
    expect(precoDePrateleiraDe(entrada({ original_price: 10, current_price: 8 }))).not.toBe(8);
  });

  it('o original vence também quando o current é MAIOR (a ordem não é "o menor")', () => {
    expect(precoDePrateleiraDe(entrada({ original_price: 10, current_price: 12 }))).toBe(10);
  });

  it('PAR — original igual ao current (sem promoção) ⇒ esse valor', () => {
    expect(precoDePrateleiraDe(entrada({ original_price: 49.9, current_price: 49.9 }))).toBe(49.9);
  });
});

describe('precoDePrateleiraDe — o zero-fill da Shopee não é um preço', () => {
  it('⚠️ PAR (M19) — original 0 e original AUSENTE caem os dois para o current: 9', () => {
    expect(precoDePrateleiraDe(entrada({ original_price: 0, current_price: 9 }))).toBe(9);
    expect(precoDePrateleiraDe(entrada({ current_price: 9 }))).toBe(9);
    expect(precoDePrateleiraDe(entrada({ original_price: null, current_price: 9 }))).toBe(9);
  });

  it('PAR — um original NEGATIVO também não é preço, e cai para o current', () => {
    expect(precoDePrateleiraDe(entrada({ original_price: -1, current_price: 9 }))).toBe(9);
  });

  it('QUASE-IGUAL — o menor original POSITIVO já vence: 0.001 não é zero-fill', () => {
    // No minimum here: `precoSchema`'s 0.01 is `precoBrlDe`'s rule, not this one's.
    expect(precoDePrateleiraDe(entrada({ original_price: 0.001, current_price: 9 }))).toBe(0.001);
  });

  it('os DOIS não-positivos (ou ausentes) ⇒ null — nunca 0', () => {
    expect(precoDePrateleiraDe(entrada({ original_price: 0, current_price: 0 }))).toBeNull();
    expect(precoDePrateleiraDe(entrada({}))).toBeNull();
    expect(precoDePrateleiraDe(entrada({ original_price: -2, current_price: -1 }))).toBeNull();
  });

  it('um valor NÃO-finito nunca é o preço de prateleira', () => {
    const infinito = { ...entrada({ current_price: 9 }), original_price: Number.POSITIVE_INFINITY };
    const nan = { ...entrada({}), original_price: 0, current_price: Number.NaN };

    expect(precoDePrateleiraDe(infinito)).toBe(9);
    expect(precoDePrateleiraDe(nan)).toBeNull();
  });
});

describe('precoDePrateleiraDe — é agnóstico de moeda, sem mínimo e sem arredondar', () => {
  it('PAR — BRL e SGD com os mesmos números respondem o MESMO valor', () => {
    const brl = entrada({ currency: 'BRL', original_price: 15, current_price: 12 });
    const sgd = entrada({ currency: 'SGD', original_price: 15, current_price: 12 });

    expect(precoDePrateleiraDe(brl)).toBe(15);
    expect(precoDePrateleiraDe(sgd)).toBe(15);
  });

  it('QUASE-IGUAL — 10.005 volta 10.005, nunca arredondado para 10.01 nem 10', () => {
    expect(precoDePrateleiraDe(entrada({ original_price: 10.005, current_price: 9 }))).toBe(10.005);
  });

  it('abaixo do mínimo do precoSchema ainda é um preço AQUI — o mínimo é do leitor da importação', () => {
    const minusculo = entrada({ currency: 'BRL', original_price: 0.005, current_price: 0.005 });

    expect(precoDePrateleiraDe(minusculo)).toBe(0.005);
    expect(0.005).toBeLessThan(PRECO_MINIMO);
    expect(precoBrlDe([minusculo])).toEqual({ valor: null, motivo: 'valor-abaixo-do-minimo' });
  });
});

describe('precoBrlDe lê o preço ATRAVÉS de precoDePrateleiraDe', () => {
  it('PAR — para a entrada BRL, os dois leitores respondem o mesmo número', () => {
    const casos = [
      { original_price: 99.9, current_price: 49.9 },
      { original_price: 0, current_price: 12.5 },
      { original_price: null, current_price: 30 },
    ];
    for (const caso of casos) {
      const e = entrada({ currency: 'BRL', ...caso });
      expect(precoBrlDe([e]).valor).toBe(precoDePrateleiraDe(e));
    }
  });

  it('QUASE-IGUAL — sem entrada BRL o leitor da importação recusa, o de prateleira responde', () => {
    const sgd = entrada({ currency: 'SGD', original_price: 10, current_price: 9 });

    expect(precoBrlDe([sgd])).toEqual({ valor: null, motivo: 'moeda-nao-brl' });
    expect(precoDePrateleiraDe(sgd)).toBe(10);
  });
});
