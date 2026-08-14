import { describe, expect, it, vi } from 'vitest';
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoValidationError,
} from '../src/errors';
import {
  type MercadoPagoOAuthConfig,
  buildAuthorizeUrl,
  exchangeCode,
  refreshAccessToken,
} from '../src/oauth';

const config: MercadoPagoOAuthConfig = {
  clientId: 'APP-123',
  clientSecret: 'secret-xyz',
  redirectUri: 'https://app.example.com/api/oauth/mercado-pago/callback',
};

/** A minimal well-formed MP token response. */
const TOKEN_JSON = {
  access_token: 'APP_USR-abc',
  token_type: 'bearer',
  expires_in: 15552000,
  scope: 'offline_access read write',
  user_id: 123456,
  refresh_token: 'TG-refresh-1',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildAuthorizeUrl', () => {
  it('builds the MP consent URL with the required params', () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: config.clientId,
        redirectUri: config.redirectUri,
        state: 'signed-state',
      }),
    );
    expect(url.origin + url.pathname).toBe('https://auth.mercadopago.com.br/authorization');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('platform_id')).toBe('mp');
    expect(url.searchParams.get('client_id')).toBe('APP-123');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('state')).toBe('signed-state');
  });
});

describe('exchangeCode', () => {
  it('POSTs the authorization_code grant and returns the parsed token', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(TOKEN_JSON),
    );
    const token = await exchangeCode({ ...config, fetch: fetchMock }, 'AUTH-CODE');

    expect(token.access_token).toBe('APP_USR-abc');
    expect(token.refresh_token).toBe('TG-refresh-1');
    expect(token.expires_in).toBe(15552000);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://api.mercadopago.com/oauth/token');
    const body = new URLSearchParams(init!.body as string);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code')).toBe('AUTH-CODE');
    expect(body.get('client_id')).toBe('APP-123');
    expect(body.get('client_secret')).toBe('secret-xyz');
    expect(body.get('redirect_uri')).toBe(config.redirectUri);
  });

  it('maps invalid_grant on the code exchange to a re-auth-required error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(
        { error: 'invalid_grant', error_description: 'expired authorization code', status: 400 },
        400,
      ),
    );
    await expect(exchangeCode({ ...config, fetch: fetchMock }, 'DEAD-CODE')).rejects.toBeInstanceOf(
      MercadoPagoReauthRequiredError,
    );
  });

  it('keeps the MP status and body on the invalid_grant path', async () => {
    // `invalid_grant` is the most likely failure of a code exchange, and this
    // branch used to drop `status` + `body` before any caller saw them — leaving
    // an expired code indistinguishable from a `redirect_uri` mismatch.
    const corpo = {
      error: 'invalid_grant',
      error_description: 'invalid redirect_uri',
      cause: [{ code: 'redirect_uri_mismatch' }],
    };
    const fetchMock = vi.fn(async () => jsonResponse(corpo, 400));

    await expect(exchangeCode({ ...config, fetch: fetchMock }, 'DEAD-CODE')).rejects.toMatchObject({
      constructor: MercadoPagoReauthRequiredError,
      status: 400,
      body: corpo,
    });
  });
});

describe('refreshAccessToken', () => {
  it('POSTs the refresh_token grant and returns the rotated token', async () => {
    const rotated = { ...TOKEN_JSON, access_token: 'APP_USR-def', refresh_token: 'TG-refresh-2' };
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(rotated),
    );
    const token = await refreshAccessToken({ ...config, fetch: fetchMock }, 'TG-refresh-1');

    expect(token.access_token).toBe('APP_USR-def');
    expect(token.refresh_token).toBe('TG-refresh-2');
    const body = new URLSearchParams(fetchMock.mock.calls[0]![1]!.body as string);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('refresh_token')).toBe('TG-refresh-1');
  });

  it('maps invalid_grant to a re-auth-required error', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse(
        {
          error: 'invalid_grant',
          error_description: 'Error validating grant. Your refresh token may be expired',
          status: 400,
        },
        400,
      ),
    );
    await expect(
      refreshAccessToken({ ...config, fetch: fetchMock }, 'TG-dead'),
    ).rejects.toBeInstanceOf(MercadoPagoReauthRequiredError);
  });

  it('maps other non-2xx bodies to an HTTP error carrying the status', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ error: 'local_rate_limited', status: 429 }, 429),
    );
    await expect(refreshAccessToken({ ...config, fetch: fetchMock }, 'TG-1')).rejects.toMatchObject(
      {
        constructor: MercadoPagoHttpError,
        status: 429,
      },
    );
  });

  it('wraps a fetch/network throw', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) => {
      throw new TypeError('ECONNRESET');
    });
    await expect(
      refreshAccessToken({ ...config, fetch: fetchMock }, 'TG-1'),
    ).rejects.toBeInstanceOf(MercadoPagoNetworkError);
  });

  it('rejects a token response missing a required field (validation)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ access_token: 'x', token_type: 'bearer' }),
    );
    await expect(
      refreshAccessToken({ ...config, fetch: fetchMock }, 'TG-1'),
    ).rejects.toBeInstanceOf(MercadoPagoValidationError);
  });

  it('tolerates unknown extra fields (MP adds fields without notice)', async () => {
    const fetchMock = vi.fn(async (_u: string | URL | Request, _i?: RequestInit) =>
      jsonResponse({ ...TOKEN_JSON, some_new_mp_field: 'surprise' }),
    );
    const token = await refreshAccessToken({ ...config, fetch: fetchMock }, 'TG-1');
    expect(token.access_token).toBe('APP_USR-abc');
    expect((token as Record<string, unknown>).some_new_mp_field).toBe('surprise');
  });
});
