/**
 * `POST`/`GET …/conta/[id]/importacoes` — start a product import, list the newest (master plan
 * step 9), end to end through the REAL start core, the REAL context loader and the REAL lifecycle
 * reads, against the fake.
 *
 * Mocked: the Admin singleton only (`verifyIdToken` and the fake as Firestore). The global `fetch`
 * is stubbed for the WHOLE file with a function that THROWS, and every case asserts it was never
 * called: the start route makes no Loja Integrada call, whatever the switch says (D17).
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import {
  CODIGO_ERRO_LI,
  erroContaLojaIntegradaSchema,
  importacaoLojaIntegradaSchema,
  respostaImportacoesLiSchema,
  respostaInicioImportacaoLiSchema,
} from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import { FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import {
  AGORA_MS,
  espiarStdout,
  seedConta,
  seedCredencial,
} from '@/lib/lojaIntegrada/testing/fixtures';
import { caminhoJobLi, seedJobLi } from '@/lib/lojaIntegrada/testing/importacaoLi';
import {
  ESCRITOR,
  ESTRANHO,
  LEITOR,
  contexto,
  espiarConsole,
  requisicao,
} from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

const { GET, POST } = await import('./route');

const CONTA = 'conta-li-importacoes-http';

let db: FakeDb;
let fetchFalso: Mock<typeof globalThis.fetch>;
let console_: ReturnType<typeof espiarConsole>;

const CORPO = { modo: 'simular', alvo: 'todos', acao: 'soVincular' };

function post(corpo: unknown = CORPO, opts: { conta?: string; semAuth?: boolean } = {}) {
  const conta = opts.conta ?? CONTA;
  return POST(
    requisicao('POST', `${encodeURIComponent(conta)}/importacoes`, {
      corpo,
      semAuth: opts.semAuth,
    }),
    contexto(conta),
  );
}

function get(opts: { conta?: string; semAuth?: boolean } = {}) {
  const conta = opts.conta ?? CONTA;
  return GET(
    requisicao('GET', `${encodeURIComponent(conta)}/importacoes`, { semAuth: opts.semAuth }),
    contexto(conta),
  );
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

beforeEach(() => {
  vi.clearAllMocks();
  __resetAllReadCaches();
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  fetchFalso = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('as rotas da importação não chamam a Loja Integrada');
  });
  vi.stubGlobal('fetch', fetchFalso);
  console_ = espiarConsole();
  seedConta(db, CONTA);
  seedCredencial(db, CONTA);
  // Every case starts with the switch as every environment has it until the window: unset.
  vi.stubEnv(CHAMADAS_ENV_LI, undefined);
});

afterEach(() => {
  console_.restaurar();
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  __resetAllReadCaches();
});

describe('POST — the caller, the id and the body: nothing read', () => {
  it('401 without a bearer token; 403 with read but not write', async () => {
    expect((await post(CORPO, { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(LEITOR);
    expect((await post()).status).toBe(403);
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await post()).status).toBe(403);
    expect(db.leituras).toEqual([]);
    expect(db.escritas).toEqual([]);
  });

  it.each(['..', 'a.b', 'conta com espaço', 'conta%2Foutra'])(
    '400 LI_ID_INVALIDO for the conta id %j, before the body or the switch',
    async (id) => {
      vi.stubEnv(CHAMADAS_ENV_LI, 'on');
      const res = await post(CORPO, { conta: decodeURIComponent(id) });
      expect(res.status).toBe(400);
      expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.idInvalido });
      expect(db.leituras).toEqual([]);
    },
  );

  it.each<[string, unknown, string]>([
    ['an unknown key', { ...CORPO, extra: 1 }, ''],
    ['a missing action', { modo: 'simular', alvo: 'todos' }, 'acao'],
    ['categories under only-link', { ...CORPO, categorias: 'criarEVincular' }, 'categorias'],
    ['photos under only-link', { ...CORPO, fotos: 'soSemFotos' }, 'fotos'],
    ['a selection outside alvo selecionados', { ...CORPO, selecionados: [1] }, 'selecionados'],
    ['alvo selecionados with nothing selected', { ...CORPO, alvo: 'selecionados' }, 'selecionados'],
  ])(
    '400 LI_CORPO_INVALIDO for %s — with the switch ON, still nothing read',
    async (_c, corpo, campo) => {
      vi.stubEnv(CHAMADAS_ENV_LI, 'on');
      const res = await post(corpo);
      expect(res.status).toBe(400);
      const erro = erroContaLojaIntegradaSchema.parse(await corpoDe(res));
      expect(erro.code).toBe(CODIGO_ERRO_LI.corpoInvalido);
      if (campo !== '') expect(erro.issues).toContain(campo);
      expect(db.leituras).toEqual([]);
      expect(db.consultas).toEqual([]);
      expect(db.escritas).toEqual([]);
    },
  );

  it('400 for a body that is not JSON, with the fixed sentence', async () => {
    const res = await POST(
      requisicao('POST', `${CONTA}/importacoes`, { corpoBruto: '{modo' }),
      contexto(CONTA),
    );
    expect(res.status).toBe(400);
    expect(db.leituras).toEqual([]);
  });
});

describe('POST — the read switch FIRST', () => {
  it.each<[string, string | undefined]>([
    ['unset', undefined],
    ['off', 'off'],
    ['ON', 'ON'],
  ])(
    'switch %s ⇒ 503 LI_CHAMADAS_DESLIGADAS: zero fetches AND zero Firestore reads, and no job',
    async (_n, valor) => {
      vi.stubEnv(CHAMADAS_ENV_LI, valor);
      // Even a running job is not looked at: the switch answers before the guard.
      seedJobLi(db, 'jobVivo', CONTA, { status: 'executando' });
      const stdout = espiarStdout();
      let res: Response;
      let escritas: string[];
      try {
        res = await post();
        // Read BEFORE restoring: the restore clears the spy's calls.
        escritas = stdout.escritas();
      } finally {
        stdout.restaurar();
      }
      expect(res.status).toBe(503);
      expect(await corpoDe(res)).toMatchObject({ code: CODIGO_ERRO_LI.chamadasDesligadas });
      expect(db.leituras).toEqual([]);
      expect(db.consultas).toEqual([]);
      expect(db.escritas).toEqual([]);
      // ONE switch line, carrying the import's flow and this conta.
      const linhas = escritas.map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(linhas).toHaveLength(1);
      expect(linhas[0]).toMatchObject({
        evento: 'chamada-bloqueada',
        fluxo: 'importacao',
        conta: CONTA,
      });
    },
  );
});

describe('POST — the switch on: the conta, the guard, the create', () => {
  beforeEach(() => {
    vi.stubEnv(CHAMADAS_ENV_LI, 'on');
  });

  it('202 { jobId }: ONE create, pendente, with the caller’s uid — and no Loja Integrada call', async () => {
    const res = await post({ ...CORPO, modo: 'aplicar', alvo: 'naoNoErp' });
    expect(res.status).toBe(202);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const { jobId } = respostaInicioImportacaoLiSchema.parse(await corpoDe(res));
    expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([['create', caminhoJobLi(jobId)]]);
    const gravado = importacaoLojaIntegradaSchema.parse(db.ler(caminhoJobLi(jobId)));
    expect(gravado).toMatchObject({
      integracaoId: CONTA,
      iniciadoPor: ESCRITOR.uid,
      status: 'pendente',
      seq: 0,
      modo: 'aplicar',
      alvo: 'naoNoErp',
      acao: 'soVincular',
    });
  });

  it('409 LI_IMPORTACAO_EM_ANDAMENTO with the RUNNING job’s id, and nothing written', async () => {
    seedJobLi(db, 'jobVivo', CONTA, { status: 'pendente' });
    const res = await post();
    expect(res.status).toBe(409);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.importacaoEmAndamento,
      jobId: 'jobVivo',
    });
    expect(db.escritas).toEqual([]);
  });

  it('the conta’s own refusals: 404 for a missing conta, 409 for an inactive one — no job', async () => {
    const r404 = await post(CORPO, { conta: 'conta-li-sumida' });
    expect(r404.status).toBe(404);
    expect(await corpoDe(r404)).toMatchObject({ code: CODIGO_ERRO_LI.contaNaoEncontrada });
    seedConta(db, 'conta-li-inativa', { ativo: false });
    seedCredencial(db, 'conta-li-inativa');
    const r409 = await post(CORPO, { conta: 'conta-li-inativa' });
    expect(r409.status).toBe(409);
    expect(await corpoDe(r409)).toMatchObject({ code: CODIGO_ERRO_LI.contaInativa });
    expect(db.escritas).toEqual([]);
  });

  it('a Firestore failure on the guard is rethrown (a 500), never answered as a refusal', async () => {
    const falha = Object.assign(new Error('UNAVAILABLE'), { code: 14 });
    db.falharConsulta('importacoesLojaIntegrada', falha);
    await expect(post()).rejects.toBe(falha);
    expect(db.escritas).toEqual([]);
  });
});

describe('GET — the newest jobs, projected', () => {
  it('403 without integracao.read; 400 for a bad conta id; nothing read', async () => {
    h.verifyIdToken.mockResolvedValue(ESTRANHO);
    expect((await get()).status).toBe(403);
    h.verifyIdToken.mockResolvedValue(LEITOR);
    expect((await get({ conta: 'a.b' })).status).toBe(400);
    expect(db.consultas).toEqual([]);
  });

  it('200 with the switch OFF: no context, no credential read — the ERP only', async () => {
    h.verifyIdToken.mockResolvedValue(LEITOR);
    seedJobLi(db, 'jobNovo', CONTA, { status: 'executando', iniciadoEmMs: AGORA_MS + 10, seq: 5 });
    seedJobLi(db, 'jobVelho', CONTA, { status: 'concluido', iniciadoEmMs: AGORA_MS });
    seedJobLi(db, 'jobDeOutra', 'conta-li-outra', { iniciadoEmMs: AGORA_MS + 20 });
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const corpo = respostaImportacoesLiSchema.parse(await corpoDe(res));
    expect(corpo.importacoes.map((j) => [j.jobId, j.status])).toEqual([
      ['jobNovo', 'executando'],
      ['jobVelho', 'concluido'],
    ]);
    expect(JSON.stringify(await (await get()).json())).not.toContain('"seq"');
    expect(db.leituras).toEqual([]);
  });

  it('a conta with no job — or no conta at all — is an empty list', async () => {
    h.verifyIdToken.mockResolvedValue(LEITOR);
    const res = await get({ conta: 'conta-li-sem-nada' });
    expect(res.status).toBe(200);
    expect(await corpoDe(res)).toEqual({ importacoes: [] });
  });
});
