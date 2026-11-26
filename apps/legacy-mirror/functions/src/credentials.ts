/**
 * What the mirror does with CREDENTIALS found in the legacy data.
 *
 * The legacy corpus stores live provider credentials in plain documents. Some of
 * them are single-use refresh tokens: Mercado Livre's `tokenDuravel` and Melhor
 * Envio's `tokenMelEnv` rotate on every refresh. So one refresh made from a COPY
 * invalidates the token the legacy app is still using, and production loses that
 * channel. A copy in a test project must therefore never hold them, and the
 * deployed code there must not find them (ADR 0013, amendment 2026-11-26).
 *
 * The real migration needs the opposite: the new project has no functions until
 * the switch, so nothing there can refresh, and the tokens must arrive CURRENT,
 * because a T0 copy of a rotating refresh token is already dead by cutover day.
 * Hence a policy with no default — each deploy has to say which run it is.
 *
 * Pure and total: no I/O. Shared with the throwaway scrub script in
 * tools/migrations, so the mirror and the scrub cannot disagree about what a
 * credential is.
 */

export type CredentialPolicy = 'deny' | 'copy';

export class InvalidCredentialPolicyError extends Error {
  constructor(raw: string) {
    super(
      `legacy-mirror: LEGACY_MIRROR_CREDENTIALS must be 'deny' (test project) or ` +
        `'copy' (the real migration), got ${JSON.stringify(raw)}.`,
    );
    this.name = 'InvalidCredentialPolicyError';
  }
}

export function parseCredentialPolicy(raw: string): CredentialPolicy {
  const value = raw.trim();
  if (value === 'deny' || value === 'copy') return value;
  throw new InvalidCredentialPolicyError(raw);
}

/**
 * Legacy subcollections that hold credentials, keyed by their parent collection.
 * Read from `.old/firestore.rules` and the new schemas' credential stores. The
 * new-shape names (`credenciais*`, `certificadoSecreto`) are listed too, so a
 * test project never receives one even if legacy gains it.
 */
export const CREDENTIAL_SUBCOLLECTIONS: Readonly<Record<string, readonly string[]>> = {
  integracao: [
    'tokenDuravel',
    'token6h',
    'token',
    'tokenoaut',
    'tokenMagalu',
    'actokshopee',
    'credenciais',
    'credenciaisLojaIntegrada',
    'credenciaisWhatsapp',
  ],
  integracoes: ['token'],
  int_frete: ['tokenMelEnv'],
  metodo_pgto: ['token6hmp', 'tokenDuravelmp', 'credenciais'],
  filiais: ['certificados', 'certificadoSecreto'],
};

/**
 * Fields holding credentials on documents that are otherwise ordinary data, keyed
 * by the collection of those documents. Legacy WhatsApp kept its permanent token
 * and PIN on the `integracao/{id}` document itself.
 */
export const CREDENTIAL_FIELDS: Readonly<Record<string, readonly string[]>> = {
  integracao: ['permanent_token', 'pin'],
};

/** Every distinct credential subcollection id, for a collection-group walk. */
export function credentialCollectionIds(): string[] {
  return [...new Set(Object.values(CREDENTIAL_SUBCOLLECTIONS).flat())].sort();
}

/**
 * True for a document inside a credential subcollection, at any depth below it
 * (`integracao/a/tokenDuravel/b`, `integracao/a/tokenDuravel/b/x/y`). A
 * subcollection id only counts under ITS parent: `pedidos/p/token/t` is not a
 * credential, and neither is the parent document `integracao/a` itself.
 */
export function isCredentialPath(path: string): boolean {
  const segments = path.split('/');
  for (let i = 0; i + 2 < segments.length; i += 2) {
    const denied = CREDENTIAL_SUBCOLLECTIONS[segments[i]!];
    if (denied?.includes(segments[i + 2]!)) return true;
  }
  return false;
}

/** The credential fields present on the document at `path` (top level only). */
export function credentialFieldsOf(path: string, data: Record<string, unknown>): string[] {
  const segments = path.split('/');
  if (segments.length !== 2) return [];
  const fields = CREDENTIAL_FIELDS[segments[0]!] ?? [];
  return fields.filter((f) => Object.prototype.hasOwnProperty.call(data, f));
}

/** A copy of `data` without its credential fields. Never mutates the input. */
export function withoutCredentialFields(
  path: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  const drop = credentialFieldsOf(path, data);
  if (drop.length === 0) return data;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!drop.includes(k)) out[k] = v;
  return out;
}
