import { describe, expect, it } from 'vitest';
import {
  notificacaoMercadoPagoSchema,
  notificacaoMercadoPagoStatusSchema,
} from './notificacaoMercadoPago';
import { ALL_DOMAINS } from './registry';

describe('notificacaoMercadoPagoSchema', () => {
  it('parses a minimal failure doc with defaults applied', () => {
    const parsed = notificacaoMercadoPagoSchema.parse({
      paymentId: '123456789',
      topic: 'payment',
    });
    expect(parsed).toMatchObject({
      id: null,
      paymentId: '123456789',
      topic: 'payment',
      collectorUserId: null,
      liveMode: null,
      dateCreated: null,
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: null,
    });
  });

  it('parses a full webhook-pointer doc', () => {
    const doc = {
      id: '987654',
      paymentId: '123456789',
      topic: 'payment',
      collectorUserId: 44444,
      liveMode: true,
      dateCreated: 1718003600000,
      status: 'failed' as const,
      tentativas: 2,
      erro: 'timeout ao buscar pagamento',
      processedAt: 1718003700000,
    };
    expect(notificacaoMercadoPagoSchema.parse(doc)).toMatchObject(doc);
  });

  it('is tolerant of an ISO-8601 dateCreated (MP wire format)', () => {
    const parsed = notificacaoMercadoPagoSchema.parse({
      paymentId: '123',
      topic: 'payment',
      dateCreated: '2021-11-01T02:02:02.000Z',
    });
    expect(parsed.dateCreated).toBe(Date.parse('2021-11-01T02:02:02.000Z'));
  });

  it('requires paymentId and topic', () => {
    expect(notificacaoMercadoPagoSchema.safeParse({ topic: 'payment' }).success).toBe(false);
    expect(notificacaoMercadoPagoSchema.safeParse({ paymentId: '123' }).success).toBe(false);
    expect(
      notificacaoMercadoPagoSchema.safeParse({ paymentId: '', topic: 'payment' }).success,
    ).toBe(false);
  });

  it('preserves unknown MP fields via passthrough', () => {
    const parsed = notificacaoMercadoPagoSchema.parse({
      paymentId: '123',
      topic: 'payment',
      action: 'payment.updated',
      api_version: 'v1',
      application_id: 555,
    }) as Record<string, unknown>;
    expect(parsed.action).toBe('payment.updated');
    expect(parsed.api_version).toBe('v1');
    expect(parsed.application_id).toBe(555);
  });

  it('only accepts failed/parked as status', () => {
    expect(notificacaoMercadoPagoStatusSchema.safeParse('failed').success).toBe(true);
    expect(notificacaoMercadoPagoStatusSchema.safeParse('parked').success).toBe(true);
    expect(notificacaoMercadoPagoStatusSchema.safeParse('done').success).toBe(false);
  });
});

describe('notificacoesMercadoPago admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only failure log)', () => {
    // The schema exposes no `xMeta`/collection path constant (admin handle
    // owns the literal path, mirroring notificacaoMercadoLivre) — assert by
    // schema identity instead of collectionPath.
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(notificacaoMercadoPagoSchema);
  });
});
