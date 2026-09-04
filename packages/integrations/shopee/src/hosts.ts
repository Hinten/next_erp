/**
 * Which Shopee hosts this integration talks to, and where the overrides win.
 *
 * ## The doc contradictions this module takes a side on
 *
 * Three of them, all still open, all overridable from the environment so that a
 * single live redirect settles each one without a code change:
 *
 *  1. **Production API host.** Shopee's docs pick the API host by SERVER
 *     location ("near US" → one host, "near SG" → another) and name no Brazilian
 *     host at all, while the master plan's step 1 wrote
 *     `partner.shopeemobile.com`. Our backends run in `us-east1`, and the legacy
 *     Flutter app ran against `openplatform.shopee.com.br` in production for
 *     years. **This module supersedes the master plan**: the default is
 *     `openplatform.shopee.com.br`.
 *  2. **Sandbox API host.** Every API reference page's `test_url` names
 *     `partner.test-stable.shopeemobile.com`, while `guide 644` — newer — gives
 *     `openplatform.sandbox.test-stable.shopee.sg`. We default to `guide 644`.
 *  3. **Sandbox consent host.** The Brazilian row in `guide 20` is corrupted;
 *     `guide 644` shows `open.sandbox.test-stable.shopee.com`. We default to
 *     `open.sandbox.test-stable.shopee.com.br`, matching the production host's
 *     `.com.br` shape, and expect the first sandbox round trip to correct it.
 *
 * ⚠️ Pick one API host and STAY on it. Whether a token minted against one host
 * is honoured by another is undocumented, so switching hosts mid-life is an
 * experiment with a live credential.
 */
import { ShopeeConfigError } from './errors';

/** Production API host — see contradiction 1 in the module header. */
export const SHOPEE_PROD_API_HOST = 'https://openplatform.shopee.com.br';
/** Sandbox API host — see contradiction 2. */
export const SHOPEE_SANDBOX_API_HOST = 'https://openplatform.sandbox.test-stable.shopee.sg';
/** Production consent host. */
export const SHOPEE_PROD_AUTH_HOST = 'https://open.shopee.com.br';
/** Sandbox consent host — see contradiction 3. */
export const SHOPEE_SANDBOX_AUTH_HOST = 'https://open.sandbox.test-stable.shopee.com.br';

export interface ShopeeHosts {
  /** Origin the signed API calls go to, with no trailing slash. */
  readonly apiHost: string;
  /** Origin the seller's browser is redirected to, with no trailing slash. */
  readonly authHost: string;
  /** `${authHost}/auth` — the consent page. */
  readonly authorizeUrlBase: string;
  /** `${authHost}/cancel_auth` — the de-authorization page. */
  readonly cancelAuthUrlBase: string;
}

export interface ResolveShopeeHostsInput {
  /** `true` selects the sandbox defaults. An explicit override still wins. */
  readonly sandbox?: boolean;
  readonly apiHost?: string;
  readonly authHost?: string;
}

/**
 * An override must be a bare ORIGIN: scheme, host, optional port, nothing else.
 *
 * ⚠️ A path-bearing override is rejected rather than trimmed. `signedQuery`
 * signs `partner_id + path + timestamp`, where `path` is the API path alone — so
 * a host carrying `/api/v2` would produce a URL whose real path is not the one
 * that was signed, and every call would come back `error_sign` with nothing in
 * the message pointing here.
 */
function normalizeHost(raw: string, envVar: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new ShopeeConfigError(
      `${envVar} deve começar com http:// ou https:// (recebido: ${JSON.stringify(raw)}).`,
    );
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch (err) {
    // `new URL` raises a plain TypeError on a malformed input; anything else is
    // not ours to interpret.
    if (err instanceof TypeError) {
      throw new ShopeeConfigError(`${envVar} não é uma URL válida: ${JSON.stringify(raw)}.`);
    }
    throw err;
  }

  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ShopeeConfigError(
      `${envVar} deve ser apenas a origem (sem caminho, query ou fragmento): ${JSON.stringify(raw)}.`,
    );
  }
  return url.origin;
}

/**
 * The four host strings, from the sandbox flag and the optional overrides.
 *
 * The two overrides are independent: setting `apiHost` alone leaves the consent
 * host on its default, which is the shape a proxied API egress needs.
 */
export function resolveShopeeHosts(input: ResolveShopeeHostsInput = {}): ShopeeHosts {
  const sandbox = input.sandbox === true;
  const apiHost =
    input.apiHost === undefined
      ? sandbox
        ? SHOPEE_SANDBOX_API_HOST
        : SHOPEE_PROD_API_HOST
      : normalizeHost(input.apiHost, 'SHOPEE_API_HOST');
  const authHost =
    input.authHost === undefined
      ? sandbox
        ? SHOPEE_SANDBOX_AUTH_HOST
        : SHOPEE_PROD_AUTH_HOST
      : normalizeHost(input.authHost, 'SHOPEE_AUTH_HOST');

  return {
    apiHost,
    authHost,
    authorizeUrlBase: `${authHost}/auth`,
    // ⚠️ `/cancel_auth`, a SIBLING of `/auth` — not `/auth/cancel_auth`.
    cancelAuthUrlBase: `${authHost}/cancel_auth`,
  };
}
