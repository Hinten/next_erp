import { centavosDeReais } from '@delfrance/core/money';
import { describe, expect, it } from 'vitest';

import { brl, linhaAmazon, pedidoAmazon } from '../testing/pedidoWireAmazon';
import {
  dinheiroDoPedidoAmazon,
  mesmosCentavos,
  reaisDeMoneyAmazon,
  ressalvasDoDinheiroAmazon,
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

describe('ressalvasDoDinheiroAmazon — what the group cannot state (PR 5-f), counted, never folded', () => {
  const linha = (id: string, quebras: readonly unknown[]) =>
    linhaAmazon(id, { qtd: 1, preco: '100.00', quebras });
  const ressalvas = (...linhas: Record<string, unknown>[]) =>
    ressalvasDoDinheiroAmazon(pedidoAmazon({ linhas }));
  const FRETE = { type: 'SHIPPING', subtotal: brl('25.00') };
  const desconto = (valor: string, detalhes?: readonly unknown[]) => ({
    type: 'DISCOUNT',
    subtotal: brl(valor),
    ...(detalhes === undefined ? {} : { detailedBreakdowns: detalhes }),
  });

  it('COUNTS: a DISCOUNT on a line charging SHIPPING whose shipping part is not stated — no details, or details (no SHIPPING) that do not add up to it, either sign', () => {
    for (const [nome, d] of [
      ['no details', desconto('25.00')],
      ['an empty details list', desconto('25.00', [])],
      [
        'an ITEM detail short of the subtotal',
        desconto('25.00', [{ subtype: 'ITEM', value: brl('10.00') }]),
      ],
      [
        'an ITEM detail one centavo short',
        desconto('25.00', [{ subtype: 'ITEM', value: brl('24.99') }]),
      ],
      [
        'ITEM details over the subtotal',
        desconto('25.00', [{ subtype: 'ITEM', value: brl('30.00') }]),
      ],
      ['an unreadable ITEM detail', desconto('25.00', [{ subtype: 'ITEM', value: brl('') }])],
      ['negative, no details', desconto('-25.00')],
      ['negative, only ITEM', desconto('-15.00', [{ subtype: 'ITEM', value: brl('-10.00') }])],
      // An undocumented subtype might be the shipping part: it never accounts
      // for the discount, even when it adds up to it (the match is exact).
      [
        'a new subtype token adding up to it',
        desconto('25.00', [{ subtype: 'NEW_SUBTYPE', value: brl('25.00') }]),
      ],
      [
        'an ITEM detail beside an undocumented one, adding up',
        desconto('25.00', [
          { subtype: 'ITEM', value: brl('20.00') },
          { subtype: 'NEW_SUBTYPE', value: brl('5.00') },
        ]),
      ],
      [
        'a lower-case shipping detail',
        desconto('25.00', [{ subtype: 'shipping', value: brl('25.00') }]),
      ],
    ] as const) {
      expect(ressalvas(linha('L1', [FRETE, d])), nome).toEqual({
        linhasDescontoNaoDetalhado: 1,
        quebrasImposto: 0,
      });
    }
  });

  it('NEAR-MISS: an itemised shipping part (positive, negative, or 0), no SHIPPING on THAT line, or a 0 row ⇒ nothing', () => {
    for (const [nome, l] of [
      [
        'itemised',
        linha('L1', [FRETE, desconto('25.00', [{ subtype: 'SHIPPING', value: brl('25.00') }])]),
      ],
      [
        'itemised, negative',
        linha('L1', [FRETE, desconto('-25.00', [{ subtype: 'SHIPPING', value: brl('-25.00') }])]),
      ],
      [
        'itemised as 0 beside an ITEM detail',
        linha('L1', [
          FRETE,
          desconto('10.00', [
            { subtype: 'ITEM', value: brl('10.00') },
            { subtype: 'SHIPPING', value: brl('0.00') },
          ]),
        ]),
      ],
      ['a DISCOUNT on a line with no SHIPPING row', linha('L1', [desconto('25.00')])],
      [
        'SHIPPING exactly 0',
        linha('L1', [{ type: 'SHIPPING', subtotal: brl('0.00') }, desconto('25.00')]),
      ],
      ['DISCOUNT exactly 0', linha('L1', [FRETE, desconto('0.00')])],
      ['no DISCOUNT at all', linha('L1', [FRETE])],
      // Details that account for the WHOLE discount state its shipping part as 0.
      [
        'only an ITEM detail equal to the subtotal',
        linha('L1', [FRETE, desconto('25.00', [{ subtype: 'ITEM', value: brl('25.00') }])]),
      ],
      [
        'two ITEM details adding up to it',
        linha('L1', [
          FRETE,
          desconto('25.00', [
            { subtype: 'ITEM', value: brl('10.00') },
            { subtype: 'ITEM', value: brl('15.00') },
          ]),
        ]),
      ],
      [
        'documented non-shipping subtypes adding up (ITEM + OTHER + GIFT_WRAP)',
        linha('L1', [
          FRETE,
          desconto('25.00', [
            { subtype: 'ITEM', value: brl('20.00') },
            { subtype: 'OTHER', value: brl('3.00') },
            { subtype: 'GIFT_WRAP', value: brl('2.00') },
          ]),
        ]),
      ],
      [
        'negative, ITEM equal to it (either sign)',
        linha('L1', [FRETE, desconto('-15.00', [{ subtype: 'ITEM', value: brl('15.00') }])]),
      ],
    ] as const) {
      expect(ressalvas(l).linhasDescontoNaoDetalhado, nome).toBe(0);
    }
    // Per LINE: a discount on one line is never read against another line's shipping.
    expect(ressalvas(linha('L1', [desconto('25.00')]), linha('L2', [FRETE]))).toEqual({
      linhasDescontoNaoDetalhado: 0,
      quebrasImposto: 0,
    });
    expect(
      ressalvas(linha('L1', [FRETE, desconto('5.00')]), linha('L2', [FRETE, desconto('-5.00')]))
        .linhasDescontoNaoDetalhado,
    ).toBe(2);
  });

  it('an amount that does not READ counts (fail-safe): an unreadable SHIPPING or DISCOUNT, a non-BRL one', () => {
    expect(
      ressalvas(linha('L1', [{ type: 'SHIPPING', subtotal: brl('') }, desconto('25.00')]))
        .linhasDescontoNaoDetalhado,
    ).toBe(1);
    expect(
      ressalvas(
        linha('L1', [
          FRETE,
          { type: 'DISCOUNT', subtotal: { amount: '3.00', currencyCode: 'USD' } },
        ]),
      ).linhasDescontoNaoDetalhado,
    ).toBe(1);
  });

  it('COUNTS a TAX row whose subtotal or any detail is not exactly 0 — line or order level, either sign, unreadable', () => {
    const imposto = (valor: unknown, detalhes?: readonly unknown[]) => ({
      type: 'TAX',
      subtotal: brl(valor),
      ...(detalhes === undefined ? {} : { detailedBreakdowns: detalhes }),
    });
    for (const [nome, q] of [
      ['a positive subtotal', imposto('149.90')],
      ['a negative subtotal', imposto('-0.24')],
      [
        'a 0 subtotal with a nonzero detail',
        imposto('0.00', [{ subtype: 'DISCOUNT', value: brl('-0.24') }]),
      ],
      ['an unreadable subtotal', imposto('')],
    ] as const) {
      expect(ressalvas(linha('L1', [q])), nome).toEqual({
        linhasDescontoNaoDetalhado: 0,
        quebrasImposto: 1,
      });
    }
    expect(
      ressalvasDoDinheiroAmazon(
        pedidoAmazon({
          extra: { proceeds: { breakdowns: [{ type: 'TAX', subtotal: brl('4.00') }] } },
        }),
      ).quebrasImposto,
    ).toBe(1);
    // Two lines, each with a TAX row, plus the order-level aggregate: the line rows
    // count, and their aggregate is never counted again (one tax, one count).
    expect(
      ressalvasDoDinheiroAmazon(
        pedidoAmazon({
          linhas: [linha('L1', [imposto('1.00')]), linha('L2', [imposto('2.00')])],
          extra: { proceeds: { breakdowns: [{ type: 'TAX', subtotal: brl('3.00') }] } },
        }),
      ).quebrasImposto,
    ).toBe(2);
    expect(
      ressalvasDoDinheiroAmazon(
        pedidoAmazon({
          linhas: [linha('L1', [imposto('5.00')])],
          extra: { proceeds: { breakdowns: [{ type: 'TAX', subtotal: brl('5.00') }] } },
        }),
      ).quebrasImposto,
    ).toBe(1);
    // NEAR-MISS: lines with breakdowns but no TAX row — the order-level TAX still counts.
    expect(
      ressalvasDoDinheiroAmazon(
        pedidoAmazon({
          linhas: [linha('L1', [FRETE])],
          extra: { proceeds: { breakdowns: [{ type: 'TAX', subtotal: brl('5.00') }] } },
        }),
      ).quebrasImposto,
    ).toBe(1);
  });

  it('NEAR-MISS: TAX exactly 0 (subtotal and details), TAX absent, or a differently spelt token ⇒ nothing', () => {
    expect(
      ressalvas(
        linha('L1', [
          {
            type: 'TAX',
            subtotal: brl('0.00'),
            detailedBreakdowns: [{ subtype: 'ITEM', value: brl('0') }],
          },
        ]),
      ).quebrasImposto,
    ).toBe(0);
    expect(
      ressalvas(linha('L1', [{ type: 'ITEM', subtotal: brl('100.00') }, FRETE])).quebrasImposto,
    ).toBe(0);
    expect(ressalvas(linha('L1', [{ type: 'tax', subtotal: brl('9.00') }])).quebrasImposto).toBe(0);
    expect(
      ressalvasDoDinheiroAmazon(
        pedidoAmazon({
          extra: { proceeds: { breakdowns: [{ type: 'TAX', subtotal: brl('0.00') }] } },
        }),
      ).quebrasImposto,
    ).toBe(0);
    // No breakdowns anywhere.
    expect(ressalvasDoDinheiroAmazon(pedidoAmazon())).toEqual({
      linhasDescontoNaoDetalhado: 0,
      quebrasImposto: 0,
    });
  });

  it('TAX never moves the group: the same order with and without a TAX row reads the same discount and freight', () => {
    const base = [FRETE, desconto('10.00', [{ subtype: 'SHIPPING', value: brl('5.00') }])];
    const sem = dinheiroDoPedidoAmazon(pedidoAmazon({ linhas: [linha('L1', base)] }));
    const com = dinheiroDoPedidoAmazon(
      pedidoAmazon({ linhas: [linha('L1', [...base, { type: 'TAX', subtotal: brl('15.00') }])] }),
    );
    expect(com).toEqual(sem);
    expect(com).toEqual({ descontoTotal: 5, valorFrete: 20 });
  });
});
