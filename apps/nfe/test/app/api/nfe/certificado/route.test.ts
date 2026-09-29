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

/**
 * Minimal in-memory Firestore — `collection(p).doc(id)` + get/set/delete, and a
 * `batch()` that applies ALL of its writes at commit or none (#1680).
 *
 * Mirrors the two Admin-SDK behaviours the route now relies on: `update()` on
 * an absent doc fails the whole batch with gRPC NOT_FOUND (5), and an
 * `update(…, { lastUpdateTime })` whose doc changed since that read fails it with
 * FAILED_PRECONDITION (9). `aoLer` runs after each `get()` — the seam a test uses
 * to play a concurrent writer between the route's read and its commit.
 */
function fakeFirestore(
  seed: Record<string, Record<string, unknown> | null> = {},
  aoLer?: (path: string, alterar: (path: string) => void) => void,
) {
  const docs: Record<string, Record<string, unknown> | null> = { ...seed };
  const versoes: Record<string, number> = {};
  let relogio = 0;
  const alterar = (path: string) => {
    relogio += 1;
    versoes[path] = relogio;
  };
  for (const path of Object.keys(docs)) alterar(path);

  const writes: { path: string; merge?: boolean }[] = [];
  const deletes: string[] = [];
  const commits: { op: 'set' | 'update' | 'delete'; path: string }[][] = [];
  const grpc = (code: number, message: string) => Object.assign(new Error(message), { code });

  function ref(path: string) {
    return {
      path,
      async get() {
        const d = docs[path];
        const snap = {
          exists: d != null,
          id: path.split('/').pop()!,
          data: () => d,
          updateTime: d != null ? { versao: versoes[path] } : undefined,
        };
        aoLer?.(path, alterar);
        return snap;
      },
      async set(data: Record<string, unknown>, opt?: { merge?: boolean }) {
        writes.push({ path, merge: opt?.merge });
        docs[path] = opt?.merge ? { ...(docs[path] ?? {}), ...data } : data;
        alterar(path);
      },
      async delete() {
        deletes.push(path);
        docs[path] = null;
        alterar(path);
      },
    };
  }

  type Op =
    | { op: 'set'; path: string; data: Record<string, unknown> }
    | {
        op: 'update';
        path: string;
        data: Record<string, unknown>;
        pre?: { lastUpdateTime?: { versao: number } };
      }
    | { op: 'delete'; path: string };

  function batch() {
    const ops: Op[] = [];
    const b = {
      set(r: { path: string }, data: Record<string, unknown>) {
        ops.push({ op: 'set', path: r.path, data });
        return b;
      },
      update(
        r: { path: string },
        data: Record<string, unknown>,
        pre?: { lastUpdateTime?: { versao: number } },
      ) {
        ops.push({ op: 'update', path: r.path, data, pre });
        return b;
      },
      delete(r: { path: string }) {
        ops.push({ op: 'delete', path: r.path });
        return b;
      },
      async commit() {
        // Validate EVERY op first: a batch lands whole or not at all.
        for (const o of ops) {
          if (o.op !== 'update') continue;
          if (docs[o.path] == null) throw grpc(5, `NOT_FOUND: ${o.path}`);
          const esperada = o.pre?.lastUpdateTime?.versao;
          if (esperada !== undefined && esperada !== versoes[o.path]) {
            throw grpc(9, `FAILED_PRECONDITION: ${o.path}`);
          }
        }
        for (const o of ops) {
          if (o.op === 'set') docs[o.path] = o.data;
          else if (o.op === 'update') docs[o.path] = { ...(docs[o.path] ?? {}), ...o.data };
          else {
            deletes.push(o.path);
            docs[o.path] = null;
          }
          alterar(o.path);
        }
        commits.push(ops.map((o) => ({ op: o.op, path: o.path })));
      },
    };
    return b;
  }

  return {
    fs: {
      doc: (p: string) => ref(p),
      collection: (p: string) => ({ doc: (id: string) => ref(`${p}/${id}`) }),
      batch,
    } as never,
    docs,
    writes,
    deletes,
    commits,
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
    const { fs, docs, commits } = fakeFirestore({
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
    // Dates are ms-epoch numbers (not ISO strings).
    expect(typeof body.notAfter).toBe('number');
    expect(typeof body.uploadedAt).toBe('number');
    expect(typeof docs['filiais/F-1/certificadoSecreto/default']?.notAfter).toBe('number');
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

    // #1680: the secret and the filial metadata land in ONE atomic commit, the
    // filial side as an update (a partial write, never a full overwrite).
    expect(commits).toEqual([
      [
        { op: 'set', path: 'filiais/F-1/certificadoSecreto/default' },
        { op: 'update', path: 'filiais/F-1' },
      ],
    ]);
    // Sibling filial fields survive.
    expect(docs['filiais/F-1']?.razaoSocial).toBe('ACME');
    expect((docs['filiais/F-1']?.certificado as { cnpj?: unknown }).cnpj).toBe(CNPJ);
  });

  it('409 FILIAL_ALTERADA when the filial changes between its read and the commit — nothing written', async () => {
    // Rule 7, tier 1: the CNPJ check was derived from the read; a concurrent edit
    // (say, of that CNPJ) must fail the batch rather than store a certificate
    // validated against a stale value.
    const { fs, docs, commits } = fakeFirestore(
      { 'filiais/F-1': { cnpj: CNPJ, razaoSocial: 'ACME' } },
      (path, alterar) => {
        if (path === 'filiais/F-1') alterar(path);
      },
    );
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const pfxBase64 = buildPfxFixture({ password: 'pw', commonName: `ACME LTDA:${CNPJ}` });

    const res = await POST(
      postReq({ filialId: 'F-1', pfxBase64, password: 'pw', filename: 'cert.pfx' }),
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { code: string }).code).toBe('FILIAL_ALTERADA');
    expect(commits).toEqual([]);
    expect(docs['filiais/F-1/certificadoSecreto/default']).toBeUndefined();
  });

  it('rejects a wrong password with 422 — pt-BR message + CERT_INVALIDO, no SEFAZ wording', async () => {
    const { fs } = fakeFirestore({ 'filiais/F-1': { cnpj: CNPJ } });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const pfxBase64 = buildPfxFixture({ password: 'right', commonName: `ACME:${CNPJ}` });
    const res = await POST(
      postReq({ filialId: 'F-1', pfxBase64, password: 'wrong', filename: 'c.pfx' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('CERT_INVALIDO');
    expect(body.error).toMatch(/senha incorreta/i);
    // The upload never contacts SEFAZ and must not leak env-var hints.
    expect(body.error).not.toMatch(/SEFAZ|NFE_CERT|Failed to open/i);
  });

  it('rejects a CNPJ mismatch with 422 — pt-BR message + CNPJ_DIVERGENTE (rejection 213 guard)', async () => {
    const { fs, docs } = fakeFirestore({ 'filiais/F-1': { cnpj: '11111111000191' } });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const pfxBase64 = buildPfxFixture({ password: 'pw', commonName: `ACME:${CNPJ}` });
    const res = await POST(
      postReq({ filialId: 'F-1', pfxBase64, password: 'pw', filename: 'c.pfx' }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('CNPJ_DIVERGENTE');
    expect(body.error).toMatch(/não corresponde/i);
    // Nothing persisted on a mismatch.
    expect(docs['filiais/F-1/certificadoSecreto/default']).toBeUndefined();
  });

  it('rejects an expired cert with 422 — pt-BR message + CERT_EXPIRADO', async () => {
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
    const body = (await res.json()) as { error: string; code: string };
    expect(body.code).toBe('CERT_EXPIRADO');
    expect(body.error).toMatch(/expirado/i);
    expect(body.error).not.toMatch(/SEFAZ|NFE_CERT/i);
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

function deleteReq(filialId: string): Request {
  return new Request(`http://localhost/api/nfe/certificado?filialId=${filialId}`, {
    method: 'DELETE',
    headers: { authorization: 'Bearer t' },
  });
}

describe('DELETE /api/nfe/certificado', () => {
  it('removes the secret doc and clears the filial metadata', async () => {
    const { fs, docs, deletes, commits } = fakeFirestore({
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
    // #1680: both halves in ONE atomic commit, so the pair can never disagree.
    expect(commits).toEqual([
      [
        { op: 'delete', path: 'filiais/F-1/certificadoSecreto/default' },
        { op: 'update', path: 'filiais/F-1' },
      ],
    ]);
  });

  it('404 for an unknown filial — and never creates a stub filial doc', async () => {
    // The old `merge({ certificado: null })` was an upsert: an unknown id left a
    // `filiais/<id>` holding nothing but `certificado: null`.
    const { fs, docs, commits } = fakeFirestore({});
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const res = await DELETE(deleteReq('MISSING'));
    expect(res.status).toBe(404);
    expect(docs['filiais/MISSING']).toBeUndefined();
    expect(commits).toEqual([]);
  });

  it('a repeat after a successful removal still succeeds (the secret is already gone)', async () => {
    const { fs, docs } = fakeFirestore({
      'filiais/F-1': { cnpj: CNPJ, certificado: null },
    });
    vi.mocked(getAdminFirestore).mockReturnValue(fs);
    const res = await DELETE(deleteReq('F-1'));
    expect(res.status).toBe(200);
    expect((docs['filiais/F-1'] as { certificado?: unknown }).certificado).toBeNull();
  });
});
