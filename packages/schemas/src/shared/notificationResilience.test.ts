import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as barrel from '../index';
import { ALL_DOMAINS } from '../registry';
import { notificacaoMercadoLivreSchema } from '../notificacaoMercadoLivre';
import { notificacaoMercadoPagoSchema } from '../notificacaoMercadoPago';
import { notificacoesWhatsappSchema } from '../notificacoesWhatsapp';
import {
  notificacaoResilienciaStatusSchema,
  notificationResilienceFields,
} from './notificationResilience';

/**
 * The shared pipeline in `@delfrance/data/admin/notifications` writes and reads
 * these four fields BLIND, by name, for every channel. These tests are the
 * coupling made visible: a channel that drifts fails here rather than at 3am in
 * a production sweep.
 */

const RESILIENCE_DEFAULTS = {
  status: 'failed',
  tentativas: 0,
  erro: null,
  processedAt: null,
};

describe('notificationResilienceFields', () => {
  it('produces exactly the four fields the shared pipeline depends on', () => {
    expect(Object.keys(notificationResilienceFields()).sort()).toEqual([
      'erro',
      'processedAt',
      'status',
      'tentativas',
    ]);
  });

  it('returns FRESH builders each call, so channels cannot share Zod instances', () => {
    const a = notificationResilienceFields();
    const b = notificationResilienceFields();
    expect(a.status).not.toBe(b.status);
  });

  it('only ever persists `failed` or `parked` — a success writes no doc at all', () => {
    expect(notificacaoResilienciaStatusSchema.options).toEqual(['failed', 'parked']);
  });
});

describe('every notification channel schema agrees on the resilience block', () => {
  it.each([
    ['mercado-livre', notificacaoMercadoLivreSchema, { resource: '/orders/1', topic: 'orders_v2' }],
    ['mercado-pago', notificacaoMercadoPagoSchema, { paymentId: '123', topic: 'payment' }],
    ['whatsapp', notificacoesWhatsappSchema, { field: 'messages' }],
  ])('%s defaults match', (_channel, schema, wireFields) => {
    const parsed = schema.parse(wireFields) as Record<string, unknown>;
    expect(parsed).toMatchObject(RESILIENCE_DEFAULTS);
  });
});

/**
 * A local copy of `registry.test.ts`'s `isDomainSchema()` predicate. Duplicated
 * on purpose: the point of these assertions is that THIS module's exports are
 * invisible to that exact shape check, so the check has to be the same one.
 */
function isDomainSchema(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { schema?: unknown; meta?: unknown };
  if (!(candidate.schema instanceof z.ZodType)) return false;
  if (typeof candidate.meta !== 'object' || candidate.meta === null) return false;
  return typeof (candidate.meta as { collectionPath?: unknown }).collectionPath === 'string';
}

describe('registry safety', () => {
  it('nothing this module exports is sweepable into ALL_DOMAINS', () => {
    // This is what keeps the admin-only notification collections OUT of
    // `ALL_DOMAINS` — and therefore default-denied, with no generated Firestore
    // rules match block. A function is rejected on the predicate's first line;
    // a bare Zod schema has no `.schema` property. (Note a Zod schema DOES carry
    // a `.meta()` method — `typeof` reports `'function'`, not `'object'`, so it
    // fails the guard's second check too.)
    expect(isDomainSchema(notificationResilienceFields)).toBe(false);
    expect(isDomainSchema(notificacaoResilienciaStatusSchema)).toBe(false);
  });

  it('no notification schema is registered in ALL_DOMAINS', () => {
    const registered = new Set<unknown>(ALL_DOMAINS);
    for (const schema of [
      notificacaoMercadoLivreSchema,
      notificacaoMercadoPagoSchema,
      notificacoesWhatsappSchema,
    ]) {
      expect(registered.has(schema)).toBe(false);
    }
    const registeredPaths = ALL_DOMAINS.map((d) => d.meta.collectionPath);
    expect(registeredPaths.filter((p) => p.startsWith('notificac'))).toEqual([]);
  });

  it('the barrel exports the schemas as BARE constants, never as a DomainSchema pair', () => {
    for (const name of [
      'notificacaoMercadoLivreSchema',
      'notificacaoMercadoPagoSchema',
      'notificacoesWhatsappSchema',
    ]) {
      const value = (barrel as Record<string, unknown>)[name];
      expect(value, `${name} must be exported from the barrel`).toBeDefined();
      expect(isDomainSchema(value), `${name} must not be a DomainSchema pair`).toBe(false);
    }
  });
});
