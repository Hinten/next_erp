/**
 * PKCE (RFC 7636) helpers, shared by every channel whose provider supports it
 * (#821, #1034).
 *
 * PKCE is what makes a stolen `code` useless: the consent URL carries
 * `code_challenge = SHA-256(code_verifier)`, and the token exchange must present
 * the matching `code_verifier`, which never leaves our backend. It COMPLEMENTS
 * the single-use `state` record rather than replacing it — the state binds the
 * callback to an account, PKCE binds it to the attempt that started it.
 *
 * ⚠️ Both providers that support this enable it **per registered application**,
 * from their dashboard, and both are explicit that once the toggle is on the
 * parameters stop being optional:
 *  - Mercado Livre — *"ao ser ativada esta opção, o envio do campo se torna
 *    obrigatório"*;
 *  - Mercado Pago — *"With the field enabled, Mercado Pago will require the
 *    `code_challenge` and `code_method` fields in OAuth requests."*
 *
 * So each channel keeps its OWN `*_PKCE_ENABLED` flag next to its client id, and
 * the flag and the provider toggle must be flipped together: code without the
 * toggle sends parameters the provider ignores; the toggle without the code
 * breaks every connect. The flag stays per-app deliberately — there is no shared
 * "PKCE is on" state, because it is a property of a registered application.
 *
 * ℹ️ Melhor Envio documents no PKCE support at all (its authorization reference
 * lists only `client_id`, `redirect_uri`, `response_type`, `scope`, `state`), so
 * that channel stores a `null` verifier and never calls these.
 */
import { createHash, randomBytes } from 'node:crypto';

/** The `code_challenge_method` values RFC 7636 defines; both providers accept either. */
export type CodeChallengeMethod = 'S256' | 'plain';

/**
 * Mint a `code_verifier`. 32 random bytes render as 43 base64url characters — the
 * low end of RFC 7636 §4.1's 43..128 range, and base64url is a subset of the
 * unreserved set the RFC allows, so no escaping is ever needed.
 */
export function createCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** `code_challenge` for `code_challenge_method=S256` — RFC 7636 §4.2. */
export function codeChallengeS256(codeVerifier: string): string {
  return createHash('sha256').update(codeVerifier).digest('base64url');
}

/**
 * Whether a channel's PKCE flag is on. ON only when the value is exactly `'1'`,
 * matching the repo's `*_ENABLED` convention.
 *
 * Takes the env var NAME rather than reading a fixed one, so each channel keeps
 * its own flag while sharing this parsing. Read at call time, never at module
 * scope, so a deploy that flips the variable does not need a cold start to take
 * effect (and so tests can stub it).
 */
export function pkceEnabledFor(envVar: string): boolean {
  return process.env[envVar] === '1';
}
