import { describe, expect, it } from 'vitest';
import { orderML, orderMLMeta, orderMLSchema } from './orderML';
import { pedidoMeta } from './pedido';
import { ALL_DOMAINS } from '../../registry';

describe('orderMLSchema', () => {
  it('parses a legacy-shaped OrderML doc with the omit-when-null keys absent', () => {
    // Mirrors the real wire: `status_detail`, `tags` and `comment` are OMITTED
    // by Flutter when null, while every other field is written even when null
    // (`includeIfNull: true`).
    const fixture = {
      id: 2000012345678,
      contaMercadoLivreOuterRef: 'documents/integracao/conta-ml-1',
      status: 'paid',
      date_created: 1_700_000_000_000,
      date_closed: 1_700_000_100_000,
      last_updated: 1_700_000_200_000,
      expiration_date: null,
      manufacturing_ending_date: null,
      order_items: [{ item: { id: 'MLB123456789' }, quantity: 2 }],
      payments: [{ id: 987654321, status: 'approved', transaction_amount: 99.9 }],
      buyer: { id: 555111222, nickname: 'COMPRADOR123' },
      pack_id: 2000099999999,
      pickup_id: null,
      buying_mode: 'buy_it_now',
      shipping_cost: 0,
      total_amount: 99.9,
      paid_amount: 99.9,
      coupon: { id: null, amount: 0 },
      shipping: { id: 40123456789 },
    };

    const parsed = orderMLSchema.parse(fixture);
    expect(parsed).toMatchObject({
      id: 2000012345678,
      contaMercadoLivreOuterRef: 'documents/integracao/conta-ml-1',
      status: 'paid',
      pack_id: 2000099999999,
      pickup_id: null,
      buying_mode: 'buy_it_now',
    });
    expect(parsed.status_detail).toBeUndefined();
    expect(parsed.tags).toBeUndefined();
    expect(parsed.comment).toBeUndefined();
    expect(parsed.order_items).toEqual(fixture.order_items);
    expect(parsed.payments).toEqual(fixture.payments);
    expect(parsed.buyer).toEqual(fixture.buyer);
    expect(parsed.coupon).toEqual(fixture.coupon);
    expect(parsed.shipping).toEqual({ id: 40123456789 });
  });

  it('requires id, contaMercadoLivreOuterRef and status', () => {
    expect(orderMLSchema.safeParse({}).success).toBe(false);
    expect(
      orderMLSchema.safeParse({
        contaMercadoLivreOuterRef: 'documents/integracao/conta-1',
        status: 'confirmed',
      }).success,
    ).toBe(false);
    expect(
      orderMLSchema.safeParse({
        id: 1,
        status: 'confirmed',
      }).success,
    ).toBe(false);
    expect(
      orderMLSchema.safeParse({
        id: 1,
        contaMercadoLivreOuterRef: 'documents/integracao/conta-1',
      }).success,
    ).toBe(false);
  });

  it('accepts every known raw ML order status as a plain string', () => {
    const knownStatuses = [
      'confirmed',
      'payment_required',
      'payment_in_process',
      'partially_paid',
      'paid',
      'partially_refunded',
      'pending_cancel',
      'cancelled',
      'invalid',
    ];
    for (const status of knownStatuses) {
      expect(
        orderMLSchema.safeParse({
          id: 1,
          contaMercadoLivreOuterRef: 'documents/integracao/conta-1',
          status,
        }).success,
      ).toBe(true);
    }
    // Not a strict enum — an ML-added status must not fail the read.
    expect(
      orderMLSchema.safeParse({
        id: 1,
        contaMercadoLivreOuterRef: 'documents/integracao/conta-1',
        status: 'some_future_ml_status',
      }).success,
    ).toBe(true);
  });

  it('defaults the always-written-even-when-null fields to null when absent', () => {
    const parsed = orderMLSchema.parse({
      id: 1,
      contaMercadoLivreOuterRef: 'documents/integracao/conta-1',
      status: 'confirmed',
    });
    expect(parsed).toMatchObject({
      date_created: null,
      date_closed: null,
      last_updated: null,
      expiration_date: null,
      manufacturing_ending_date: null,
      order_items: null,
      payments: null,
      buyer: null,
      pack_id: null,
      pickup_id: null,
      buying_mode: null,
      shipping_cost: null,
      total_amount: null,
      paid_amount: null,
      coupon: null,
      shipping: null,
    });
  });

  it('tolerates a shipping block with only the legacy {id} shape', () => {
    const parsed = orderMLSchema.parse({
      id: 1,
      contaMercadoLivreOuterRef: 'documents/integracao/conta-1',
      status: 'confirmed',
      shipping: { id: null },
    });
    expect(parsed.shipping).toEqual({ id: null });
  });

  it('preserves unknown top-level fields via passthrough', () => {
    const parsed = orderMLSchema.parse({
      id: 1,
      contaMercadoLivreOuterRef: 'documents/integracao/conta-1',
      status: 'confirmed',
      _futureMlField: 'whatever',
    }) as Record<string, unknown>;
    expect(parsed._futureMlField).toBe('whatever');
  });

  it('lives at pedidos/{pedidoId}/orderML sharing the PEDIDO permission domain', () => {
    expect(orderMLMeta.collectionPath).toBe('pedidos/{pedidoId}/orderML');
    expect(orderMLMeta.permissions).toEqual({
      read: 1n << 16n,
      write: 1n << 17n,
      delete: 1n << 18n,
    });
  });
});

describe('orderML registration + cascade', () => {
  it('is registered in ALL_DOMAINS', () => {
    expect(ALL_DOMAINS).toContain(orderML);
  });

  it('is cascade-deleted with its parent pedido', () => {
    expect(pedidoMeta.cascade).toContainEqual({
      path: 'pedidos/{pedidoId}/orderML',
      onDelete: 'cascade',
    });
  });
});
