import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { envioPrecoShopeeSchema } from '@delfrance/schemas';

import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

/**
 * `GET /api/marketplace/shopee/atualizar-precos/historico` (#1521, step 13 PR
 * 2; D2 §3.6, reconcile C-y e). The double APPLIES `Query.select(...)` the way
 * the server does — an unlisted field vanishes — so a projection that forgot a
 * field reads back as the schema DEFAULT here too, exactly the silent wrong
 * answer a real `.select()` would give.
 */

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
}));

const { GET, CAMPOS_PROJETADOS } = await import('./route');

/** The shared double plus a REAL projection on the collection chain, recorded. */
class FakeDbComProjecao extends FakeDb {
  readonly projecoes: string[][] = [];

  override collection(colPath: string) {
    // eslint-disable-next-line no-restricted-syntax -- a test double extending the shared double's own chain
    const consulta = super.collection(colPath);
    const buscar = consulta.get;
    const projecoes = this.projecoes;
    let campos: string[] | null = null;
    return Object.assign(consulta, {
      select: (...lista: string[]) => {
        campos = lista;
        projecoes.push(lista);
        return consulta;
      },
      get: async () => {
        const resposta = await buscar();
        return {
          docs: resposta.docs.map((d) => ({
            ...d,
            data: () => {
              const dados = d.data();
              if (campos === null) return dados;
              const saida: DocData = {};
              for (const c of campos) if (Object.hasOwn(dados, c)) saida[c] = dados[c];
              return saida;
            },
          })),
        };
      },
    });
  }
}

const INT_A = 'int-1';
const INT_B = 'int-2';
const AGORA_MS = 1_757_000_000_000;
const DIA_MS = 86_400_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/atualizar-precos/historico');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

/** A run with EVERY field set to a non-default value, `fila` and the samples included. */
function semearRun(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(`enviosPrecoShopee/${id}`, {
    integracaoId: INT_A,
    status: 'completed',
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
    retomarEm: null,
    skips: [{ itemId: '2500139861', produtoId: 'p1', code: 'preco-igual' }],
    failures: [{ itemId: '2500139862', produtoId: 'p2', code: 'preco-recusado', error: 'x' }],
    relatorioLinhas: 35,
    relatorioShards: 1,
    relatorioCompleto: true,
    filaRestante: 0,
    startedBy: 'u9',
    startedAt: AGORA_MS - DIA_MS,
    updatedAt: AGORA_MS - DIA_MS + 60_000,
    finishedAt: AGORA_MS - DIA_MS + 120_000,
    erro: null,
    expiraEm: new Date(AGORA_MS + 179 * DIA_MS),
    ...over,
  });
}

let db: FakeDbComProjecao;

beforeEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  db = new FakeDbComProjecao();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  vi.spyOn(Date, 'now').mockReturnValue(AGORA_MS);
});

async function envios(query: Record<string, string> = { integracaoId: INT_A }) {
  const res = await GET(req(query, AUTORIZADO));
  expect(res.status).toBe(200);
  return ((await res.json()) as { envios: Record<string, unknown>[] }).envios;
}

describe('autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: INT_A }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.integracao.read.toString() });
    expect((await GET(req({ integracaoId: INT_A }, AUTORIZADO))).status).toBe(403);
  });

  it.each([
    ['sem integracaoId', {}],
    ['integracaoId com separador', { integracaoId: 'a/b' }],
    ['limite 0', { integracaoId: INT_A, limite: '0' }],
    ['limite 51', { integracaoId: INT_A, limite: '51' }],
    ['limite fracionário', { integracaoId: INT_A, limite: '1.5' }],
    ['limite negativo', { integracaoId: INT_A, limite: '-1' }],
    ['limite com expoente', { integracaoId: INT_A, limite: '1e1' }],
  ])('%s ⇒ 400, sem consultar', async (_nome, query) => {
    const res = await GET(req(query, AUTORIZADO));

    expect(res.status).toBe(400);
    expect(db.consultasCompletas).toEqual([]);
  });
});

describe('a consulta', () => {
  it('UMA consulta: `integracaoId ==`, `startedAt desc`, a projeção e o limite padrão 20', async () => {
    await envios();

    expect(db.consultasCompletas).toEqual([
      {
        fonte: 'enviosPrecoShopee',
        clausulas: [['integracaoId', '==', INT_A]],
        ordens: [['startedAt', 'desc']],
        limite: 20,
        apos: null,
      },
    ]);
    expect(db.projecoes).toEqual([[...CAMPOS_PROJETADOS]]);
  });

  it('PAR: `limite=50` é aceito e vai à consulta; QUASE-IGUAL: `limite=51` é 400 (acima)', async () => {
    await envios({ integracaoId: INT_A, limite: '50' });
    expect(db.consultasCompletas.at(-1)?.limite).toBe(50);

    expect((await GET(req({ integracaoId: INT_A, limite: '51' }, AUTORIZADO))).status).toBe(400);
  });

  it('só a conta pedida, a mais recente primeiro', async () => {
    semearRun(db, 'antigo', { startedAt: AGORA_MS - 3 * DIA_MS });
    semearRun(db, 'recente', { startedAt: AGORA_MS - DIA_MS });
    semearRun(db, 'de-outra-conta', { integracaoId: INT_B });

    expect((await envios()).map((e) => e.jobId)).toEqual(['recente', 'antigo']);
  });
});

