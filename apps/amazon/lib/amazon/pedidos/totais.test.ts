/**
 * The order's money, end to end through the shared `derivePedidoFreteTotals`
 * (`@delfrance/schemas`): what the pedido totals, what its pagamento states, and
 * what the buyer paid Amazon — to the centavo (master plan step 6, PR 6).
 *
 * The rule pinned here (the FOB answer of 2026-10-21): the pagamento `valor` is
 * what the NF-e states, `vNF` = Σ lines − `descontoTotal` + the freight ONLY
 * under CIF (`'0'`, the one modalidade whose freight the NF-e builder puts in
 * the note). So Σ vPag = vNF under either modalidade, with no NF-e-side rule:
 *
 *   CIF: Σ lines − descontoTotal + freight = valor = Σ executions
 *   FOB: Σ lines − descontoTotal           = valor = Σ executions − freight
 *
 * where the freight is what the buyer paid Amazon for shipping, net of its
 * shipping discount. Each modalidade gets an EQUAL pair and a one-centavo
 * NEAR-MISS (`pagamento-divergente`).
 *
 * ⚠️ PLACEHOLDERS ONLY: the sandbox values come from `testing/sandboxBr.ts`
 * (composed in test code, plan §3 decision 34); the acquirer's CNPJ is made at
 * run time there.
 */
import {
  pedidoWireAmazonSchema,
  type PedidoWireAmazon,
} from '@delfrance/integrations-amazon-sp-api';
import { nextPedidoEstado } from '@delfrance/data/pedido';
import {
  ESTADO_PEDIDO,
  MODALIDADE_FRETE,
  derivePedidoFreteTotals,
  type ItemDoPedido,
} from '@delfrance/schemas';
import { describe, expect, it } from 'vitest';

import { brl } from '../testing/pedidoWireAmazon';
import { searchOrdersBr } from '../testing/sandboxBr';
import {
  mapearPedidoAmazon,
  montarEscritaPedidoAmazon,
  type EntradasPedidoAmazon,
} from './pedidoMapeamento';

const NOW_US = 1_900_000_000_000_000;

const ENTRADAS: EntradasPedidoAmazon = {
  integracaoPedidoOuterRef: 'documents/integracao/conta-teste',
  operacaoPedidoOuterRef: null,
  clientePedidoOuterRef: null,
  enderecoFreteOuterReference: null,
  integracaoFreteOuterRef: null,
  modalidadeFreteImportacao: null,
  vinculos: new Map(),
};

/** The sandbox B2B order (searchOrders 200 static[2]) as a getOrder body, with `ajuste` applied. */
function pedidoB2b(
  ajuste: {
    readonly quebras?: readonly unknown[];
    readonly pago?: string;
  } = {},
): PedidoWireAmazon {
  const base = structuredClone(searchOrdersBr().orders[0]) as Record<string, unknown>;
  const linhas = base.orderItems as Record<string, unknown>[];
  const linha = linhas[0] as Record<string, unknown>;
  if (ajuste.quebras !== undefined) {
    linha.proceeds = { breakdowns: [...ajuste.quebras] };
  }
  if (ajuste.pago !== undefined) {
    const pagamento = base.payment as { paymentExecutions: Record<string, unknown>[] };
    const [execucao] = pagamento.paymentExecutions;
    if (execucao === undefined) throw new Error('sandbox sem execução');
    execucao.paymentAmount = brl(ajuste.pago);
  }
  return pedidoWireAmazonSchema.parse(base);
}

/** Everything the order money becomes: the pedido's numbers and the pagamento's. */
function totais(order: PedidoWireAmazon, modalidade: '0' | '1' | null) {
  const r = montarEscritaPedidoAmazon(
    null,
    null,
    mapearPedidoAmazon(order, { ...ENTRADAS, modalidadeFreteImportacao: modalidade }),
    { nowUs: NOW_US },
  );
  if (r.tipo !== 'criar') throw new Error(`esperava criar, veio ${r.tipo}`);
  if (r.pagamento.tipo !== 'criar') throw new Error(`pagamento ${r.pagamento.tipo}`);
  const itens = Object.values(r.corpo.itens as Record<string, ItemDoPedido[]>).flat();
  const frete = (r.corpo.freteInicial as { valorCobrado: number | null; modalidade: string })
    .valorCobrado;
  const descontoTotal = r.corpo.descontoTotal as number;
  return {
    itens,
    descontoTotal,
    frete,
    modalidade: (r.corpo.freteInicial as { modalidade: string }).modalidade,
    valorCobrado: r.corpo.valorCobrado as number,
    valor: r.pagamento.corpo.valor as number,
    incidentes: r.decisao.incidentes,
    /** What the NF-e states: the shared derive, the freight member only under CIF. */
    vNF: derivePedidoFreteTotals({
      itens,
      descontoTotal,
      freteInicial: {
        valorCobrado:
          (r.corpo.freteInicial as { modalidade: string }).modalidade === MODALIDADE_FRETE.cif
            ? frete
            : null,
      },
    }).valorCobrado,
    somaLinhas: derivePedidoFreteTotals({ itens, descontoTotal: 0, freteInicial: null })
      .valorCobrado,
  };
}

