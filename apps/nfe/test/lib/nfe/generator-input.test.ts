import { describe, expect, it } from 'vitest';

import { roundReais } from '@delfrance/core/money';
import {
  MODALIDADE_FRETE,
  ORIGEM,
  FORMA_PAGAMENTO,
  pagamentoSchema,
  type FreteDoPedido,
} from '@delfrance/schemas';

import {
  apportionDescontos,
  buildGeneratorInput,
  buildGenItems,
} from '../../../lib/nfe/orchestrator/generator-input';
import type { FiscalItem, PedidoBundle } from '../../../lib/nfe/orchestrator/bundle';

/**
 * Regression tests for the discount handling in the NF-e generator input.
 *
 * Bugs fixed:
 *  - the wire `<prod><vProd>` must be GROSS (`vUnCom × qCom`) with the discount
 *    in `<prod><vDesc>`, else SEFAZ rejects with cStat 629;
 *  - `pedido.descontoTotal` must be apportioned across items (it was silently
 *    dropped, overstating `vNF` and mismatching payments → cStat 865).
 */

/** Minimal bundle carrying only the fields buildGenItems/apportionDescontos read. */
function bundleWith(
  operacao: Record<string, unknown>,
  pedido: Record<string, unknown> = {},
): PedidoBundle {
  return {
    pedidoId: 'PED-TEST',
    operacao,
    pedido,
  } as unknown as PedidoBundle;
}

/** Minimal FiscalItem — `vProd` is net-of-unit-discount, `vProdBruto` is gross. */
function item(partial: Partial<FiscalItem>): FiscalItem {
  const precoDeVenda = partial.precoDeVenda ?? 100;
  const quantidade = partial.quantidade ?? 1;
  const descontoUnitario = partial.descontoUnitario ?? null;
  return {
    produtoUid: 'prod-1',
    itemIndex: 0,
    sku: 'SKU-1',
    gtin: null,
    nomeDeVenda: 'Camiseta',
    precoDeVenda,
    descontoUnitario,
    quantidade,
    imposto: {
      origem: ORIGEM.nacional,
      unidade: 'UN',
      NCM: '61091000',
      cfop: '5102',
      configuracaoICMS: { crt: '1', csosn: '102' },
    },
    vProd: roundReais((precoDeVenda - (descontoUnitario ?? 0)) * quantidade),
    vProdBruto: roundReais(precoDeVenda * quantidade),
    ...partial,
  } as FiscalItem;
}

const OP = { cfop: '5102', cfopInterestadual: '6102', NCM: '61091000', unidade: 'UN' };

describe('buildGenItems — discount on the wire', () => {
  it('emits GROSS vProd + vDesc for a per-unit discount (not a net vProd)', () => {
    const it0 = item({ precoDeVenda: 100, quantidade: 2, descontoUnitario: 10 });
    const [gi] = buildGenItems([it0], bundleWith(OP), false);
    // vUnCom × qCom = 100 × 2 = 200 (gross); vDesc = 10 × 2 = 20; net = 180.
    expect(gi!.vProd).toBe(200);
    expect(gi!.vDesc).toBe(20);
    expect(gi!.vUnCom).toBe(100);
    expect(gi!.qCom).toBe(2);
  });

  it('omits vDesc when there is no discount', () => {
    const [gi] = buildGenItems([item({ precoDeVenda: 50, quantidade: 3 })], bundleWith(OP), false);
    expect(gi!.vProd).toBe(150);
    expect(gi!.vDesc).toBeUndefined();
  });

  it('throws when the discount exceeds the gross item value', () => {
    // descontoTotal larger than the whole order → apportioned share blows past gross.
    const it0 = item({ precoDeVenda: 10, quantidade: 1 });
    expect(() => buildGenItems([it0], bundleWith(OP, { descontoTotal: 999 }), false)).toThrow(
      /desconto .* exceeds the gross item value/,
    );
  });
});

