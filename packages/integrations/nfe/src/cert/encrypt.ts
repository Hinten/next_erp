/**
 * AES-256-GCM symmetric encryption for the per-filial A1 private key at rest.
 *
 * **Server-only** (pulls `node:crypto`). The master key is supplied by the
 * caller (`getCertEncryptionKey()` reads it from `NFE_CERT_ENC_KEY`); these
 * functions are pure — key + plaintext in, ciphertext out — so they are
 * trivial to unit-test with a throwaway key and never touch `process.env`.
 *
 * Only the **private key** is encrypted: the public cert + identity metadata
 * are public information (they ship in every NF-e). GCM gives us
 * authenticated encryption — `decryptSecret` throws if the ciphertext, IV, or
 * auth tag was tampered with, or if the wrong key is used.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGO = 'aes-256-gcm';
/** 96-bit IV is the GCM-recommended size; a fresh random IV per encryption. */
const IV_BYTES = 12;

/** One AES-256-GCM ciphertext bundle — all parts base64. */
export interface EncryptedBlob {
  readonly iv: string;
  readonly authTag: string;
  readonly ciphertext: string;
}

/**
 * Encrypt a UTF-8 string with a 32-byte key. Returns a fresh-IV bundle; the
 * same plaintext encrypts to different ciphertext each call (IV randomness).
 */
export function encryptSecret(plaintext: string, key: Buffer): EncryptedBlob {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

/**
 * Decrypt a bundle produced by {@link encryptSecret} with the same key.
 * Throws (Node's `ERR_OSSL_*` / auth-tag failure) on a wrong key or any
 * tampering — callers treat that as a hard failure, never a silent null.
 */
export function decryptSecret(blob: EncryptedBlob, key: Buffer): string {
  const iv = Buffer.from(blob.iv, 'base64');
  const authTag = Buffer.from(blob.authTag, 'base64');
  const ciphertext = Buffer.from(blob.ciphertext, 'base64');
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