const ITEM = { type: 'ITEM', subtotal: brl('1599.90') };
const FRETE = { type: 'SHIPPING', subtotal: brl('25.00') };

describe('★ the sandbox B2B order: Σ lines − descontoTotal + freight = valor = Σ executions, to the centavo', () => {
  it('as it comes (no shipping row): 1599.90 everywhere, under the conta default (FOB) and CIF alike', () => {
    for (const modalidade of [null, MODALIDADE_FRETE.cif] as const) {
      const t = totais(pedidoB2b(), modalidade);
      expect(t.frete).toBeNull();
      expect(t.descontoTotal).toBe(0);
      expect(t.somaLinhas).toBe(1599.9);
      expect(t.valorCobrado).toBe(1599.9);
      expect(t.valor).toBe(1599.9);
      expect(t.vNF).toBe(t.valor);
      expect(t.incidentes).toEqual([]);
    }
    // The conta default is FOB.
    expect(totais(pedidoB2b(), null).modalidade).toBe(MODALIDADE_FRETE.fob);
  });

  it('★ proceeds.grandTotal (what the SELLER receives) is never read: a net total below what the buyer paid changes nothing', () => {
    const base = structuredClone(searchOrdersBr().orders[0]) as Record<string, unknown>;
    base.proceeds = { grandTotal: brl('1400.00') };
    const t = totais(pedidoWireAmazonSchema.parse(base), null);
    expect(t.valor).toBe(1599.9);
    expect(t.incidentes).toEqual([]);
  });
});

