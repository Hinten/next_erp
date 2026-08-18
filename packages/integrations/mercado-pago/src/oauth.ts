/**
 * Mercado Pago OAuth core — **SERVER-SIDE ONLY**. Every token request sends the
 * app `clientSecret` to `POST /oauth/token`, so this module must never be
 * imported into client/browser code (doing so would bundle + leak the secret).
 * It stays platform-neutral (fetch-only) but is consumed exclusively by the
 * App-Hosting backend. Mirrors the Mercado Livre OAuth core.
 */
import {
  MercadoPagoHttpError,
  MercadoPagoNetworkError,
  MercadoPagoReauthRequiredError,
  MercadoPagoValidationError,
} from './errors';
import { type TokenResponse, tokenErrorSchema, tokenResponseSchema } from './types';

/** Consent host (Brazil). */
export const DEFAULT_AUTH_BASE_URL = 'https://auth.mercadopago.com.br';
/** REST + token host. */
export const DEFAULT_API_BASE_URL = 'https://api.mercadopago.com';

/**
 * App-wide OAuth config — one registered MP application serves every connected
 * account. `clientId`/`clientSecret`/`redirectUri` come from env / Secret
 * Manager; `fetch` is injectable for tests.
 */
export interface MercadoPagoOAuthConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must match EXACTLY the redirect URI registered in the MP app dashboard. */
  readonly redirectUri: string;
  readonly authBaseUrl?: string;
  readonly apiBaseUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
}

export interface BuildAuthorizeUrlParams {
  readonly clientId: string;
  readonly redirectUri: string;
  /** Opaque, signed state — verified on callback (CSRF + carries the account id). */
  readonly state: string;
  readonly authBaseUrl?: string;
  /**
   * PKCE (RFC 7636) — only when the registered MP application has PKCE enabled.
   *
   * ⚠️ MP's docs are explicit that the toggle makes these MANDATORY: *"With the
   * field enabled, Mercado Pago will require the `code_challenge` and
   * `code_method` fields in OAuth requests."* So the caller's flag and the
   * dashboard toggle must be flipped together — sending them to an app that has
   * PKCE off is ignored, omitting them from one that has it on breaks consent.
   */
  readonly codeChallenge?: string;
  readonly codeChallengeMethod?: 'S256' | 'plain';
}

/** Build the MP consent URL to redirect the seller to. */
export function buildAuthorizeUrl(params: BuildAuthorizeUrlParams): string {
  const url = new URL('/authorization', params.authBaseUrl ?? DEFAULT_AUTH_BASE_URL);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('platform_id', 'mp');
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('state', params.state);
  if (params.codeChallenge) {
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', params.codeChallengeMethod ?? 'S256');
  }
  return url.toString();
}

/**
 * Exchange an authorization `code` for the first token pair.
 *
 * `codeVerifier` is the PKCE proof matching the `code_challenge` sent to
 * `buildAuthorizeUrl`; omit it when the app has PKCE off. The refresh grant never
 * carries one.
 */
export function exchangeCode(
  config: MercadoPagoOAuthConfig,
  code: string,
  codeVerifier?: string,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  });
  if (codeVerifier) params.set('code_verifier', codeVerifier);
  return requestToken(config, params);
}

/**
 * Trade a `refresh_token` for a new access + refresh token. MP refresh tokens
 * rotate, so the caller MUST persist the returned `refresh_token`.
 * `invalid_grant` here ⇒ re-consent required.
 */
export function refreshAccessToken(
  config: MercadoPagoOAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
  });
  return requestToken(config, params);
}

async function requestToken(
  config: MercadoPagoOAuthConfig,
  params: URLSearchParams,
): Promise<TokenResponse> {
  const doFetch = config.fetch ?? globalThis.fetch;
  const url = `${config.apiBaseUrl ?? DEFAULT_API_BASE_URL}/oauth/token`;

  let res: Response;
  try {
    res = await doFetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });
  } catch (err) {
    throw new MercadoPagoNetworkError(
      `Falha de rede ao contatar o Mercado Pago: ${err instanceof Error ? err.message : 'fetch falhou'}`,
      err,
    );
  }

  const text = await res.text();
  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      if (err instanceof SyntaxError) parsed = { raw: text };
      else throw err;
    }
  }

  if (!res.ok) {
    const errBody = tokenErrorSchema.safeParse(parsed);
    const code = errBody.success ? errBody.data.error : undefined;
    const description = errBody.success
      ? (errBody.data.error_description ?? errBody.data.message)
      : undefined;
    // `invalid_grant` is terminal — the code/refresh token is expired, revoked,
    // or already used. Everything else is a transient/other HTTP error.
    if (code === 'invalid_grant') {
      // Carry status + body: `description` alone cannot distinguish an expired
      // code from a `redirect_uri` mismatch.
      throw new MercadoPagoReauthRequiredError(
        'refresh_failed',
        description ?? 'Sessão do Mercado Pago expirada. Reconecte a conta.',
        res.status,
        parsed,
      );
    }
    throw new MercadoPagoHttpError(
      `MP /oauth/token: ${description ?? code ?? `HTTP ${res.status}`}`,
      res.status,
      parsed,
    );
  }

  const result = tokenResponseSchema.safeParse(parsed);
  if (!result.success) {
    throw new MercadoPagoValidationError(
      'Resposta do /oauth/token do Mercado Pago em formato inesperado.',
      result.error.issues,
    );
  }
  return result.data;
}
