/**
 * Per-filial cert resolution + the env-fallback gate.
 *
 * MOCK CERTS ONLY: the stored cert is a self-signed `buildPfxFixture`,
 * encrypted with a throwaway key. The real env cert is never read.
 * `deriveRuntimeForCert` is mocked so the resolution LOGIC is tested without
 * reading TLS chains off disk (that's runtime.ts's concern).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/runtime')>();
  return {
    ...actual,
    deriveRuntimeForCert: vi.fn((base: Record<string, unknown>, cert: unknown) => ({
      ...base,
      cert,
    })),
  };
});

import {
  NFeCertError,
  encryptSecret,
  loadCertificateFromBase64,
} from '@delfrance/integrations-nfe';
import { buildPfxFixture } from '@delfrance/integrations-nfe/test-helpers/pfx-fixture';

import {
  __resetFilialCertCacheForTests,
  resolveFilialCert,
  resolveFilialRuntime,
} from '@/lib/nfe/filial-cert';
import type { NFeRuntime } from '@/lib/nfe/runtime';

const CNPJ = '99999999000191';
const KEY = Buffer.alloc(32, 5);

function fakeFirestore(seed: Record<string, Record<string, unknown> | null> = {}) {
  const docs: Record<string, Record<string, unknown> | null> = { ...seed };
  function ref(path: string) {
    return {
      async get() {
        const d = docs[path];
        return { exists: d != null, id: path.split('/').pop()!, data: () => d };
      },
    };
  }
  return {
    fs: {
      doc: (p: string) => ref(p),
      collection: (p: string) => ({ doc: (id: string) => ref(`${p}/${id}`) }),
    } as never,
  };
}

function fakeBaseRuntime(): NFeRuntime {
  return {
    cert: { cnpj: 'ENV-CERT' } as never,
    agent: {} as never,
    ambiente: 'homologacao',
    uf: 'SP',
    tpAmb: '2',
    endpoints: {} as never,
    svc: (() => ({ endpoints: {}, agent: {} })) as never,
    an: (() => ({ endpoints: {}, agent: {} })) as never,
    diagnostics: { subjectCommonName: 'ENV', notAfter: '2027-01-01', chainSource: 'x' },
  };
}

/** A secret doc built from a mock cert, encrypted with KEY. */
function seedSecret(): Record<string, unknown> {
  const original = loadCertificateFromBase64(
    buildPfxFixture({ password: 'pw', commonName: `ACME:${CNPJ}` }),
    'pw',
  );
  return {
    encPrivateKey: encryptSecret(original.privateKeyPem, KEY),
    certificatePem: original.certificatePem,
    certificateDerBase64: original.certificateDerBase64,
    subjectCommonName: original.subjectCommonName,
    cnpj: original.cnpj,
    notAfter: original.notAfter.toISOString(),
    algoritmo: 'aes-256-gcm',
    keyVersion: 1,
    uploadedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  process.env.NFE_CERT_ENC_KEY = KEY.toString('base64');
  // This suite owns the fallback flag per-test (the "off" cases depend on it
  // being unset) — clear any value leaked from another file in this worker.
  delete process.env.NFE_CERT_ENV_FALLBACK;
  __resetFilialCertCacheForTests();
});

afterEach(() => {
  delete process.env.NFE_CERT_ENC_KEY;
  delete process.env.NFE_CERT_ENV_FALLBACK;
  vi.clearAllMocks();
  __resetFilialCertCacheForTests();
});

describe('resolveFilialCert', () => {
  it('decrypts + rebuilds the stored cert', async () => {
    const { fs } = fakeFirestore({ 'filiais/F-1/certificadoSecreto/default': seedSecret() });
    const cert = await resolveFilialCert(fs, 'F-1');
    expect(cert?.cnpj).toBe(CNPJ);
  });

  it('returns null when the filial has no stored cert', async () => {
    const { fs } = fakeFirestore({});
    expect(await resolveFilialCert(fs, 'F-1')).toBeNull();
  });
});

describe('resolveFilialRuntime', () => {
  it('derives a runtime bound to the stored cert', async () => {
    const { fs } = fakeFirestore({ 'filiais/F-1/certificadoSecreto/default': seedSecret() });
    const rt = await resolveFilialRuntime(fs, fakeBaseRuntime(), 'F-1');
    expect(rt.cert.cnpj).toBe(CNPJ);
  });

  it('throws NFeCertError when there is no stored cert and fallback is off', async () => {
    const { fs } = fakeFirestore({});
    await expect(resolveFilialRuntime(fs, fakeBaseRuntime(), 'F-1')).rejects.toBeInstanceOf(
      NFeCertError,
    );
  });

  it('falls back to the base (env) runtime when NFE_CERT_ENV_FALLBACK=1', async () => {
    process.env.NFE_CERT_ENV_FALLBACK = '1';
    const { fs } = fakeFirestore({});
    const base = fakeBaseRuntime();
    expect(await resolveFilialRuntime(fs, base, 'F-1')).toBe(base);
  });
});
