import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';

import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

/**
 * `POST /api/marketplace/shopee/atualizar-precos/cancelar` (#1521, step 13 PR
 * 2; D2 §3.6). The cancel runs through the job's REAL terminal transaction
 * against the shared double, so "not stamped" is a read of the store.
 */

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
}));

const { POST, CODIGO_ENVIO_PRECO_NAO_EM_ANDAMENTO, MSG_ENVIO_PRECO_NAO_ENCONTRADO } =
  await import('./route');

const INT_A = 'int-1';
const INT_B = 'int-2';
const JOB = 'job-1';
const CAMINHO_JOB = `enviosPrecoShopee/${JOB}`;
const AGORA_MS = 1_757_000_000_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/atualizar-precos/cancelar', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function semearJob(db: FakeDb, over: DocData = {}): void {
  db.seed(CAMINHO_JOB, {
    integracaoId: INT_A,
    status: 'running',
    fila: [
      { produtoId: 'p1', linkDocId: 'l1', itemId: 2500139861, modelos: [] },
      { produtoId: 'p2', linkDocId: 'l2', itemId: 2500139862, modelos: [] },
    ],
    startedAt: AGORA_MS - 5000,
    updatedAt: AGORA_MS - 5000,
    ...over,
  });
}

function job(db: FakeDb): DocData | undefined {
  return db.store[CAMINHO_JOB]?.data;
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  vi.spyOn(Date, 'now').mockReturnValue(AGORA_MS);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('autenticação e corpo', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    semearJob(db);
    expect((await POST(req({ integracaoId: INT_A, jobId: JOB }))).status).toBe(401);
    expect(job(db)).toMatchObject({ status: 'running' });
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO))).status).toBe(403);
  });

  it.each([
    ['JSON malformado', '{"integracaoId":'],
    ['corpo null', null],
    ['corpo array', []],
    ['sem jobId', { integracaoId: INT_A }],
    ['jobId com separador', { integracaoId: INT_A, jobId: 'a/b' }],
    ['jobId número', { integracaoId: INT_A, jobId: 7 }],
    ['sem integracaoId', { jobId: JOB }],
    ['integracaoId relativo', { integracaoId: '..', jobId: JOB }],
  ])('%s ⇒ 400, sem tocar no documento', async (_nome, corpo) => {
    semearJob(db);

    const res = await POST(req(corpo, AUTORIZADO));

    expect(res.status).toBe(400);
    expect(db.writes).toEqual([]);
    expect(job(db)).toMatchObject({ status: 'running' });
  });
});

describe('o carimbo', () => {
  it('carimba cancelled e responde 200, com filaRestante e UMA linha job-cancelado', async () => {
    semearJob(db);

    const res = await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ status: 'cancelled' });
    expect(job(db)).toMatchObject({
      status: 'cancelled',
      erro: null,
      relatorioCompleto: false,
      finishedAt: AGORA_MS,
      filaRestante: 2,
    });
    const linhas = Object.values(
      db.store[`${CAMINHO_JOB}/relatorios/0000`]?.data['linhas'] as Record<string, DocData>,
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ motivo: 'job-cancelado', resultado: 'nao-tentado' });
  });

  it('um job já finalizado responde 409 SHOPEE_PRICE_SYNC_NOT_RUNNING e não é reescrito', async () => {
    semearJob(db, { status: 'completed', finishedAt: AGORA_MS - 10 });

    const res = await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: CODIGO_ENVIO_PRECO_NAO_EM_ANDAMENTO });
    expect(job(db)).toMatchObject({ status: 'completed' });
    expect(db.writes).toEqual([]);
  });

  it('PAR: um job inexistente responde 404 com a frase única', async () => {
    const res = await POST(req({ integracaoId: INT_A, jobId: 'nao-existe' }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: MSG_ENVIO_PRECO_NAO_ENCONTRADO });
  });

  it('⛔ (M44) QUASE-IGUAL: o job de OUTRA conta responde o MESMO 404 — nunca 409 — e não carimba nada', async () => {
    // Sem a checagem de dono a conta A encerraria o envio da conta B; com um 409
    // a rota revelaria que o id existe.
    semearJob(db, { integracaoId: INT_B });

    const res = await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: MSG_ENVIO_PRECO_NAO_ENCONTRADO });
    expect(job(db)).toMatchObject({ status: 'running', integracaoId: INT_B });
    expect(db.writes).toEqual([]);
  });

  it('⛔ o job FINALIZADO de outra conta também é 404, nunca o 409 que confirmaria o id', async () => {
    semearJob(db, { integracaoId: INT_B, status: 'completed', finishedAt: AGORA_MS - 10 });

    const res = await POST(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(404);
  });
});
