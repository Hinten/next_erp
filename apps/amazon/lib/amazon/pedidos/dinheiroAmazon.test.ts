import { centavosDeReais } from '@delfrance/core/money';
import { describe, expect, it } from 'vitest';

import { brl, linhaAmazon, pedidoAmazon } from '../testing/pedidoWireAmazon';
import {
  dinheiroDoPedidoAmazon,
  mesmosCentavos,
  reaisDeMoneyAmazon,
  somaReais,
} from './dinheiroAmazon';

describe('mesmosCentavos — the one money comparison (the fold’s scope, both directions)', () => {
  it('EQUAL: amounts that round to the same centavo, legacy floats included; null ≡ null', () => {
    expect(mesmosCentavos(33.300000000000004, 33.3)).toBe(true);
    expect(mesmosCentavos(25.000000000000004, 25)).toBe(true);
    expect(mesmosCentavos(1599.9, 1599.9)).toBe(true);
    expect(mesmosCentavos(null, null)).toBe(true);
  });

  it('NEAR-MISS: one centavo apart stays distinct (whole reais never fold); null ≢ 0', () => {
    expect(mesmosCentavos(25, 25.02)).toBe(false);
    expect(mesmosCentavos(10, 10.01)).toBe(false);
    expect(mesmosCentavos(3, 3.01)).toBe(false);
    expect(mesmosCentavos(null, 0)).toBe(false);
    expect(mesmosCentavos(0, null)).toBe(false);
  });
});

describe('reaisDeMoneyAmazon — the one money reader', () => {
  it("EQUAL: '1599.90' and '1599.9' read the same centavos (1599.9)", () => {
    const a = reaisDeMoneyAmazon(brl('1599.90'));
    const b = reaisDeMoneyAmazon(brl('1599.9'));
    expect(a).toBe(1599.9);
    expect(b).toBe(1599.9);
    expect(centavosDeReais(a ?? -1)).toBe(centavosDeReais(b ?? -2));
  });

  it("NEAR-MISS: '10.00' vs '10.01' and '10.00' vs '0.01' stay distinct", () => {
    expect(centavosDeReais(reaisDeMoneyAmazon(brl('10.00')) ?? 0)).not.toBe(
      centavosDeReais(reaisDeMoneyAmazon(brl('10.01')) ?? 0),
    );
    expect(reaisDeMoneyAmazon(brl('10.00'))).not.toBe(reaisDeMoneyAmazon(brl('0.01')));
  });

  it("0 and absent stay DISTINCT: '0'/'0.00' read 0; '', '1e3', null, absent, a JSON number and a non-BRL currency read null", () => {
    expect(reaisDeMoneyAmazon(brl('0'))).toBe(0);
    expect(reaisDeMoneyAmazon(brl('0.00'))).toBe(0);
    for (const amount of ['', '1e3', null, undefined, 1599.9]) {
      expect(reaisDeMoneyAmazon(brl(amount)), String(amount)).toBeNull();
    }
    expect(reaisDeMoneyAmazon({ amount: '10.00', currencyCode: 'USD' })).toBeNull();
    expect(reaisDeMoneyAmazon({ amount: '10.00', currencyCode: 'brl' })).toBeNull();
    expect(reaisDeMoneyAmazon({ amount: '10.00' })).toBeNull();
    expect(reaisDeMoneyAmazon(null)).toBeNull();
    expect(reaisDeMoneyAmazon(undefined)).toBeNull();
  });

  it('somaReais keeps null when any part is null; an empty list is 0', () => {
    expect(somaReais([10, 0.1, 0.2])).toBe(10.3);
    expect(somaReais([10, null])).toBeNull();
    expect(somaReais([])).toBe(0);
  });
});

describe('dinheiroDoPedidoAmazon — the order-money group from the line breakdowns', () => {
  const comQuebras = (quebras: readonly unknown[], outras: readonly unknown[] = []) =>
    pedidoAmazon({
      linhas: [
        linhaAmazon('L1', { qtd: 1, preco: '100.00', quebras }),
        linhaAmazon('L2', { qtd: 1, preco: '50.00', quebras: outras }),
      ],
    });

  it('freight = Σ SHIPPING − the SHIPPING part of the DISCOUNT rows; descontoTotal = Σ DISCOUNT − that part', () => {
    const order = comQuebras(
      [
        { type: 'ITEM', subtotal: brl('100.00') },
        { type: 'SHIPPING', subtotal: brl('15.00') },
        {
          type: 'DISCOUNT',
          subtotal: brl('12.00'),
          detailedBreakdowns: [
            { subtype: 'ITEM', value: brl('7.00') },
            { subtype: 'SHIPPING', value: brl('5.00') },
          ],
        },
      ],
      [
        { type: 'ITEM', subtotal: brl('50.00') },
        { type: 'SHIPPING', subtotal: brl('5.00') },
      ],
    );
    expect(dinheiroDoPedidoAmazon(order)).toEqual({ descontoTotal: 7, valorFrete: 15 });
  });

  it('a discount is read as an ABSOLUTE value (the sign is a C1 checkpoint)', () => {
    const order = comQuebras([
      { type: 'SHIPPING', subtotal: brl('10.00') },
      {
        type: 'DISCOUNT',
        subtotal: brl('-3.00'),
        detailedBreakdowns: [{ subtype: 'SHIPPING', value: brl('-1.00') }],
      },
    ]);
    expect(dinheiroDoPedidoAmazon(order)).toEqual({ descontoTotal: 2, valorFrete: 9 });
  });

  it('no SHIPPING row ⇒ the freight is ABSENT (never 0); no DISCOUNT row ⇒ discount 0', () => {
    const order = comQuebras([{ type: 'ITEM', subtotal: brl('100.00') }]);
    expect(dinheiroDoPedidoAmazon(order)).toEqual({ descontoTotal: 0, valorFrete: null });
  });

  it('no line carrying breakdowns at all ⇒ both members absent', () => {
    expect(dinheiroDoPedidoAmazon(pedidoAmazon())).toEqual({
      descontoTotal: null,
      valorFrete: null,
    });
  });

  it('an unreadable member reads absent, never 0; the token match is exact', () => {
    const ilegivel = comQuebras([
      { type: 'SHIPPING', subtotal: brl('') },
      { type: 'DISCOUNT', subtotal: { amount: '3.00', currencyCode: 'USD' } },
    ]);
    expect(dinheiroDoPedidoAmazon(ilegivel)).toEqual({ descontoTotal: null, valorFrete: null });
    const tokens = comQuebras([{ type: 'shipping', subtotal: brl('9.00') }]);
    expect(dinheiroDoPedidoAmazon(tokens).valorFrete).toBeNull();
  });

  it('proceeds.grandTotal is never read (it is what the SELLER receives)', () => {
    const order = pedidoAmazon({
      linhas: [
        linhaAmazon('L1', {
          qtd: 1,
          preco: '100.00',
          quebras: [{ type: 'SHIPPING', subtotal: brl('10.00') }],
        }),
      ],
      extra: { proceeds: { grandTotal: brl('9999.99') } },
    });
    expect(dinheiroDoPedidoAmazon(order)).toEqual({ descontoTotal: 0, valorFrete: 10 });
  });
});
