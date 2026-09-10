import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { itemDoPedidoSchema } from '@delfrance/schemas';
import {
  shopeeEscrowDetailPayloadSchema,
  shopeeEscrowItemSchema,
  shopeeEscrowKitItemSchema,
  shopeeOrderDetailRowSchema,
  shopeeOrderItemSchema,
  type ShopeeEscrowDetail,
  type ShopeeEscrowItem,
  type ShopeeEscrowKitItem,
  type ShopeeOrderDetailRow,
  type ShopeeOrderItem,
} from '@delfrance/integrations-shopee';

import {
  DETALHE_PRECO_E_TOTAL_DA_LINHA,
  componentesDoKit,
  conferirQuantidades,
  descontoUnitario,
  ehKitShopee,
  mapearItensShopee,
  precoUnitario,
} from './itens';
import { chaveDaLinhaShopee } from './orderIds';
import type { ResolvedShopeeLineProduto } from './produtoResolve';
import {
  FIXTURE_ESCROW_DETAIL_QTY2_SG,
  FIXTURE_ORDER_DETAIL_QTY2_SG,
  lerEscrowDetalhe,
  lerPedidoDetalhe,
} from '../fixtures/wireCorpus';

/* -------------------------------------------------------------------------- */
/*  Fixturas — todas sintéticas; ids inventados, nenhum dado de comprador.     */
/*  Tudo passa pelos schemas do pacote, para que os defaults sejam os REAIS.   */
/* -------------------------------------------------------------------------- */

const ORDER_SN = '220810QSK8S7BX';
const AGORA_US = 1_700_000_000_000_000;

function item(over: Partial<ShopeeOrderItem> = {}): ShopeeOrderItem {
  return shopeeOrderItemSchema.parse({ item_id: 100, ...over });
}

function escrowItem(over: Partial<ShopeeEscrowItem> = {}): ShopeeEscrowItem {
  return shopeeEscrowItemSchema.parse({ ...over });
}

/**
 * ⚠️ Ids INTEIROS de propósito: `shopeeEscrowKitItemSchema` os declara como
 * `wireInt()` e a amostra da documentação da Shopee manda `0.1`, que NÃO passa
 * pelo schema (P#3 da onda 1) — por isso os vetores de kit são inline aqui e
 * não vêm do fixture `get_escrow_detail.doc-kit.json`.
 */
function componenteDeKit(over: Partial<ShopeeEscrowKitItem> = {}): ShopeeEscrowKitItem {
  return shopeeEscrowKitItemSchema.parse({
    original_product_id: 7,
    original_model_id: 8,
    total_qty: 1,
    ...over,
  });
}

function escrow(items: ShopeeEscrowItem[]): ShopeeEscrowDetail {
  return shopeeEscrowDetailPayloadSchema.parse({
    order_sn: ORDER_SN,
    order_income: { items },
  });
}

function detalhe(
  itens: ShopeeOrderItem[],
  over: Record<string, unknown> = {},
): ShopeeOrderDetailRow {
  return shopeeOrderDetailRowSchema.parse({
    order_sn: ORDER_SN,
    order_status: 'READY_TO_SHIP',
    item_list: itens,
    ...over,
  });
}

const SEM_RESOLUCAO = new Map<string, ResolvedShopeeLineProduto>();

