/**
 * The one place `apps/shopee` reads its **Shopee** configuration from the
 * environment.
 *
 * `@delfrance/integrations-shopee` deliberately never touches `process.env` —
 * every value it needs is a parameter — so this module is the boundary where
 * the environment becomes a typed config object.
 *
 * ⚠️ Not the app's only `process.env` reader, and the narrower claim is the
 * true one: Firebase credentials are read by `lib/firebase/admin.ts` and the
 * CORS allow-list by `proxy.ts`, neither of which follows the rule below.
 * Scoping the claim to the Shopee values is what makes that rule enforceable
 * here instead of an app-wide invariant two other modules already break.
 *
 * ## Every SHOPEE read is BLANK-GUARDED, never `??`
 *
 * `??` guards only `undefined`/`null`, so a variable declared and left empty
 * (`SHOPEE_PUBLIC_URL=`) reads as a present empty string. That is not a
 * theoretical hole in this repo: the same shape sent Melhor Envio a RELATIVE
 * `redirect_uri` (silently rejected as a mismatch) and left `*_TASKS_REGION`
 * blank in #887. Here it would build the consent URL with an empty callback and
 * the failure would surface at Shopee, not at boot. Blank is treated as unset.
 */
import {
  ShopeeConfigError,
  type ShopeeHosts,
  resolveShopeeHosts,
} from '@delfrance/integrations-shopee';

/**
 * ⚠️ ONE class, re-exported rather than redeclared.
 *
 * A second app-local `ShopeeConfigError` would not be `instanceof` the
 * package's, and `respond.ts` / the OAuth callback both branch on exactly that
 * — so the two copies would map to different HTTP statuses and different
 * redirect slugs depending on which module happened to throw. The package's
 * class already means "OUR misconfiguration", which is precisely what a missing
 * env var is.
 */
export { ShopeeConfigError };

/**
 * The resolved Shopee configuration for this backend.
 *
 * ⚠️ `hosts` rather than the flat `apiHost` / `authHost` pair: `resolveShopeeHosts`
 * already returns the four strings (including the two consent bases) as one
 * value, and copying two of them out would be a second source of truth for the
 * host — the exact drift `hosts.ts` warns about, since a token minted against
 * one API host may not be honoured by another.
 */
export interface ShopeeConfig {
  readonly partnerId: number;
  readonly partnerKey: string;
  readonly hosts: ShopeeHosts;
  readonly redirectUri: string;
  readonly sandbox: boolean;
}

/** Trimmed value, or `null` when unset OR blank. The only reader of `process.env` here. */
function envValue(name: string): string | null {
  const raw = process.env[name]?.trim();
  return raw != null && raw.length > 0 ? raw : null;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/**
 * Whether to talk to Shopee's sandbox.
 *
 * ⚠️ **OPT-IN**, exactly `'1'` — the OPPOSITE polarity of `MELHOR_ENVIO_SANDBOX`
 * (which is sandbox unless you opt out). Production here reuses the live legacy
 * Flutter application's registered Shopee app, so an unset or typo'd value on a
 * deployed backend must mean PRODUCTION. `'true'`, `'yes'`, `'0'` and `''` are
 * all production; `.env.example` ships `SHOPEE_SANDBOX=1` so local dev is not.
 */
export function shopeeSandbox(): boolean {
  return process.env.SHOPEE_SANDBOX === '1';
}

/**
 * The four Shopee hosts.
 *
 * Precedence is override > flag > documented default, and the two overrides are
 * independent: `SHOPEE_API_HOST` alone leaves the consent host on its default,
 * which is the shape a proxied API egress will need (master plan P2).
 */
export function shopeeHosts(): ShopeeHosts {
  const apiHost = envValue('SHOPEE_API_HOST');
  const authHost = envValue('SHOPEE_AUTH_HOST');
  return resolveShopeeHosts({
    sandbox: shopeeSandbox(),
    ...(apiHost !== null ? { apiHost } : {}),
    ...(authHost !== null ? { authHost } : {}),
  });
}

/**
 * The OAuth redirect target, absolute.
 *
 * It must match a redirect URL whose DOMAIN is registered on the Shopee app.
 * The localhost default keeps local dev working; a deployed backend with a
 * blank `SHOPEE_PUBLIC_URL` therefore fails at Shopee rather than at boot,
 * which is why the callback's failure log echoes this value.
 */
export function shopeeRedirectUri(): string {
  const base = stripTrailingSlash(envValue('SHOPEE_PUBLIC_URL') ?? 'http://localhost:3009');
  return `${base}/api/oauth/shopee/callback`;
}

/**
 * The partner credentials plus the resolved hosts and redirect URI.
 *
 * ⚠️ `partnerId` is parsed with `/^\d+$/` **and** `Number.isSafeInteger`, never
 * `parseInt`. `parseInt('123abc')` answers `123` and `Number('')` answers `0`,
 * and a truncated partner id signs cleanly — the only symptom is `error_sign`
 * on every call, with nothing in the message pointing at the env var.
 *
 * ⚠️ The messages name the VARIABLE and never its value: `SHOPEE_PARTNER_KEY`
 * is the HMAC secret.
 */
export function shopeeConfig(): ShopeeConfig {
  const partnerIdRaw = envValue('SHOPEE_PARTNER_ID');
  if (partnerIdRaw === null) {
    throw new ShopeeConfigError('SHOPEE_PARTNER_ID não configurado no ambiente.');
  }
  if (!/^\d+$/.test(partnerIdRaw)) {
    throw new ShopeeConfigError('SHOPEE_PARTNER_ID deve conter apenas dígitos.');
  }
  const partnerId = Number(partnerIdRaw);
  if (!Number.isSafeInteger(partnerId) || partnerId <= 0) {
    throw new ShopeeConfigError('SHOPEE_PARTNER_ID deve ser um inteiro positivo.');
  }

  const partnerKey = envValue('SHOPEE_PARTNER_KEY');
  if (partnerKey === null) {
    throw new ShopeeConfigError('SHOPEE_PARTNER_KEY não configurado no ambiente.');
  }

  return {
    partnerId,
    partnerKey,
    hosts: shopeeHosts(),
    redirectUri: shopeeRedirectUri(),
    sandbox: shopeeSandbox(),
  };
}

/**
 * The HMAC key behind the signed OAuth `state`, or `null` when unset.
 *
 * `null` rather than a throw because the two callers answer differently: the
 * authenticated `oauth/start` route returns a 500 naming the variable, while
 * the public callback has no caller to tell and redirects with `reason=config`.
 */
export function shopeeStateSecret(): string | null {
  return envValue('SHOPEE_STATE_SECRET');
}

/** Origin of `apps/web`, where the OAuth callback sends the browser back. */
export function webBase(): string {
  return stripTrailingSlash(envValue('WEB_APP_URL') ?? 'http://localhost:3000');
}
