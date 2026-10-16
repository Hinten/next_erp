/**
 * The identity of a stored LWA credential: its versioned REF, the park's guard
 * input and the access token's `acessoRef` tag (step-2 plan §3 decision 12).
 *
 * `<16 lowercase hex>.<autorizadoEmMs>` — a domain-prefixed sha256 prefix of the
 * REFRESH TOKEN, a dot, and the millisecond start of the consent that stored it.
 * About 30 characters, inside the package's `MAX_REF_CREDENCIAL` (64).
 *
 * ## Why these two inputs, and never a stored field or the doc's `updateTime`
 *
 *  - **Re-derived, never read back.** {@link refDaCredencial} computes the ref
 *    from the stored `refresh_token` + `autorizadoEmMs` every time. No
 *    fingerprint is stored at all, so a hand-edited field cannot disable
 *    parking, nor make a stale access token look current.
 *  - **Not the commit time.** The access token is persisted on the same
 *    document roughly every hour; a ref keyed on `updateTime` would move with
 *    each refresh — spurious mismatches, and a refresh that "un-parks" a conta.
 *    The refresh token does not rotate on use, so this ref changes only when a
 *    consent stores a new grant.
 *  - **The consent's own clock in it.** A reconnect that returns the SAME
 *    refresh token still gets a new ref, so a refusal already in flight under
 *    the old one parks nothing.
 *
 * ⚠️ Only ever a label: the ref names a credential and says nothing about the
 * token, but it is still never logged (it carries the fingerprint).
 */
import { sha256Hex } from '@delfrance/data/admin';
import type { CredenciaisAmazon } from '@delfrance/schemas';

/**
 * The domain prefix. It makes our fingerprint uncorrelatable with a plain
 * sha256 of the same token computed anywhere else.
 *
 * ⚠️ Load-bearing: changing one character re-derives every ref, so every stored
 * access token stops matching (`acessoRef`) and every refusal in flight stops
 * parking. The test vector in `refCredencial.test.ts` is what notices.
 */
const PREFIXO_FINGERPRINT = 'amazon:lwa-refresh-token:';

/**
 * The label the code exchange runs under. There is no stored credential yet, so
 * nothing is ever stored under it, and the park ignores that operation
 * (`estacionamento.ts`). It can never equal a versioned ref (no hex, no dot).
 */
export const REF_CONSENTIMENTO = 'consentimento';

/** 16 lowercase hex characters: a domain-prefixed sha256 prefix of the refresh token. */
export function fingerprintDoRefreshToken(refreshToken: string): string {
  return sha256Hex(`${PREFIXO_FINGERPRINT}${refreshToken}`).slice(0, 16);
}

/** `<fingerprint>.<autorizadoEmMs>`. The caller supplies the fingerprint. */
export function montarRef(fingerprint: string, autorizadoEmMs: number): string {
  return `${fingerprint}.${String(autorizadoEmMs)}`;
}

/** The ref of a stored (or about to be stored) credential, re-derived from its grant. */
export function refDaCredencial(
  c: Pick<CredenciaisAmazon, 'refresh_token' | 'autorizadoEmMs'>,
): string {
  return montarRef(fingerprintDoRefreshToken(c.refresh_token), c.autorizadoEmMs);
}
