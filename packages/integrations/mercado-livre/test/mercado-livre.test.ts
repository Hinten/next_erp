import { describe, it, expect } from 'vitest';
import { createMercadoLivreChannel, MercadoLivreNotConfiguredError } from '../src/index';
import type { ChannelContext } from '@delfrance/core/plugins';

const channel = createMercadoLivreChannel({
  clientId: 'CID',
  clientSecretEnvVar: 'ML_SECRET',
  redirectUri: 'https://app.test/oauth/mercado-livre/callback',
});

const ctx: ChannelContext = { integracaoId: 'i1', accessToken: 'live-token', account: {} };

describe('createMercadoLivreChannel scaffold (extended #288 contract)', () => {
  it('exposes the channel id', () => {
    expect(channel.id).toBe('mercado-livre');
  });

  it('required methods reject with NotConfigured until Phase 5', async () => {
    await expect(channel.syncProducts(ctx)).rejects.toBeInstanceOf(MercadoLivreNotConfiguredError);
    await expect(channel.pullOrders(ctx)).rejects.toBeInstanceOf(MercadoLivreNotConfiguredError);
    await expect(channel.pushTracking(ctx, 'order-1', 'BR123')).rejects.toBeInstanceOf(
      MercadoLivreNotConfiguredError,
    );
    await expect(channel.oauthFlow.callback('code', 'state')).rejects.toBeInstanceOf(
      MercadoLivreNotConfiguredError,
    );
  });

  it('optional capabilities are absent on the scaffold (callers feature-detect)', () => {
    expect(channel.pushPrice).toBeUndefined();
    expect(channel.pushStock).toBeUndefined();
    expect(channel.importOrders).toBeUndefined();
    expect(channel.getOrderCharges).toBeUndefined();
    expect(channel.getOrderFiscalIdentity).toBeUndefined();
    expect(channel.importIncidents).toBeUndefined();
    expect(channel.fetchLabel).toBeUndefined();
  });

  it('oauthFlow.start builds a consent URL carrying state, client_id and redirect_uri', () => {
    const url = new URL(channel.oauthFlow.start('xyz-state'));
    expect(url.searchParams.get('state')).toBe('xyz-state');
    expect(url.searchParams.get('client_id')).toBe('CID');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://app.test/oauth/mercado-livre/callback',
    );
  });
});
