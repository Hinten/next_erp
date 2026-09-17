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

const { GET } = await import('./route');

const INT_A = 'int-1';
const INT_B = 'int-2';
const JOB = 'job-1';
const CAMINHO_JOB = `importacoesShopee/${JOB}`;
const AGORA_MS = 1_757_000_000_000;

const LEITOR = { uid: 'u1', permissions: PERM.integracao.read.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/importar-todos/status');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

function semearJob(db: FakeDb, over: DocData = {}): void {
  db.seed(CAMINHO_JOB, {
    integracaoId: INT_A,
    status: 'running',
    nextOffset: 100,
    fila: [2500139861, 2500139862],
    filaKits: [2500139863],
    scanned: 40,
    imported: 12,
    created: 9,
    skipped: 3,
    kits: 1,
    failureCount: 2,
    failures: [{ itemId: 2500139864, motivo: 'sem-nome', mensagem: '' }],
    options: importacaoShopeeOptionsSchema.parse({}),
    startedAt: AGORA_MS - 5000,
    updatedAt: AGORA_MS - 1000,
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
  h.verifyIdToken.mockResolvedValue(LEITOR);
});

describe('autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: INT_A, jobId: JOB }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.read', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO))).status).toBe(403);
  });

  it('responde 400 sem jobId', async () => {
    const res = await GET(req({ integracaoId: INT_A }, AUTORIZADO));
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: 'jobId é obrigatório.' });
  });

  it('responde 400 sem integracaoId', async () => {
    expect((await GET(req({ jobId: JOB }, AUTORIZADO))).status).toBe(400);
  });
});

describe('o que a rota devolve', () => {
  it('entrega os contadores, o restante e o veredicto da varredura', async () => {
    semearJob(db);

    const res = await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      status: 'running',
      scanned: 40,
      imported: 12,
      created: 9,
      skipped: 3,
      kits: 1,
      failureCount: 2,
      failures: [{ itemId: 2500139864, motivo: 'sem-nome', mensagem: '' }],
      // 2 anúncios + 1 kit ainda na fila.
      restante: 3,
      varreduraExaurida: false,
      startedAt: AGORA_MS - 5000,
      updatedAt: AGORA_MS - 1000,
      finishedAt: null,
      erro: null,
    });
  });

  it('nextOffset null é a varredura esgotada', async () => {
    semearJob(db, { nextOffset: null, fila: [], filaKits: [] });

    const corpo = (await (
      await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO))
    ).json()) as Record<string, unknown>;

    expect(corpo).toMatchObject({ varreduraExaurida: true, restante: 0 });
  });

  it('⛔ NÃO ecoa fila, filaKits, nextOffset nem options', async () => {
    // As duas filas são listas ilimitadas de ids de anúncio e `nextOffset` é um
    // cursor vivo dentro do catálogo de alguém; o que o operador precisa das
    // filas é o TAMANHO e do cursor é se a varredura acabou.
    semearJob(db);

    const corpo = (await (
      await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO))
    ).json()) as Record<string, unknown>;

    for (const chave of ['fila', 'filaKits', 'nextOffset', 'options']) {
      expect(corpo).not.toHaveProperty(chave);
    }
  });
});

describe('um id que não é desta conta não revela nada', () => {
  it('responde 404 para um job inexistente', async () => {
    const res = await GET(req({ integracaoId: INT_A, jobId: 'nao-existe' }, AUTORIZADO));
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Importação não encontrada.' });
  });

  it('responde 404 — com a MESMA frase — para um job de outra conta', async () => {
    semearJob(db, { integracaoId: INT_B });

    const res = await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Importação não encontrada.' });
  });
});
