import { describe, expect, it } from 'vitest';
import {
  notificacoesWhatsappMeta,
  notificacoesWhatsappSchema,
  notificacoesWhatsappStatusSchema,
} from './notificacoesWhatsapp';
import { ALL_DOMAINS } from './registry';

describe('notificacoesWhatsappSchema', () => {
  it('parses a minimal failure doc with defaults applied', () => {
    const parsed = notificacoesWhatsappSchema.parse({
      field: 'messages',
    });
    expect(parsed).toMatchObject({
      field: 'messages',
      phoneNumberId: null,
      messageId: null,
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: null,
    });
  });

  it('parses a full webhook-pointer doc', () => {
    const doc = {
      field: 'statuses',
      phoneNumberId: '109876543210',
      messageId: 'wamid.HBgL...==',
      status: 'failed' as const,
      tentativas: 2,
      erro: 'timeout ao resolver Conta_Whatsapp',
      processedAt: 1718003700000,
    };
    expect(notificacoesWhatsappSchema.parse(doc)).toMatchObject(doc);
  });

  it('requires field', () => {
    expect(notificacoesWhatsappSchema.safeParse({}).success).toBe(false);
    expect(notificacoesWhatsappSchema.safeParse({ field: '' }).success).toBe(false);
  });

  it('preserves unknown WA fields via passthrough', () => {
    const parsed = notificacoesWhatsappSchema.parse({
      field: 'messages',
      value: { messaging_product: 'whatsapp' },
      entryId: '123456789',
    }) as Record<string, unknown>;
    expect(parsed.value).toEqual({ messaging_product: 'whatsapp' });
    expect(parsed.entryId).toBe('123456789');
  });

  // Pinned as a SET — an alias of the shared enum, so a new retry lane (#808's
  // `deferred`) lands here without touching this file. See the ML sibling.
  it('accepts exactly the shared resilience statuses', () => {
    expect([...notificacoesWhatsappStatusSchema.options].sort()).toEqual([
      'deferred',
      'failed',
      'parked',
    ]);
    for (const status of notificacoesWhatsappStatusSchema.options) {
      expect(notificacoesWhatsappStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(notificacoesWhatsappStatusSchema.safeParse('done').success).toBe(false);
  });

  it('targets the top-level notificacoesWhatsapp collection path', () => {
    expect(notificacoesWhatsappMeta.collectionPath).toBe('notificacoesWhatsapp');
  });

  it('is admin-only / default-deny: zero perms (mirrors credenciaisWhatsapp)', () => {
    expect(notificacoesWhatsappMeta.permissions).toEqual({
      read: 0n,
      write: 0n,
      delete: 0n,
    });
  });
});

describe('notificacoesWhatsapp admin-only registration', () => {
  it('is NOT registered in ALL_DOMAINS (server-only failure log)', () => {
    // The bare `{ schema, meta }` pair is exported as two separate constants
    // (not a single DomainSchema-shaped object), so `registry.test.ts`'s
    // `isDomainSchema()` never sweeps it in. Assert by schema identity too.
    const domainSchemas = ALL_DOMAINS.map((d) => d.schema);
    expect(domainSchemas).not.toContain(notificacoesWhatsappSchema);
  });
});