describe('o corpo', () => {
  it('cada run traz os contadores e o jobId — e NUNCA fila, amostras, cursor, dono nem expiraEm', async () => {
    semearRun(db, 'job-1');

    const [run] = await envios();

    expect(run).toEqual({
      jobId: 'job-1',
      integracaoId: INT_A,
      status: 'completed',
      baixarPreco: true,
      planejados: 40,
      enviados: 12,
      pulados: 20,
      falhas: 3,
      pausas: 2,
      parques: 1,
      retomarEm: null,
      filaRestante: 0,
      relatorioCompleto: true,
      relatorioShards: 1,
      startedAt: AGORA_MS - DIA_MS,
      updatedAt: AGORA_MS - DIA_MS + 60_000,
      finishedAt: AGORA_MS - DIA_MS + 120_000,
      erro: null,
    });
  });
});

describe('(M46) a projeção, fixada contra as chaves do schema', () => {
  /** What the projection deliberately LEAVES in Firestore, each for a named reason. */
  const FORA_DA_PROJECAO = [
    'fila', // a whole plan page of identities with their models
    'skips', // capped samples: the status route carries them for ONE run
    'failures',
    'afterAnchorId', // the plan's live cursor
    'planejamentoConcluido',
    'relatorioLinhas', // the shard cursor — `relatorioShards` is what a reader needs
    'startedBy',
  ];

  it('projeção ∪ excluídos = EXATAMENTE as chaves do schema — um campo novo obriga uma decisão', () => {
    expect([...CAMPOS_PROJETADOS, ...FORA_DA_PROJECAO].sort()).toEqual(
      Object.keys(envioPrecoShopeeSchema.shape).sort(),
    );
  });

  it('⛔ fila, skips e failures NÃO estão na projeção', () => {
    for (const campo of ['fila', 'skips', 'failures']) {
      expect(CAMPOS_PROJETADOS).not.toContain(campo);
    }
  });

  it('os quatro campos sem default estão na projeção — sem eles todo parse falha', () => {
    for (const campo of ['integracaoId', 'status', 'startedAt', 'updatedAt']) {
      expect(CAMPOS_PROJETADOS).toContain(campo);
    }
  });

  it('um documento com SÓ os campos projetados passa pelo schema; sem `startedAt`, não passa', () => {
    const projetado: DocData = {
      integracaoId: INT_A,
      status: 'completed',
      startedAt: 1,
      updatedAt: 2,
      expiraEm: new Date(AGORA_MS),
    };
    expect(envioPrecoShopeeSchema.parse(projetado).fila).toEqual([]);

    const { startedAt: _sem, ...semStartedAt } = projetado;
    expect(() => envioPrecoShopeeSchema.parse(semStartedAt)).toThrow();
  });
});

describe('(M-T4) um run com o TTL vencido some da lista', () => {
  it('PAR: expiraEm 1 ms no passado ⇒ oculto; expiraEm IGUAL ao instante ⇒ oculto também', async () => {
    semearRun(db, 'vencido', { expiraEm: new Date(AGORA_MS - 1) });
    semearRun(db, 'na-borda', { expiraEm: new Date(AGORA_MS), startedAt: AGORA_MS - 2 * DIA_MS });

    expect(await envios()).toEqual([]);
  });

  it('QUASE-IGUAL: expiraEm 1 ms no FUTURO ⇒ mostrado', async () => {
    semearRun(db, 'quase', { expiraEm: new Date(AGORA_MS + 1) });

    expect((await envios()).map((e) => e.jobId)).toEqual(['quase']);
  });

  it('um run SEM expiraEm (null, ou ausente) nunca vence ⇒ mostrado', async () => {
    semearRun(db, 'nulo', { expiraEm: null });
    semearRun(db, 'ausente', { expiraEm: undefined, startedAt: AGORA_MS - 2 * DIA_MS });

    expect((await envios()).map((e) => e.jobId)).toEqual(['nulo', 'ausente']);
  });

  it('o vencido sai DEPOIS do limite: a página volta com menos runs, nunca com um vencido', async () => {
    semearRun(db, 'novo', { startedAt: AGORA_MS - DIA_MS });
    semearRun(db, 'velho', {
      startedAt: AGORA_MS - 200 * DIA_MS,
      expiraEm: new Date(AGORA_MS - DIA_MS),
    });

    expect((await envios({ integracaoId: INT_A, limite: '2' })).map((e) => e.jobId)).toEqual([
      'novo',
    ]);
  });
});
