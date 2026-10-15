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
 * Caching (#1680). Every `apps/nfe` instance — and the `nfe` Functions
 * codebase, which runs this same code — keeps what it resolved, and instances
 * do not coordinate. So the secret doc is read through a TTL-bounded
 * `createCachedDocReader` (`@delfrance/data/admin/cache`): an upload or removal
 * made through ANOTHER instance reaches this one within
 * `CERTIFICADO_CACHE_TTL_MS` (15 min), the bound the certificate screen tells
 * the operator. Until then this instance keeps signing with what it had — the
 * accepted trade for an operation a filial does about once a year. The route
 * evicts its own instance's entry, so the instance that served the upload or
 * removal switches at once.
 *
 * The decrypted cert and its derived runtime (the keep-alive mTLS agent) are
 * reused for as long as the re-read returns the SAME stored bytes (certificate
 * and encrypted key), so a TTL expiry costs one document read, never a decrypt
 * nor a fresh TLS handshake.
 */
import type { Firestore } from 'firebase-admin/firestore';

import { createCachedDocReader } from '@delfrance/data/admin/cache';
import { certificadoSecretoCollection, filialCollection } from '@delfrance/data/admin/collections';
import {
  CERTIFICADO_CACHE_TTL_MS,
  CERTIFICADO_SECRETO_DOC_ID,
  type CertificadoSecreto,
} from '@delfrance/schemas';
import {
  NFeCertError,
  assertCertNotExpired,
  buildCertFromStored,
  decryptSecret,
  type EncryptedBlob,
  getCertEncryptionKey,
  type NFeCertificate,
} from '@delfrance/integrations-nfe';

import { deriveRuntimeForCert, type NFeBaseRuntime, type NFeRuntime } from './runtime';

/** True when the env opts into env-cert fallback for filiais without a stored cert. */
function envFallbackEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env.NFE_CERT_ENV_FALLBACK;
  return v === '1' || v?.toLowerCase() === 'true';
}

/**
 * The filial's secret doc — the one read this module repeats (every emission,
 * cancelamento, CC-e and sweep unit resolves its filial's runtime). The TTL IS
 * the staleness bound above.
 *
 * `negativeTtlMs: 0`: a filial with no certificate is re-read every time, as it
 * always was, so an upload is visible to an instance that had none at once —
 * absence is never what keeps a filial from emitting.
 *
 * `now` is resolved per call: the cache would otherwise capture `Date.now` when
 * this module loads, and a test's `vi.setSystemTime` could never reach it.
 */
const secretoReader = createCachedDocReader(certificadoSecretoCollection, {
  name: 'nfe:certificado-secreto',
  ttlMs: CERTIFICADO_CACHE_TTL_MS,
  maxEntries: 256,
  negativeTtlMs: 0,
  now: () => Date.now(),
});

/**
 * The decrypted cert per filial, tagged with the stored bytes it was built
 * from — the certificate PEM AND the encrypted key blob. The PEM alone is not
 * enough: the upload route takes the PFX's first key bag and first cert bag
 * independently and never checks that they match, so a re-upload fixing a
 * mismatched export can carry the SAME certificate with a DIFFERENT key. The
 * blob gets a fresh random IV on every encryption, so any upload — even of an
 * identical PFX — is a new tag. The entry is reused until a re-read returns
 * different bytes (an upload) or none (a removal).
 */
const certCache = new Map<
  string,
  { readonly segredo: SegredoArmazenado; readonly cert: NFeCertificate }
>();

type SegredoArmazenado = Pick<CertificadoSecreto, 'certificatePem' | 'encPrivateKey'>;

function mesmoSegredo(a: SegredoArmazenado, b: SegredoArmazenado): boolean {
  return (
    a.certificatePem === b.certificatePem &&
    a.encPrivateKey.iv === b.encPrivateKey.iv &&
    a.encPrivateKey.authTag === b.encPrivateKey.authTag &&
    a.encPrivateKey.ciphertext === b.encPrivateKey.ciphertext
  );
}

/**
 * Per-filial DERIVED runtime cache (cert + the mTLS `https.Agent`s). The SOAP
 * layer relies on reusing ONE keep-alive agent per cert, so we cache the whole
 * derived runtime — not just the cert — to avoid a fresh TLS handshake + socket
 * churn on every emission. Tagged with the cert object it was derived from:
 * `resolveFilialCert` returns that same object for as long as the certificate
 * is unchanged, so identity is the whole test.
 */
const runtimeCache = new Map<string, { readonly cert: NFeCertificate; readonly rt: NFeRuntime }>();

/**
 * Read + decrypt a filial's stored A1 cert. Returns `null` when the filial has
 * no uploaded cert. Throws `NFeCertError` when the master key is missing or
 * the ciphertext fails to authenticate (tamper / wrong key).
 */