function mapear(args: {
  itens: ShopeeOrderItem[];
  escrow?: ShopeeEscrowDetail | null;
  resolucoes?: ReadonlyMap<string, ResolvedShopeeLineProduto>;
  freteCobrado?: number | null;
  totalDaLinha?: boolean;
  detalheOver?: Record<string, unknown>;
}) {
  return mapearItensShopee({
    detalhe: detalhe(args.itens, args.detalheOver ?? {}),
    escrow: args.escrow ?? null,
    resolucoes: args.resolucoes ?? SEM_RESOLUCAO,
    freteCobrado: args.freteCobrado ?? null,
    nowUs: AGORA_US,
    detalhePrecoEhTotalDaLinha: args.totalDaLinha,
  });
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('precoUnitario', () => {
  it('sai do escrow: discounted_price ÷ quantity_purchased, arredondado', () => {
    const leitura = precoUnitario(
      item({ model_quantity_purchased: 3, model_discounted_price: 99 }),
      escrowItem({ discounted_price: 31, quantity_purchased: 3 }),
    );
    expect(leitura.fonte).toBe('escrow');
    expect(leitura.unitario).toBe(10.33);
  });

  it('⚠️ NEAR-MISS: divide pelo quantity_purchased DO ESCROW, nunca pelo do detalhe', () => {
    // O detalhe diz 4, o escrow diz 2 (duas unidades foram canceladas). Dividir
    // o subtotal do escrow pela quantidade do detalhe é um erro de dinheiro
    // silencioso: 30/4 = 7,50 em vez de 15.
    const leitura = precoUnitario(
      item({ model_quantity_purchased: 4 }),
      escrowItem({ discounted_price: 30, quantity_purchased: 2 }),
    );
    expect(leitura.unitario).toBe(15);
    expect(leitura.unitario).not.toBe(7.5);
    expect(leitura.quantidadeEscrow).toBe(2);
    expect(leitura.quantidadeDetalhe).toBe(4);
  });

  it('⚠️ com os DOIS corpos REAIS do pedido de sandbox: escrow 30 ÷ 2 = 15 = o detalhe', () => {
    // ⚠️ O par que fecha o item 1 do registro de "resolver ao vivo", e nenhum
    // dos dois lados sozinho o fecha: a linha do ESCROW traz o TOTAL DA LINHA
    // (`discounted_price: 30` com `quantity_purchased: 2`) enquanto o MESMO
    // pedido no DETALHE traz o preço POR UNIDADE (`model_discounted_price: 15`).
    // A quantidade 2 é o que torna as duas leituras distinguíveis.
    const detalheReal = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const escrowReal = lerEscrowDetalhe(FIXTURE_ESCROW_DETAIL_QTY2_SG).response;
    const linhaDetalhe = detalheReal.item_list![0]!;
    const linhaEscrow = escrowReal.order_income!.items![0]!;
    // As duas linhas são a MESMA linha — o par (item_id, model_id) casa.
    expect(chaveDaLinhaShopee(linhaEscrow.item_id!, linhaEscrow.model_id)).toBe(
      chaveDaLinhaShopee(linhaDetalhe.item_id, linhaDetalhe.model_id),
    );

    const leitura = precoUnitario(linhaDetalhe, linhaEscrow);
    expect(leitura.fonte).toBe('escrow');
    expect(leitura.unitario).toBe(15);
    expect(leitura.precoEscrowUnitario).toBe(15);
    expect(leitura.precoDetalhe).toBe(15);
    expect(leitura.quantidadeEscrow).toBe(2);
    expect(leitura.quantidadeDetalhe).toBe(2);
    // NEAR-MISS: NÃO é 30 (o total da linha lido como unitário) nem 7,5.
    expect(leitura.unitario).not.toBe(linhaEscrow.discounted_price);
    // …e o escrow deste pedido não traz desconto nenhum, então o preço de venda
    // e o unitário líquido coincidem — é por isso que o vetor com desconto do
    // `totais.test.ts` tem de ser inline.
    expect(descontoUnitario(linhaEscrow).unitario).toBe(0);
  });

  it('sem linha no escrow cai no detalhe e o lê POR UNIDADE (o interruptor está em false)', () => {
    expect(DETALHE_PRECO_E_TOTAL_DA_LINHA).toBe(false);
    const leitura = precoUnitario(
      item({ model_quantity_purchased: 2, model_discounted_price: 15 }),
      null,
    );
    expect(leitura).toMatchObject({ fonte: 'detalhe', unitario: 15 });
  });

  it('com o interruptor em true o MESMO corpo divide pela quantidade', () => {
    const linha = item({ model_quantity_purchased: 2, model_discounted_price: 15 });
    expect(precoUnitario(linha, null, true).unitario).toBe(7.5);
    expect(precoUnitario(linha, null, false).unitario).toBe(15);
  });

  it('quantidade 1 não distingue os dois modos — por isso o pedido de sandbox tinha 2', () => {
    const linha = item({ model_quantity_purchased: 1, model_discounted_price: 15 });
    expect(precoUnitario(linha, null, true).unitario).toBe(
      precoUnitario(linha, null, false).unitario,
    );
  });

  it('o pedido SG do corpus fecha 15 × 2 + 1,99 = 31,99 lendo POR UNIDADE', () => {
    const row = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const linha = row.item_list![0]!;
    const porUnidade = precoUnitario(linha, null, false).unitario;
    const comoTotal = precoUnitario(linha, null, true).unitario;
    expect(porUnidade * linha.model_quantity_purchased! + row.estimated_shipping_fee!).toBe(
      row.total_amount,
    );
    expect(comoTotal * linha.model_quantity_purchased! + row.estimated_shipping_fee!).not.toBe(
      row.total_amount,
    );
  });

  it('bundle (model_discounted_price === 0) sem escrow ⇒ preço 0 MARCADO, não o 0 do detalhe', () => {
    const leitura = precoUnitario(
      item({ model_discounted_price: 0, model_quantity_purchased: 1 }),
      null,
    );
    expect(leitura).toMatchObject({ fonte: 'zero', unitario: 0, ehBundle: true });
  });

  it('activity_type bundle_deal toma o escrow mesmo com model_discounted_price > 0', () => {
    const leitura = precoUnitario(
      item({ model_discounted_price: 50, model_quantity_purchased: 1 }),
      escrowItem({ discounted_price: 42, quantity_purchased: 1, activity_type: 'bundle_deal' }),
    );
    expect(leitura).toMatchObject({ fonte: 'escrow', unitario: 42, ehBundle: true });
  });

  it('o diagnóstico da linha carrega ehBundle — o par igual é uma linha comum', () => {
    const comum = mapear({ itens: [item({ model_discounted_price: 10 })] });
    const bundle = mapear({ itens: [item({ model_discounted_price: 0 })] });
    expect(comum.diagnosticos[0]!.ehBundle).toBe(false);
    expect(bundle.diagnosticos[0]!.ehBundle).toBe(true);
  });

  it('quantity_purchased 0 no escrow não divide por zero — cai no detalhe', () => {
    const leitura = precoUnitario(
      item({ model_discounted_price: 20, model_quantity_purchased: 1 }),
      escrowItem({ discounted_price: 20, quantity_purchased: 0 }),
    );
    expect(leitura).toMatchObject({ fonte: 'detalhe', unitario: 20 });
    expect(Number.isFinite(leitura.unitario)).toBe(true);
  });

  it('sem preço em lugar nenhum ⇒ 0 marcado, e a linha ainda é importada', () => {
    const leitura = precoUnitario(item({ model_discounted_price: null }), null);
    expect(leitura).toMatchObject({ fonte: 'zero', unitario: 0 });
  });
});

/* -------------------------------------------------------------------------- */

describe('o casamento das linhas do escrow', () => {
  it('é por (item_id, model_id): duas variações do MESMO anúncio recebem preços DIFERENTES', () => {
    const { itens } = mapear({
      itens: [
        item({ item_id: 100, model_id: 1, model_quantity_purchased: 1 }),
        item({ item_id: 100, model_id: 2, model_quantity_purchased: 1 }),
      ],
      escrow: escrow([
        escrowItem({ item_id: 100, model_id: 1, discounted_price: 10, quantity_purchased: 1 }),
        escrowItem({ item_id: 100, model_id: 2, discounted_price: 20, quantity_purchased: 1 }),
      ]),
    });
    expect(itens.map((i) => i.precoDeVenda)).toEqual([10, 20]);
  });

  it('⚠️ NEAR-MISS: model_id 0 não casa com uma linha de escrow com model_id null', () => {
    const { itens, diagnosticos } = mapear({
      itens: [item({ item_id: 100, model_id: 0, model_discounted_price: 7 })],
      escrow: escrow([
        escrowItem({ item_id: 100, model_id: null, discounted_price: 99, quantity_purchased: 1 }),
      ]),
    });
    expect(diagnosticos[0]!.fontePreco).toBe('detalhe');
    expect(itens[0]!.precoDeVenda).toBe(7);
  });

  it('uma linha do escrow nunca é gasta duas vezes', () => {
    const { itens, diagnosticos } = mapear({
      itens: [
        item({ item_id: 100, model_id: 5, model_quantity_purchased: 1, model_discounted_price: 3 }),
        item({ item_id: 100, model_id: 5, model_quantity_purchased: 1, model_discounted_price: 3 }),
      ],
      escrow: escrow([
        escrowItem({ item_id: 100, model_id: 5, discounted_price: 40, quantity_purchased: 1 }),
      ]),
    });
    expect(diagnosticos.map((d) => d.fontePreco)).toEqual(['escrow', 'detalhe']);
    expect(itens.map((i) => i.precoDeVenda)).toEqual([40, 3]);
  });

  it('duas linhas do escrow no mesmo par são desempatadas por line_item_id', () => {
    const { itens, diagnosticos } = mapear({
      itens: [
        item({ item_id: 100, model_id: 5, line_item_id: 22, model_quantity_purchased: 1 }),
        item({ item_id: 100, model_id: 5, line_item_id: 11, model_quantity_purchased: 1 }),
      ],
      escrow: escrow([
        escrowItem({
          item_id: 100,
          model_id: 5,
          line_item_id: 11,
          discounted_price: 11,
          quantity_purchased: 1,
        }),
        escrowItem({
          item_id: 100,
          model_id: 5,
          line_item_id: 22,
          discounted_price: 22,
          quantity_purchased: 1,
        }),
      ]),
    });
    expect(itens.map((i) => i.precoDeVenda)).toEqual([22, 11]);
    expect(diagnosticos.every((d) => !d.escrowAmbiguo)).toBe(true);
  });

  it('sem desempate possível a primeira linha ganha e a linha é MARCADA', () => {
    const { itens, diagnosticos } = mapear({
      itens: [item({ item_id: 100, model_id: 5, model_quantity_purchased: 1 })],
      escrow: escrow([
        escrowItem({ item_id: 100, model_id: 5, discounted_price: 11, quantity_purchased: 1 }),
        escrowItem({ item_id: 100, model_id: 5, discounted_price: 22, quantity_purchased: 1 }),
      ]),
    });
    expect(itens[0]!.precoDeVenda).toBe(11);
    expect(diagnosticos[0]!.escrowAmbiguo).toBe(true);
  });

  it('⚠️ a ambiguidade CHEGA a um observável — warn na linha e flag no log', () => {
    // A flag that reaches no log, no store and no warn is a report nobody can
    // read: `diagnosticos` is in-memory and `importarPedido.ts` keeps only
    // `itemId`/`modelId`/`via`. And the order-level cross-check cannot cover
    // this: with two same-pair lines of equal quantity BOTH escrow rows are
    // consumed, so `diferenca` stays 0 while the per-line attribution permuted.
    const warn = vi.spyOn(console, 'warn');
    const info = vi.spyOn(console, 'info');
    mapear({
      itens: [item({ item_id: 100, model_id: 5, model_quantity_purchased: 1 })],
      escrow: escrow([
        escrowItem({ item_id: 100, model_id: 5, discounted_price: 11, quantity_purchased: 1 }),
        escrowItem({ item_id: 100, model_id: 5, discounted_price: 22, quantity_purchased: 1 }),
      ]),
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('AMBÍGUA'))).toBe(true);
    const linhas = (info.mock.calls[0]![1] as Record<string, unknown>).linhas as Record<
      string,
      unknown
    >[];
    expect(linhas[0]!.escrowAmbiguo).toBe(true);
  });

  it('⚠️ NEAR-MISS: um desempate por line_item_id não avisa nem marca', () => {
    const warn = vi.spyOn(console, 'warn');
    const info = vi.spyOn(console, 'info');
    mapear({
      itens: [item({ item_id: 100, model_id: 5, line_item_id: 22 })],
      escrow: escrow([
        escrowItem({
          item_id: 100,
          model_id: 5,
          line_item_id: 21,
          discounted_price: 11,
          quantity_purchased: 2,
        }),
        escrowItem({
          item_id: 100,
          model_id: 5,
          line_item_id: 22,
          discounted_price: 44,
          quantity_purchased: 2,
        }),
      ]),
    });
    expect(warn.mock.calls.some((c) => String(c[0]).includes('AMBÍGUA'))).toBe(false);
    const linhas = (info.mock.calls[0]![1] as Record<string, unknown>).linhas as Record<
      string,
      unknown
    >[];
    expect(linhas[0]!.escrowAmbiguo).toBe(false);
  });

  it('uma linha do escrow sem item_id não entra na fila (não casaria com nada)', () => {
    const { diagnosticos } = mapear({
      itens: [item({ item_id: 100, model_id: null, model_discounted_price: 9 })],
      escrow: escrow([
        escrowItem({ item_id: null, model_id: null, discounted_price: 99, quantity_purchased: 1 }),
      ]),
    });
    expect(diagnosticos[0]!.fontePreco).toBe('detalhe');
  });
});

/* -------------------------------------------------------------------------- */

describe('descontoUnitario', () => {
  it('soma os CINCO descontos e divide pela quantidade do escrow', () => {
    const d = descontoUnitario(
      escrowItem({
        quantity_purchased: 2,
        seller_discount: 1,
        shopee_discount: 2,
        discount_from_coin: 3,
        discount_from_voucher_shopee: 4,
        discount_from_voucher_seller: 5,
      }),
    );
    expect(d.unitario).toBe(7.5);
    expect(d.travado).toBe(false);
  });

  it('NEGATIVO é travado em 0 — o schema recusa negativo e derrubaria a importação', () => {
    const d = descontoUnitario(escrowItem({ quantity_purchased: 1, seller_discount: -10 }));
    expect(d).toEqual({ unitario: 0, bruto: -10, travado: true });
    // A prova de que o trava não é cosmético: sem ele a linha não é gravável.
    expect(() =>
      itemDoPedidoSchema.parse({ precoDeVenda: 1, descontoUnitario: d.bruto, quantidade: 1 }),
    ).toThrow();
  });

  it('sem linha no escrow o desconto é 0 (o detalhe não tem desconto por linha)', () => {
    expect(descontoUnitario(null)).toEqual({ unitario: 0, bruto: 0, travado: false });
  });
});

/* -------------------------------------------------------------------------- */

describe('a linha mapeada', () => {
  it('precoDeVenda = unitário + desconto, e o subtotal reconcilia com o escrow', () => {
    const { itens } = mapear({
      itens: [item({ item_id: 100, model_id: 1, model_quantity_purchased: 2 })],
      escrow: escrow([
        escrowItem({
          item_id: 100,
          model_id: 1,
          discounted_price: 30,
          quantity_purchased: 2,
          seller_discount: 4,
        }),
      ]),
    });
    const linha = itens[0]!;
    expect(linha.precoDeVenda).toBe(17);
    expect(linha.descontoUnitario).toBe(2);
    expect((linha.precoDeVenda - linha.descontoUnitario!) * linha.quantidade).toBe(30);
  });

  it('nomeDeVenda não deixa espaço sobrando quando model_name é vazio', () => {
    const { itens } = mapear({ itens: [item({ item_name: 'Camiseta', model_name: '' })] });
    expect(itens[0]!.nomeDeVenda).toBe('Camiseta');
  });

  it('nomeDeVenda junta anúncio e variação, e é null quando os dois são vazios', () => {
    expect(
      mapear({ itens: [item({ item_name: 'Camiseta', model_name: 'P' })] }).itens[0]!.nomeDeVenda,
    ).toBe('Camiseta P');
    expect(mapear({ itens: [item({ item_name: '', model_name: '' })] }).itens[0]!.nomeDeVenda).toBe(
      null,
    );
  });

  it('sku sai de model_sku, cai para item_sku e é VERBATIM (nada é aparado)', () => {
    expect(mapear({ itens: [item({ model_sku: ' A-1 ', item_sku: 'B' })] }).itens[0]!.sku).toBe(
      ' A-1 ',
    );
    expect(mapear({ itens: [item({ model_sku: '', item_sku: 'B-2' })] }).itens[0]!.sku).toBe('B-2');
    expect(mapear({ itens: [item({ model_sku: '', item_sku: '' })] }).itens[0]!.sku).toBe(null);
  });

  it('⚠️ NEAR-MISS: um sku "0" sobrevive — a checagem é de vazio, não de truthiness', () => {
    expect(mapear({ itens: [item({ model_sku: '0' })] }).itens[0]!.sku).toBe('0');
  });

  it('ordem é o índice 0-based, o timestamp é o relógio recebido e gtin/custo/imposto ficam nulos', () => {
    const { itens } = mapear({ itens: [item({ item_id: 1 }), item({ item_id: 2 })] });
    expect(itens.map((i) => i.ordem)).toEqual([0, 1]);
    expect(itens[0]!.timestamp).toBe(AGORA_US);
    expect(itens[0]).toMatchObject({ gtin: null, custo: null, imposto: null });
  });

  it('a linha mapeada é GRAVÁVEL — passa pelo itemDoPedidoSchema', () => {
    const { itens } = mapear({
      itens: [item({ model_discounted_price: 0, model_quantity_purchased: 1 })],
    });
    expect(() => itemDoPedidoSchema.parse(itens[0])).not.toThrow();
  });

  it('o produtoUid vem do mapa de resoluções, pela chave da linha', () => {
    const resolucoes = new Map<string, ResolvedShopeeLineProduto>([
      [chaveDaLinhaShopee(100, 5), { produtoId: 'prod-A', via: 'variashopee' }],
    ]);
    const { itens, diagnosticos } = mapear({
      itens: [item({ item_id: 100, model_id: 5 }), item({ item_id: 100, model_id: 6 })],
      resolucoes,
    });
    expect(itens.map((i) => i.produtoUid)).toEqual(['prod-A', null]);
    expect(diagnosticos.map((d) => d.via)).toEqual(['variashopee', null]);
  });
});

/* -------------------------------------------------------------------------- */

describe('a guarda de completude', () => {
  it('avisa e MARCA a linha, e NUNCA a descarta nem ajusta a quantidade', () => {
    const aviso = vi.spyOn(console, 'warn');
    const { itens, diagnosticos } = mapear({
      itens: [
        item({ model_quantity_purchased: 3, active_qty: 1, cancelled_qty: 1, returned_qty: 0 }),
      ],
    });
    expect(itens).toHaveLength(1);
    expect(itens[0]!.quantidade).toBe(3);
    expect(diagnosticos[0]).toMatchObject({ completa: false, somaQtd: 2, quantidadeComprada: 3 });
    expect(aviso).toHaveBeenCalledWith(expect.stringContaining('quantidades que não fecham'), {
      orderSn: ORDER_SN,
      mktplaceId: '100',
      somaQtd: 2,
      quantidadeComprada: 3,
    });
  });

  it('fecha quando active + cancelled + returned bate com o comprado', () => {
    expect(
      conferirQuantidades(
        item({ model_quantity_purchased: 3, active_qty: 1, cancelled_qty: 1, returned_qty: 1 }),
      ),
    ).toEqual({ completa: true, somaQtd: 3 });
  });

  it('⚠️ NEAR-MISS: sem NENHUM dos três contadores a resposta é null (desconhecido)', () => {
    // Somar três ausências em 0 e comparar com uma quantidade real marcaria
    // TODA linha de todo pedido que os omite — uma guarda que não relata nada
    // por relatar tudo.
    expect(conferirQuantidades(item({ model_quantity_purchased: 2 }))).toEqual({
      completa: null,
      somaQtd: null,
    });
  });

  it('⚠️ NEAR-MISS: os *_requested_qty ficam de FORA da soma', () => {
    // "requested" não é "done", e se `active_qty` já os desconta é indocumentado.
    expect(
      conferirQuantidades(
        item({
          model_quantity_purchased: 2,
          active_qty: 2,
          cancelled_qty: 0,
          returned_qty: 0,
          cancel_requested_qty: 1,
          return_requested_qty: 1,
        }),
      ),
    ).toEqual({ completa: true, somaQtd: 2 });
  });

  it('a divergência de quantidade contra o escrow é marcada, não corrigida', () => {
    const { itens, diagnosticos } = mapear({
      itens: [item({ item_id: 100, model_id: 1, model_quantity_purchased: 4 })],
      escrow: escrow([
        escrowItem({ item_id: 100, model_id: 1, discounted_price: 30, quantity_purchased: 2 }),
      ]),
    });
    expect(diagnosticos[0]!.quantidadeDivergenteDoEscrow).toBe(true);
    expect(itens[0]!.quantidade).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */

describe('o braço de kit', () => {
  it('kit_items como OBJETO e como ARRAY dão a mesma contagem', () => {
    const componente = componenteDeKit();
    const objeto = escrowItem({ is_kit: true, kit_items: componente });
    const array = escrowItem({ is_kit: true, kit_items: [componente] });
    expect(componentesDoKit(objeto)).toHaveLength(1);
    expect(componentesDoKit(array)).toHaveLength(1);
    expect(componentesDoKit(array)).toEqual(componentesDoKit(objeto));
  });

  it('um kit de dois componentes conta dois — e nenhum deles vira linha', () => {
    const linhaEscrow = escrowItem({
      item_id: 100,
      model_id: 0,
      discounted_price: 90,
      quantity_purchased: 1,
      is_kit: true,
      kit_items: [
        componenteDeKit(),
        componenteDeKit({ original_product_id: 9, original_model_id: 10, total_qty: 2 }),
      ],
    });
    const { itens, diagnosticos } = mapear({
      itens: [item({ item_id: 100, model_id: 0, model_quantity_purchased: 1 })],
      escrow: escrow([linhaEscrow]),
    });
    expect(itens).toHaveLength(1);
    expect(diagnosticos[0]).toMatchObject({ ehKit: true, componentesDoKit: 2 });
  });

  it('⚠️ a contagem do kit CHEGA ao log — é o que responde a cardinalidade ao vivo', () => {
    // `kit_items` is declared `obj | obj[]`, so BOTH cardinalities parse in
    // silence and the escrow containment never fires on them. §5 says the first
    // real BR kit order settles the question, and this line is the only thing
    // that can answer it: `diagnosticos` is in-memory and nothing stores it.
    const info = vi.spyOn(console, 'info');
    mapear({
      itens: [item({ item_id: 100, model_id: 0, model_quantity_purchased: 1 })],
      escrow: escrow([
        escrowItem({
          item_id: 100,
          model_id: 0,
          discounted_price: 90,
          quantity_purchased: 1,
          is_kit: true,
          kit_items: [
            componenteDeKit(),
            componenteDeKit({ original_product_id: 9, original_model_id: 10, total_qty: 2 }),
          ],
        }),
      ]),
    });
    const linhas = (info.mock.calls[0]![1] as Record<string, unknown>).linhas as Record<
      string,
      unknown
    >[];
    expect(linhas[0]).toMatchObject({ ehKit: true, componentesDoKit: 2 });
  });

  it('⚠️ NEAR-MISS: uma linha SEM kit sai como ehKit false e contagem 0 no log', () => {
    const info = vi.spyOn(console, 'info');
    mapear({
      itens: [item({ item_id: 100, model_id: 5, model_quantity_purchased: 1 })],
      escrow: escrow([
        escrowItem({ item_id: 100, model_id: 5, discounted_price: 9, quantity_purchased: 1 }),
      ]),
    });
    const linhas = (info.mock.calls[0]![1] as Record<string, unknown>).linhas as Record<
      string,
      unknown
    >[];
    expect(linhas[0]).toMatchObject({ ehKit: false, componentesDoKit: 0 });
  });

  it('sem kit_items a contagem é 0 e ehKitShopee é false', () => {
    expect(componentesDoKit(escrowItem({}))).toEqual([]);
    expect(componentesDoKit(null)).toEqual([]);
    expect(ehKitShopee(null)).toBe(false);
  });

  it('⚠️ NEAR-MISS: is_kit null (BR-only, "desconhecido") não é true', () => {
    expect(ehKitShopee(escrowItem({ is_kit: null }))).toBe(false);
    expect(ehKitShopee(escrowItem({ is_kit: false }))).toBe(false);
    expect(ehKitShopee(escrowItem({ is_kit: true }))).toBe(true);
  });

  it('⚠️ o "true" em STRING nem chega até aqui — quem recusa é o schema', () => {
    // Honestidade sobre o alcance do near-miss acima: `is_kit === true` e
    // `!!is_kit` são equivalentes para TODO valor que o tipo admite, então
    // nenhum teste sobre `ehKitShopee` consegue distinguir os dois. A guarda
    // que importa mora um nível abaixo — e é esta.
    expect(() => shopeeEscrowItemSchema.parse({ is_kit: 'true' })).toThrow();
    expect(() => shopeeEscrowItemSchema.parse({ is_kit: 1 })).toThrow();
  });
});

/* -------------------------------------------------------------------------- */

describe('a conferência e o log', () => {
  it('soma itens × quantidade, acrescenta o frete e compara com o total_amount', () => {
    const row = lerPedidoDetalhe(FIXTURE_ORDER_DETAIL_QTY2_SG).response.order_list[0]!;
    const { conferencia } = mapearItensShopee({
      detalhe: row,
      escrow: null,
      resolucoes: SEM_RESOLUCAO,
      freteCobrado: 1.99,
      nowUs: AGORA_US,
    });
    expect(conferencia).toMatchObject({
      somaDosItens: 30,
      freteCobrado: 1.99,
      totalConferido: 31.99,
      totalDoPedido: 31.99,
      diferenca: 0,
    });
  });

  it('sem frete conhecido o total conferido e a diferença ficam null (nunca um 0 fabricado)', () => {
    const { conferencia } = mapear({
      itens: [item({ model_discounted_price: 10, model_quantity_purchased: 1 })],
      detalheOver: { total_amount: 11.99 },
    });
    expect(conferencia).toMatchObject({
      somaDosItens: 10,
      freteCobrado: null,
      totalConferido: null,
      diferenca: null,
    });
  });

  it('descontoDasLinhas é a soma de desconto × quantidade — e JÁ está dentro dos itens', () => {
    const { conferencia, itens } = mapear({
      itens: [item({ item_id: 100, model_id: 1, model_quantity_purchased: 2 })],
      escrow: escrow([
        escrowItem({
          item_id: 100,
          model_id: 1,
          discounted_price: 30,
          quantity_purchased: 2,
          seller_discount: 4,
        }),
      ]),
    });
    expect(conferencia.descontoDasLinhas).toBe(4);
    // ⚠️ O nome carrega o achado: cada linha já traz o seu `descontoUnitario`, e
    // `itemSubtotal` o desconta de `precoDeVenda` ANTES de somar. Este número
    // é um diagnóstico — nunca o `descontoTotal` do pedido, que é o campo do
    // RODAPÉ e que `derivePedidoFreteTotals` subtrai uma SEGUNDA vez.
    // `totais.test.ts` cruza os dois módulos.
    const linha = itens[0]!;
    expect(linha.descontoUnitario).toBe(2);
    expect(linha.precoDeVenda).toBe(17);
    expect((linha.precoDeVenda - linha.descontoUnitario!) * linha.quantidade).toBe(
      conferencia.somaDosItens,
    );
  });

  it('sai UM console.info por importação, com as duas leituras e o interruptor', () => {
    const info = vi.spyOn(console, 'info');
    mapear({ itens: [item({ item_id: 100, model_id: 5 }), item({ item_id: 100, model_id: 6 })] });
    expect(info).toHaveBeenCalledTimes(1);
    const payload = info.mock.calls[0]![1] as Record<string, unknown>;
    expect(payload.interruptorTotalDaLinha).toBe(false);
    expect(payload.linhas).toHaveLength(2);
  });

  it('o log não carrega nome, endereço nem documento — só ids e números', () => {
    const info = vi.spyOn(console, 'info');
    mapear({
      itens: [item({ item_name: 'Camiseta Preta', model_sku: 'SKU-1' })],
      detalheOver: {
        recipient_address: {
          name: 'Joaquin da Silva',
          full_address: 'Rua Inventada, 1',
          zipcode: '01310100',
        },
        buyer_cpf_id: '12345678909',
      },
    });
    const serializado = JSON.stringify(info.mock.calls[0]);
    expect(serializado).not.toContain('Joaquin');
    expect(serializado).not.toContain('Rua Inventada');
    expect(serializado).not.toContain('12345678909');
    expect(serializado).not.toContain('Camiseta Preta');
  });

  it('um pedido sem item_list nenhum mapeia zero linhas sem quebrar', () => {
    const resultado = mapearItensShopee({
      detalhe: detalhe([], { item_list: null }),
      escrow: null,
      resolucoes: SEM_RESOLUCAO,
      freteCobrado: null,
      nowUs: AGORA_US,
    });
    expect(resultado.itens).toEqual([]);
    expect(resultado.conferencia.somaDosItens).toBe(0);
  });
});
