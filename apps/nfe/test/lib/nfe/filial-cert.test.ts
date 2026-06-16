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
  resolveFilialRuntimeByCnpj,
} from '@/lib/nfe/filial-cert';
import { deriveRuntimeForCert } from '@/lib/nfe/runtime';
import type { NFeBaseRuntime, NFeRuntime } from '@/lib/nfe/runtime';

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
  // Minimal `collection(p).where(f,op,v).limit(n).get()` over the seed: matches
  // only DIRECT children of `p` (one path segment past `${p}/`) by equality.
  function collection(p: string) {
    return {
      doc: (id: string) => ref(`${p}/${id}`),
      where(field: string, _op: string, value: unknown) {
        return {
          limit(n: number) {
            return {
              async get() {
                const matched = Object.entries(docs)
                  .filter(([path, d]) => {
                    if (d == null || !path.startsWith(`${p}/`)) return false;
                    if (path.slice(p.length + 1).includes('/')) return false;
                    return d[field] === value;
                  })
                  .slice(0, n)
                  .map(([path, d]) => ({ id: path.split('/').pop()!, data: () => d }));
                return { docs: matched, empty: matched.length === 0 };
              },
            };
          },
        };
      },
    };
  }
  return {
    fs: {
      doc: (p: string) => ref(p),
      collection,
    } as never,
  };
}

/** The lazy env-cert runtime a base resolves to on the fallback path. */
function fakeEnvRuntime(): NFeRuntime {
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

/**
 * Cert-free base runtime — boots with NO signing cert. `envRuntime` returns a
 * stable env runtime (the fallback path) unless overridden to `null` (full
 * cutover). `deriveRuntimeForCert` (mocked) spreads this base, so it carries the
 * fields the spread reads.
 */
function fakeBaseRuntime(envRuntime: () => NFeRuntime | null = fakeEnvRuntime): NFeBaseRuntime {
  const env = envRuntime();
  return {
    ambiente: 'homologacao',
    uf: 'SP',
    tpAmb: '2',
    endpoints: {} as never,
    envRuntime: () => env,
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
    notAfter: original.notAfter.getTime(),
    algoritmo: 'aes-256-gcm',
    keyVersion: 1,
    uploadedAt: Date.now(),
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

  it('caches the derived runtime per filial — reuses it (one derive, agent kept alive)', async () => {
    const { fs } = fakeFirestore({ 'filiais/F-1/certificadoSecreto/default': seedSecret() });
    const base = fakeBaseRuntime();
    const rt1 = await resolveFilialRuntime(fs, base, 'F-1');
    const rt2 = await resolveFilialRuntime(fs, base, 'F-1');
    expect(rt2).toBe(rt1); // same cached runtime → same keep-alive https.Agent
    expect(vi.mocked(deriveRuntimeForCert)).toHaveBeenCalledTimes(1);
  });

  it('throws NFeCertError when there is no stored cert and fallback is off', async () => {
    const { fs } = fakeFirestore({});
    await expect(resolveFilialRuntime(fs, fakeBaseRuntime(), 'F-1')).rejects.toBeInstanceOf(
      NFeCertError,
    );
  });

  it('falls back to the env runtime (base.envRuntime()) when NFE_CERT_ENV_FALLBACK=1', async () => {
    process.env.NFE_CERT_ENV_FALLBACK = '1';
    const { fs } = fakeFirestore({});
    const base = fakeBaseRuntime();
    expect(await resolveFilialRuntime(fs, base, 'F-1')).toBe(base.envRuntime());
  });

  it('still throws when fallback is on but there is no env cert (full cutover)', async () => {
    process.env.NFE_CERT_ENV_FALLBACK = '1';
    const { fs } = fakeFirestore({});
    // base.envRuntime() === null → the fallback has nothing to return.
    const base = fakeBaseRuntime(() => null);
    await expect(resolveFilialRuntime(fs, base, 'F-1')).rejects.toBeInstanceOf(NFeCertError);
  });
});

describe('resolveFilialRuntimeByCnpj', () => {
  it('finds the filial by CNPJ then derives its stored-cert runtime', async () => {
    const { fs } = fakeFirestore({
      'filiais/F-1': { cnpj: CNPJ },
      'filiais/F-1/certificadoSecreto/default': seedSecret(),
    });
    const rt = await resolveFilialRuntimeByCnpj(fs, fakeBaseRuntime(), CNPJ);
    expect(rt.cert.cnpj).toBe(CNPJ);
  });

  it('throws NFeCertError when no filial carries the CNPJ', async () => {
    const { fs } = fakeFirestore({});
    await expect(resolveFilialRuntimeByCnpj(fs, fakeBaseRuntime(), CNPJ)).rejects.toBeInstanceOf(
      NFeCertError,
    );
  });
});
