import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MercadoLivreValidationError } from '@delfrance/integrations-mercado-livre';

import { describeValidationFailure, validationPaths } from './validationIssues';

describe('validationPaths', () => {
  it('names the field and the code for a Zod issue array', () => {
    const issues = z.object({ order_id: z.number() }).safeParse({ order_id: '1' });
    expect(issues.success).toBe(false);
    if (!issues.success) {
      expect(validationPaths(issues.error.issues)).toEqual(['order_id: invalid_type']);
    }
  });

  it('reports the root when an issue has no path', () => {
    expect(validationPaths([{ path: [], code: 'invalid_type' }])).toEqual(['(raiz): invalid_type']);
  });

  it('⚠️ passes a PATH-SHAPED string through — parseTestUser hands it a string[]', () => {
    // That producer has already done this function's job; mapping it to
    // '(desconhecido)' destroyed the one shape that was safe by construction.
    expect(validationPaths(['nickname', 'password'])).toEqual(['nickname', 'password']);
    expect(validationPaths(['fee_details.0.amount'])).toEqual(['fee_details.0.amount']);
    expect(validationPaths(['(raiz)'])).toEqual(['(raiz)']);
  });

  it('⛔ but refuses an arbitrary string — echoing one is the #1015 shape', () => {
    // `issues` is typed `unknown`; trust the SHAPE, not the producer.
    expect(
      validationPaths([
        'nem um objeto',
        '{"access_token":"APP_USR-secret"}',
        '<html>error page</html>',
        'x'.repeat(80),
      ]),
    ).toEqual(['(desconhecido)', '(desconhecido)', '(desconhecido)', '(desconhecido)']);
  });

  it('never throws on a hostile element — it must not turn a failure into a worse one', () => {
    expect(validationPaths([null, undefined, 42, { path: 'nope', code: 7 }])).toEqual([
      '(desconhecido)',
      '(desconhecido)',
      '(desconhecido)',
      '(raiz): desconhecido',
    ]);
  });

  it('returns nothing for a non-array (parseOk puts a raw body there on non-JSON)', () => {
    expect(validationPaths('<html>error page</html>')).toEqual([]);
    expect(validationPaths(null)).toEqual([]);
  });
});

describe('describeValidationFailure', () => {
  it('covers a MercadoLivreValidationError', () => {
    const err = new MercadoLivreValidationError('x', [
      { path: ['order_id'], code: 'invalid_type' },
    ]);
    expect(describeValidationFailure(err)).toEqual(['order_id: invalid_type']);
  });

  it('covers a bare ZodError — the shape a collection.parse raises on the way INTO Firestore', () => {
    const parsed = z.object({ valor: z.number().min(0) }).safeParse({ valor: -1 });
    if (!parsed.success) {
      expect(describeValidationFailure(parsed.error)).toEqual(['valor: too_small']);
    }
  });

  it('returns null — not [] — for anything else, so a caller can tell the two apart', () => {
    expect(describeValidationFailure(new Error('boom'))).toBe(null);
    expect(describeValidationFailure('nope')).toBe(null);
  });
});
