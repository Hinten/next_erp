/**
 * `POST /api/marketplace/loja-integrada/enviar-estoque` — the manual stock push (master plan step
 * 12, PR 12-h), through the real core (`lib/lojaIntegrada/estoque/envioManualEstoqueLi.ts`) and the
 * real App Hosting root (`lib/firebase/filasLi.ts`) against the fake.
 *
 * It mocks the Admin singleton (`verifyIdToken`, the Firestore handle, the app) and the Admin SDK's
 * `getFunctions` (a recording Cloud Tasks that answers a repeated name with the SDK's own
 * already-exists), and stubs the global `fetch` to THROW for the whole file: the route makes no
 * call outside the ERP. The Loja Integrada package is the REAL one with every client factory
 * replaced by a tripwire (the link reader's module loads it for its constants), and the context
 * loaders, the park, the pacer, the credential modules and the send run are tripwires that flag
 * themselves if anything in the route's graph loads them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MissingRegionError } from '@delfrance/core/region';
import {
  CODIGO_ERRO_LI,
  ORIGEM_TAREFA_ESTOQUE_LI,
  RESULTADO_ENVIO_ESTOQUE_LI,
  erroContaLojaIntegradaSchema,
  respostaEnvioEstoqueLiSchema,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { falhaDoFunctions } from '@/lib/lojaIntegrada/testing/falhaDeEnfileiramento';
import {
  seedContaComDeposito,
  seedLinkFilho,
} from '@/lib/lojaIntegrada/testing/reconcileEstoqueLi';
import { ESCRITOR, LEITOR, espiarConsole } from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
  carregados: [] as string[],
  clientes: [] as string[],
  caminhos: [] as string[],
  tarefas: [] as { tarefa: unknown; opcoes: { id: string; scheduleTime?: Date } }[],
  nomes: new Set<string>(),
  falha: null as Error | null,
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
  getAdminApp: () => ({ name: 'app-de-teste' }),
}));
vi.mock('firebase-admin/functions', async (importOriginal) => {
  const original = await importOriginal<typeof import('firebase-admin/functions')>();
  return {
    ...original,
    getFunctions: () => ({
      taskQueue: (caminho: string) => {
        h.caminhos.push(caminho);
        return {
          enqueue: async (tarefa: unknown, opcoes: { id: string; scheduleTime?: Date }) => {
            await Promise.resolve();
            if (h.falha !== null) throw h.falha;
            if (h.nomes.has(opcoes.id)) throw falhaDoFunctions('task-already-exists', 409);
            h.nomes.add(opcoes.id);
            h.tarefas.push({ tarefa, opcoes });
          },
        };
      },
    }),
  };
});
vi.mock('@delfrance/integrations-loja-integrada', async (importOriginal) => {
  const original = await importOriginal<typeof import('@delfrance/integrations-loja-integrada')>();
  const armadilha = (nome: string) => () => {
    h.clientes.push(nome);
    throw new Error(`a rota de estoque não constrói ${nome}`);
  };
  return {
    ...original,
    criarClienteLeituraLi: armadilha('criarClienteLeituraLi'),
    criarClienteEscritaLi: armadilha('criarClienteEscritaLi'),
    validarPersonalToken: armadilha('validarPersonalToken'),
    criarLeitorCdnLi: armadilha('criarLeitorCdnLi'),
  };
});
for (const modulo of [
  'contexto',
  'contextoEscrita',
  'estacionamento',
  'ritmo',
  'credentialStore',
  'credencial',
  'contas',
]) {
  vi.doMock(`@/lib/lojaIntegrada/core/${modulo}`, () => {
    h.carregados.push(`core/${modulo}`);
    return {};
  });
}
vi.mock('@/lib/lojaIntegrada/estoque/processarEstoque', () => {
  h.carregados.push('estoque/processarEstoque');
  return {};
});

const { POST } = await import('./route');

const URL_ROTA = 'http://localhost:3010/api/marketplace/loja-integrada/enviar-estoque';
const CONTA = 'conta-li-envio';
const REGIAO = 'southamerica-east1';
/** 2027-01-15T15:00:10Z. */
const AGORA = Date.UTC(2027, 0, 15, 15, 0, 10);