describe('★ CIF (`0`): the NF-e carries the freight, so does the pagamento', () => {
  it('EQUAL: Σ lines − descontoTotal + freight = valor = Σ executions = vNF', () => {
    const t = totais(pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.90' }), MODALIDADE_FRETE.cif);
    expect(t.frete).toBe(25);
    expect(t.somaLinhas - t.descontoTotal + (t.frete ?? 0)).toBe(1624.9);
    expect(t.valor).toBe(1624.9);
    expect(t.valorCobrado).toBe(1624.9);
    expect(t.vNF).toBe(t.valor);
    expect(t.incidentes).toEqual([]);
  });

  it('NEAR-MISS: one centavo short ⇒ the valor still covers the note’s total, + pagamento-divergente', () => {
    const t = totais(pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.89' }), MODALIDADE_FRETE.cif);
    expect(t.valor).toBe(1624.9);
    expect(t.vNF).toBe(t.valor);
    expect(t.incidentes).toEqual(['pagamento-divergente']);
  });
});

describe('★ FOB (`1`, the conta default): the NF-e carries no freight, so neither does the pagamento', () => {
  it('EQUAL: Σ lines − descontoTotal = valor = Σ executions − the buyer-paid freight = vNF; the pedido still totals the freight', () => {
    const t = totais(pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.90' }), MODALIDADE_FRETE.fob);
    expect(t.frete).toBe(25);
    expect(t.somaLinhas - t.descontoTotal).toBe(1599.9);
    expect(t.valor).toBe(1599.9);
    expect(t.vNF).toBe(t.valor);
    // The pedido's own total keeps the freight the buyer paid (the shared derive).
    expect(t.valorCobrado).toBe(1624.9);
    expect(t.incidentes).toEqual([]);
  });

  it('RESIDUE (a merge-gating OWNER decision, cross-channel): the shared reconcile still totals the freight, so a pagamento edit relabels a FOB pago whose valor excludes it', () => {
    const t = totais(pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.90' }), MODALIDADE_FRETE.fob);
    // `nextPedidoEstado` compares the paid sum with the pedido's `valorCobrado`
    // (freight included); the pagamento states the note's total (freight excluded).
    // The trigger is ANY pagamento mutation on the Pagamentos tab (its reconcile
    // carries no marketplace gate; a pedido-form save does, and skips Amazon).
    // The relabelled estado is pre-approval, so the order's next import mirrors
    // the lines again (D17 row 9, SHIPPED orders included) and re-promotes it to
    // pago. The pair table in `pedidoMapeamento.test.ts` lists every such row BY
    // NAME; the owner's choice (the reconcile compares with the note's total, or
    // the pedido's total stops carrying non-CIF freight) flips both.
    expect(nextPedidoEstado(ESTADO_PEDIDO.pago, t.valorCobrado, t.valor, t.valor)).toEqual({
      estado: ESTADO_PEDIDO.aguardandoConfirmacaoDePagamento,
      autorizarDespacho: false,
    });
    // NEAR-MISS: without buyer-paid shipping, or under CIF, nothing is relabelled.
    const semFrete = totais(pedidoB2b(), MODALIDADE_FRETE.fob);
    expect(
      nextPedidoEstado(ESTADO_PEDIDO.pago, semFrete.valorCobrado, semFrete.valor, semFrete.valor),
    ).toBeNull();
    const cif = totais(
      pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.90' }),
      MODALIDADE_FRETE.cif,
    );
    expect(nextPedidoEstado(ESTADO_PEDIDO.pago, cif.valorCobrado, cif.valor, cif.valor)).toBeNull();
  });

  it('NEAR-MISS: one centavo above ⇒ the larger remainder + pagamento-divergente (Σ vPag ≠ vNF is visible, never hidden)', () => {
    const t = totais(pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.91' }), MODALIDADE_FRETE.fob);
    expect(t.valor).toBe(1599.91);
    expect(t.incidentes).toEqual(['pagamento-divergente']);
  });

  it('the freight is SHIPPING net of its own discount: SHIPPING 25 with a 10 discount of which 5 is shipping ⇒ freight 20, descontoTotal 5', () => {
    const quebras = [
      ITEM,
      FRETE,
      {
        type: 'DISCOUNT',
        subtotal: brl('10.00'),
        detailedBreakdowns: [{ subtype: 'SHIPPING', value: brl('5.00') }],
      },
    ];
    const fob = totais(pedidoB2b({ quebras, pago: '1614.90' }), MODALIDADE_FRETE.fob);
    expect(fob).toMatchObject({ frete: 20, descontoTotal: 5, valor: 1594.9, incidentes: [] });
    expect(fob.vNF).toBe(fob.valor);
    const cif = totais(pedidoB2b({ quebras, pago: '1614.90' }), MODALIDADE_FRETE.cif);
    expect(cif).toMatchObject({ frete: 20, descontoTotal: 5, valor: 1614.9, incidentes: [] });
    expect(cif.vNF).toBe(cif.valor);
  });
});

/**
 * The same money on an UPDATE: a stored, approved pedido WITHOUT a pagamento
 * (the legacy approved-without-pagamento shape), created under a conta seeding
 * `semente`, whose freight block was then set to `bloco` — read again under the
 * same conta, so the import creates the pagamento from the STORED pedido.
 */
function valorNaAtualizacao(order: PedidoWireAmazon, semente: '0' | '1', bloco: '0' | '1') {
  const entradas = { ...ENTRADAS, modalidadeFreteImportacao: semente };
  const criado = montarEscritaPedidoAmazon(null, null, mapearPedidoAmazon(order, entradas), {
    nowUs: NOW_US,
  });
  if (criado.tipo !== 'criar') throw new Error(`esperava criar, veio ${criado.tipo}`);
  const guardado = structuredClone(criado.corpo) as Record<string, unknown>;
  expect(guardado.estado).toBe(ESTADO_PEDIDO.pago);
  const frete = guardado.freteInicial as Record<string, unknown>;
  expect(frete.modalidade).toBe(semente);
  frete.modalidade = bloco;
  const r = montarEscritaPedidoAmazon(guardado, null, mapearPedidoAmazon(order, entradas), {
    nowUs: NOW_US,
  });
  if (r.tipo === 'nao-importado' || r.tipo === 'obsoleto') throw new Error(r.tipo);
  if (r.pagamento.tipo !== 'criar') throw new Error(`pagamento ${r.pagamento.tipo}`);
  const itens = Object.values(guardado.itens as Record<string, ItemDoPedido[]>).flat();
  return {
    valor: r.pagamento.corpo.valor as number,
    incidentes: r.decisao.incidentes,
    somaLinhas: derivePedidoFreteTotals({ itens, descontoTotal: 0, freteInicial: null })
      .valorCobrado,
    descontoTotal: guardado.descontoTotal as number,
    frete: frete.valorCobrado as number,
  };
}

describe('★ on an UPDATE the PEDIDO’s freight modalidade decides, never the conta’s seed', () => {
  it('a stored CIF block under a conta seeding FOB: Σ lines − descontoTotal + freight = valor (EQUAL); one centavo short ⇒ the total + pagamento-divergente (NEAR-MISS)', () => {
    const igual = valorNaAtualizacao(
      pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.90' }),
      MODALIDADE_FRETE.fob,
      MODALIDADE_FRETE.cif,
    );
    expect(igual.frete).toBe(25);
    expect(igual.somaLinhas - igual.descontoTotal + igual.frete).toBe(1624.9);
    expect(igual.valor).toBe(1624.9);
    expect(igual.incidentes).toEqual([]);
    const curto = valorNaAtualizacao(
      pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.89' }),
      MODALIDADE_FRETE.fob,
      MODALIDADE_FRETE.cif,
    );
    expect(curto.valor).toBe(1624.9);
    expect(curto.incidentes).toEqual(['pagamento-divergente']);
  });

  it('a stored FOB block under a conta seeding CIF: Σ lines − descontoTotal = valor = Σ − freight (EQUAL); one centavo above ⇒ that remainder + pagamento-divergente (NEAR-MISS)', () => {
    const igual = valorNaAtualizacao(
      pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.90' }),
      MODALIDADE_FRETE.cif,
      MODALIDADE_FRETE.fob,
    );
    expect(igual.somaLinhas - igual.descontoTotal).toBe(1599.9);
    expect(igual.valor).toBe(1599.9);
    expect(igual.incidentes).toEqual([]);
    const acima = valorNaAtualizacao(
      pedidoB2b({ quebras: [ITEM, FRETE], pago: '1624.91' }),
      MODALIDADE_FRETE.cif,
      MODALIDADE_FRETE.fob,
    );
    expect(acima.valor).toBe(1599.91);
    expect(acima.incidentes).toEqual(['pagamento-divergente']);
  });
});

/**
 * (PR 5-f) What the order money cannot state. The pagamento check proves the
 * TOTAL against the payment, never the split behind it, so two shapes leave the
 * note's numbers wrong with every total agreeing: the money stays as derived
 * (never a guessed split), and a pedido incidente asks a person to check the
 * NF-e before emitting it.
 */
describe('★ a money shape the check cannot see ⇒ an incidente, the money unchanged (PR 5-f)', () => {
  const ITEM_1450 = { type: 'ITEM', subtotal: brl('1450.00') };
  const descontoDeFrete = (valor: string, detalhes?: readonly unknown[]) => ({
    type: 'DISCOUNT',
    subtotal: brl(valor),
    ...(detalhes === undefined ? {} : { detailedBreakdowns: detalhes }),
  });

  it('★ a free-shipping DISCOUNT 25 with NO detail, the buyer paying 1599.90: FOB vNF = valor = 1574.90 with every total agreeing ⇒ desconto-nao-detalhado', () => {
    const quebras = [ITEM, FRETE, descontoDeFrete('25.00')];
    const fob = totais(pedidoB2b({ quebras, pago: '1599.90' }), MODALIDADE_FRETE.fob);
    // The money is what it was (no guessed split): the whole discount on the goods, the freight gross.
    expect(fob).toMatchObject({ descontoTotal: 25, frete: 25, valor: 1574.9 });
    expect(fob.vNF).toBe(fob.valor);
    // The payment check agrees with it (no pagamento-divergente); only the new incidente speaks.
    expect(fob.incidentes).toEqual(['desconto-nao-detalhado']);
    // Under CIF the note's total is right, but its discount and freight are each off by 25.
    const cif = totais(pedidoB2b({ quebras, pago: '1599.90' }), MODALIDADE_FRETE.cif);
    expect(cif).toMatchObject({ descontoTotal: 25, frete: 25, valor: 1599.9 });
    expect(cif.incidentes).toEqual(['desconto-nao-detalhado']);
  });

  it('the same with an ITEM detail that does not account for the whole discount (10 of 25), and with a NEGATIVE discount (goods 10 + shipping 5 as −15), ⇒ desconto-nao-detalhado', () => {
    const itemParcial = totais(
      pedidoB2b({
        quebras: [
          ITEM,
          FRETE,
          descontoDeFrete('25.00', [{ subtype: 'ITEM', value: brl('10.00') }]),
        ],
        pago: '1599.90',
      }),
      MODALIDADE_FRETE.fob,
    );
    expect(itemParcial.incidentes).toEqual(['desconto-nao-detalhado']);
    const negativo = totais(
      pedidoB2b({ quebras: [ITEM, FRETE, descontoDeFrete('-15.00')], pago: '1609.90' }),
      MODALIDADE_FRETE.fob,
    );
    expect(negativo).toMatchObject({ descontoTotal: 15, frete: 25, valor: 1584.9 });
    expect(negativo.incidentes).toEqual(['desconto-nao-detalhado']);
  });

  it('NEAR-MISS: the same DISCOUNT 25 ITEMISED as SHIPPING (either sign) ⇒ freight net, vNF 1599.90, nothing filed', () => {
    for (const valor of ['25.00', '-25.00']) {
      const t = totais(
        pedidoB2b({
          quebras: [
            ITEM,
            FRETE,
            descontoDeFrete(valor, [{ subtype: 'SHIPPING', value: brl(valor) }]),
          ],
          pago: '1599.90',
        }),
        MODALIDADE_FRETE.fob,
      );
      expect(t, valor).toMatchObject({ descontoTotal: 0, frete: 0, valor: 1599.9, incidentes: [] });
      expect(t.vNF, valor).toBe(1599.9);
    }
  });

  it('★ NEAR-MISS: a DISCOUNT 10 whose ITEM detail accounts for all of it (its shipping part stated as 0), the buyer paying 1614.90 ⇒ every number right under CIF and FOB, nothing filed', () => {
    const quebras = [
      ITEM,
      FRETE,
      descontoDeFrete('10.00', [{ subtype: 'ITEM', value: brl('10.00') }]),
    ];
    const cif = totais(pedidoB2b({ quebras, pago: '1614.90' }), MODALIDADE_FRETE.cif);
    expect(cif).toMatchObject({ descontoTotal: 10, frete: 25, valor: 1614.9, incidentes: [] });
    expect(cif.vNF).toBe(1614.9);
    const fob = totais(pedidoB2b({ quebras, pago: '1614.90' }), MODALIDADE_FRETE.fob);
    expect(fob).toMatchObject({ descontoTotal: 10, frete: 25, valor: 1589.9, incidentes: [] });
    expect(fob.vNF).toBe(1589.9);
  });

  it('NEAR-MISS: a DISCOUNT with no detail on an order charging NO shipping ⇒ a plain goods discount, nothing filed', () => {
    const t = totais(
      pedidoB2b({ quebras: [ITEM, descontoDeFrete('100.00')], pago: '1499.90' }),
      MODALIDADE_FRETE.fob,
    );
    expect(t).toMatchObject({ descontoTotal: 100, frete: null, valor: 1499.9, incidentes: [] });
  });

  it('★ a TAX breakdown beside an itemised order, every total agreeing (the mixed basis is silent) ⇒ imposto-destacado', () => {
    // ITEM 1450 + TAX 149.90 (unitPrice stays 1599.90), SHIPPING 100 and a goods
    // DISCOUNT 100 (its shipping part itemised as 0), each with a TAX detail of 10.
    const quebras = [
      ITEM_1450,
      { type: 'SHIPPING', subtotal: brl('100.00') },
      descontoDeFrete('100.00', [
        { subtype: 'ITEM', value: brl('100.00') },
        { subtype: 'SHIPPING', value: brl('0.00') },
      ]),
      {
        type: 'TAX',
        subtotal: brl('149.90'),
        detailedBreakdowns: [
          { subtype: 'ITEM', value: brl('149.90') },
          { subtype: 'SHIPPING', value: brl('10.00') },
          { subtype: 'DISCOUNT', value: brl('-10.00') },
        ],
      },
    ];
    const fob = totais(pedidoB2b({ quebras, pago: '1599.90' }), MODALIDADE_FRETE.fob);
    expect(fob).toMatchObject({ descontoTotal: 100, frete: 100, valor: 1499.9 });
    expect(fob.vNF).toBe(fob.valor);
    expect(fob.incidentes).toEqual(['imposto-destacado']);
  });

  it('NEAR-MISS: the same order with TAX exactly 0, or with no TAX row ⇒ nothing filed', () => {
    const base = [
      ITEM,
      { type: 'SHIPPING', subtotal: brl('100.00') },
      descontoDeFrete('100.00', [
        { subtype: 'ITEM', value: brl('100.00') },
        { subtype: 'SHIPPING', value: brl('0.00') },
      ]),
    ];
    const zero = {
      type: 'TAX',
      subtotal: brl('0.00'),
      detailedBreakdowns: [{ subtype: 'ITEM', value: brl('0.00') }],
    };
    for (const quebras of [[...base, zero], base]) {
      const t = totais(pedidoB2b({ quebras, pago: '1599.90' }), MODALIDADE_FRETE.fob);
      expect(t.incidentes).toEqual([]);
      expect(t.valor).toBe(1499.9);
    }
  });
});
