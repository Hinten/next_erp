import { describe, it, expect } from 'vitest';
import type { MlOrder } from '@delfrance/integrations-mercado-livre';
import { buildOrderMLWire, mergeOrderMLWire } from './orderMLWire';

/**
 * Fixture ported straight from the legacy sample order payload documented in
 * `.old/packages/canais_de_venda/mercado_livre/lib/src/models.dart` (the
 * comment block preceding the `OrderML` class, ~line 2649) — a real (redacted)
 * Mercado Livre order response, `full_unit_price` included to prove it gets
 * dropped (not a Dart-declared `_Item`/`_OrderItem` field).
 */
function buildFixtureOrder(): MlOrder {
  return {
    id: 2000003508897196,
    date_created: '2022-04-08T17:01:30.000-04:00',
    date_closed: '2022-04-08T17:01:33.000-04:00',
    last_updated: '2022-04-08T17:03:32.000-04:00',
    manufacturing_ending_date: null,
    comment: null,
    pack_id: 2000003508553677,
    pickup_id: null,
    total_amount: 50,
    paid_amount: 50,
    coupon: { id: null, amount: 0 },
    expiration_date: '2022-05-06T17:01:33.000-04:00',
    order_items: [
      {
        item: {
          id: 'MLB2608564035',
          title: 'Camiseta Basica',
          category_id: 'MLB31447',
          variation_id: 174390848694,
          seller_custom_field: null,
          variation_attributes: [
            { id: 'SIZE', name: 'Tamanho', value_id: '2282666', value_name: 'M' },
            { id: 'COLOR', name: 'Cor', value_id: '52049', value_name: 'Preto' },
          ],
          warranty: 'Sem garantia',
          condition: 'new',
          seller_sku: null,
          global_price: null,
          net_weight: null,
        },
        quantity: 1,
        requested_quantity: { value: 1, measure: 'unit' },
        picked_quantity: null,
        unit_price: 50,
        full_unit_price: 50, // NOT a Dart-declared field — must be dropped
        currency_id: 'BRL',
        manufacturing_days: null,
        sale_fee: 12,
        listing_type_id: 'gold_special',
      },
    ],
    currency_id: 'BRL',
    payments: [
      {
        id: 21463688923,
        order_id: 2000003508897196,
        payer_id: 266272126,
        collector: { id: 478055419 },
        card_id: null,
        site_id: 'MLB',
        reason: 'Camiseta Basica',
        payment_method_id: 'account_money',
        currency_id: 'BRL',
        installments: 1,
        issuer_id: null,
        coupon_id: null,
        operation_type: 'regular_payment',
        payment_type: 'account_money',
        status: 'approved',
        status_code: null,
        status_detail: 'accredited',
        transaction_amount: 50,
        shipping_cost: 0,
        coupon_amount: 0,
        overpaid_amount: 0,
        total_paid_amount: 50,
        installment_amount: null,
        deferred_period: null,
        date_approved: '2022-04-08T17:01:32.000-04:00',
        authorization_code: null,
        transaction_order_id: null,
        date_created: '2022-04-08T17:01:32.000-04:00',
        // does NOT feed `date_last_updated` — key mismatch, see orderMLWire.ts.
        date_last_modified: '2022-04-08T17:01:44.000-04:00',
      },
    ],
    shipping: { id: 41297142475 },
    status: 'paid',
    status_detail: null,
    tags: ['test_order', 'not_delivered', 'pack_order', 'paid'],
    buyer: {
      id: 266272126,
      nickname: 'TETE8127263',
      first_name: 'Test',
      last_name: 'Test',
    },
  } as unknown as MlOrder;
}

