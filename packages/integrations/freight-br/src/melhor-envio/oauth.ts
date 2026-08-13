/**
 * Melhor Envio OAuth2 (authorization-code) — port of the legacy
 * `MelhorEnviosApi.authUrl` / `getTokenInicial` / `refreshToken`
 * (`.old/.../melhor_envio/lib/src/api/api.dart`).
 *
 * Platform-neutral and fetch-based; **runs server-side only** in
 * `apps/integrations` (it touches `client_secret`). The browser never
 * imports this module.
 */
import { MelhorEnvioHttpError, MelhorEnvioNetworkError, MelhorEnvioSchemaError } from './errors';
import { type TokenResponse, tokenErrorSchema, tokenResponseSchema } from './types';

export const MELHOR_ENVIO_HOSTS = {
  sandbox: 'sandbox.melhorenvio.com.br',
  producao: 'www.melhorenvio.com.br',
} as const;

/** `https://sandbox…` or `https://www…` for the chosen environment. */
export function melhorEnvioBaseUrl(sandbox: boolean): string {
  return `https://${sandbox ? MELHOR_ENVIO_HOSTS.sandbox : MELHOR_ENVIO_HOSTS.producao}`;
}

/**
 * Least-privilege scope set (user-confirmed) — only what quote +
 * buy/generate/print/track need. ME's own guidance is "request only the
 * permissions your integration uses"; widening later forces a re-auth
 * (tokens last 30/45 days). Deliberately omits products-*, coupons-*,
 * companies-write, users-write, shipping-share, purchases-read,
 * notifications-read that the legacy app over-requested.
 */
export const MELHOR_ENVIO_SCOPES = [
  'shipping-calculate',
  'shipping-checkout',
  'shipping-generate',
  'shipping-print',
  'shipping-preview',
  'shipping-cancel',
  'shipping-tracking',
  'shipping-companies',
  'cart-read',
  'cart-write',
  'orders-read',
  'users-read',
  'transactions-read',
  'ecommerce-shipping',
] as const;

export interface OAuthConfig {
  /** From `melhorEnvioBaseUrl(sandbox)`. */
  readonly baseUrl: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** Must be byte-identical to the URI registered in the ME app. */
  readonly redirectUri: string;
  /** Required by ME — app name + contact email. */
  readonly userAgent: string;
  readonly fetchImpl?: typeof globalThis.fetch;
}

/**
 * The consent URL to send the user's browser to. `scope` is the
 * space-joined scope list; `state` is the (HMAC-signed) opaque value the
 * callback verifies.
 */
export function buildAuthorizeUrl(params: {
  baseUrl: string;
  clientId: string;
  redirectUri: string;
  state: string;
  scopes?: ReadonlyArray<string>;
}): string {
  const url = new URL(`${params.baseUrl}/oauth/authorize`);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('redirect_uri', params.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('state', params.state);
  url.searchParams.set('scope', (params.scopes ?? MELHOR_ENVIO_SCOPES).join(' '));
  return url.toString();
}

/** POST `/oauth/token` (form-urlencoded). Shared by code-exchange + refresh. */
async function postToken(
  config: OAuthConfig,
  body: Record<string, string>,
): Promise<TokenResponse> {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  let res: Response;
  try {
    res = await fetchImpl(`${config.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'User-Agent': config.userAgent,
      },
      // URLSearchParams sets Content-Type: application/x-www-form-urlencoded.
      body: new URLSearchParams(body),
    });
  } catch (err) {
    // A dedicated class, not the bare base: the base is ALSO what an unmapped
    // failure looks like, so callers could not tell a dead network from an
    // unrecognised error.
    throw new MelhorEnvioNetworkError(
      `Falha de rede ao chamar Melhor Envio /oauth/token: ${err instanceof Error ? err.message : 'fetch failed'}`,
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

  if (res.ok) {
    // `safeParse`, not `parse`: a raw ZodError is not a MelhorEnvioError, so it
    // escaped every `isMelhorEnvioError` guard and turned a malformed 200 into an
    // unhandled 500 at the OAuth callback instead of a redirect naming the cause.
    // `refresh_token` is required here, so this arm is genuinely reachable.
    const result = tokenResponseSchema.safeParse(parsed);
    if (!result.success) {
      // `parsed` is deliberately NOT attached — it is the token response.
      throw new MelhorEnvioSchemaError(
        'Resposta do /oauth/token do Melhor Envio em formato inesperado.',
        result.error.issues,
      );
    }
    return result.data;
  }

  const errBody = tokenErrorSchema.safeParse(parsed);
  const msg = errBody.success
    ? (errBody.data.error_description ??
      errBody.data.message ??
      errBody.data.error ??
      `HTTP ${res.status}`)
    : `HTTP ${res.status}`;
  throw new MelhorEnvioHttpError(`Melhor Envio /oauth/token: ${msg}`, res.status, parsed);
}

/** Exchange the authorization `code` for the first token pair. */
export function exchangeCode(config: OAuthConfig, code: string): Promise<TokenResponse> {
  return postToken(config, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'authorization_code',
    code,
  });
}

/** Trade a refresh token for a new access/refresh pair. */
export function refreshAccessToken(
  config: OAuthConfig,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(config, {
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  });
}