export async function resolveFilialCert(
  fs: Firestore,
  filialId: string,
): Promise<NFeCertificate | null> {
  const doc = await secretoReader.get(fs, { filialId }, CERTIFICADO_SECRETO_DOC_ID);
  if (doc == null) {
    // Removed (or never uploaded): drop what this instance held, so nothing
    // below can hand out the old certificate again.
    certCache.delete(filialId);
    runtimeCache.delete(filialId);
    return null;
  }

  const hit = certCache.get(filialId);
  if (hit && mesmoSegredo(hit.segredo, doc)) return hit.cert;

  const key = getCertEncryptionKey();
  const privateKeyPem = decifrarChavePrivada(doc.encPrivateKey, key, filialId);
  const cert = buildCertFromStored({ privateKeyPem, certificatePem: doc.certificatePem });
  certCache.set(filialId, {
    segredo: { certificatePem: doc.certificatePem, encPrivateKey: doc.encPrivateKey },
    cert,
  });
  return cert;
}

/**
 * Node's `decipher.final()` message for a GCM tag that does not verify — a
 * wrong master key, or a tampered IV / ciphertext / tag. Node gives this failure
 * no class of its own and no `code`, so its message is the only narrow handle.
 */
const GCM_NAO_AUTENTICA = 'Unsupported state or unable to authenticate data';

/**
 * Node's codes for a stored blob whose tag or IV has an impossible length — a
 * tampered or truncated blob (the schema only requires non-empty strings).
 */
const GCM_BLOB_INVALIDO: ReadonlySet<string> = new Set([
  'ERR_CRYPTO_INVALID_AUTH_TAG',
  'ERR_CRYPTO_INVALID_IV',
]);

/**
 * Decrypt a filial's stored private key, turning a blob that does not
 * authenticate into the `NFeCertError` {@link resolveFilialCert} documents —
 * the class every caller already reads as "this filial's cert is unusable": the
 * task handler returns without a queue retry, and the backstop sweep records
 * the doc and goes on to the other filiais (#1654). As Node's plain `Error` it
 * was an unknown class there, and one filial's cert (a rotated
 * `NFE_CERT_ENC_KEY` not yet re-uploaded everywhere) aborted every run.
 * Anything else is rethrown as it came (rule 6).
 */
function decifrarChavePrivada(blob: EncryptedBlob, key: Buffer, filialId: string): string {
  try {
    return decryptSecret(blob, key);
  } catch (err) {
    if (
      err instanceof Error &&
      (err.message === GCM_NAO_AUTENTICA ||
        ('code' in err && typeof err.code === 'string' && GCM_BLOB_INVALIDO.has(err.code)))
    ) {
      // The key and the blob stay out of the message (rule 9).
      throw new NFeCertError(
        `Filial '${filialId}': a chave privada do certificado armazenado não pôde ser ` +
          'decifrada (NFE_CERT_ENC_KEY trocada ou dado adulterado). ' +
          'Refaça o upload do certificado A1 na aba "Certificado Digital" da filial.',
      );
    }
    throw err;
  }
}

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
  const stored = await resolveFilialCert(fs, filialId);
  if (stored) {
    // Re-checked on every call, so a long-running process can't keep signing
    // with a cert that expired after it was cached.
    assertCertNotExpired(stored);
    const hit = runtimeCache.get(filialId);
    if (hit && hit.cert === stored) return hit.rt;
    const rt = deriveRuntimeForCert(base, stored);
    runtimeCache.set(filialId, { cert: stored, rt });
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
 * Resolve the runtime for a filial identified by **CNPJ** (14 characters) —
 * used by the by-chave consulta, which has no filialId but carries the emit
 * CNPJ in the chave (positions 6–20). Single-field equality query → Firestore
 * auto-index.
 *
 * ⚠️ Characters, not digits, and this function is why `filial.cnpj` has a
 * canonical form. Positions 6–17 of that window are the CNPJ body and may hold
 * `A-Z` (NT 2026.004), so the value sliced out of the chave is compared
 * BYTE-EXACT against the stored one by the `where('cnpj', '==')` below. A
 * stored CNPJ that differs by case or punctuation resolves no filial at all.
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

/**
 * Evict a filial's cached secret doc, cert + derived runtime (call after an
 * upload / delete). Covers THIS instance only — the others converge within
 * `CERTIFICADO_CACHE_TTL_MS`.
 */
export function evictFilialCert(filialId: string): void {
  secretoReader.invalidate({ filialId }, CERTIFICADO_SECRETO_DOC_ID);
  certCache.delete(filialId);
  runtimeCache.delete(filialId);
}

/** Test-only: clear the per-filial caches so each test sees a fresh state. */
export function __resetFilialCertCacheForTests(): void {
  // Cleared directly so this helper alone resets every cache this module owns;
  // `__resetAllReadCaches()` reaches the reader too (it re-registers on its next get).
  secretoReader.clear();
  certCache.clear();
  runtimeCache.clear();
}
