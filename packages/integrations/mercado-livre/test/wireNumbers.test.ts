import { describe, expect, it } from 'vitest';
import {
  mlClaimSchema,
  mlPaymentSchema,
  mlQuestionSchema,
  mlShipmentSchema,
  orderSchema,
  packSchema,
  testUserSchema,
  userSchema,
} from '../src/types';

/**
 * The ML half of the quoted-number contract (#1087).
 *
 * The coercer's OWN contract — that it accepts both shapes and, far more
 * importantly, that it never invents a value where `z.coerce.number()` would
 * have produced `0` — lives with the coercer, in
 * `packages/core/src/wire/wire.test.ts`. It moved there with the rule itself
 * (#1251): the same payment resource reached through Mercado Pago's
 * `GET /v1/payments/{id}` had the identical exposure, so a per-channel copy of
 * the regex was always going to drift (#810).
 *
 * What stays here is the half only this package can assert: that a stringified
 * REQUIRED id no longer discards every other field on an ML resource. The schema
 * list is what makes it meaningful, and the schema list is local.
 */
describe('a stringified REQUIRED id no longer kills a whole resource parse', () => {
  // Each of these ids is required, so before the sweep one quoted value threw
  // away every other field on the response.
  it.each([
    ['userSchema', userSchema, { id: '123' }],
    [
      'testUserSchema',
      testUserSchema,
      { id: '123', nickname: 'n', password: 'p', site_status: 'a' },
    ],
    ['orderSchema', orderSchema, { id: '2000003508419013' }],
    ['packSchema', packSchema, { id: '2000015428123455', orders: [{ id: '2000003508419013' }] }],
    ['mlPaymentSchema', mlPaymentSchema, { id: '174034247387' }],
    ['mlShipmentSchema', mlShipmentSchema, { id: '555' }],
    [
      'mlClaimSchema',
      mlClaimSchema,
      {
        id: '1',
        resource_id: '2',
        resource: 'order',
        date_created: '2026-08-21T17:27:51.000-04:00',
      },
    ],
    ['mlQuestionSchema', mlQuestionSchema, { id: '1' }],
  ])('%s', (_label, schema, body) => {
    const result = schema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('⛔ and an id that is NOT a number still fails — tolerance, not coercion', () => {
    // The counterweight to the table above: widening the shape must not have
    // turned the required id into something that accepts anything at all.
    expect(orderSchema.safeParse({ id: '' }).success).toBe(false);
    expect(orderSchema.safeParse({ id: '0x1F' }).success).toBe(false);
    expect(mlPaymentSchema.safeParse({ id: true }).success).toBe(false);
  });
});