describe('apportionDescontos — pedido-level descontoTotal', () => {
  it('splits descontoTotal proportional to net subtotal, remainder on the last item', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }), // net 100
      item({ produtoUid: 'b', precoDeVenda: 300, quantidade: 1 }), // net 300
    ];
    // descontoTotal 40 over net total 400 → 10 to item A (25%), 30 remainder to B.
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 40 }));
    expect(vDescs).toEqual([10, 30]);
    expect(vDescs[0]! + vDescs[1]!).toBe(40);
  });

  it('adds the unit discount to the apportioned order share', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1, descontoUnitario: 5 }), // unit 5, net 95
      item({ produtoUid: 'b', precoDeVenda: 100, quantidade: 1 }), // net 100
    ];
    // order desc 39 over net 195 → A share round(39*95/195)=19 (used), B remainder 20.
    // A total vDesc = 5 + 19 = 24; B total = 0 + 20 = 20.
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 39 }));
    expect(vDescs[0]).toBe(24);
    expect(vDescs[1]).toBe(20);
  });

  it('returns only the unit discounts when descontoTotal is 0/absent', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 2, descontoUnitario: 3 }), // 6
      item({ produtoUid: 'b', precoDeVenda: 100, quantidade: 1 }), // 0
    ];
    expect(apportionDescontos(items, bundleWith(OP))).toEqual([6, 0]);
  });

  it('never leaks a rounding cent: Σ vDesc equals Σ unit discount + descontoTotal', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 33.33, quantidade: 1 }),
      item({ produtoUid: 'b', precoDeVenda: 33.33, quantidade: 1 }),
      item({ produtoUid: 'c', precoDeVenda: 33.34, quantidade: 1 }),
    ];
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 10 }));
    const sum = vDescs.reduce((s, v) => s + v, 0);
    expect(roundReais(sum)).toBe(10);
  });

  it('does not overshoot when equal shares land on a half-cent (Σ stays exact, no negative)', () => {
    // 4 × R$1,00 with a R$0,02 order discount: naïve per-item rounding gives
    // 0,01+0,01+0,01 = 0,03 > 0,02 and a negative last share. The cumulative
    // method must keep Σ = 0,02 with every share ≥ 0.
    const items = Array.from({ length: 4 }, (_, i) =>
      item({ produtoUid: `p${i}`, precoDeVenda: 1, quantidade: 1 }),
    );
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 0.02 }));
    expect(vDescs.every((v) => v >= 0)).toBe(true);
    expect(roundReais(vDescs.reduce((s, v) => s + v, 0))).toBe(0.02);
  });

  it('does not overshoot on the classic 20-item × R$0,50 case (would be R$0,57 naïvely)', () => {
    const items = Array.from({ length: 20 }, (_, i) =>
      item({ produtoUid: `p${i}`, precoDeVenda: 10, quantidade: 1 }),
    );
    const vDescs = apportionDescontos(items, bundleWith(OP, { descontoTotal: 0.5 }));
    expect(vDescs.every((v) => v >= 0)).toBe(true);
    expect(roundReais(vDescs.reduce((s, v) => s + v, 0))).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Σ vPag ↔ vNF pre-send guard (#394 — NT 2025.001 YA03-10/-20, cStat 865/866)
// ---------------------------------------------------------------------------

/** Bundle full enough for buildGeneratorInput (single SP→SP item, no frete). */
function fullBundle(opts: {
  pagamentos?: unknown[];
  frete?: FreteDoPedido | null;
  pedido?: Record<string, unknown>;
}): PedidoBundle {
  return {
    pedidoId: 'PED-GUARD',
    pedido: opts.pedido ?? {},
    operacao: { ...OP, ehExterior: false, indIntermed: '0', infCpl: null },
    filial: { sede: { estado: 'SP' } },
    cliente: {},
    enderecoDest: { estado: 'SP' },
    integracao: null,
    frete: opts.frete ?? null,
    pagamentos: (opts.pagamentos ?? []).map((p) => pagamentoSchema.parse(p)),
    regrasImposto: [],
  } as unknown as PedidoBundle;
}

/** One 100-reais item → vNF = 100 (no frete, no discount). */
const ITEM_100 = [item({ precoDeVenda: 100, quantidade: 1 })];

function build(bundle: PedidoBundle) {
  return buildGeneratorInput(bundle, ITEM_100, 7, 1, 'homologacao');
}

describe('buildGeneratorInput — Σ vPag ↔ vNF guard', () => {
  it('Σ vPag < vNF → throws naming both values (would be SEFAZ 865)', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 90, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
    });
    expect(() => build(bundle)).toThrow(/90\.00.*100\.00.*865/s);
  });

  it('Σ vPag > vNF → throws (would be SEFAZ 866)', () => {
    const bundle = fullBundle({
      pagamentos: [
        { valor: 60, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 60, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
    });
    expect(() => build(bundle)).toThrow(/866/);
  });

  it('Σ vPag == vNF → passes and emits the payments', () => {
    const bundle = fullBundle({
      pagamentos: [
        { valor: 40, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 60, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
    });
    const out = build(bundle);
    expect(out.pagXml).toContain('<vPag>40.00</vPag>');
    expect(out.pagXml).toContain('<vPag>60.00</vPag>');
  });

  it('empty pagamentos (default tPag=90) → guard skipped', () => {
    const out = build(fullBundle({ pagamentos: [] }));
    expect(out.pagXml).toContain('<tPag>90</tPag>');
  });

  it('explicit sem-pagamento record (forma=90, valor>0) → guard skipped, vPag=0', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 50, forma_de_pagamento: FORMA_PAGAMENTO.sem_pagamento }],
    });
    const out = build(bundle);
    expect(out.pagXml).toContain('<vPag>0.00</vPag>');
  });

  it('frete-emitente single-payment override (vPag := vNF) → guard passes', () => {
    // vNF = 100 (item) + 20 (frete emitente) = 120; the single payment's valor
    // (55) is overridden to vNF by the documented Flutter-parity rule.
    const bundle = fullBundle({
      pagamentos: [{ valor: 55, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
      frete: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 20 } as FreteDoPedido,
    });
    const out = build(bundle);
    expect(out.pagXml).toContain('<vPag>120.00</vPag>');
  });
});

