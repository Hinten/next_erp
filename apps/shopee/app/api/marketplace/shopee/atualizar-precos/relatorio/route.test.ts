import { FieldPath } from 'firebase-admin/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { envioPrecoShopeeSchema } from '@delfrance/schemas';

import {
  MENSAGEM_ENVIO_PRECO_LIMPO,
  MENSAGEM_POR_MOTIVO_PRECO,
} from '@/lib/shopee/precos/errosPreco';
import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

/**
 * `GET /api/marketplace/shopee/atualizar-precos/relatorio` (#1521, step 13 PR
 * 2; D2 §3.6). The double answers the two read shapes the shared one does not
 * model — the shard page by `__name__` with a VALUE cursor, and
 * `getAll(...refs, { fieldMask })` with the mask APPLIED — and records both.
 */

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
}));

const { GET, CAMPOS_JOB, SHARDS_POR_PAGINA } = await import('./route');

interface PaginaPorId {
  fonte: string;
  apos: string | null;
  limite: number | null;
}

/** The shared double plus the keyset-by-id page and the masked batch read. */
class FakeDbDoRelatorio extends FakeDb {
  readonly paginas: PaginaPorId[] = [];
  readonly lotes: { caminhos: string[]; mascara: string[] | null }[] = [];

  override collection(colPath: string) {
    // eslint-disable-next-line no-restricted-syntax -- a test double extending the shared double's own chain
    const consulta = super.collection(colPath);
    const store = this.store;
    const paginas = this.paginas;
    let porId = false;
    let apos: string | null = null;
    let limite: number | null = null;
    const ordenarPor = consulta.orderBy;
    const buscar = consulta.get;
    return Object.assign(consulta, {
      orderBy: (campo: unknown, direcao: 'asc' | 'desc' = 'asc') => {
        if (campo instanceof FieldPath && campo.isEqual(FieldPath.documentId())) porId = true;
        else ordenarPor(campo as string, direcao);
        return consulta;
      },
      startAfter: (cursor: unknown) => {
        if (typeof cursor !== 'string') throw new Error('fixture: só o cursor por VALOR de id');
        apos = cursor;
        return consulta;
      },
      limit: (n: number) => {
        limite = n;
        return consulta;
      },
      get: async () => {
        if (!porId) return buscar();
        paginas.push({ fonte: colPath, apos, limite });
        const prefixo = `${colPath}/`;
        const linhas = Object.entries(store)
          .filter(([p]) => p.startsWith(prefixo) && !p.slice(prefixo.length).includes('/'))
          .map(([p, s]) => ({ id: p.slice(prefixo.length), data: () => s.data }))
          .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
          .filter(({ id }) => apos === null || id > apos);
        return { docs: limite === null ? linhas : linhas.slice(0, limite) };
      },
    });
  }

  getAll(...args: unknown[]) {
    const ultimo = args[args.length - 1];
    const opcoes =
      typeof ultimo === 'object' && ultimo !== null && 'fieldMask' in ultimo
        ? (ultimo as { fieldMask: string[] })
        : null;
    const refs = (opcoes === null ? args : args.slice(0, -1)) as {
      id: string;
      path: string;
      get: () => Promise<{ exists: boolean; data: () => DocData | undefined }>;
    }[];
    this.lotes.push({ caminhos: refs.map((r) => r.path), mascara: opcoes?.fieldMask ?? null });
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
const CAMINHO_JOB = `enviosPrecoShopee/${JOB}`;
const AGORA_MS = 1_757_000_000_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(query: Record<string, string>, headers: Record<string, string> = {}): Request {
  const url = new URL('http://localhost:3009/api/marketplace/shopee/atualizar-precos/relatorio');
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return new Request(url, { headers });
}

function semearJob(db: FakeDb, over: DocData = {}): void {
  db.seed(CAMINHO_JOB, {
    integracaoId: INT_A,
    status: 'failed',
    fila: [{ produtoId: 'p1', linkDocId: 'l1', itemId: 2500139861, modelos: [] }],
    relatorioLinhas: 3,
    relatorioShards: 1,
    relatorioCompleto: false,
    filaRestante: 1,
    startedAt: AGORA_MS - 5000,
    updatedAt: AGORA_MS - 1000,
    ...over,
  });
}

function linha(over: DocData): DocData {
  return {
    produtoId: 'prod-1',
    variacaoProdutoId: null,
    anuncioId: '2500139861',
    linkDocId: 'link-1',
    resultado: 'enviado',
    fase: 'envio',
    motivo: null,
    erro: null,
    preco: 15,
    precoAnterior: 10,
    variacoes: null,
    ...over,
  };
}

function semearShard(db: FakeDb, id: string, linhas: Record<string, DocData>): void {
  db.seed(`${CAMINHO_JOB}/relatorios/${id}`, { linhas, timestamp: AGORA_MS });
}

let db: FakeDbDoRelatorio;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDbDoRelatorio();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
});