function post(corpo: unknown, o: { readonly semAuth?: boolean; readonly bruto?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (o.semAuth !== true) headers.authorization = 'Bearer id-token-de-teste';
  return POST(
    new Request(URL_ROTA, { method: 'POST', headers, body: o.bruto ?? JSON.stringify(corpo) }),
  );
}

const corpo = (produtoIds: readonly string[] = ['pai-1']) => ({ contaId: CONTA, produtoIds });

function seedFamilia(db: FakeDb): void {
  db.seed('produtos/pai-1', { nome: 'Pai', paiId: null, integracoesComProduto: [CONTA] });
  for (const [id, idLi] of [
    ['f1', 101],
    ['f2', 102],
  ] as const) {
    db.seed(`produtos/${id}`, {
      nome: `Filho ${id}`,
      paiId: 'pai-1',
      integracoesComProduto: [CONTA],
    });
    seedLinkFilho(db, id, `l-${id}`, CONTA, idLi);
  }
}

function ambiente(over: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    LOJA_INTEGRADA_MODO_ESTOQUE: 'on',
    LOJA_INTEGRADA_CHAMADAS: 'on',
    LOJA_INTEGRADA_TASKS_DISABLED: undefined,
    LOJA_INTEGRADA_TASKS_REGION: REGIAO,
    FUNCTIONS_REGION: undefined,
    ...over,
  };
  for (const [k, v] of Object.entries(base)) vi.stubEnv(k, v);
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
}

async function codigoDe(res: Response): Promise<string> {
  return erroContaLojaIntegradaSchema.parse(await corpoDe(res)).code;
}

let db: FakeDb;
let fetchFalso: ReturnType<typeof vi.fn>;
let console_: ReturnType<typeof espiarConsole>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA);
  db = new FakeDb();
  h.db = asDb(db);
  h.caminhos.length = 0;
  h.tarefas.length = 0;
  h.nomes.clear();
  h.falha = null;
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  fetchFalso = vi.fn(() => {
    throw new Error('a rota de envio de estoque não chama nada fora do ERP');
  });
  vi.stubGlobal('fetch', fetchFalso);
  console_ = espiarConsole();
  ambiente();
  seedContaComDeposito(db, CONTA, 'documents/depositos/D1');
});

