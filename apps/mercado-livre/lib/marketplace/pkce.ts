/**
 * PKCE (RFC 7636) helpers for the Mercado Livre connect flow — #821.
 *
 * PKCE is what makes a stolen `code` useless: the consent URL carries
 * `code_challenge = SHA-256(code_verifier)`, and the token exchange must present
 * the matching `code_verifier`, which never leaves our backend. It complements
 * the single-use `state` record rather than replacing it — the state binds the
 * callback to an account, PKCE binds it to the attempt that started it.
 *
 * ⚠️ ML enables PKCE **per registered application**, in the DevCenter, and its
 * docs are explicit that once the toggle is on the parameters stop being
 * optional ("ao ser ativada esta opção, o envio do campo se torna obrigatório").
 * So this side is gated by {@link pkceEnabled} and the two must be flipped
 * together for a given `client_id`: code without the toggle sends parameters ML
 * ignores; the toggle without the code breaks every connect.
 */
import { createHash, randomBytes } from 'node:crypto';

/**
 * Mint a `code_verifier`. 32 random bytes render as 43 base64url characters —
 * the low end of RFC 7636 §4.1's 43..128 range, and base64url is a subset of
 * the unreserved set the RFC allows, so no escaping is ever needed.
 */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** `code_challenge` for `code_challenge_method=S256` — RFC 7636 §4.2. */
export function codeChallengeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/** The env flag gating PKCE — ON only when it is exactly `'1'`. */
export const PKCE_FLAG_ENV = 'MERCADO_LIVRE_PKCE_ENABLED';

/**
 * Whether to drive the connect flow with PKCE. Must match the DevCenter toggle
 * on `MERCADO_LIVRE_CLIENT_ID` — see the ⚠️ above.
 *
 * Read at call time, never at module scope, so a deploy that flips the variable
 * does not need a cold start to take effect (and so tests can stub it).
 */
export function pkceEnabled(): boolean {
  return process.env[PKCE_FLAG_ENV] === '1';
}