async function pagina(query: Record<string, string> = {}) {
  const res = await GET(req({ integracaoId: INT_A, jobId: JOB, ...query }, AUTORIZADO));
  expect(res.status).toBe(200);
  return (await res.json()) as {
    linhas: Record<string, unknown>[];
    proximoDepois: string | null;
    status: string;
    relatorioCompleto: boolean;
    filaRestante: number;
  };
}

describe('autenticação e argumentos', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await GET(req({ integracaoId: INT_A, jobId: JOB }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: PERM.integracao.read.toString() });
    expect((await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO))).status).toBe(403);
  });

  it.each([
    ['sem jobId', { integracaoId: INT_A }],
    ['sem integracaoId', { jobId: JOB }],
    ['jobId com separador', { integracaoId: INT_A, jobId: 'a/b' }],
    ['(M45) depois com separador', { integracaoId: INT_A, jobId: JOB, depois: '../x' }],
    ['depois com barra', { integracaoId: INT_A, jobId: JOB, depois: 'a/b' }],
    ['depois curto demais', { integracaoId: INT_A, jobId: JOB, depois: '001' }],
    ['depois não-numérico', { integracaoId: INT_A, jobId: JOB, depois: 'abcd' }],
  ])('%s ⇒ 400, sem ler nada', async (_nome, query) => {
    semearJob(db);

    const res = await GET(req(query, AUTORIZADO));

    expect(res.status).toBe(400);
    expect(db.lotes).toEqual([]);
    expect(db.paginas).toEqual([]);
  });

  it('PAR: `depois=0000` é aceito e vira o cursor; QUASE-IGUAL: `depois=000` (três dígitos) é 400', async () => {
    semearJob(db);

    await pagina({ depois: '0000' });
    expect(db.paginas).toEqual([
      { fonte: `${CAMINHO_JOB}/relatorios`, apos: '0000', limite: SHARDS_POR_PAGINA },
    ]);

    const curto = await GET(req({ integracaoId: INT_A, jobId: JOB, depois: '000' }, AUTORIZADO));
    expect(curto.status).toBe(400);
  });
});

describe('o job', () => {
  it('é lido com a máscara — sem `fila` — e a máscara cobre os campos sem default', async () => {
    semearJob(db);

    await pagina();

    expect(db.lotes[0]).toEqual({ caminhos: [CAMINHO_JOB], mascara: [...CAMPOS_JOB] });
    expect(CAMPOS_JOB).not.toContain('fila');
    const chaves = Object.keys(envioPrecoShopeeSchema.shape);
    for (const campo of CAMPOS_JOB) expect(chaves).toContain(campo);
    for (const campo of ['integracaoId', 'status', 'startedAt', 'updatedAt']) {
      expect(CAMPOS_JOB).toContain(campo);
    }
  });

  it('PAR: um job inexistente ⇒ 404, sem ler shard nenhum', async () => {
    const res = await GET(req({ integracaoId: INT_A, jobId: 'nao-existe' }, AUTORIZADO));

    expect(res.status).toBe(404);
    expect(db.paginas).toEqual([]);
  });

  it('QUASE-IGUAL: o job de OUTRA conta ⇒ o MESMO 404, sem ler shard nenhum', async () => {
    semearJob(db, { integracaoId: INT_B });
    semearShard(db, '0000', { a: linha({}) });

    const res = await GET(req({ integracaoId: INT_A, jobId: JOB }, AUTORIZADO));

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'Atualização de preços não encontrada.' });
    expect(db.paginas).toEqual([]);
  });

  it('a página traz os fatos do job que separam um relatório completo de um truncado', async () => {
    semearJob(db);

    const corpo = await pagina();

    expect(corpo).toMatchObject({ status: 'failed', relatorioCompleto: false, filaRestante: 1 });
  });
});

