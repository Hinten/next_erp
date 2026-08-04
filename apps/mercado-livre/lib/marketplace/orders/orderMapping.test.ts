import { describe, expect, it } from 'vitest';
import type { MlOrder } from '@delfrance/integrations-mercado-livre';
import { coerceToMicros } from '@delfrance/core/datetime';
import {
  assertOrderItemsComplete,
  mlOrderItemToItemDoPedido,
  mlOrderToPedidoCoreFields,
  OrderItemsIncompleteError,
} from './orderMapping';

/**
 * Two `order_items[]` lines: index 0 has a `variation_id` + `discounts[]`
 * (mktplaceId = `55667788`), index 1 has neither (mktplaceId falls back to
 * `item.id` = `MLB123456`). Both `(orderId, mktplaceId, index)` triples were
 * chosen to match known vectors already asserted in `orderIds.test.ts`
 * (`makeItemEnsureUniqueId(987654321, '55667788', 0)` and
 * `makeItemEnsureUniqueId(987654321, 'MLB123456', 1)`), so the expected
 * `ensureUniqueId` hex below is an independent cross-check, not a value only
 * this file computes.
 */
function baseOrder(overrides: Record<string, unknown> = {}): MlOrder {
  return {
    id: 987654321,
    status: 'paid',
    date_created: '2026-07-20T10:00:00.000-04:00',
    last_updated: '2026-07-20T11:30:00.000-04:00',
    pack_id: null,
    comment: 'Entregar rápido, por favor',
    payments: [
      { transaction_amount: 150, coupon_amount: 5, shipping_cost: 20 },
      { transaction_amount: 0, coupon_amount: null, shipping_cost: null },
    ],
    order_items: [
      {
        item: {
          id: 'MLB999000',
          title: 'Camiseta Azul P',
          variation_id: 55667788,
          seller_sku: 'CAM-AZ-P',
        },
        quantity: 2,
        unit_price: 100,
        discounts: [{ amounts: { full: 10 } }, { amounts: { full: 5 } }],
      },
      {
        item: {
          id: 'MLB123456',
          title: 'Boné',
          variation_id: null,
          seller_sku: null,
        },
        quantity: 1,
        unit_price: 24.015,
      },
    ],
    ...overrides,
  } as MlOrder;
}

describe('mlOrderToPedidoCoreFields', () => {
  it('sums payments the same way legacy toPedido does (total, desconto, frete)', () => {
    const result = mlOrderToPedidoCoreFields({ order: baseOrder(), packId: null });
    // total = 150 + 0 = 150; total += valorFreteInicial(20) - descontoTotal(5) => 165
    expect(result.valorCobrado).toBe(165);
    expect(result.descontoTotal).toBe(5);
    expect(result.valorFreteInicial).toBe(20);
  });

  it('numero falls back to order.id when packId is null', () => {
    const result = mlOrderToPedidoCoreFields({ order: baseOrder(), packId: null });
    expect(result.numero).toBe('987654321');
  });

  it('numero uses the caller-supplied packId over order.id when present', () => {
    const result = mlOrderToPedidoCoreFields({ order: baseOrder(), packId: 555 });
    expect(result.numero).toBe('555');
  });

  it('maps status "paid" to estado "emProcessamento" (NOT "pago")', () => {
    const result = mlOrderToPedidoCoreFields({ order: baseOrder(), packId: null });
    expect(result.estado).toBe('emProcessamento');
  });

  it('converts date_created/last_updated ISO strings to microseconds', () => {
    const order = baseOrder();
    const result = mlOrderToPedidoCoreFields({ order, packId: null });
    expect(result.timestamp).toBe(coerceToMicros(order.date_created));
    expect(result.ultimaModificacao).toBe(coerceToMicros(order.last_updated));
  });

  it('carries the order comment as observacoesInternas', () => {
    const result = mlOrderToPedidoCoreFields({ order: baseOrder(), packId: null });
    expect(result.observacoesInternas).toBe('Entregar rápido, por favor');
  });

  it('observacoesInternas is null when the order has no comment', () => {
    const order = baseOrder({ comment: null });
    const result = mlOrderToPedidoCoreFields({ order, packId: null });
    expect(result.observacoesInternas).toBeNull();
  });

  it('an order with no payments zeroes out every money field', () => {
    const order = baseOrder({ payments: null });
    const result = mlOrderToPedidoCoreFields({ order, packId: null });
    expect(result.valorCobrado).toBe(0);
    expect(result.descontoTotal).toBe(0);
    expect(result.valorFreteInicial).toBe(0);
  });
});

