/**
 * The Seller Central consent URL of the website authorization workflow
 * [D:website-authorization-workflow]: where the operator's browser goes to
 * authorize the app, and what brings the `spapi_oauth_code` back to our
 * callback.
 *
 * Pure and fetch-free: it BUILDS a URL and sends nothing. It lives here, beside
 * the code exchange that redeems what it starts, because the two halves must
 * agree on the provider's wire protocol — above all on the `redirect_uri`,
 * which Amazon compares byte for byte between the consent and the exchange
 * (both go through `redirectUriValido`, in `transporte.ts`).
 *
 * ## The parameters, in this order
 *
 *  1. `application_id` — the app's id in the Solution Provider Portal (an
 *     `amzn1.sp.solution.…` value). Not a secret: it travels in the browser's
 *     address bar by design.
 *  2. `state` — the caller's signed, single-use value. Opaque here.
 *  3. `version=beta` — a CONSTANT: the app is in Draft (master plan D10), and a
 *     Draft app's consent page answers only with this parameter.
 *  4. `redirect_uri` — EXPLICIT, always. The app is shared with the legacy
 *     integration until the cutover, and an omitted `redirect_uri` sends the code
 *     to the FIRST URI registered on the app — presumably the legacy one, not
 *     ours. ⚠️ `[live-proven, legacy]`: the direct consent → redirect path (with
 *     no log-in URI leg) is what the legacy flow used live; that Amazon honours
 *     an explicit `redirect_uri` on THIS app is confirmed only in the migration
 *     window (D11). The exchange must then send the identical string.
 *
 * Every value is checked before the URL exists, and refused with
 * `AmazonConfigError` — whose message never echoes the value.
 */
import { AmazonConfigError } from './errors';
import { ehAsciiVisivel, redirectUriValido } from './transporte';

/** Seller Central's consent page for the Brazil store. */
export const URL_CONSENTIMENTO_BR = 'https://sellercentral.amazon.com.br/apps/authorize/consent';

/** The consent page's `version` for an app in Draft (D10). A constant, never a parameter. */
export const VERSAO_CONSENTIMENTO_RASCUNHO = 'beta';

/** The longest `application_id` accepted. A bound on the input, not a format. */
export const MAX_APPLICATION_ID = 200;

/** The operation name a refusal reports. */
const OPERACAO = 'montarUrlConsentimento';

export interface OpcoesUrlConsentimento {
  /** The app's Solution Provider Portal id, raw. */
  readonly applicationId: string;
  /** The caller's signed state, raw. Never trimmed. */
  readonly state: string;
  /**
   * Our OAuth callback, exactly as the code exchange will repeat it: an absolute
   * `https:` URL with no fragment and no userinfo.
   */
  readonly redirectUri: string;
}

/**
 * The consent URL: {@link URL_CONSENTIMENTO_BR} with exactly `application_id`,
 * `state`, `version` and `redirect_uri`, in that order.
 *
 * @throws {AmazonConfigError} `'application-id'`, `'state'` or `'redirect-uri'`
 *   (checked in that order); `refCredencial` is always `null` — there is no
 *   credential yet.
 */
export function montarUrlConsentimento(opts: OpcoesUrlConsentimento): string {
  const { applicationId, state, redirectUri } = opts;
  if (!ehAsciiVisivel(applicationId) || applicationId.length > MAX_APPLICATION_ID) {
    throw new AmazonConfigError('application-id', { operacao: OPERACAO, refCredencial: null });
  }
  if (!ehAsciiVisivel(state)) {
    throw new AmazonConfigError('state', { operacao: OPERACAO, refCredencial: null });
  }
  if (!redirectUriValido(redirectUri)) {
    throw new AmazonConfigError('redirect-uri', { operacao: OPERACAO, refCredencial: null });
  }

  // Set one key at a time, in the documented order — never by iterating an
  // object, which would carry any key a caller's value gained.
  const url = new URL(URL_CONSENTIMENTO_BR);
  url.searchParams.set('application_id', applicationId);
  url.searchParams.set('state', state);
  url.searchParams.set('version', VERSAO_CONSENTIMENTO_RASCUNHO);
  url.searchParams.set('redirect_uri', redirectUri);
  return url.toString();
}
