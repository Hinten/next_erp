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
import { READ_CACHE_TTL } from '@delfrance/data/admin/cache';
import { CERTIFICADO_CACHE_TTL_MS } from '@delfrance/schemas';

import {
  __resetFilialCertCacheForTests,
  evictFilialCert,
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
  /** Every document `get()`, by path — what the TTL tests count. */
  const reads: string[] = [];
  function ref(path: string) {
    return {
      async get() {
        reads.push(path);
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
    docs,
    reads,
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

describe('the certificate cache is bounded by CERTIFICADO_CACHE_TTL_MS (#1680)', () => {
  const SECRET = 'filiais/F-1/certificadoSecreto/default';
  const T0 = new Date('2026-09-29T12:00:00Z').getTime();

  beforeEach(() => {
    // Only Date: the cache reads the clock per call, and nothing here sleeps.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is the 15-minute config tier the screen warns about', () => {
    expect(CERTIFICADO_CACHE_TTL_MS).toBe(15 * 60_000);
    expect(CERTIFICADO_CACHE_TTL_MS).toBe(READ_CACHE_TTL.config);
  });

  it('a removal made on ANOTHER instance stops this one at the TTL — not before, not never', async () => {
    const { fs, docs, reads } = fakeFirestore({ [SECRET]: seedSecret() });
    const base = fakeBaseRuntime();
    await resolveFilialRuntime(fs, base, 'F-1');

    // Another instance removes it: this one never hears about it.
    docs[SECRET] = null;

    vi.setSystemTime(T0 + CERTIFICADO_CACHE_TTL_MS - 1);
    // Near-miss: one millisecond short, the cached certificate still signs.
    expect((await resolveFilialRuntime(fs, base, 'F-1')).cert.cnpj).toBe(CNPJ);
    expect(reads).toEqual([SECRET]);

    vi.setSystemTime(T0 + CERTIFICADO_CACHE_TTL_MS);
    await expect(resolveFilialRuntime(fs, base, 'F-1')).rejects.toBeInstanceOf(NFeCertError);
    expect(reads).toEqual([SECRET, SECRET]);
  });

  it('a replacement made on another instance is picked up at the TTL', async () => {
    const { fs, docs } = fakeFirestore({ [SECRET]: seedSecret() });
    const base = fakeBaseRuntime();
    const antigo = await resolveFilialRuntime(fs, base, 'F-1');

    const novo = seedSecret(); // a fresh key pair → a different certificate
    docs[SECRET] = novo;
    vi.setSystemTime(T0 + CERTIFICADO_CACHE_TTL_MS);

    const rt = await resolveFilialRuntime(fs, base, 'F-1');
    expect(rt).not.toBe(antigo);
    expect(rt.cert.certificatePem).toBe(novo.certificatePem);
    expect(vi.mocked(deriveRuntimeForCert)).toHaveBeenCalledTimes(2);
  });

  it('an unchanged certificate costs one re-read per TTL — no decrypt, same runtime and agent', async () => {
    const { fs, reads } = fakeFirestore({ [SECRET]: seedSecret() });
    const base = fakeBaseRuntime();
    const rt1 = await resolveFilialRuntime(fs, base, 'F-1');

    vi.setSystemTime(T0 + CERTIFICADO_CACHE_TTL_MS);
    const rt2 = await resolveFilialRuntime(fs, base, 'F-1');

    expect(reads).toHaveLength(2); // the re-read happened…
    expect(rt2).toBe(rt1); // …and found the same certificate: keep the keep-alive agent
    expect(vi.mocked(deriveRuntimeForCert)).toHaveBeenCalledTimes(1);
  });

  it('absence is never cached — an upload reaches an instance that had none at once', async () => {
    const { fs, docs } = fakeFirestore({});
    const base = fakeBaseRuntime();
    await expect(resolveFilialRuntime(fs, base, 'F-1')).rejects.toBeInstanceOf(NFeCertError);

    docs[SECRET] = seedSecret(); // uploaded through another instance, a moment later
    expect((await resolveFilialRuntime(fs, base, 'F-1')).cert.cnpj).toBe(CNPJ);
  });

  it('the instance that served the upload or removal switches at once (evictFilialCert)', async () => {
    const { fs, docs, reads } = fakeFirestore({ [SECRET]: seedSecret() });
    const base = fakeBaseRuntime();
    await resolveFilialRuntime(fs, base, 'F-1');

    docs[SECRET] = null;
    evictFilialCert('F-1');
    await expect(resolveFilialRuntime(fs, base, 'F-1')).rejects.toBeInstanceOf(NFeCertError);
    expect(reads).toHaveLength(2); // no TTL wait
  });
});
