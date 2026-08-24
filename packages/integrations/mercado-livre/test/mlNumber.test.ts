import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { mlInt, mlNumber } from '../src/mlNumber';
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
 * The contract has two halves, and the SECOND one is the reason this file is
 * long: tolerance must never invent a value. Every rejection case below is a
 * value `z.coerce.number()` — the obvious implementation — would have silently
 * turned into a number, most of them into `0` on a money field.
 */

describe('mlNumber — accepts both shapes', () => {
  it.each([
    ['a JSON number', 0, 0],
    ['a negative', -3, -3],
    ['a decimal', 1.5, 1.5],
    ['the safe-integer ceiling', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
    ['a zero string', '0', 0],
    ['a negative string', '-3', -3],
    ['a signed string', '+3', 3],
    ['a decimal string', '1.5', 1.5],
    ['a padded string', '  2.50  ', 2.5],
    ['a money string', '123.45', 123.45],
    ['a C-formatted string', '0.500000', 0.5],
    ['a zero-padded string', '007', 7],
    ['the live order_id', '2000018052464608', 2000018052464608],
  ])('%s', (_label, input, expected) => {
    expect(mlNumber().parse(input)).toBe(expected);
  });
});

describe('mlNumber — rejects rather than inventing', () => {
  /**
   * Each row names what a looser implementation would have produced instead — so
   * the table doubles as the argument for why `z.coerce.number()` is banned.
   * `unknown` on the input column is deliberate: these are the shapes a strict
   * signature would not let you write.
   */
  const REJECTED: ReadonlyArray<readonly [string, string, unknown]> = [
    ['an empty string', 'z.coerce.number() reads it as 0', ''],
    ['whitespace', 'z.coerce.number() reads it as 0', '   '],
    ['null', 'z.coerce.number() reads it as 0', null],
    ['true', 'z.coerce.number() reads it as 1', true],
    ['false', 'z.coerce.number() reads it as 0', false],
    ['an empty array', 'z.coerce.number() reads it as 0', []],
    ['an object', 'z.coerce.number() reads it as NaN', {}],
    ['undefined', 'there is no value at all', undefined],
    ['NaN', 'not a usable number', Number.NaN],
    ['a pt-BR decimal comma', 'a locale parse would say 1.5 OR 150', '1,50'],
    ['a hex string', 'bare Number() says 31', '0x1F'],
    ['an exponent string', 'bare Number() says 1000', '1e3'],
    ['an uppercase exponent string', 'bare Number() says 1000', '1E3'],
    ['a currency string', 'not a number in any reading', 'R$ 100,00'],
    ['a thousands separator', 'not a number in any reading', '1 000'],
    ['a numeric separator', 'not a number in any reading', '1_000'],
    ['a trailing dot', 'no serializer emits this', '3.'],
    ['the word Infinity', 'not a finite number', 'Infinity'],
    ['the word NaN', 'not a number', 'NaN'],
    ['plain text', 'not a number', 'abc'],
  ];

  it.each(REJECTED)('%s — %s', (_label, _reason, input) => {
    const result = mlNumber().safeParse(input);
    // ⛔ Assert the REJECTION, not merely the absence of a value. That the parse
    // fails is the entire point of not reaching for `z.coerce.number()`.
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.code).toBe('invalid_type');
  });

  it('a 400-digit run of 9s — it overflows to Infinity, which z.number() refuses', () => {
    // The decimal regex matches it; the inner `z.number()` is what closes this.
    expect(Number('9'.repeat(400))).toBe(Infinity);
    expect(mlNumber().safeParse('9'.repeat(400)).success).toBe(false);
  });

  it('an id string beyond MAX_SAFE_INTEGER — never silently rounded', () => {
    // ⚠️ The one hole the regex cannot see. `Number('9007199254740993')` is
    // 9007199254740992 (note the trailing 92, not 93) and `z.number()` accepts
    // it happily. A rounded id is an INVENTED id.
    expect(Number('9007199254740993')).toBe(9007199254740992);
    const result = mlNumber().safeParse('9007199254740993');
    expect(result.success).toBe(false);
    // Belt and braces: prove it did not come back as the rounded neighbour.
    expect(result.success ? result.data : null).not.toBe(9007199254740992);
  });
});

describe('mlInt', () => {
  it.each([
    ['a JSON integer', 3],
    ['an integer string', '3'],
    ['the live order_id', '2000018052464608'],
  ])('accepts %s', (_label, input) => {
    expect(mlInt().safeParse(input).success).toBe(true);
  });

  it.each([
    ['a fractional number', 1.5],
    ['a fractional string', '1.5'],
    ['beyond MAX_SAFE_INTEGER', '9007199254740993'],
    ['an exponent beyond the range', 1e21],
  ])('rejects %s', (_label, input) => {
    expect(mlInt().safeParse(input).success).toBe(false);
  });
});

describe('mlNumber — composes with every modifier types.ts uses', () => {
  it('.nullable().optional()', () => {
    const s = mlNumber().nullable().optional();
    expect(s.parse('1.5')).toBe(1.5);
    expect(s.parse(null)).toBe(null);
    expect(s.parse(undefined)).toBe(undefined);
    expect(s.safeParse('abc').success).toBe(false);
  });

  it('.nullable().default(null)', () => {
    expect(mlNumber().nullable().default(null).parse(undefined)).toBe(null);
    expect(mlInt().nullable().default(null).parse('7')).toBe(7);
  });

  it('.nullable().catch(null) — the per-field mlMissedFeedSchema idiom', () => {
    const s = mlNumber().nullable().catch(null);
    expect(s.parse('200')).toBe(200);
    expect(s.parse('abc')).toBe(null);
    expect(s.parse(null)).toBe(null);
  });

  it('.nullish().transform() over an array', () => {
    const s = z
      .array(mlNumber())
      .nullish()
      .transform((v) => v ?? []);
    expect(s.parse(null)).toEqual([]);
    expect(s.parse(['1', '2.5', 3])).toEqual([1, 2.5, 3]);
  });

  it('a missing optional key stays missing, and passthrough survives', () => {
    const s = z.object({ a: mlNumber().optional() }).passthrough();
    expect('a' in s.parse({})).toBe(false);
    expect(s.parse({ b: 'x' })).toEqual({ b: 'x' });
  });

  it('the issue PATH is preserved — this is what names the culprit in the log', () => {
    const result = z.object({ id: mlInt() }).safeParse({ id: 'abc' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(['id']);
  });
});

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
});
