/**
 * `POST …/conta/[id]/estoque/reconciliar` — the operator's reconcile (master plan step 12, PR
 * 12-h), through the real core (`lib/lojaIntegrada/estoque/reconcile/reconcileManualLi.ts`) and the
 * real App Hosting root against the fake. The Admin singleton and `getFunctions` are mocked (a
 * recording Cloud Tasks that answers a repeated name with the SDK's own already-exists); `fetch`
 * throws for the whole file; the context loaders, the park, the pacer, the credential modules and
 * the package's client factories are tripwires.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { MissingRegionError } from '@delfrance/core/region';
import {
  CODIGO_ERRO_LI,
  FASE_RECONCILE_ESTOQUE_LI,
  erroContaLojaIntegradaSchema,
  respostaReconcileEstoqueLiSchema,
} from '@delfrance/schemas';

import { type DocData, FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { falhaDoFunctions } from '@/lib/lojaIntegrada/testing/falhaDeEnfileiramento';
import { seedContaComDeposito } from '@/lib/lojaIntegrada/testing/reconcileEstoqueLi';
import {
  ESCRITOR,
  LEITOR,
  contexto,
  espiarConsole,
  requisicao,
} from '@/lib/lojaIntegrada/testing/rotas';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  db: undefined as unknown,
  carregados: [] as string[],
  clientes: [] as string[],
  caminhos: [] as string[],
  tarefas: [] as { tarefa: unknown; opcoes: unknown }[],
  nomes: new Set<string>(),
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
          enqueue: async (tarefa: unknown, opcoes: { id: string }) => {
            await Promise.resolve();
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
    throw new Error(`a rota de reconcile não constrói ${nome}`);
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

const { POST } = await import('./route');

const CONTA = 'conta-li-reconcile';
const REGIAO = 'southamerica-east1';
const RUN = 'reconcileEstoqueLojaIntegrada/atual';
/** 2027-01-15T15:00:10Z. */
const AGORA = Date.UTC(2027, 0, 15, 15, 0, 10);
const MINUTO = Math.floor(AGORA / 60_000) * 60_000;
const ID = `estoque-reconcile-manual-${String(MINUTO)}`;

const post = (id = CONTA, o: { readonly semAuth?: boolean } = {}) =>
  POST(requisicao('POST', `${id}/estoque/reconciliar`, o), contexto(id));

function ambiente(over: Record<string, string | undefined> = {}): void {
  const base: Record<string, string | undefined> = {
    LOJA_INTEGRADA_MODO_ESTOQUE: 'dry-run',
    LOJA_INTEGRADA_CHAMADAS: undefined,
    LOJA_INTEGRADA_TASKS_DISABLED: undefined,
    LOJA_INTEGRADA_TASKS_REGION: REGIAO,
    FUNCTIONS_REGION: undefined,
    ...over,
  };
  for (const [k, v] of Object.entries(base)) vi.stubEnv(k, v);
}

function seedRun(over: DocData = {}): void {
  db.seed(RUN, {
    execucaoId: 'estoque-reconcile-20270115',
    iniciadoEmMs: AGORA - 3_600_000,
    emExecucaoAteMs: AGORA + 3_600_000,
    seq: 3,
    fase: FASE_RECONCILE_ESTOQUE_LI.li,
    contas: [CONTA],
    idxConta: 0,
    walk: null,
    candidatos: [],
    proximoSlotMs: null,
    contadores: {},
    ...over,
  });
}

async function corpoDe(res: Response): Promise<unknown> {
  return (await res.json()) as unknown;
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
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  fetchFalso = vi.fn(() => {
    throw new Error('a rota de reconcile não chama nada fora do ERP');
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

describe('POST …/estoque/reconciliar — the gates', () => {
  it('401 without a bearer token; 403 for integracao.read only; 400 for a bad id — nothing read', async () => {
    expect((await post(CONTA, { semAuth: true })).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(LEITOR);
    expect((await post()).status).toBe(403);
    h.verifyIdToken.mockResolvedValue(ESCRITOR);
    for (const id of ['a.b', 'a b', '']) {
      const res = await post(id);
      expect(res.status, id).toBe(400);
      expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res)).code).toBe(
        CODIGO_ERRO_LI.idInvalido,
      );
    }
    expect(db.leituras).toEqual([]);
    expect(h.tarefas).toEqual([]);
  });

  it.each([[undefined], ['off'], ['ON']])(
    '503 LI_ESTOQUE_DESLIGADO with the valve %j — zero reads, nothing enqueued',
    async (valvula) => {
      ambiente({ LOJA_INTEGRADA_MODO_ESTOQUE: valvula });
      const res = await post();
      expect(res.status).toBe(503);
      expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res)).code).toBe(
        CODIGO_ERRO_LI.estoqueDesligado,
      );
      expect(db.leituras).toEqual([]);
      expect(h.tarefas).toEqual([]);
    },
  );

  it("503 LI_TAREFAS_DESLIGADAS with TASKS_DISABLED '1' — zero reads; a missing region is a 500 before any read", async () => {
    ambiente({ LOJA_INTEGRADA_TASKS_DISABLED: '1' });
    const res = await post();
    expect(res.status).toBe(503);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res)).code).toBe(
      CODIGO_ERRO_LI.tarefasDesligadas,
    );
    ambiente({ LOJA_INTEGRADA_TASKS_REGION: undefined });
    await expect(post()).rejects.toBeInstanceOf(MissingRegionError);
    expect(db.leituras).toEqual([]);
    expect(h.caminhos).toEqual([]);
  });

  it.each([
    ['missing', 'conta-ausente', null, 404, CODIGO_ERRO_LI.contaNaoEncontrada],
    ['another channel', CONTA, { tipo: 99 }, 404, CODIGO_ERRO_LI.contaNaoEncontrada],
    ['inactive', CONTA, { ativo: false }, 409, CODIGO_ERRO_LI.contaInativa],
    ['with no depósito', CONTA, { depositoOuterRef: null }, 409, CODIGO_ERRO_LI.contaSemDeposito],
  ] as const)(
    'a conta %s ⇒ its status and code (the table): one read, nothing enqueued',
    async (_caso, id, over, status, codigo) => {
      if (over !== null) seedContaComDeposito(db, CONTA, 'documents/depositos/D1', over as DocData);
      const res = await post(id);
      expect(res.status).toBe(status);
      expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res)).code).toBe(codigo);
      expect(db.leituras).toEqual([`integracao/${id}`]);
      expect(h.tarefas).toEqual([]);
    },
  );
});

