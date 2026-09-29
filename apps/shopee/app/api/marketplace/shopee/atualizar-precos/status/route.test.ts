import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { envioPrecoShopeeSchema } from '@delfrance/schemas';

import { MENSAGEM_POR_MOTIVO_PRECO } from '@/lib/shopee/precos/errosPreco';
import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

/**
 * `GET /api/marketplace/shopee/atualizar-precos/status` (#1521, step 13 PR 2;
 * D2 §3.6). The double APPLIES the field mask the way the server does, so a
 * field the route forgot to mask reads back as its schema default here too.
 */

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
}));

const { GET, CAMPOS_STATUS } = await import('./route');

/** The shared double plus `getAll(...refs, { fieldMask })`, the mask APPLIED and recorded. */
class FakeDbComMascara extends FakeDb {
  readonly mascaras: (string[] | null)[] = [];

  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const opcoes =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] })
        : null;
    const refs = (opcoes === null ? args : args.slice(0, -1)) as {
      id: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    this.mascaras.push(opcoes?.fieldMask ?? null);
    return Promise.all(
      refs.map(async (ref) => {
        const snap = await ref.get();
        const dados = snap.data();
        return {
          id: ref.id,
          exists: snap.exists,
          data: () => {
            if (!snap.exists || dados === undefined || opcoes === null) return dados;
            const saida: DocData = {};
            for (const c of opcoes.fieldMask) if (Object.hasOwn(dados, c)) saida[c] = dados[c];
            return saida;
          },
        };
      }),
    );
  }
}

const INT_A = 'int-1';
const INT_B = 'int-2';
const JOB = 'job-1';
const AGORA_MS = 1_757_000_000_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/atualizar-precos/status');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

/** A job with EVERY field set to a non-default value, so a missed field reads wrong. */
function semearJob(db: FakeDb, over: DocData = {}): void {
  db.seed(`enviosPrecoShopee/${JOB}`, {
    integracaoId: INT_A,
    status: 'running',
    baixarPreco: true,
    afterAnchorId: 'prod-9',
    planejamentoConcluido: true,
    fila: [{ produtoId: 'p1', linkDocId: 'l1', itemId: 2500139861, modelos: [] }],
    planejados: 40,
    enviados: 12,
    pulados: 20,
    falhas: 3,
    pausas: 2,
    parques: 1,
    retomarEm: AGORA_MS + 3_600_000,
    skips: [
      {
        itemId: '2500139861',
        produtoId: 'p1',
        code: 'preco-igual',
        linkDocId: 'l1',
        precoAnterior: 10,
        inventadoNaAmostra: 'NÃO PODE VAZAR',
      },
    ],
    failures: [
      {
        itemId: '2500139862',
        produtoId: 'p2',
        code: 'preco-recusado',
        linkDocId: 'l2',
        precoAnterior: 11,
        error: 'product.error_busi',
      },
    ],
    relatorioLinhas: 35,
    relatorioShards: 1,
    relatorioCompleto: false,
    filaRestante: 1,
    startedBy: 'u9',
    startedAt: AGORA_MS - 5000,
    updatedAt: AGORA_MS - 1000,
    finishedAt: null,
    erro: null,
    expiraEm: new Date(AGORA_MS + 180 * 86_400_000),
    ...over,
  });
}

let db: FakeDbComMascara;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDbComMascara();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
});

describe('autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: INT_A, jobId: JOB }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.write — a leitura NÃO basta', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.integracao.read.toString() });
    expect((await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO))).status).toBe(403);
  });

  it.each([
    ['sem jobId', { integracaoId: INT_A }],
    ['sem integracaoId', { jobId: JOB }],
    ['jobId com separador', { integracaoId: INT_A, jobId: 'a/b' }],
    ['integracaoId relativo', { integracaoId: '..', jobId: JOB }],
  ])('%s ⇒ 400, sem ler nada', async (_nome, query) => {
    const res = await GET(req(query, AUTORIZADO));

    expect(res.status).toBe(400);
    expect(db.mascaras).toEqual([]);
  });
});

describe('o que a rota devolve', () => {
  it('entrega os contadores, o parque, o tamanho da fila e as amostras COM a frase renderizada', async () => {
    semearJob(db);

    const res = await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      jobId: JOB,
      status: 'running',
      baixarPreco: true,
      planejados: 40,
      enviados: 12,
      pulados: 20,
      falhas: 3,
      pausas: 2,
      parques: 1,
      retomarEm: AGORA_MS + 3_600_000,
      filaRestante: 1,
      relatorioCompleto: false,
      relatorioShards: 1,
      skips: [
        {
          itemId: '2500139861',
          produtoId: 'p1',
          code: 'preco-igual',
          linkDocId: 'l1',
          precoAnterior: 10,
          mensagem: MENSAGEM_POR_MOTIVO_PRECO['preco-igual'],
        },
      ],
      failures: [
        {
          itemId: '2500139862',
          produtoId: 'p2',
          code: 'preco-recusado',
          linkDocId: 'l2',
          precoAnterior: 11,
          mensagem: MENSAGEM_POR_MOTIVO_PRECO['preco-recusado'],
          error: 'product.error_busi',
        },
      ],
      startedAt: AGORA_MS - 5000,
      updatedAt: AGORA_MS - 1000,
      finishedAt: null,
      erro: null,
    });
  });

  it('⛔ `fila` nunca sai do Firestore: a máscara a exclui, e o corpo não a traz', async () => {
    semearJob(db);

    const corpo = (await (
      await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO))
    ).json()) as Record<string, unknown>;

    expect(db.mascaras).toEqual([[...CAMPOS_STATUS]]);
    expect(CAMPOS_STATUS).not.toContain('fila');
    for (const chave of ['fila', 'afterAnchorId', 'startedBy', 'relatorioLinhas', 'expiraEm']) {
      expect(corpo).not.toHaveProperty(chave);
    }
  });

  it('a máscara é um subconjunto do schema e cobre os quatro campos sem default', () => {
    const chaves = Object.keys(envioPrecoShopeeSchema.shape);
    for (const campo of CAMPOS_STATUS) expect(chaves).toContain(campo);
    for (const campo of ['integracaoId', 'status', 'startedAt', 'updatedAt']) {
      expect(CAMPOS_STATUS).toContain(campo);
    }
  });
});

describe('um id que não é desta conta não revela nada', () => {
  it('PAR: responde 404 para um job inexistente', async () => {
    const res = await GET(req({ integracaoId: INT_A, jobId: 'nao-existe' }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Atualização de preços não encontrada.' });
  });

  it('QUASE-IGUAL: responde o MESMO 404 — mesma frase — para o job de outra conta', async () => {
    semearJob(db, { integracaoId: INT_B });

    const res = await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Atualização de preços não encontrada.' });
  });
});
