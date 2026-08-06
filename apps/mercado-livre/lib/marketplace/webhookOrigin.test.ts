import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetWebhookHeaderLog, checkApplicationId, logWebhookHeaders } from './webhookOrigin';

/** A realistic ML application id (from the Notificações reference examples). */
const APP_ID = '2069392825111111';

function req(headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3006/api/webhooks/mercado-livre', {
    method: 'POST',
    headers,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetWebhookHeaderLog();
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
      'accepts our id as the string %j — `asInt` would drop it (#810)',
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

describe('logWebhookHeaders', () => {
  it('logs the sorted header names', () => {
    logWebhookHeaders(req({ 'x-zulu': '1', 'x-alpha': '2' }));

    expect(console.warn).toHaveBeenCalledWith(
      '[mercado-livre/webhook] header-inventory',
      expect.objectContaining({ names: ['x-alpha', 'x-zulu'] }),
    );
  });

  it.each(['x-signature', 'x-hub-signature-256', 'x-meli-signature', 'x-content-digest'])(
    'logs the value of the signature candidate %s — the whole point of the exercise',
    (name) => {
      logWebhookHeaders(req({ [name]: 'ts=1,v1=abc' }));

      expect(console.warn).toHaveBeenCalledWith(
        '[mercado-livre/webhook] header-inventory',
        expect.objectContaining({ values: { [name]: 'ts=1,v1=abc' } }),
      );
    },
  );

  it('does NOT log the value of an ordinary header', () => {
    logWebhookHeaders(req({ 'content-type': 'application/json' }));

    expect(console.warn).toHaveBeenCalledWith(
      '[mercado-livre/webhook] header-inventory',
      expect.objectContaining({ names: ['content-type'], values: {} }),
    );
  });

  it('reduces a credential header to its scheme', () => {
    logWebhookHeaders(req({ authorization: 'Bearer super-secret-token' }));

    expect(console.warn).toHaveBeenCalledWith(
      '[mercado-livre/webhook] header-inventory',
      expect.objectContaining({ values: { authorization: '<Bearer>' } }),
    );
  });

  it('truncates a long candidate value', () => {
    logWebhookHeaders(req({ 'x-signature': 'a'.repeat(400) }));

    const { values } = vi.mocked(console.warn).mock.calls[0]![1] as {
      values: Record<string, string>;
    };
    expect(values['x-signature']).toHaveLength(256);
  });

  describe('log budget', () => {
    it('logs a header shape once, then stays quiet', () => {
      logWebhookHeaders(req({ 'content-type': 'application/json' }));
      logWebhookHeaders(req({ 'content-type': 'application/json' }));
      logWebhookHeaders(req({ 'content-type': 'text/plain' })); // same NAMES, new value

      expect(console.warn).toHaveBeenCalledOnce();
    });

    it('logs each new shape, then stops after the per-instance cap', () => {
      for (let i = 0; i < 25; i += 1) logWebhookHeaders(req({ [`x-shape-${i}`]: '1' }));

      expect(console.warn).toHaveBeenCalledTimes(20);
    });

    it('MERCADO_LIVRE_WEBHOOK_LOG_HEADERS=all logs every request', () => {
      vi.stubEnv('MERCADO_LIVRE_WEBHOOK_LOG_HEADERS', 'all');

      logWebhookHeaders(req({ 'content-type': 'application/json' }));
      logWebhookHeaders(req({ 'content-type': 'application/json' }));

      expect(console.warn).toHaveBeenCalledTimes(2);
    });

    it.each(['off', 'OFF', ' off '])(
      'MERCADO_LIVRE_WEBHOOK_LOG_HEADERS=%j disables logging',
      (value) => {
        vi.stubEnv('MERCADO_LIVRE_WEBHOOK_LOG_HEADERS', value);

        logWebhookHeaders(req({ 'x-signature': 'ts=1,v1=abc' }));

        expect(console.warn).not.toHaveBeenCalled();
      },
    );
  });
});
