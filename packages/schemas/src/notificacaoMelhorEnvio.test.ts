import { describe, expect, it } from 'vitest';
import { ALL_DOMAINS } from './registry';
import { notificacaoMelhorEnvioSchema } from './notificacaoMelhorEnvio';

describe('notificacaoMelhorEnvioSchema', () => {
  it('keeps the provider status separate from the resilience lane and preserves extras', () => {
    const parsed = notificacaoMelhorEnvioSchema.parse({
      labelId: 'label-1',
      event: 'order.posted',
      providerStatus: 'posted',
      tracking: 'ME123BR',
      evidence: 'kept',
    });

    expect(parsed).toMatchObject({
      labelId: 'label-1',
      providerStatus: 'posted',
      status: 'failed',
      tentativas: 0,
      erro: null,
      processedAt: null,
      evidence: 'kept',
    });
  });

  it('stays admin-only and absent from ALL_DOMAINS', () => {
    expect(
      ALL_DOMAINS.some((domain) => domain.meta.collectionPath === 'notificacoesMelhorEnvio'),
    ).toBe(false);
  });
});
