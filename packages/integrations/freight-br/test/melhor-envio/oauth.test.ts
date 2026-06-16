import { describe, expect, it } from 'vitest';

import {
  MELHOR_ENVIO_SCOPES,
  buildAuthorizeUrl,
  exchangeCode,
  melhorEnvioBaseUrl,
  type OAuthConfig,
  refreshAccessToken,
} from '../../src/melhor-envio/oauth';
import { MelhorEnvioHttpError } from '../../src/melhor-envio/errors';
import { mockFetch } from '../_helpers/mockFetch';

const TOKEN_OK = {
  token_type: 'Bearer',
  expires_in: 2_592_000,
  access_token: 'access-123',
  refresh_token: 'refresh-456',
};

function config(fetchImpl: typeof globalThis.fetch): OAuthConfig {
  return {
    baseUrl: melhorEnvioBaseUrl(true),
    clientId: 'cid',
    clientSecret: 'secret',
    redirectUri: 'https://app.example.com/api/oauth/melhor-envio/callback',
    userAgent: '@delfrance/erp-next (contato@example.com)',
    fetchImpl,
  };
}

describe('melhorEnvioBaseUrl', () => {
  it('selects sandbox vs production host', () => {
    expect(melhorEnvioBaseUrl(true)).toBe('https://sandbox.melhorenvio.com.br');
    expect(melhorEnvioBaseUrl(false)).toBe('https://www.melhorenvio.com.br');
  });
});

describe('buildAuthorizeUrl', () => {
  it('builds the consent URL with space-joined scopes', () => {
    const url = new URL(
      buildAuthorizeUrl({
        baseUrl: melhorEnvioBaseUrl(true),
        clientId: 'cid',
        redirectUri: 'https://app.example.com/cb',
        state: 'signed.state',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://sandbox.melhorenvio.com.br/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('signed.state');
    expect(url.searchParams.get('scope')).toBe(MELHOR_ENVIO_SCOPES.join(' '));
  });

  it('uses least-privilege scopes (no products-write / coupons / users-write)', () => {
    expect(MELHOR_ENVIO_SCOPES).toContain('shipping-calculate');
    expect(MELHOR_ENVIO_SCOPES).toContain('shipping-checkout');
    expect(MELHOR_ENVIO_SCOPES).not.toContain('products-write');
    expect(MELHOR_ENVIO_SCOPES).not.toContain('coupons-write');
    expect(MELHOR_ENVIO_SCOPES).not.toContain('users-write');
  });
});

describe('exchangeCode', () => {
  it('POSTs form-urlencoded authorization_code with User-Agent', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify(TOKEN_OK), { status: 200 }));
    const token = await exchangeCode(config(fetchMock), 'the-code');

    expect(token.access_token).toBe('access-123');
    expect(token.refresh_token).toBe('refresh-456');
    expect(token.expires_in).toBe(2_592_000);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://sandbox.melhorenvio.com.br/oauth/token');
    expect(init?.method).toBe('POST');
    const body = init?.body as URLSearchParams;
    expect(body).toBeInstanceOf(URLSearchParams);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('the-code');
    expect(body.get('client_id')).toBe('cid');
    expect(body.get('client_secret')).toBe('secret');
    expect(body.get('redirect_uri')).toBe(
      'https://app.example.com/api/oauth/melhor-envio/callback',
    );
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toContain('@delfrance/erp-next');
  });

  it('maps a non-2xx token response to MelhorEnvioHttpError', async () => {
    const fetchMock = mockFetch(
      () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'bad code' }), {
          status: 401,
        }),
    );
    await expect(exchangeCode(config(fetchMock), 'x')).rejects.toMatchObject({
      name: 'MelhorEnvioHttpError',
      status: 401,
    });
    await expect(exchangeCode(config(fetchMock), 'x')).rejects.toBeInstanceOf(MelhorEnvioHttpError);
  });
});

describe('refreshAccessToken', () => {
  it('POSTs grant_type=refresh_token', async () => {
    const fetchMock = mockFetch(() => new Response(JSON.stringify(TOKEN_OK), { status: 200 }));
    await refreshAccessToken(config(fetchMock), 'old-refresh');
    const body = fetchMock.mock.calls[0]![1]?.body as URLSearchParams;
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('old-refresh');
  });
});
