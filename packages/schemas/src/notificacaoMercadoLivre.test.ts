import { describe, expect, it } from 'vitest';

import {
  notificacaoMercadoLivreSchema,
  notificacaoResourceId,
  notificacaoStatusSchema,
} from './notificacaoMercadoLivre';

describe('notificacaoMercadoLivreSchema', () => {
  it('requires the two routing fields and defaults the rest', () => {
    const parsed = notificacaoMercadoLivreSchema.parse({
      resource: '/orders/2000',
      topic: 'orders_v2',
    });
    expect(parsed).toMatchObject({
      id: null,
      user_id: null,
      application_id: null,
      attempts: null,
      sent: null,
      received: null,
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: null,
    });
    expect(notificacaoMercadoLivreSchema.safeParse({ topic: 'orders_v2' }).success).toBe(false);
    expect(notificacaoMercadoLivreSchema.safeParse({ resource: '/orders/1' }).success).toBe(false);
    expect(
      notificacaoMercadoLivreSchema.safeParse({ resource: '', topic: 'orders_v2' }).success,
    ).toBe(false);
  });

  /**
   * ⚠️ Load-bearing for #810. The receiver stopped hand-building an 8-key
   * literal precisely so that a field ML adds without telling us survives onto
   * the dead-letter row — which it can only do if THIS schema keeps passing it
   * through `parseForWrite`. Making the collection strict would silently
   * re-break that, and the only symptom would be a thinner audit record on the
   * day someone actually needs it.
   */
  it('preserves unknown ML fields via passthrough', () => {
    const parsed = notificacaoMercadoLivreSchema.parse({
      resource: '/orders/2000',
      topic: 'orders_v2',
      site_id: 'MLB',
      seller_nickname: 'LOJA',
      priority: 3,
    }) as Record<string, unknown>;
    expect(parsed.site_id).toBe('MLB');
    expect(parsed.seller_nickname).toBe('LOJA');
    expect(parsed.priority).toBe(3);
  });

  it('tolerates a legacy µs/ISO sent on READ, normalizing to millis', () => {
    const iso = '2025-03-05T20:27:20.218Z';
    const parsed = notificacaoMercadoLivreSchema.parse({
      resource: '/orders/1',
      topic: 'orders_v2',
      sent: iso,
      received: 1_741_196_520_060_000, // µs
    });
    expect(parsed.sent).toBe(Date.parse(iso));
    expect(parsed.received).toBe(1_741_196_520_060);
  });

  it('only accepts failed/parked as status', () => {
    expect(notificacaoStatusSchema.safeParse('failed').success).toBe(true);
    expect(notificacaoStatusSchema.safeParse('parked').success).toBe(true);
    expect(notificacaoStatusSchema.safeParse('done').success).toBe(false);
  });
});

describe('notificacaoResourceId', () => {
  it('takes the last path segment, tolerating a bare id', () => {
    expect(notificacaoResourceId('/orders/2000')).toBe('2000');
    expect(notificacaoResourceId('/items/MLB123')).toBe('MLB123');
    expect(notificacaoResourceId('2000')).toBe('2000');
    expect(notificacaoResourceId('/orders/2000/')).toBe('2000');
  });
});