describe('buildOrderMLWire', () => {
  it('produces the exact expected wire object for the full fixture order', () => {
    const wire = buildOrderMLWire({
      order: buildFixtureOrder(),
      contaOuterRef: 'integracao/CONTA123',
    });

    expect(wire).toEqual({
      id: 2000003508897196,
      contaMercadoLivreOuterRef: 'documents/integracao/CONTA123',
      status: 'paid',
      // ISO -> epoch MILLISECONDS (top-level order dates only).
      date_created: 1649451690000,
      date_closed: 1649451693000,
      last_updated: 1649451812000,
      expiration_date: 1651870893000,
      manufacturing_ending_date: null,
      order_items: [
        {
          item: {
            id: 'MLB2608564035',
            title: 'Camiseta Basica',
            category_id: 'MLB31447',
            variation_id: 174390848694,
            seller_custom_field: null,
            variation_attributes: [
              { id: 'SIZE', value_id: '2282666', name: 'Tamanho', value_name: 'M' },
              { id: 'COLOR', value_id: '52049', name: 'Cor', value_name: 'Preto' },
            ],
            warranty: 'Sem garantia',
            condition: 'new',
            seller_sku: null,
            global_price: null,
            net_weight: null,
            // NOTE: no `full_unit_price` key — dropped, not a Dart-declared field.
          },
          quantity: 1,
          requested_quantity: { value: 1, measure: 'unit' },
          picked_quantity: null,
          unit_price: 50,
          currency_id: 'BRL',
          manufacturing_days: null,
          sale_fee: 12,
          listing_type_id: 'gold_special',
          // NOTE: no `discounts` key — omitted when absent (legacy writeNotNull).
        },
      ],
      payments: [
        {
          id: 21463688923,
          site_id: 'MLB',
          // stays ISO — nested payment dates are NOT ms-converted.
          date_created: '2022-04-08T17:01:32.000-04:00',
          date_approved: '2022-04-08T17:01:32.000-04:00',
          date_last_updated: null, // raw key is `date_last_modified` — legacy quirk, not derived
          date_of_expiration: null,
          money_release_date: null,
          money_release_status: null,
          notification_url: null,
          last_modified: null,
          reason: 'Camiseta Basica',
          card_id: null,
          currency_id: 'BRL',
          transaction_amount: 50,
          total_paid_amount: 50,
          shipping_cost: 0,
          coupon_amount: 0,
          coupon_id: null,
          status: 'approved',
          status_detail: 'accredited',
          installments: 1,
          installment_amount: null,
          payment_type: 'account_money',
          payment_type_id: null,
          payment_method_id: 'account_money',
          marketplace: null,
          operation_type: 'regular_payment',
          deduction_schema: null,
          description: null,
          differential_pricing_id: null,
          amount_refunded: null,
          api_version: null,
          concept_id: null,
          concept_amount: null,
          sponsor_id: null,
          overpaid_amount: 0,
          external_reference: null,
          order_id: '2000003508897196',
          merchant_order_id: null,
          tags: null,
          refunds: null,
          deferred_period: null,
          status_code: null,
          account_money_amount: null,
          transaction_order_id: null,
          additional_info: null,
          issuer_id: null,
          live_mode: null,
          net_received_amount: null,
          mercadopago_fee: null,
          marketplace_fee: null,
          discount_fee: null,
          coupon_fee: null,
          finance_fee: null,
          released: null,
          collector_id: null, // raw carries `collector: { id }`, not derived
          payer: null, // raw carries a flat `payer_id`, not derived
          authorization_code: null,
          binary_mode: null,
          captured: null,
          card: null,
          charge_details: null,
          charges_details: null,
          fee_details: null,
          transaction_details: null,
        },
      ],
      buyer: {
        id: 266272126,
        nickname: 'TETE8127263',
        first_name: 'Test',
        last_name: 'Test',
      },
      pack_id: 2000003508553677,
      pickup_id: null,
      buying_mode: null,
      shipping_cost: null,
      total_amount: 50,
      paid_amount: 50,
      coupon: { id: null, amount: 0 },
      shipping: { id: 41297142475 },
      tags: ['test_order', 'not_delivered', 'pack_order', 'paid'],
      // NOTE: no `status_detail` / `comment` keys — both null in the fixture, omitted.
    });
  });

  it('omits status_detail/tags/comment when null, and includes them when present', () => {
    const withNulls = buildOrderMLWire({
      order: buildFixtureOrder(),
      contaOuterRef: 'integracao/CONTA123',
    });
    expect(withNulls).not.toHaveProperty('status_detail');
    expect(withNulls).not.toHaveProperty('comment');
    expect(withNulls).toHaveProperty('tags'); // fixture's tags array is non-null

    const withValues = buildOrderMLWire({
      order: {
        ...buildFixtureOrder(),
        status_detail: 'some_detail',
        comment: 'nota do comprador',
      } as unknown as MlOrder,
      contaOuterRef: 'integracao/CONTA123',
    });
    expect(withValues.status_detail).toBe('some_detail');
    expect(withValues.comment).toBe('nota do comprador');
  });

  it('omits tags when null/absent', () => {
    const order = buildFixtureOrder() as unknown as Record<string, unknown>;
    delete order.tags;
    const wire = buildOrderMLWire({
      order: order as unknown as MlOrder,
      contaOuterRef: 'integracao/CONTA123',
    });
    expect(wire).not.toHaveProperty('tags');
  });

  it('always writes shipping/pack_id/pickup_id as null (not omitted) when absent', () => {
    const order = {
      id: 123,
      status: 'confirmed',
      buyer: { id: 1 },
      order_items: [],
    } as unknown as MlOrder;
    const wire = buildOrderMLWire({ order, contaOuterRef: 'integracao/CONTA123' });

    expect(wire).toMatchObject({
      pack_id: null,
      pickup_id: null,
      buying_mode: null,
      shipping_cost: null,
      total_amount: null,
      paid_amount: null,
      coupon: null,
      shipping: null,
      date_created: null,
      date_closed: null,
      last_updated: null,
      expiration_date: null,
      manufacturing_ending_date: null,
      order_items: [],
      payments: null,
    });
    expect(wire).not.toHaveProperty('status_detail');
    expect(wire).not.toHaveProperty('tags');
    expect(wire).not.toHaveProperty('comment');
  });

  it('normalizes contaOuterRef to the canonical documents/integracao/<id> form', () => {
    const order = { id: 1, status: 'confirmed', buyer: { id: 1 } } as unknown as MlOrder;
    const wire = buildOrderMLWire({ order, contaOuterRef: 'integracao/CONTA999' });
    expect(wire.contaMercadoLivreOuterRef).toBe('documents/integracao/CONTA999');
  });
});

