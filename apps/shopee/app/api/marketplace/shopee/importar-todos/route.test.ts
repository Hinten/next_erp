import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { importacaoShopeeOptionsSchema } from '@delfrance/schemas';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { ShopeeMassImportTasksDisabledError } from '@/lib/shopee/produtos/errosImportacao';
import {
  MSG_VALVULA_FECHADA,
  ShopeeImportacaoEmAndamentoError,
} from '@/lib/shopee/produtos/importacaoMassa';
import { FakeDb, asDb, type DocData } from '@/lib/shopee/testing/fakeDb';

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  enqueue: vi.fn(),
  db: { atual: null as unknown },
}));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db.atual,
}));

vi.mock('@/lib/shopee/core/shopee', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/core/shopee')>();
  return { ...actual, loadShopeeContext: h.loadCtx };
});

vi.mock('@/lib/shopee/produtos/shopeeMassImportTasks', () => ({
  createShopeeMassImportScheduler: () => ({ enqueue: h.enqueue }),
}));

const { POST } = await import('./route');

const INT_A = 'int-1';
const COL = 'importacoesShopee';
const AGORA_MS = 1_757_000_000_000;

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/importar-todos', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

/** Ids under `importacoesShopee` — the collection mutant 20 must leave empty. */
function jobs(db: FakeDb): string[] {
  return db.idsEm(COL);
}

function docDoJob(db: FakeDb): DocData {
  const id = jobs(db)[0];
  if (id === undefined) throw new Error('nenhum job foi criado');
  const doc = db.store[`${COL}/${id}`]?.data;
  if (!doc) throw new Error('o job criado não está no fake');
  return doc;
}

let db: FakeDb;
let spyWarn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadCtx.mockResolvedValue({ integracaoId: INT_A });
  h.enqueue.mockResolvedValue(undefined);
  vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
  spyWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  spyWarn.mockRestore();
});

describe('autenticação e corpo', () => {
  it('responde 401 sem o cabeçalho Authorization', async () => {
    expect((await POST(req({ integracaoId: INT_A }))).status).toBe(401);
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req({ integracaoId: INT_A }, AUTORIZADO))).status).toBe(403);
  });

  it('responde 400 para um body JSON malformado, sem criar job', async () => {
    const res = await POST(req('{"integracaoId":', AUTORIZADO));

    expect(res.status).toBe(400);
    expect(jobs(db)).toHaveLength(0);
  });

  it('responde 400 com SHOPEE_IMPORT_STATUS_RECUSADO para um status apagado', async () => {
    const res = await POST(
      req({ integracaoId: INT_A, options: { statuses: ['NORMAL', 'SELLER_DELETE'] } }, AUTORIZADO),
    );

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_IMPORT_STATUS_RECUSADO' });
    expect(jobs(db)).toHaveLength(0);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe('a válvula é lida ANTES de qualquer criação', () => {
  it('válvula fechada responde 503 e NÃO cria job', async () => {
    // Mutante 20: mover esta checagem para depois de `iniciarImportacaoShopee`
    // deixa um job `running` sem worker, e como o guard de início não tem limite
    // de idade o botão passa a responder 409 para sempre.
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');

    const res = await POST(req({ integracaoId: INT_A }, AUTORIZADO));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: MSG_VALVULA_FECHADA,
      code: 'SHOPEE_MASS_IMPORT_ENQUEUE_FAILED',
    });
    expect(jobs(db)).toHaveLength(0);
    expect(db.writes).toHaveLength(0);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

describe('a conta precisa existir', () => {
  it('uma conta de outro tipo (ou inexistente) responde 404 e não cria job', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));

    const res = await POST(req({ integracaoId: INT_A }, AUTORIZADO));

    expect(res.status).toBe(404);
    expect(jobs(db)).toHaveLength(0);
  });
});

describe('uma importação por conta de cada vez', () => {
  function semearRunning(): void {
    db.seed(`${COL}/job-antigo`, {
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
    });
  }

  it('um job em andamento responde 409 SHOPEE_MASS_IMPORT_RUNNING', async () => {
    semearRunning();

    const res = await POST(req({ integracaoId: INT_A }, AUTORIZADO));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ code: 'SHOPEE_MASS_IMPORT_RUNNING' });
    expect(jobs(db)).toEqual(['job-antigo']);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('⛔ o braço genérico responderia 500: o catch explícito é o que dá o 409', async () => {
    // `ShopeeImportacaoEmAndamentoError` estende `ShopeeError` e `respond.ts`
    // não o conhece, então sem o catch explícito da rota uma condição
    // perfeitamente normal sairia como uma indisponibilidade NOSSA.
    const err = new ShopeeImportacaoEmAndamentoError('já existe uma importação em andamento');

    expect(isShopeeError(err)).toBe(true);
    const generico = shopeeErrorResponse(err);
    expect(generico.status).toBe(500);
    await expect(generico.json()).resolves.toMatchObject({ code: 'SHOPEE_ERROR' });
  });
});

describe('o enfileiramento', () => {
  it('responde 202 com o jobId e enfileira exatamente { jobId, integracaoId }', async () => {
    const res = await POST(req({ integracaoId: INT_A }, AUTORIZADO));

    expect(res.status).toBe(202);
    const corpo = (await res.json()) as { jobId: string };
    expect(jobs(db)).toEqual([corpo.jobId]);
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue).toHaveBeenCalledWith({ jobId: corpo.jobId, integracaoId: INT_A });
  });

  it('grava as options saneadas no documento do job', async () => {
    await POST(req({ integracaoId: INT_A, options: { importarFotos: false } }, AUTORIZADO));

    expect(docDoJob(db)).toMatchObject({
      integracaoId: INT_A,
      status: 'running',
      options: expect.objectContaining({ importarFotos: false, statuses: ['NORMAL', 'UNLIST'] }),
    });
  });

  it('uma falha de enfileiramento responde 503 COM o job carimbado failed', async () => {
    h.enqueue.mockRejectedValue(new ShopeeMassImportTasksDisabledError());

    const res = await POST(req({ integracaoId: INT_A }, AUTORIZADO));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: 'SHOPEE_MASS_IMPORT_ENQUEUE_FAILED',
      error: MSG_VALVULA_FECHADA,
    });
    expect(docDoJob(db)).toMatchObject({ status: 'failed', erro: MSG_VALVULA_FECHADA });
  });

  it('⛔ o erro carimbado é o NOME da classe, nunca a mensagem do transporte', async () => {
    // O campo `erro` é persistido e mostrado ao operador: uma mensagem de
    // transporte pode carregar url, corpo ou credencial.
    h.enqueue.mockRejectedValue(new TypeError('queue https://tasks/…?token=abc recusou'));

    const res = await POST(req({ integracaoId: INT_A }, AUTORIZADO));

    expect(res.status).toBe(503);
    const doc = docDoJob(db);
    expect(doc).toMatchObject({ status: 'failed' });
    expect(String(doc['erro'])).toContain('TypeError');
    expect(String(doc['erro'])).not.toContain('token=abc');
  });

  it('uma falha ao CARIMBAR ainda produz o 503, com um aviso no log', async () => {
    h.enqueue.mockRejectedValue(new ShopeeMassImportTasksDisabledError());
    // O carimbo terminal passa por uma transação; derrubá-la é o que prova que
    // o 503 não depende dela.
    db.occ.beforeCommit = () => {
      throw new Error('firestore indisponível');
    };

    const res = await POST(req({ integracaoId: INT_A }, AUTORIZADO));

    expect(res.status).toBe(503);
    expect(spyWarn).toHaveBeenCalled();
  });
});
