import { describe, expect, it } from 'vitest';
import {
  agencySchema,
  calculateOptionSchema,
  calculateRequestSchema,
  calculateResponseSchema,
  cartInsertRequestSchema,
  balanceSchema,
  parseMePrice,
  shipmentServiceSchema,
  tokenResponseSchema,
} from '../../src/melhor-envio/types';

/**
 * Melhor Envio's half of the quoted-number contract (#1251).
 *
 * ⚠️ This file is the one that mixes DIRECTIONS, so the suite has to assert both
 * rules and, above all, that they did not get swapped:
 *
 *  - a RESPONSE numeric field tolerates a quoted number, because one quoted `id`
 *    would otherwise discard the entire quote list;
 *  - a REQUEST numeric field still REFUSES one, because accepting a stringified
 *    dimension means forwarding it to ME.
 *
 * The coercer's own contract lives with the coercer, in
 * `packages/core/src/wire/wire.test.ts`.
 */

describe('RESPONSE shapes tolerate a quoted number', () => {
  it('a quoted required option id no longer kills the whole quote array', () => {
    // The sharp edge. `calculateResponseSchema` is an ARRAY of options, so before
    // the sweep one quoted `id` on one carrier returned zero quotes for all of
    // them — and an operator with no quotes cannot ship the order at all.
    const result = calculateResponseSchema.safeParse([
      { id: '1', name: 'PAC', price: '37.79' },
      { id: 2, name: 'SEDEX', price: '58.10' },
    ]);
    expect(result.success).toBe(true);
    expect(result.success && result.data.map((o) => o.id)).toEqual([1, 2]);
  });

  it.each([
    ['agencySchema', agencySchema],
    ['shipmentServiceSchema', shipmentServiceSchema],
  ])('%s takes a quoted required id', (_label, schema) => {
    const result = schema.safeParse({ id: '2468', name: 'Jadlog Centro' });
    expect(result.success).toBe(true);
    expect(result.success && result.data.id).toBe(2468);
  });

  it('quoted delivery times and a quoted company id parse', () => {
    const result = calculateOptionSchema.safeParse({
      id: 1,
      name: 'PAC',
      delivery_time: '5',
      custom_delivery_time: '4',
      delivery_range: { min: '3', max: '6' },
      company: { id: '31', name: 'Correios' },
    });
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.delivery_time).toBe(5);
    expect(result.data.custom_delivery_time).toBe(4);
    expect(result.data.delivery_range?.min).toBe(3);
    expect(result.data.company?.id).toBe(31);
  });

  it('a quoted wallet balance and a quoted expires_in parse', () => {
    expect(balanceSchema.parse({ balance: '1234.56' }).balance).toBe(1234.56);
    expect(
      tokenResponseSchema.parse({
        expires_in: '2592000',
        access_token: 'a',
        refresh_token: 'r',
      }).expires_in,
    ).toBe(2592000);
  });

  it.each([
    ['', 'reads as 0'],
    ['1,50', 'reads as 1.5 or 150'],
    ['0x1F', 'reads as 31'],
  ])('⛔ still REJECTS a balance of %s — a looser reading %s', (balance) => {
    expect(balanceSchema.safeParse({ balance }).success).toBe(false);
  });
});

describe('⚠️ REQUEST shapes still REFUSE a quoted number', () => {
  // The inverse assertion, and the reason it is here: the sweep and the
  // carve-outs are one edit apart in the same file, so "did they get swapped?"
  // has to be a test rather than a review habit. Tolerating a stringified
  // dimension would mean FORWARDING it to ME, which answers an opaque 422.
  it('a stringified volume dimension fails calculateRequestSchema', () => {
    const base = {
      from: { postal_code: '01001000' },
      to: { postal_code: '30110010' },
    };
    expect(
      calculateRequestSchema.safeParse({
        ...base,
        package: { width: '11', height: 2, length: 16, weight: 0.3 },
      }).success,
    ).toBe(false);
    expect(
      calculateRequestSchema.safeParse({
        ...base,
        package: { width: 11, height: 2, length: 16, weight: 0.3 },
      }).success,
    ).toBe(true);
  });

  it('a stringified insurance_value fails calculateRequestSchema', () => {
    const body = {
      from: { postal_code: '01001000' },
      to: { postal_code: '30110010' },
      options: { insurance_value: '150.00' },
    };
    expect(calculateRequestSchema.safeParse(body).success).toBe(false);
  });

  it('a stringified service id fails cartInsertRequestSchema', () => {
    expect(cartInsertRequestSchema.safeParse({ service: '1' }).success).toBe(false);
    expect(cartInsertRequestSchema.safeParse({ service: 1 }).success).toBe(true);
  });
});

describe('money: the union, and parseMePrice as the one place it is read', () => {
  it('accepts the string shape `calculate` sends', () => {
    const o = calculateOptionSchema.parse({ id: 1, name: 'PAC', price: '37.79' });
    expect(parseMePrice(o.price)).toBe(37.79);
  });

  it('⚠️ accepts the NUMBER shape the cart 201 sends — the mirror of #1087', () => {
    // `z.string()` alone used to reject this, and because the calculate response
    // is an array the failure would have taken every option with it.
    const o = calculateOptionSchema.parse({ id: 1, name: 'PAC', price: 37.79, discount: 0 });
    expect(parseMePrice(o.price)).toBe(37.79);
    expect(parseMePrice(o.discount)).toBe(0);
  });

  it.each([
    ['37.79', 37.79],
    ['0', 0],
    ['0.500000', 0.5],
    ['  12.5  ', 12.5],
    [37.79, 37.79],
    [0, 0],
  ])('parseMePrice(%o) -> %o', (input, expected) => {
    expect(parseMePrice(input)).toBe(expected);
  });

  /** `[label, what a looser reading would have produced, input]`. */
  const REJECTED: ReadonlyArray<readonly [string, string, string | number | null | undefined]> = [
    ['an empty string', 'a bare Number() reads it as 0 — free shipping', ''],
    ['whitespace', 'a bare Number() reads it as 0', '   '],
    ['a pt-BR comma', 'a locale parse would say 1.5 OR 150', '1,50'],
    ['a hex string', 'a bare Number() reads it as 31', '0x1F'],
    ['an exponent', 'a bare Number() reads it as 1000', '1e3'],
    ['a currency string', 'not a number in any reading', 'R$ 100,00'],
    ['null', 'there is no value', null],
    ['undefined', 'there is no value', undefined],
    ['a non-finite number', 'not a usable amount', Number.NaN],
  ];

  it.each(REJECTED)('⛔ parseMePrice returns null for %s — %s', (_label, _reason, input) => {
    // ⛔ null, never 0. The screen that renders a quote used to run a private
    // `Number(s)` over exactly these, and its `?? 0` turned the result into the
    // freight the operator then saved onto the pedido.
    expect(parseMePrice(input)).toBe(null);
  });
});