/* ========================================================================== */
/*                              mergeOrderMLWire                              */
/* ========================================================================== */

/** The stored mirror doc a complete order left behind, as `buildOrderMLWire`
 * would have written it (only the keys these tests read about). */
function storedMirror(): Record<string, unknown> {
  return {
    id: 2000003508897196,
    contaMercadoLivreOuterRef: 'documents/integracao/CONTA123',
    status: 'paid',
    status_detail: 'accredited',
    tags: ['pack_order', 'paid'],
    comment: 'entregar na portaria',
    pack_id: 2000003508553677,
    pickup_id: null,
    buying_mode: 'buy_equals_pay',
    last_updated: 1649451812000,
    total_amount: 50,
    paid_amount: 50,
    payments: [{ id: 21463688923 }],
    buyer: { id: 266272126 },
    shipping: { id: 41297142475 },
    order_items: [{ item: { id: 'MLB2608564035' } }],
  };
}

describe('mergeOrderMLWire', () => {
  it('keeps the stored pack_id when the incoming payload nulls it (#793)', () => {
    // A `206 Partial Content` order — `pack_id` absent from the body, so
    // `buildOrderMLWire` emits it as an explicit null.
    const incoming = buildOrderMLWire({
      order: { id: 2000003508897196, status: 'paid', order_items: [] } as unknown as MlOrder,
      contaOuterRef: 'integracao/CONTA123',
    });
    expect(incoming.pack_id).toBeNull(); // precondition: the wire really does null it

    const merged = mergeOrderMLWire(storedMirror(), incoming);

    expect(merged.pack_id).toBe(2000003508553677);
  });

  it('keeps the stored writeNotNull keys the incoming wire omits', () => {
    // `status_detail`/`tags`/`comment` are omitted (not nulled) by the wire.
    const incoming = buildOrderMLWire({
      order: { id: 2000003508897196, status: 'paid', order_items: [] } as unknown as MlOrder,
      contaOuterRef: 'integracao/CONTA123',
    });
    expect(incoming).not.toHaveProperty('status_detail');
    expect(incoming).not.toHaveProperty('tags');
    expect(incoming).not.toHaveProperty('comment');

    const merged = mergeOrderMLWire(storedMirror(), incoming);

    expect(merged.status_detail).toBe('accredited');
    expect(merged.tags).toEqual(['pack_order', 'paid']);
    expect(merged.comment).toBe('entregar na portaria');
  });

  it('lets a non-null incoming value win — including a pack_id change', () => {
    // ML reassigns pack_id when e.g. an extended warranty is added to a
    // not_specified item ("criando um novo pack_id").
    const merged = mergeOrderMLWire(storedMirror(), {
      pack_id: 2000009999999999,
      status: 'cancelled',
      status_detail: 'refunded',
      tags: ['cancelled'],
      last_updated: 1649999999000,
    });

    expect(merged).toMatchObject({
      pack_id: 2000009999999999,
      status: 'cancelled',
      status_detail: 'refunded',
      tags: ['cancelled'],
      last_updated: 1649999999000,
    });
  });

  it('writes null when BOTH sides are null — a never-set key keeps its explicit null', () => {
    const merged = mergeOrderMLWire({ pack_id: null, pickup_id: null }, { pack_id: null });

    expect(merged).toHaveProperty('pack_id', null);
    expect(merged).toHaveProperty('pickup_id', null);
  });

  it('preserves a stored key the wire never emits (dual-run with the Flutter app)', () => {
    const stored = { ...storedMirror(), campoEscritoPeloFlutter: 'preservar' };
    const incoming = buildOrderMLWire({
      order: { id: 2000003508897196, status: 'paid', order_items: [] } as unknown as MlOrder,
      contaOuterRef: 'integracao/CONTA123',
    });

    const merged = mergeOrderMLWire(stored, incoming);

    expect(merged.campoEscritoPeloFlutter).toBe('preservar');
  });

  it('does not mutate the stored object it merges onto', () => {
    const stored = storedMirror();
    mergeOrderMLWire(stored, { pack_id: 42, status: 'cancelled' });
    expect(stored).toEqual(storedMirror());
  });

  it('replaces a non-null list/object wholesale — field-level, never deep', () => {
    const merged = mergeOrderMLWire(storedMirror(), {
      order_items: [],
      payments: [{ id: 99 }],
      buyer: { id: 7 },
    });

    // `[]` is non-null, so it wins — same as Dart's `??` on a nullable field.
    expect(merged.order_items).toEqual([]);
    expect(merged.payments).toEqual([{ id: 99 }]);
    expect(merged.buyer).toEqual({ id: 7 });
  });

  it('null-coalesces EVERY key the wire emits — the whole OrderML.update surface', () => {
    // Table-driven so the "which fields did legacy's ~17-field `OrderML.update`
    // cover?" question is answered by construction rather than by a hand-copied
    // list (`.old/` is not part of this checkout — see `mergeOrderMLWire`'s ⚠️).
    const full = buildOrderMLWire({
      order: buildFixtureOrder(),
      contaOuterRef: 'integracao/CONTA123',
    });
    // The emptiest order the schema still accepts: every nullable key nulled,
    // every writeNotNull key omitted.
    const empty = buildOrderMLWire({
      order: { id: 2000003508897196, status: 'paid', order_items: [] } as unknown as MlOrder,
      contaOuterRef: 'integracao/CONTA123',
    });

    const merged = mergeOrderMLWire(full, empty);

    for (const [key, storedValue] of Object.entries(full)) {
      // `order_items` is the one key the empty wire still emits non-null (`[]`).
      if (key === 'order_items') continue;
      expect({ key, value: merged[key] }).toEqual({ key, value: storedValue });
    }
  });
});
