/**
 * The two identities derived from a stored Personal Token: its FINGERPRINT
 * (diagnostic) and its versioned REF (the park's guard input).
 *
 * They live in the app, not in `@delfrance/integrations-loja-integrada`: the
 * package treats `ref` as an opaque label and stays free of `node:` imports, and
 * `apps/web` never needs either.
 *
 * ⚠️ Both are derived from `personalToken` — NEVER read back from the stored
 * `tokenFingerprint` field. That field is for logs and support only; a
 * hand-edited fingerprint therefore cannot disable parking, nor make a
 * wrong-store check pass.
 */
import { sha256Hex } from '@delfrance/data/admin';
import type { CredenciaisLojaIntegrada } from '@delfrance/schemas';

import { montarRef } from './refCredencial';

/**
 * The domain prefix. It makes our fingerprint uncorrelatable with a plain
 * sha256 of the same token computed anywhere else.
 *
 * ⚠️ Load-bearing: changing one character re-fingerprints every stored token
 * and every ref, so every 401 in flight would stop matching. The test vector in
 * `credencial.test.ts` is what notices.
 */
const PREFIXO_FINGERPRINT = 'loja-integrada:personal-token:';

/** 16 lowercase hex characters: a domain-prefixed sha256 prefix of the token. */
export function fingerprintDoToken(token: string): string {
  return sha256Hex(`${PREFIXO_FINGERPRINT}${token}`).slice(0, 16);
}

/**
 * The versioned ref of a stored credential: `<fingerprint>.<tokenAtualizadoEmMs>`.
 *
 * Handed to the package with the token on every request, echoed on every
 * `LiAuthError`, and compared by the park. The version suffix is the point: an
 * operator who re-saves the SAME token after a park they think is wrong gets a
 * NEW ref, so a 401 already in flight with the old one parks nothing.
 *
 * About 30 characters — within the package's `MAX_REF_CREDENCIAL` (64). The
 * format has one owner, `refCredencial.ts`, which is also what the logger reads
 * the version suffix back with.
 */
export function refDaCredencial(
  c: Pick<CredenciaisLojaIntegrada, 'personalToken' | 'tokenAtualizadoEmMs'>,
): string {
  return montarRef(fingerprintDoToken(c.personalToken), c.tokenAtualizadoEmMs);
}

/**
 * Would this token be found INSIDE its own ref? The package refuses every
 * request whose ref contains the token (`LiConfigError('ref')`), so a token that
 * short could never be used — the save route refuses it up front (422).
 */
export function tokenCabeNaRef(token: string, tokenAtualizadoEmMs: number): boolean {
  return refDaCredencial({ personalToken: token, tokenAtualizadoEmMs }).includes(token);
}
