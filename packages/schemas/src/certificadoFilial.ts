import { z } from 'zod';
import type { CollectionMetadata } from './types';

/**
 * Per-filial A1 certificate storage.
 *
 * SEFAZ enforces "signing-cert CNPJ = emitente CNPJ" (rejection 213), so each
 * filial (CNPJ) must sign its NF-e with its own ICP-Brasil A1 cert. The cert
 * is uploaded on the filial screen and split into two documents:
 *
 *   - **Public metadata** (`certificadoFilialInfoSchema`) — embedded on the
 *     filial doc as `filial.certificado`. Holder CN, CNPJ, validade, filename.
 *     All of this is public information (it ships in every NF-e), so it is
 *     client-readable and drives the UI status badge with no decryption.
 *   - **Secret material** (`certificadoSecretoSchema`) — an admin-only
 *     subcollection doc holding the AES-256-GCM-encrypted private key plus the
 *     public cert PEM the emissor needs. The Admin SDK (apps/nfe) reads this
 *     ONE doc to reconstruct the signing cert; clients are denied access by the
 *     generated Firestore rules (the encrypted key never reaches a browser).
 *
 * The user's PFX password is used only transiently at upload to decrypt the
 * PFX; it is never stored. The master encryption key lives in the apps/nfe
 * env (`NFE_CERT_ENC_KEY`).
 */

/** Public, client-readable cert metadata embedded on the filial doc. */
export const certificadoFilialInfoSchema = z.object({
  /** Subject CN as written on the cert (`<COMPANY NAME>:<CNPJ>`). */
  subjectCommonName: z.string().min(1).describe('Titular do certificado'),
  /** CNPJ extracted from the cert CN — must match the filial's CNPJ. */
  cnpj: z.string().min(1).describe('CNPJ do certificado'),
  /**
   * Certificate `notAfter` as **ms since epoch** (Dart/Flutter date convention,
   * SDK-agnostic) — drives the expiry badge. UI converts via `new Date(value)`.
   */
  notAfter: z.number().int().describe('Validade'),
  /** Original uploaded filename (.pfx/.p12), for operator recognition. */
  filename: z.string().min(1).describe('Arquivo'),
  /** Upload time as **ms since epoch**. UI converts via `new Date(value)`. */
  uploadedAt: z.number().int().describe('Enviado em'),
});

export type CertificadoFilialInfo = z.infer<typeof certificadoFilialInfoSchema>;

/**
 * One AES-256-GCM ciphertext bundle. All three parts are base64 strings.
 * `authTag` is the GCM authentication tag — decryption fails (tamper /
 * wrong key) if it doesn't verify.
 */
export const encryptedBlobSchema = z.object({
  iv: z.string().min(1),
  authTag: z.string().min(1),
  ciphertext: z.string().min(1),
});

export type EncryptedBlob = z.infer<typeof encryptedBlobSchema>;

/**
 * Admin-only secret doc at `filiais/{filialId}/certificadoSecreto/default`.
 * The private key is encrypted; the public cert PEM + derived identity fields
 * are stored plaintext (they are public) so the emissor reconstructs the
 * `NFeCertificate` from this single read.
 */
export const certificadoSecretoSchema = z.object({
  /** AES-256-GCM-encrypted PKCS#1 private key PEM. */
  encPrivateKey: encryptedBlobSchema,
  /** PEM-encoded X.509 public certificate (embedded in `<X509Certificate>`). */
  certificatePem: z.string().min(1),
  /** Base-64 of the X.509 DER. */
  certificateDerBase64: z.string().min(1),
  /** Subject CN (`<COMPANY NAME>:<CNPJ>`). */
  subjectCommonName: z.string().min(1),
  /** CNPJ extracted from the cert CN. */
  cnpj: z.string().min(1),
  /** Certificate `notAfter` as ms since epoch (metadata; emissor re-derives it from the PEM). */
  notAfter: z.number().int(),
  /** Encryption algorithm tag — pinned so a future migration can branch. */
  algoritmo: z.literal('aes-256-gcm'),
  /** Master-key version that encrypted this doc (for future key rotation). */
  keyVersion: z.number().int().min(1),
  /** Upload timestamp as ms since epoch. */
  uploadedAt: z.number().int(),
});

export type CertificadoSecreto = z.infer<typeof certificadoSecretoSchema>;

/** Subcollection path + fixed doc id (one cert per filial). */
export const CERTIFICADO_SECRETO_PATH = 'filiais/{filialId}/certificadoSecreto';
export const CERTIFICADO_SECRETO_DOC_ID = 'default';

/**
 * Collection metadata for the secret subcollection. **Admin-only.** The
 * Admin SDK bypasses Firestore rules; clients must be denied. The generated
 * ruleset (rules-gen) denies client read/write here — the encrypted private
 * key must never be client-readable. (`firestore.rules` is the deny-all
 * placeholder until that ruleset is wired + the cert rules step lands.)
 */
export const certificadoSecretoMeta: CollectionMetadata = {
  collectionPath: CERTIFICADO_SECRETO_PATH,
  // No client domain grants these bits — placeholder values. This collection is
  // deliberately NOT registered in `ALL_DOMAINS`, so the rules generator emits
  // no match block for it and Firestore default-denies every client read/write.
  // Only the Admin SDK (apps/nfe), which bypasses rules, reaches the secret.
  permissions: {
    read: 0n,
    write: 0n,
    delete: 0n,
  },
};

// NOTE: intentionally NOT exported as a `{ schema, meta }` DomainSchema and NOT
// added to `ALL_DOMAINS` — that would make the rules generator grant clients
// access. Admin-only = default-deny (see `certificadoSecretoMeta`). The admin
// collection handle consumes `CERTIFICADO_SECRETO_PATH` + the schema directly.