afterEach(() => {
  console_.restaurar();
  expect(fetchFalso).not.toHaveBeenCalled();
  expect(h.carregados).toEqual([]);
  expect(h.clientes).toEqual([]);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('POST …/enviar-estoque — the refusal ladder (each before any read, nothing enqueued)', () => {
  it('401 without a bearer token; 403 for integracao.read only — nothing read', async () => {
    seedFamilia(db);
    expect((await post(corpo(), { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(LEITOR);
    expect((await post(corpo())).status).toBe(403);
    expect(db.leituras).toEqual([]);
    expect(db.consultas).toEqual([]);
    expect(h.tarefas).toEqual([]);
  });

  it.each([
    ['not JSON', undefined, 'não é json'],
    ['an extra key (reenviarComErro)', { ...corpo(), reenviarComErro: true }, undefined],
    ['no ids', { contaId: CONTA, produtoIds: [] }, undefined],
    [
      '201 ids',
      { contaId: CONTA, produtoIds: Array.from({ length: 201 }, (_, i) => `p${String(i)}`) },
      undefined,
    ],
    ['a path-shaped id', { contaId: CONTA, produtoIds: ['a/b'] }, undefined],
    ['a dotted conta id', { contaId: 'a.b', produtoIds: ['p'] }, undefined],
  ])('400 LI_CORPO_INVALIDO for %s', async (_caso, c, bruto) => {
    const res = await post(c, bruto === undefined ? {} : { bruto });
    expect(res.status).toBe(400);
    expect(await codigoDe(res)).toBe(CODIGO_ERRO_LI.corpoInvalido);
    expect(db.leituras).toEqual([]);
  });

  it.each([
    [undefined, 0],
    ['', 0],
    ['off', 0],
    ['ON', 1],
    [' on', 1],
    ['true', 1],
  ])(
    '503 LI_ESTOQUE_DESLIGADO with the stock valve %j — zero reads, zero enqueues, %i valve line(s)',
    async (valvula, linhasDaValvula) => {
      ambiente({ LOJA_INTEGRADA_MODO_ESTOQUE: valvula });
      seedFamilia(db);
      const escritas: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
        escritas.push(String(t));
        return true;
      });
      const res = await post(corpo());
      stdout.mockRestore();
      // A value merely off is the expected state; an unrecognised one is a misconfiguration line.
      expect(escritas.filter((l) => l.includes('"evento":"valvula"'))).toHaveLength(
        linhasDaValvula,
      );
      expect(res.status).toBe(503);
      expect(await codigoDe(res)).toBe(CODIGO_ERRO_LI.estoqueDesligado);
      expect(db.leituras).toEqual([]);
      expect(db.consultas).toEqual([]);
      expect(h.tarefas).toEqual([]);
    },
  );

  it.each([[undefined], ['off'], ['ON'], [' on'], ['true']])(
    '503 LI_CHAMADAS_DESLIGADAS with the read switch %j (valve on) — one chamada-bloqueada line, zero reads',
    async (chave) => {
      ambiente({ LOJA_INTEGRADA_CHAMADAS: chave });
      seedFamilia(db);
      const escritas: string[] = [];
      const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
        escritas.push(String(t));
        return true;
      });
      const res = await post(corpo());
      stdout.mockRestore();
      expect(res.status).toBe(503);
      expect(await codigoDe(res)).toBe(CODIGO_ERRO_LI.chamadasDesligadas);
      expect(escritas.filter((l) => l.includes('chamada-bloqueada'))).toHaveLength(1);
      expect(db.leituras).toEqual([]);
      expect(h.tarefas).toEqual([]);
    },
  );

  it('the valve comes FIRST: with the valve AND the read switch off the answer is LI_ESTOQUE_DESLIGADO, with no chamada-bloqueada line', async () => {
    ambiente({ LOJA_INTEGRADA_MODO_ESTOQUE: undefined, LOJA_INTEGRADA_CHAMADAS: undefined });
    seedFamilia(db);
    const escritas: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
      escritas.push(String(t));
      return true;
    });
    const res = await post(corpo());
    stdout.mockRestore();
    expect(res.status).toBe(503);
    expect(await codigoDe(res)).toBe(CODIGO_ERRO_LI.estoqueDesligado);
    expect(escritas.filter((l) => l.includes('chamada-bloqueada'))).toEqual([]);
    expect(db.leituras).toEqual([]);
    expect(h.tarefas).toEqual([]);
  });

  it("503 LI_TAREFAS_DESLIGADAS with TASKS_DISABLED exactly '1'; ⚠️ ' 1' leaves it open", async () => {
    seedFamilia(db);
    ambiente({ LOJA_INTEGRADA_TASKS_DISABLED: '1' });
    const res = await post(corpo());
    expect(res.status).toBe(503);
    expect(await codigoDe(res)).toBe(CODIGO_ERRO_LI.tarefasDesligadas);
    expect(db.leituras).toEqual([]);
    ambiente({ LOJA_INTEGRADA_TASKS_DISABLED: ' 1' });
    expect((await post(corpo())).status).toBe(200);
  });

  it('a missing region is a 500 (MissingRegionError) BEFORE any read — never a guessed queue', async () => {
    ambiente({ LOJA_INTEGRADA_TASKS_REGION: undefined, FUNCTIONS_REGION: undefined });
    seedFamilia(db);
    await expect(post(corpo())).rejects.toBeInstanceOf(MissingRegionError);
    expect(db.leituras).toEqual([]);
    expect(h.caminhos).toEqual([]);
  });
});

describe('POST …/enviar-estoque — the conta (ONE uncached read)', () => {
  it.each([
    ['missing', null, 404, CODIGO_ERRO_LI.contaNaoEncontrada],
    ['another channel', { tipo: 99 }, 404, CODIGO_ERRO_LI.contaNaoEncontrada],
    ['inactive', { ativo: false }, 409, CODIGO_ERRO_LI.contaInativa],
    ['with no depósito', { depositoOuterRef: null }, 409, CODIGO_ERRO_LI.contaSemDeposito],
  ] as const)(
    'a conta %s ⇒ its status and code (the table): one read, nothing enqueued',
    async (_caso, over, status, codigo) => {
      seedFamilia(db);
      const contaId = over === null ? 'conta-ausente' : CONTA;
      if (over !== null) seedContaComDeposito(db, CONTA, 'documents/depositos/D1', over as DocData);
      const res = await post({ contaId, produtoIds: ['pai-1'] });
      expect(res.status).toBe(status);
      expect(await codigoDe(res)).toBe(codigo);
      expect(db.leituras).toEqual([`integracao/${contaId}`]);
      expect(db.consultas).toEqual([]);
      expect(h.tarefas).toEqual([]);
    },
  );
});