describe('buildGeneratorInput — guard uses the WIRE (rounded) vPag values', () => {
  it('sub-cent valor is rounded before the comparison, matching what SEFAZ sums', () => {
    // 10.005 → wire <vPag>10.01</vPag> (roundReais at source). vNF = 10.00 →
    // the guard must throw 866 exactly like SEFAZ would; comparing the RAW sum
    // (10.005 → roundReais 10.01) happens to agree here, but the invariant we
    // pin is: guard verdict == wire verdict, judged on the rounded values.
    const bundle = fullBundle({
      pagamentos: [{ valor: 10.005, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
    });
    const items = [item({ precoDeVenda: 10, quantidade: 1 })];
    expect(() => buildGeneratorInput(bundle, items, 7, 1, 'homologacao')).toThrow(/866/);
  });

  it('two sub-cent valores that round to the exact vNF pass and emit rounded vPag', () => {
    // 33.334999… rounds to 33.33 each → Σ 66.66 == vNF (item 66.66) → passes,
    // and the emitted XML carries the same rounded values the guard summed.
    const bundle = fullBundle({
      pagamentos: [
        { valor: 33.331, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro },
        { valor: 33.329, forma_de_pagamento: FORMA_PAGAMENTO.pix },
      ],
    });
    const items = [item({ precoDeVenda: 66.66, quantidade: 1 })];
    const out = buildGeneratorInput(bundle, items, 7, 1, 'homologacao');
    expect(out.pagXml).toContain('<vPag>33.33</vPag>');
  });
});

/** Imposto that opts the item OUT of the NF-e totals (indTot='0', #398). */
const IMPOSTO_FORA_DO_TOTAL = {
  origem: '0',
  unidade: 'UN',
  NCM: '61091000',
  cfop: '5102',
  compoeValorTotalDaNFe: false,
  configuracaoICMS: { crt: '1', csosn: '102' },
} as const;

describe('indTot — compoeValorTotalDaNFe (#398)', () => {
  it("maps compoeValorTotalDaNFe=false to indTot='0'; absent/true to '1'", () => {
    const items = [
      item({ produtoUid: 'a' }), // no flag → composes
      item({ produtoUid: 'b', imposto: IMPOSTO_FORA_DO_TOTAL as never }),
    ];
    const gis = buildGenItems(items, bundleWith(OP), false);
    expect(gis[0]!.indTot).toBe('1');
    expect(gis[1]!.indTot).toBe('0');
  });

  it('excludes non-composing items from ICMSTot vProd and vNF', () => {
    const bundle = fullBundle({});
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }),
      item({
        produtoUid: 'b',
        precoDeVenda: 50,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
    ];
    const out = buildGeneratorInput(bundle, items, 7, 1, 'homologacao');
    expect(out.totalXml).toContain('<vProd>100.00</vProd>');
    expect(out.totalXml).toContain('<vNF>100.00</vNF>');
  });

  it('gives non-composing items no share of descontoTotal (pin lands on the last composing item)', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }),
      item({
        produtoUid: 'b',
        precoDeVenda: 100,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
      item({ produtoUid: 'c', precoDeVenda: 300, quantidade: 1 }),
    ];
    // 40 over composing net 400 → a: 10, b (fora do total): 0, c (pinned): 30.
    expect(apportionDescontos(items, bundleWith(OP, { descontoTotal: 40 }))).toEqual([10, 0, 30]);
  });

  it('pin still lands the exact remainder when the LAST array item is non-composing', () => {
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }),
      item({ produtoUid: 'b', precoDeVenda: 300, quantidade: 1 }),
      item({
        produtoUid: 'c',
        precoDeVenda: 100,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
    ];
    const shares = apportionDescontos(items, bundleWith(OP, { descontoTotal: 40 }));
    expect(shares).toEqual([10, 30, 0]);
    expect(shares.reduce((s, v) => s + v, 0)).toBe(40);
  });

  it("keeps a non-composing item's unit discount on its det but out of the totals vDesc", () => {
    const bundle = fullBundle({});
    const items = [
      item({ produtoUid: 'a', precoDeVenda: 100, quantidade: 1 }),
      item({
        produtoUid: 'b',
        precoDeVenda: 100,
        quantidade: 1,
        descontoUnitario: 5,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
    ];
    const out = buildGeneratorInput(bundle, items, 7, 1, 'homologacao');
    const gis = buildGenItems(items, bundle, false);
    expect(gis[1]!.vDesc).toBe(5); // stays on the det
    expect(out.totalXml).toContain('<vDesc>0.00</vDesc>'); // out of the totals
    expect(out.totalXml).toContain('<vNF>100.00</vNF>');
  });

  it('stamps frete-emitente vFrete on the FIRST COMPOSING det, not a non-composing one', () => {
    const bundle = fullBundle({
      pagamentos: [{ valor: 55, forma_de_pagamento: FORMA_PAGAMENTO.dinheiro }],
      frete: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 20 } as FreteDoPedido,
    });
    const items = [
      item({
        produtoUid: 'a',
        precoDeVenda: 50,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
      item({ produtoUid: 'b', precoDeVenda: 100, quantidade: 1 }),
    ];
    const out = buildGeneratorInput(bundle, items, 7, 1, 'homologacao');
    expect(out.itens[0]!.vFrete).toBeUndefined();
    expect(out.itens[1]!.vFrete).toBe(20);
    // vNF = composing vProd (100) + frete (20); the single payment overrides to vNF.
    expect(out.totalXml).toContain('<vNF>120.00</vNF>');
    expect(out.pagXml).toContain('<vPag>120.00</vPag>');
  });
});

describe('frete-emitente with no composing item (review fix)', () => {
  it('throws instead of stamping vFrete on an indTot=0 det', () => {
    const bundle = fullBundle({
      pagamentos: [],
      frete: { modalidade: MODALIDADE_FRETE.cif, valorCobrado: 20 } as FreteDoPedido,
    });
    const items = [
      item({
        produtoUid: 'a',
        precoDeVenda: 50,
        quantidade: 1,
        imposto: IMPOSTO_FORA_DO_TOTAL as never,
      }),
    ];
    // A det-level vFrete on an excluded item breaks the indTot-conditioned
    // Σ rule; with EVERY item excluded there is no coherent NF-e to emit.
    expect(() => buildGeneratorInput(bundle, items, 7, 1, 'homologacao')).toThrow(
      /nenhum item compõe o total/,
    );
  });
});
