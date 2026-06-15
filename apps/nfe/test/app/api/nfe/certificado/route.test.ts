/**
 * Route tests for POST/DELETE /api/nfe/certificado — the per-filial A1 upload.
 *
 * MOCK CERTS ONLY: every cert is a self-signed `buildPfxFixture`; the real env
 * cert (`NFE_CERT_*`) is never read. A throwaway `NFE_CERT_ENC_KEY` is set
 * here. Asserts the security contract — the encrypted key is written, the
 * response carries NO key material, and bad input (wrong password / CNPJ
 * mismatch / expired) is rejected with 422.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/nfe/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/nfe/auth')>();
  return { ...actual, verifyCaller: vi.fn() };
});
vi.mock('@/lib/firebase/admin', () => ({ getAdminFirestore: vi.fn() }));

import { verifyCaller } from '@/lib/nfe/auth';
import { getAdminFirestore } from '@/lib/firebase/admin';
import { buildPfxFixture } from '@delfrance/integrations-nfe/test-helpers/pfx-fixture';

import { POST, DELETE } from '../../../../../app/api/nfe/certificado/route';

const CNPJ = '99999999000191';

/** Minimal in-memory Firestore — `collection(p).doc(id)` + get/set/delete. */
function fakeFirestore(seed: Record<string, Record<string, unknown> | null> = {}) {
  const docs: Record<string, Record<string, unknown> | null> = { ...seed };
  const writes: { path: string; merge?: boolean }[] = [];
  const deletes: string[] = [];
  function ref(path: string) {
    return {
      async get() {
        const d = docs[path];
        return { exists: d != null, id: path.split('/').pop()!, data: () => d };
      },
      async set(data: Record<string, unknown>, opt?: { merge?: boolean }) {
        writes.push({ path, merge: opt?.merge });
        docs[path] = opt?.merge ? { ...(docs[path] ?? {}), ...data } : data;
      },
      async delete() {
        deletes.push(path);
        docs[path] = null;
      },
    };
  }
  return {
    fs: {
      doc: (p: string) => ref(p),
      collection: (p: string) => ({ doc: (id: string) => ref(`${p}/${id}`) }),
    } as never,
    docs,
    writes,
    deletes,
  };
}

function postReq(body: unknown): Request {
  return new Request('http://localhost/api/nfe/certificado', {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.mocked(verifyCaller).mockResolvedValue({
    caller: { uid: 'u-1', permissions: '0xff' },
  } as never);
  // Throwaway master key — NOT the real env cert; only the encryption key.
  process.env.NFE_CERT_ENC_KEY = Buffer.alloc(32, 5).toString('base64');
});

afterEach(() => {
  vi.clearAllMocks();
  delete process.env.NFE_CERT_ENC_KEY;
});

describe('POST /api/nfe/certificado', () => {
  it('stores the encrypted key + filial metadata and returns NO key material', async () => {
    const { fs, docs, writes } = fakeFirestore({
      'filiais/F-1': { cnpj: CNPJ, razaoSocial: 'ACME' },
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const pfxBase64 = buildPfxFixture({ password: 'pw', commonName: `ACME LTDA:${CNPJ}` });

    const res = await POST(
      postReq({ filialId: 'F-1', pfxBase64, password: 'pw', filename: 'cert.pfx' }),
    );
    expect(res.status).toBe(200);

    const body = (await res.json()) as Record<string, unknown>;
    expect(body.cnpj).toBe(CNPJ);
    expect(body.filename).toBe('cert.pfx');
    // The response is public metadata only — never key material.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('encPrivateKey');
    expect(raw).not.toContain('ciphertext');

    // The secret doc holds an ENCRYPTED key, not the raw PEM.
    const secret = docs['filiais/F-1/certificadoSecreto/default'];
    expect(secret).toBeTruthy();
    expect(secret?.encPrivateKey).toBeTruthy();
    expect(JSON.stringify(secret?.encPrivateKey)).not.toContain('PRIVATE KEY');
    expect(String(secret?.certificatePem)).toContain('BEGIN CERTIFICATE');

    // Filial metadata merged onto the filial doc (not a full overwrite).
    expect(writes.some((w) => w.path === 'filiais/F-1' && w.merge === true)).toBe(true);
  });

  it('rejects a wrong password with 422', async () => {
    const { fs } = fakeFirestore({ 'filiais/F-1': { cnpj: CNPJ } });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const pfxBase64 = buildPfxFixture({ password: 'right', commonName: `ACME:${CNPJ}` });
    const res = await POST(
      postReq({ filialId: 'F-1', pfxBase64, password: 'wrong', filename: 'c.pfx' }),
    );
    expect(res.status).toBe(422);
  });

  it('rejects a CNPJ mismatch with 422 (rejection 213 guard)', async () => {
    const { fs, docs } = fakeFirestore({ 'filiais/F-1': { cnpj: '11111111000191' } });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const pfxBase64 = buildPfxFixture({ password: 'pw', commonName: `ACME:${CNPJ}` });
    const res = await POST(
      postReq({ filialId: 'F-1', pfxBase64, password: 'pw', filename: 'c.pfx' }),
    );
    expect(res.status).toBe(422);
    // Nothing persisted on a mismatch.
    expect(docs['filiais/F-1/certificadoSecreto/default']).toBeUndefined();
  });

  it('rejects an expired cert with 422', async () => {
    const { fs } = fakeFirestore({ 'filiais/F-1': { cnpj: CNPJ } });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const pfxBase64 = buildPfxFixture({
      password: 'pw',
      commonName: `ACME:${CNPJ}`,
      notAfter: new Date(Date.now() - 86_400_000),
    });
    const res = await POST(
      postReq({ filialId: 'F-1', pfxBase64, password: 'pw', filename: 'c.pfx' }),
    );
    expect(res.status).toBe(422);
  });

  it('404 when the filial does not exist', async () => {
    const { fs } = fakeFirestore({});
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const pfxBase64 = buildPfxFixture({ password: 'pw', commonName: `ACME:${CNPJ}` });
    const res = await POST(
      postReq({ filialId: 'MISSING', pfxBase64, password: 'pw', filename: 'c.pfx' }),
    );
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/nfe/certificado', () => {
  it('removes the secret doc and clears the filial metadata', async () => {
    const { fs, docs, deletes } = fakeFirestore({
      'filiais/F-1': { cnpj: CNPJ, certificado: { cnpj: CNPJ } },
      'filiais/F-1/certificadoSecreto/default': { encPrivateKey: {} },
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const res = await DELETE(
      new Request('http://localhost/api/nfe/certificado?filialId=F-1', {
        method: 'DELETE',
        headers: { authorization: 'Bearer t' },
      }),
    );
    expect(res.status).toBe(200);
    expect(deletes).toContain('filiais/F-1/certificadoSecreto/default');
    expect((docs['filiais/F-1'] as { certificado?: unknown }).certificado).toBeNull();
  });
});