describe('POST …/estoque/reconciliar — 409 or 202', () => {
  it('a run HOLDING the lease ⇒ 409 LI_RECONCILE_EM_ANDAMENTO with ITS execucaoId; two reads (conta, masked run), nothing enqueued', async () => {
    seedRun();
    const res = await post();
    expect(res.status).toBe(409);
    expect(erroContaLojaIntegradaSchema.parse(await corpoDe(res))).toMatchObject({
      code: CODIGO_ERRO_LI.reconcileEmAndamento,
      execucaoId: 'estoque-reconcile-20270115',
    });
    expect(db.leituras).toEqual([`integracao/${CONTA}`, RUN]);
    expect(h.tarefas).toEqual([]);
  });

  it.each([
    ['no run document', null],
    ['a free lease', { emExecucaoAteMs: 0 }],
    ['an expired lease', { emExecucaoAteMs: AGORA - 1 }],
    ['a run started more than 48 h ago', { iniciadoEmMs: AGORA - 48 * 3_600_000 - 1 }],
    [
      'a run released THIS minute (its slice will adiar; the queue retries)',
      { emExecucaoAteMs: 0, iniciadoEmMs: MINUTO },
    ],
  ])(
    '%s ⇒ 202 with the minute’s run id: ONE task on the reads queue, seq 0, no delay',
    async (_caso, over) => {
      if (over !== null) seedRun(over);
      const res = await post();
      expect(res.status).toBe(202);
      expect(res.headers.get('Cache-Control')).toBe('no-store');
      expect(respostaReconcileEstoqueLiSchema.parse(await corpoDe(res))).toMatchObject({
        execucaoId: ID,
        modo: 'dry-run',
        chamadas: false,
      });
      expect(h.caminhos).toEqual([`locations/${REGIAO}/functions/filaLeituraLojaIntegrada`]);
      expect(h.tarefas).toEqual([
        {
          tarefa: { tipo: 'estoque-reconcile', execucaoId: ID, seq: 0 },
          opcoes: { id: `li-${ID}-0` },
        },
      ]);
      expect(db.escritas).toEqual([]);
    },
  );

  it('⚠️ the read switch is NOT a gate: off, the run is still enqueued (the ERP side runs); on, the answer says so', async () => {
    ambiente({ LOJA_INTEGRADA_CHAMADAS: 'off' });
    expect((await post()).status).toBe(202);
    ambiente({ LOJA_INTEGRADA_CHAMADAS: 'on', LOJA_INTEGRADA_MODO_ESTOQUE: 'on' });
    vi.setSystemTime(MINUTO + 60_000);
    const resposta = respostaReconcileEstoqueLiSchema.parse(await corpoDe(await post()));
    expect(resposta).toMatchObject({ chamadas: true, modo: 'on' });
    expect(h.tarefas).toHaveLength(2);
  });

  it('a repeat in the same minute: the same task (already-exists) and the same 202', async () => {
    const a = respostaReconcileEstoqueLiSchema.parse(await corpoDe(await post()));
    vi.setSystemTime(AGORA + 40_000);
    const b = respostaReconcileEstoqueLiSchema.parse(await corpoDe(await post()));
    expect(a.execucaoId).toBe(ID);
    expect(b.execucaoId).toBe(ID);
    expect(h.tarefas).toHaveLength(1);
  });

  it('ONE structured INFO line per answer, ids only — nothing on the console', async () => {
    const escritas: string[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation((t) => {
      escritas.push(String(t));
      return true;
    });
    await post();
    stdout.mockRestore();
    const linhas = escritas
      .filter((l) => l.includes('[loja-integrada/estoque] reconcile manual'))
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      severity: 'INFO',
      integracaoId: CONTA,
      execucaoId: ID,
      modo: 'dry-run',
    });
    expect(console_.argumentos()).toEqual([]);
  });
});

describe('the permission bit', () => {
  it('is the conta writes’ own (integracao.write)', () => {
    expect(BigInt(ESCRITOR.permissions) & PERM.integracao.write).toBe(PERM.integracao.write);
    expect(BigInt(LEITOR.permissions) & PERM.integracao.write).toBe(0n);
  });
});