describe('as linhas', () => {
  it('cada linha ganha a `mensagem` RENDERIZADA na leitura — o envio limpo incluído', async () => {
    semearJob(db);
    semearShard(db, '0000', {
      a: linha({}),
      b: linha({ anuncioId: '2500139862', resultado: 'pulado', motivo: 'preco-igual' }),
      c: linha({ anuncioId: '2500139863', resultado: 'falha', motivo: 'preco-recusado' }),
      d: linha({ anuncioId: '2500139864', resultado: 'falha', motivo: 'motivo-que-nao-existe' }),
    });

    const { linhas } = await pagina();

    expect(linhas.map((l) => l['mensagem'])).toEqual([
      MENSAGEM_ENVIO_PRECO_LIMPO,
      MENSAGEM_POR_MOTIVO_PRECO['preco-igual'],
      MENSAGEM_POR_MOTIVO_PRECO['preco-recusado'],
      'Não enviado (motivo não reconhecido).',
    ]);
  });

  it('a linha é montada POR NOME: uma chave extra gravada não vaza', async () => {
    semearJob(db);
    semearShard(db, '0000', { a: linha({ inventadoNaLinha: 'NÃO PODE VAZAR' }) });

    const { linhas } = await pagina();

    expect(Object.keys(linhas[0]!).sort()).toEqual(
      [
        'produtoId',
        'variacaoProdutoId',
        'anuncioId',
        'linkDocId',
        'resultado',
        'fase',
        'motivo',
        'mensagem',
        'erro',
        'preco',
        'precoAnterior',
        'produtoNome',
        'sku',
      ].sort(),
    );
  });

  it('PAR: uma linha POR MODELO mostra o nome e o SKU da VARIAÇÃO; QUASE-IGUAL: a sem modelo mostra os da âncora', async () => {
    semearJob(db);
    db.seed('produtos/prod-1', { nome: 'Camiseta', sku: 'CAM' });
    db.seed('produtos/prod-1-p', { nome: 'Camiseta P', sku: 'CAM-P' });
    semearShard(db, '0000', {
      a: linha({ variacaoProdutoId: 'prod-1-p' }),
      b: linha({ anuncioId: '2500139862' }),
    });

    const { linhas } = await pagina();

    expect(linhas.map((l) => [l['produtoNome'], l['sku']])).toEqual([
      ['Camiseta P', 'CAM-P'],
      ['Camiseta', 'CAM'],
    ]);
    // ONE batched read for the distinct produtos, masked to the two fields.
    expect(db.lotes[1]).toEqual({
      caminhos: ['produtos/prod-1-p', 'produtos/prod-1'],
      mascara: ['nome', 'sku'],
    });
  });

  it('um produto que não existe (ou a linha sintética `job-*`) vem com nome e SKU em branco, nunca como falha', async () => {
    semearJob(db);
    semearShard(db, '0000', {
      a: linha({ produtoId: 'sumiu' }),
      b: linha({
        produtoId: INT_A,
        anuncioId: null,
        linkDocId: null,
        resultado: 'nao-tentado',
        motivo: 'job-interrompido',
        preco: null,
        precoAnterior: null,
      }),
    });

    const { linhas } = await pagina();

    expect(linhas.map((l) => [l['produtoNome'], l['sku']])).toEqual([
      [null, null],
      [null, null],
    ]);
    expect(linhas[1]!['mensagem']).toBe(MENSAGEM_POR_MOTIVO_PRECO['job-interrompido']);
  });
});

describe('a paginação por `__name__`', () => {
  it(`uma página CHEIA (${String(SHARDS_POR_PAGINA)} shards) aponta o último id; a seguinte, parcial, termina em null`, async () => {
    semearJob(db);
    for (const id of ['0000', '0001', '0002', '0003', '0004']) {
      semearShard(db, id, { [id]: linha({ anuncioId: id }) });
    }

    const primeira = await pagina();
    expect(primeira.linhas.map((l) => l['anuncioId'])).toEqual(['0000', '0001', '0002', '0003']);
    expect(primeira.proximoDepois).toBe('0003');

    const segunda = await pagina({ depois: '0003' });
    expect(segunda.linhas.map((l) => l['anuncioId'])).toEqual(['0004']);
    expect(segunda.proximoDepois).toBeNull();

    expect(db.paginas).toEqual([
      { fonte: `${CAMINHO_JOB}/relatorios`, apos: null, limite: SHARDS_POR_PAGINA },
      { fonte: `${CAMINHO_JOB}/relatorios`, apos: '0003', limite: SHARDS_POR_PAGINA },
    ]);
  });

  it('um run sem shard nenhum responde uma página vazia e termina', async () => {
    semearJob(db);

    const corpo = await pagina();

    expect(corpo.linhas).toEqual([]);
    expect(corpo.proximoDepois).toBeNull();
  });
});