describe('mlOrderItemToItemDoPedido', () => {
  it('maps the variation line: mktplaceId from variation_id, discounts summed into preco/desconto', () => {
    const order = baseOrder();
    const line = order.order_items![0]!;
    const result = mlOrderItemToItemDoPedido({
      orderId: order.id,
      orderItem: line,
      index: 0,
      produtoUid: 'produto-1',
      timestampUs: 42,
    });
    expect(result).toEqual({
      produtoUid: 'produto-1',
      ordem: 0,
      // sha256("987654321-55667788-0") — matches orderIds.test.ts's own vector.
      ensureUniqueId: '4df891fa3174571ababee0f8c72ce9e5f818f6c7871dea61b4ed5af4e8362a7b',
      mktplaceId: '55667788',
      sku: 'CAM-AZ-P',
      gtin: null,
      nomeDeVenda: 'Camiseta Azul P',
      precoDeVenda: 115, // unit_price(100) + Σ discounts.amounts.full (10 + 5)
      descontoUnitario: 15,
      quantidade: 2,
      custo: null,
      timestamp: 42,
      imposto: null,
    });
  });

  it('maps the plain line: mktplaceId falls back to item.id, no discounts => descontoUnitario 0', () => {
    const order = baseOrder();
    const line = order.order_items![1]!;
    const result = mlOrderItemToItemDoPedido({
      orderId: order.id,
      orderItem: line,
      index: 1,
      produtoUid: null,
      timestampUs: 42,
    });
    expect(result).toEqual({
      produtoUid: null,
      ordem: 1,
      // sha256("987654321-MLB123456-1") — matches orderIds.test.ts's own vector.
      ensureUniqueId: '990a7abb804b0ea03fdff2fc6634a5c45ed3464811828b42a8fda836f84cb490',
      mktplaceId: 'MLB123456',
      sku: null,
      gtin: null,
      nomeDeVenda: 'Boné',
      // roundReais(24.015) => 24.02 — its double sits a hair ABOVE the tie
      // (documented in @delfrance/core/money's own roundReais doc comment).
      precoDeVenda: 24.02,
      descontoUnitario: 0,
      quantidade: 1,
      custo: null,
      timestamp: 42,
      imposto: null,
    });
  });

  it('never sets gtin/custo — legacy _makeItemDoPedido never sets either', () => {
    const order = baseOrder();
    const result = mlOrderItemToItemDoPedido({
      orderId: order.id,
      orderItem: order.order_items![0]!,
      index: 0,
      produtoUid: null,
      timestampUs: 1,
    });
    expect(result.gtin).toBeNull();
    expect(result.custo).toBeNull();
  });
});

describe('assertOrderItemsComplete', () => {
  it('does not throw for a complete order', () => {
    expect(() => assertOrderItemsComplete(baseOrder())).not.toThrow();
  });

  it('throws when order_items is null (206 partial-content defense)', () => {
    const order = baseOrder({ order_items: null });
    expect(() => assertOrderItemsComplete(order)).toThrow(OrderItemsIncompleteError);
  });

  it('throws when order_items is an empty array', () => {
    const order = baseOrder({ order_items: [] });
    let caught: OrderItemsIncompleteError | undefined;
    try {
      assertOrderItemsComplete(order);
    } catch (err) {
      if (err instanceof OrderItemsIncompleteError) {
        caught = err;
      } else {
        throw err;
      }
    }
    expect(caught).toBeInstanceOf(OrderItemsIncompleteError);
    expect(caught?.message).toContain('order_items vazio');
  });

  it('throws listing every incomplete line with variation_id/seller_sku/element_id (#362)', () => {
    const order = baseOrder({
      order_items: [
        {
          item: { id: null, variation_id: 999, seller_sku: 'SKU-X' },
          element_id: 'EL-1',
          quantity: 1,
          unit_price: 10,
        },
        {
          item: { id: 'MLB1', variation_id: null, seller_sku: null },
          quantity: 1,
          unit_price: 10,
        },
      ],
    });
    let caught: OrderItemsIncompleteError | undefined;
    try {
      assertOrderItemsComplete(order);
    } catch (err) {
      if (err instanceof OrderItemsIncompleteError) {
        caught = err;
      } else {
        throw err;
      }
    }
    expect(caught).toBeInstanceOf(OrderItemsIncompleteError);
    // Only the first line is incomplete — the second (item.id = 'MLB1') is fine.
    expect(caught?.missing).toEqual([
      { itemId: null, variationId: 999, sellerSku: 'SKU-X', elementId: 'EL-1' },
    ]);
    expect(caught?.message).toContain('variation_id=999');
    expect(caught?.message).toContain('seller_sku=SKU-X');
    expect(caught?.message).toContain('element_id=EL-1');
  });
});