describe('POST …/enviar-estoque — the push', () => {
  it('200: an anchor expands to its two linked children, two tasks on the stock queue (origem manual), rows say enfileirado — never enviado', async () => {
    seedFamilia(db);
    const res = await post(corpo());
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const texto = JSON.stringify(await corpoDe(res.clone()));
    const resposta = respostaEnvioEstoqueLiSchema.parse(await corpoDe(res));

    expect(resposta.listings.map((l) => [l.produtoId, l.resultado])).toEqual([
      ['f1', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado],
      ['f2', RESULTADO_ENVIO_ESTOQUE_LI.enfileirado],
    ]);
    expect(texto).not.toContain('"enviado"');
    expect(texto).not.toContain('enviado');
    expect(h.caminhos).toEqual([
      `locations/${REGIAO}/functions/filaEstoqueLojaIntegrada`,
      `locations/${REGIAO}/functions/filaEstoqueLojaIntegrada`,
    ]);
    expect(h.tarefas.map((t) => t.tarefa)).toEqual(
      ['f1', 'f2'].map((produtoId) =>
        expect.objectContaining({ produtoId, origem: ORIGEM_TAREFA_ESTOQUE_LI.manual }),
      ),
    );
    // The conta read and the selection's ONE getAll: no other document read.
    expect(db.leituras).toEqual([`integracao/${CONTA}`, 'produtos/pai-1']);
    expect(db.escritas).toEqual([]);
  });

  it('a double click in the same minute: the same task names, the second met by already-exists — both 200 enfileirado', async () => {
    seedFamilia(db);
    const a = respostaEnvioEstoqueLiSchema.parse(await corpoDe(await post(corpo())));
    vi.setSystemTime(AGORA + 30_000);
    const b = respostaEnvioEstoqueLiSchema.parse(await corpoDe(await post(corpo())));
    expect(h.tarefas).toHaveLength(2);
    for (const r of [a, b]) {
      expect(r.listings.every((l) => l.resultado === RESULTADO_ENVIO_ESTOQUE_LI.enfileirado)).toBe(
        true,
      );
    }
  });

  it('dry-run valve with the switch on also enqueues — the answer says modo dry-run', async () => {
    ambiente({ LOJA_INTEGRADA_MODO_ESTOQUE: 'dry-run' });
    seedFamilia(db);
    const resposta = respostaEnvioEstoqueLiSchema.parse(await corpoDe(await post(corpo())));
    expect(resposta.modo).toBe('dry-run');
    expect(h.tarefas).toHaveLength(2);
  });

  it('a transient Cloud Tasks failure is each row’s falha (200); a deploy-shaped one is a 500', async () => {
    seedFamilia(db);
    h.falha = falhaDoFunctions('unknown-error', 503);
    const resposta = respostaEnvioEstoqueLiSchema.parse(await corpoDe(await post(corpo())));
    expect(resposta.listings.map((l) => l.resultado)).toEqual([
      RESULTADO_ENVIO_ESTOQUE_LI.falha,
      RESULTADO_ENVIO_ESTOQUE_LI.falha,
    ]);
    h.falha = falhaDoFunctions('permission-denied', 403);
    await expect(post(corpo())).rejects.toMatchObject({ code: 'functions/permission-denied' });
  });

  it('400 LI_SELECAO_EXCEDE_LIMITE (limite, encontrados) for a family over the bound — nothing listed or enqueued', async () => {
    db.seed('produtos/grande', { nome: 'G', paiId: null, integracoesComProduto: [CONTA] });
    for (let i = 0; i < 40; i += 1) {
      db.seed(`produtos/g${String(i)}`, {
        nome: 'x',
        paiId: 'grande',
        integracoesComProduto: [CONTA],
      });
    }
    const res = await post(corpo(['grande']));
    expect(res.status).toBe(400);
    const envelope = erroContaLojaIntegradaSchema.parse(await corpoDe(res));
    expect(envelope).toMatchObject({
      code: CODIGO_ERRO_LI.selecaoExcedeLimite,
      limite: 30,
      encontrados: 31,
    });
    expect(db.consultas.filter((c) => c.colecao.endsWith('/produtolojaintegrada'))).toEqual([]);
    expect(h.tarefas).toEqual([]);
  });

  it('ONE structured INFO line per answer, ids and counts only — nothing on the console', async () => {
    seedFamilia(db);
    const escritas: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
      escritas.push(String(t));
      return true;
    });
    await post(corpo());
    stdout.mockRestore();
    const linhas = escritas
      .filter((l) => l.includes('[loja-integrada/enviar-estoque]'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      severity: 'INFO',
      integracaoId: CONTA,
      modo: 'on',
      enfileirados: 2,
      alvos: 2,
    });
    expect(JSON.stringify(linhas)).not.toContain('Filho');
    expect(console_.argumentos()).toEqual([]);
  });
});
