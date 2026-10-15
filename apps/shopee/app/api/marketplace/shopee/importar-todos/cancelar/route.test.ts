import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { importacaoShopeeOptionsSchema } from '@delfrance/schemas';

import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
}));

const { POST } = await import('./route');

const INT_A = 'int-1';
const INT_B = 'int-2';
const JOB = 'job-1';
const CAMINHO_JOB = `importacoesShopee/${JOB}`;
const AGORA_MS = 1_757_000_000_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/importar-todos/cancelar', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function semearJob(db: FakeDb, over: DocData = {}): void {
  db.seed(CAMINHO_JOB, {
    integracaoId: INT_A,
    status: 'running',
    nextOffset: null,
    fila: [],
    filaKits: [],
    scanned: 0,
    imported: 0,
    created: 0,
    skipped: 0,
    kits: 0,
    failureCount: 0,
    failures: [],
    options: importacaoShopeeOptionsSchema.parse({}),
    startedAt: AGORA_MS - 5000,
    updatedAt: AGORA_MS - 5000,
    finishedAt: null,
    erro: null,
    ...over,
  });
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
});

describe('autenticação e corpo', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await POST(req({ integracaoId: INT_A, jobId: JOB }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO))).status).toBe(403);
  });

  it('responde 400 para um body JSON malformado', async () => {
    const res = await POST(req('{"integracaoId":', AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Body JSON inválido.' });
  });

  it('responde 400 sem jobId, sem tocar no documento', async () => {
    semearJob(db);

    const res = await POST(req({ integracaoId: INT_A }, AUTORIZADO));

    expect(res.status).toBe(400);
    expect(db.writes).toHaveLength(0);
  });
});

describe('o interruptor do job', () => {
  it('carimba cancelled e responde 200', async () => {
    semearJob(db);

    const res = await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'cancelled' });
    expect(db.store[CAMINHO_JOB]?.data).toMatchObject({ status: 'cancelled' });
  });

  it('um job já finalizado responde 409 e não é reescrito', async () => {
    semearJob(db, { status: 'completed', finishedAt: AGORA_MS - 10 });

    const res = await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_MASS_IMPORT_NOT_RUNNING' });
    expect(db.store[CAMINHO_JOB]?.data).toMatchObject({ status: 'completed' });
  });

  it('um job inexistente responde 404', async () => {
    const res = await POST(req({ integracaoId: INT_A, jobId: 'nao-existe' }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Importação não encontrada.' });
  });

  it('⛔ cancelar o job de OUTRA conta responde 404 e não carimba nada', async () => {
    // Sem a checagem de dono a conta A encerraria a importação da conta B, e a
    // resposta ainda diria "cancelled".
    semearJob(db, { integracaoId: INT_B });

    const res = await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Importação não encontrada.' });
    expect(db.store[CAMINHO_JOB]?.data).toMatchObject({ status: 'running' });
  });
});
