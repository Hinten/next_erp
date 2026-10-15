import { describe, expect, it } from 'vitest';

import * as barril from '../src/index';

describe('the constants', () => {
  it('pins the SP-API host, the LWA endpoint and the BR marketplace id', () => {
    expect(barril.URL_BASE_SP_API).toBe('https://sellingpartnerapi-na.amazon.com');
    expect(barril.URL_TOKEN_LWA).toBe('https://api.amazon.com/auth/o2/token');
    expect(barril.MARKETPLACE_ID_BR).toBe('A2Q3Y263D00KWC');
    expect(barril.MAX_USER_AGENT).toBe(500);
    expect(barril.MAX_REF_CREDENCIAL).toBe(64);
  });
});

describe('the barrel', () => {
  it('exports the public surface', () => {
    for (const nome of [
      'criarClienteSpApi',
      'trocarRefreshToken',
      'trocarCodigoAutorizacao',
      'lerLimiteTaxa',
      'lerCodigoErroLwa',
    ] as const) {
      expect(typeof barril[nome], nome).toBe('function');
    }
    for (const nome of ['lwaTokenRespostaSchema', 'lwaErroSchema', 'spApiErrosSchema'] as const) {
      expect(typeof barril[nome].safeParse, nome).toBe('function');
    }
    expect(barril.PRAZO_AMAZON_MS).toEqual({ leitura: 20_000, lwa: 20_000 });
    for (const classe of [
      barril.AmazonError,
      barril.AmazonConfigError,
      barril.AmazonHttpError,
      barril.AmazonAuthError,
      barril.AmazonNotFoundError,
      barril.AmazonThrottleError,
      barril.AmazonSchemaError,
      barril.AmazonNetworkError,
      barril.AmazonTimeoutError,
    ]) {
      expect(typeof classe).toBe('function');
    }
  });

  it('does NOT export the internal transport', () => {
    const exportados = Object.keys(barril);
    for (const interno of [
      'enviar',
      'criarEmissor',
      'resolverFetch',
      'refValida',
      'userAgentValido',
      'ehAsciiVisivel',
      'contemSegredo',
      'lerRequestIdAmazon',
    ]) {
      expect(exportados, interno).not.toContain(interno);
    }
  });

  it('declares no MarketplaceChannel (ADR 0015)', () => {
    expect(Object.keys(barril)).not.toContain('MarketplaceChannel');
  });
});
