import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetWebhookOriginState, checkApplicationId } from './webhookOrigin';

/** A realistic ML application id (from the Notificações reference examples). */
const APP_ID = '2069392825111111';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetWebhookOriginState();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkApplicationId', () => {
  describe('fail-open: the gate must never be able to stall the genuine stream', () => {
    it.each([
      ['unset', undefined],
      ['empty', ''],
      ['whitespace', '   '],
      ['non-numeric', 'not-an-id'],
      ['zero', '0'],
      ['negative', '-5'],
    ])('skips when MERCADO_LIVRE_CLIENT_ID is %s', (_label, value) => {
      if (value !== undefined) vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', value);

      expect(checkApplicationId({ application_id: 123 })).toBe('skip');
    });

    it('warns ONCE about a malformed client id, so the disabled gate is visible', () => {
      vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', 'not-an-id');

      checkApplicationId({ application_id: 123 });
      checkApplicationId({ application_id: 123 });

      expect(console.warn).toHaveBeenCalledOnce();
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('MERCADO_LIVRE_CLIENT_ID is not a numeric application id'),
      );
    });
  });

  describe('with a configured client id', () => {
    beforeEach(() => {
      vi.stubEnv('MERCADO_LIVRE_CLIENT_ID', APP_ID);
    });

    it('accepts our id as a JSON number', () => {
      expect(checkApplicationId({ application_id: Number(APP_ID) })).toBe('ok');
    });

    it.each([APP_ID, ` ${APP_ID} `, `\t${APP_ID}\n`])(
      'accepts our id as the (possibly padded) string %j — this gate never sees the coerced payload',
      (value) => {
        expect(checkApplicationId({ application_id: value })).toBe('ok');
      },
    );

    it.each([
      ['a different application', 9999999999999],
      ['a different application, as a string', '9999999999999'],
      ['a prefix of ours', APP_ID.slice(0, -1)],
      ['ours with a trailing digit', `${APP_ID}0`],
    ])('refuses %s', (_label, value) => {
      expect(checkApplicationId({ application_id: value })).toBe('foreign');
    });

    it.each([
      ['missing', {}],
      ['null', { application_id: null }],
      ['a float', { application_id: 1.5 }],
      ['zero', { application_id: 0 }],
      ['negative', { application_id: -1 }],
      ['leading-zero padded', { application_id: `0${APP_ID}` }],
      ['not a number at all', { application_id: 'MLB-abc' }],
      ['an object', { application_id: { id: APP_ID } }],
      ['beyond Number.MAX_SAFE_INTEGER', { application_id: 2 ** 53 }],
    ])('reports %s as absent (accepted upstream, never a 403)', (_label, body) => {
      expect(checkApplicationId(body)).toBe('absent');
    });

    it.each([
      ['null', null],
      ['undefined', undefined],
      ['an array', [{ application_id: APP_ID }]],
      ['a string', '{}'],
      ['a number', 42],
    ])('reports a body that is %s as absent', (_label, body) => {
      expect(checkApplicationId(body)).toBe('absent');
    });
  });
});
