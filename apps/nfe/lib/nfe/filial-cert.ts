/**
 * Per-filial A1 certificate resolution.
 *
 * SEFAZ enforces "signing-cert CNPJ = emitente CNPJ", so each filial signs
 * with its own A1. At emission time we read the filial's encrypted secret doc
 * (`filiais/{filialId}/certificadoSecreto/default`), decrypt the private key
 * with the env master key (`NFE_CERT_ENC_KEY`), rebuild the `NFeCertificate`,
 * and derive a runtime bound to it (`deriveRuntimeForCert`).
 *
 * When a filial has no stored cert, `NFE_CERT_ENV_FALLBACK` decides:
 *   - on  → use the env cert (the base runtime as loaded) — for the live
 *           homologação suites, which run against a fixture filial.
 *   - off → throw (production default — every filial must upload its cert).
 *
 * The decrypted cert is cached per filialId for the process lifetime; rotating
 * a filial's cert requires an apps/nfe restart (same model as the env-cert
 * singleton + svc chain cache). The upload route evicts its own filialId entry
 * so an in-process re-upload is picked up immediately.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { certificadoSecretoCollection, filialCollection } from '@delfrance/data/admin/collections';
import { CERTIFICADO_SECRETO_DOC_ID } from '@delfrance/schemas';
import {
  NFeCertError,
  assertCertNotExpired,
  buildCertFromStored,
  decryptSecret,
  getCertEncryptionKey,
  type NFeCertificate,
} from '@delfrance/integrations-nfe';

import { deriveRuntimeForCert, type NFeBaseRuntime, type NFeRuntime } from './runtime';

/** True when the env opts into env-cert fallback for filiais without a stored cert. */
function envFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.NFE_CERT_ENV_FALLBACK;
  return v === '1' || v?.toLowerCase() === 'true';
}

/** Decrypted cert cache, keyed by filialId. Cleared on restart / explicit evict. */
const certCache = new Map<string, NFeCertificate>();

/**
 * Read + decrypt a filial's stored A1 cert. Returns `null` when the filial has
 * no uploaded cert. Throws `NFeCertError` when the master key is missing or
 * the ciphertext fails to authenticate (tamper / wrong key).
 */
export async function resolveFilialCert(
  fs: Firestore,
  filialId: string,
): Promise<NFeCertificate | null> {
  const hit = certCache.get(filialId);
  if (hit) return hit;

  const snap = await certificadoSecretoCollection
    .docRef(fs, { filialId }, CERTIFICADO_SECRETO_DOC_ID)
    .get();
  if (!snap.exists) return null;

  const doc = certificadoSecretoCollection.parseRead(
    snap.data(),
    certificadoSecretoCollection.docPath({ filialId }, CERTIFICADO_SECRETO_DOC_ID),
  );

  const key = getCertEncryptionKey();
  const privateKeyPem = decryptSecret(doc.encPrivateKey, key);
  const cert = buildCertFromStored({ privateKeyPem, certificatePem: doc.certificatePem });
  certCache.set(filialId, cert);
  return cert;
}

/**
 * Per-filial DERIVED runtime cache (cert + the mTLS `https.Agent`s). The SOAP
 * layer relies on reusing ONE keep-alive agent per cert, so we cache the whole
 * derived runtime — not just the cert — to avoid a fresh TLS handshake + socket
 * churn on every emission. Keyed by filialId; evicted on upload/delete.
 */
const runtimeCache = new Map<string, NFeRuntime>();

/**
 * Resolve the runtime that emits for `filialId`: the filial's stored cert when
 * present (expiry-checked), else the env cert when `NFE_CERT_ENV_FALLBACK` is
 * on, else throw. The orchestrator consumes the returned runtime unchanged.
 */
export async function resolveFilialRuntime(
  fs: Firestore,
  base: NFeBaseRuntime,
  filialId: string,
): Promise<NFeRuntime> {
  // Fast path: reuse the derived runtime (and its keep-alive agent). Re-check
  // expiry every call so a long-running process can't keep signing with a cert
  // that expired after it was cached.
  const cachedRt = runtimeCache.get(filialId);
  if (cachedRt) {
    assertCertNotExpired(cachedRt.cert);
    return cachedRt;
  }

  const stored = await resolveFilialCert(fs, filialId);
  if (stored) {
    assertCertNotExpired(stored);
    const rt = deriveRuntimeForCert(base, stored);
    runtimeCache.set(filialId, rt);
    return rt;
  }
  if (envFallbackEnabled()) {
    // Fall back to the env cert (homologação suites / single-cert dev). With a
    // full cutover (no env cert) this is null → fall through to the throw.
    const envRt = base.envRuntime();
    if (envRt) return envRt;
  }
  throw new NFeCertError(
    `Filial '${filialId}' não possui certificado digital cadastrado. ` +
      'Faça o upload do certificado A1 na aba "Certificado Digital" da filial.',
  );
}

/**
 * Resolve the runtime for a filial identified by **CNPJ** (14 digits) — used by
 * the by-chave consulta, which has no filialId but carries the emit CNPJ in the
 * chave (positions 6–20). Single-field equality query → Firestore auto-index.
 */
export async function resolveFilialRuntimeByCnpj(
  fs: Firestore,
  base: NFeBaseRuntime,
  cnpj: string,
): Promise<NFeRuntime> {
  const snap = await filialCollection.ref(fs, {}).where('cnpj', '==', cnpj).limit(1).get();
  const doc = snap.docs[0];
  if (!doc) {
    throw new NFeCertError(
      `Nenhuma filial cadastrada com o CNPJ ${cnpj} (extraído da chave) — ` +
        'não é possível resolver o certificado para a consulta.',
    );
  }
  return resolveFilialRuntime(fs, base, doc.id);
}

/** Evict a filial's cached cert + derived runtime (call after an upload / delete). */
export function evictFilialCert(filialId: string): void {
  certCache.delete(filialId);
  runtimeCache.delete(filialId);
}

/** Test-only: clear the per-filial cert + runtime caches so each test sees a fresh state. */
export function __resetFilialCertCacheForTests(): void {
  certCache.clear();
  runtimeCache.clear();
}
