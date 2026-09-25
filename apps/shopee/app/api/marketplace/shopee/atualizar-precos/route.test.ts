import { readFileSync } from 'node:fs';
import { FirebaseAppError } from 'firebase-admin/app';
import { FirebaseFunctionsError } from 'firebase-admin/functions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PERM } from '@delfrance/auth';
import { MissingRegionError } from '@delfrance/core/region';

import { ShopeeContaNotConfiguredError } from '@/lib/shopee/core/shopee';
import { isShopeeError, shopeeErrorResponse } from '@/lib/shopee/core/respond';
import { MOTIVOS_DE_PAUSA } from '@/lib/shopee/estoque/constantesEstoque';
import {
  CODIGO_ENVIO_PRECO_EM_ANDAMENTO,
  CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU,
  CODIGO_GUARDA_PRECO,
  MENSAGEM_POR_MOTIVO_PRECO,
  MOTIVO_PRECO_SHOPEE,
  ShopeeEnvioPrecoEmAndamentoError,
  ShopeePriceSyncTasksDisabledError,
} from '@/lib/shopee/precos/errosPreco';
import type { ContextoContaPreco } from '@/lib/shopee/precos/regiaoPreco';
import { FakeDb, asDb, grpc, type DocData } from '@/lib/shopee/testing/fakeDb';

/**
 * `POST /api/marketplace/shopee/atualizar-precos` (#1521, step 13 PR 2;
 * reconcile §2.11, C-j, D2 §3.6). The job module runs for REAL against the
 * shared double — the start's query, the document it creates, the terminal
 * transaction an enqueue failure stamps through — so every "no document was
 * created" below is a read of the store, never a mock that was not called.
 */

const h = vi.hoisted(() => ({
  verifyIdToken: vi.fn(),
  loadCtx: vi.fn(),
  avaliar: vi.fn(),
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

vi.mock('@/lib/shopee/precos/regiaoPreco', async (importActual) => {
  const actual = await importActual<typeof import('@/lib/shopee/precos/regiaoPreco')>();
  return { ...actual, avaliarContaParaPreco: h.avaliar };
});

vi.mock('@/lib/shopee/precos/shopeePriceSyncTasks', () => ({
  createShopeePriceSyncScheduler: () => ({ enqueue: h.enqueue }),
}));

const { POST, MSG_FILA_DE_PRECO_DESABILITADA, MSG_ENVIO_PRECO_EM_ANDAMENTO } =
  await import('./route');

/* --------------------------------- fixtures ------------------------------- */

const INT = 'int-1';
const COL = 'enviosPrecoShopee';
const AGORA_MS = 1_757_000_000_000;
const DIA_MS = 24 * 60 * 60 * 1000;
const TABELA_REF = 'documents/listaDePrecos/lp-1';

const ESCRITOR = { uid: 'u1', permissions: PERM.integracao.write.toString() };
const AUTORIZADO = { authorization: 'Bearer t' };

/** A context that passed the verdict — branded, so only a cast builds one here. */
const CONTEXTO = {
  integracaoId: INT,
  client: {},
  regiao: 'BR',
  moeda: 'BRL',
  multiplo: 5,
  tabelaNormalId: 'lp-1',
} as unknown as ContextoContaPreco;

function req(corpo: unknown, headers: Record<string, string> = {}): Request {
  return new Request('http://localhost:3009/api/marketplace/shopee/atualizar-precos', {
    method: 'POST',
    headers,
    body: typeof corpo === 'string' ? corpo : JSON.stringify(corpo),
  });
}

function ctxDouble(conta: Record<string, unknown> = {}) {
  return {
    integracaoId: INT,
    conta: {
      tipo: 9,
      shop_id: 987_654,
      nome: 'Loja teste',
      tabelaNormalOuterRef: TABELA_REF,
      ...conta,
    },
    config: { sandbox: false },
    createShopClient: () => ({}),
  };
}

function jobs(db: FakeDb): string[] {
  return db.idsEm(COL);
}

function doc(db: FakeDb, caminho: string): DocData {
  const d = db.store[caminho]?.data;
  if (!d) throw new Error(`fixture: ${caminho} não está no fake`);
  return d;
}

/** A live job: its `updatedAt` is five seconds old, so it is no orphan. */
function semearJob(db: FakeDb, id: string, over: DocData = {}): void {
  db.seed(`${COL}/${id}`, {
    integracaoId: INT,
    status: 'running',
    startedAt: AGORA_MS - 5000,
    updatedAt: AGORA_MS - 5000,
    ...over,
  });
}

let db: FakeDb;

beforeEach(() => {
  vi.clearAllMocks();
  db = new FakeDb();
  h.db.atual = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  h.loadCtx.mockResolvedValue(ctxDouble());
  h.avaliar.mockResolvedValue({ ok: true, contexto: CONTEXTO });
  h.enqueue.mockResolvedValue(undefined);
  vi.stubEnv('SHOPEE_TASKS_DISABLED', '');
  vi.spyOn(Date, 'now').mockReturnValue(AGORA_MS);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/* --------------------------------- (1) auth -------------------------------- */

describe('(1) autenticação', () => {
  it('responde 401 sem o cabeçalho, sem ler nada nem criar job', async () => {
    expect((await POST(req({ integracaoId: INT }))).status).toBe(401);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(jobs(db)).toEqual([]);
  });

  it('responde 403 para quem não tem integracao.write', async () => {
    h.verifyIdToken.mockResolvedValue({ uid: 'u1', permissions: '0' });
    expect((await POST(req({ integracaoId: INT }, AUTORIZADO))).status).toBe(403);
    expect(jobs(db)).toEqual([]);
  });
});

/* --------------------------------- (2) body -------------------------------- */

describe('(2) o corpo', () => {
  it.each([
    ['JSON malformado', '{"integracaoId":'],
    ['corpo null', null],
    ['corpo array', []],
    ['corpo escalar', 42],
    ['integracaoId ausente', {}],
    ['integracaoId vazio', { integracaoId: '' }],
    ['integracaoId com separador', { integracaoId: 'a/b' }],
    ['integracaoId relativo', { integracaoId: '..' }],
    ['integracaoId não-string verdadeiro', { integracaoId: 7 }],
    ['baixarPreco texto', { integracaoId: INT, baixarPreco: 'true' }],
    ['baixarPreco número', { integracaoId: INT, baixarPreco: 1 }],
    ['baixarPreco null', { integracaoId: INT, baixarPreco: null }],
  ])('%s ⇒ 400, e nada é lido nem criado', async (_nome, corpo) => {
    const res = await POST(req(corpo, AUTORIZADO));

    expect(res.status).toBe(400);
    expect(typeof ((await res.json()) as { error: unknown }).error).toBe('string');
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(jobs(db)).toEqual([]);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('(M3) `baixarPreco` AUSENTE chega ao job como FALSE; `true` chega como TRUE', async () => {
    const ausente = (await (await POST(req({ integracaoId: INT }, AUTORIZADO))).json()) as {
      jobId: string;
    };
    expect(doc(db, `${COL}/${ausente.jobId}`)['baixarPreco']).toBe(false);

    // A second start needs the first one gone: it is still `running`.
    db = new FakeDb();
    h.db.atual = asDb(db);
    const verdadeiro = (await (
      await POST(req({ integracaoId: INT, baixarPreco: true }, AUTORIZADO))
    ).json()) as { jobId: string };
    expect(doc(db, `${COL}/${verdadeiro.jobId}`)['baixarPreco']).toBe(true);
  });
});

/* -------------------------------- (3) valve -------------------------------- */

describe('(3) a válvula é lida ANTES de qualquer leitura ou criação (M27)', () => {
  it('SHOPEE_TASKS_DISABLED=1 ⇒ 503 SHOPEE_PRICE_SYNC_ENQUEUE_FAILED, ZERO documentos, zero conta, zero veredito', async () => {
    vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: MSG_FILA_DE_PRECO_DESABILITADA,
      code: CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU,
    });
    expect(db.writes).toEqual([]);
    expect(db.caminhos).toEqual([]);
    expect(h.loadCtx).not.toHaveBeenCalled();
    expect(h.avaliar).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('a válvula que FECHA entre a checagem e o início também é 503, e não deixa documento', async () => {
    // `iniciarEnvioPrecoShopee` lê a válvula de novo: o que ela lança é o
    // mesmo 503, nunca o braço genérico.
    h.loadCtx.mockImplementation(() => {
      vi.stubEnv('SHOPEE_TASKS_DISABLED', '1');
      return Promise.resolve(ctxDouble());
    });

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({
      code: CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU,
    });
    expect(jobs(db)).toEqual([]);
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});

/* ------------------------------ (4) the conta ------------------------------ */

describe('(4) as guardas da conta — ANTES do job (C-j)', () => {
  it('uma conta inexistente ou de outro tipo ⇒ 404, nenhum job', async () => {
    h.loadCtx.mockRejectedValue(new ShopeeContaNotConfiguredError('não é do tipo Shopee'));

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(404);
    expect(jobs(db)).toEqual([]);
  });

  it('tabela normal EM BRANCO ⇒ 400 SHOPEE_CONTA_SEM_TABELA_NORMAL, sem veredito e sem job', async () => {
    h.loadCtx.mockResolvedValue(ctxDouble({ tabelaNormalOuterRef: '  ' }));

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({
      error: MENSAGEM_POR_MOTIVO_PRECO['sem-tabela-normal'],
      code: CODIGO_GUARDA_PRECO.contaSemTabelaNormal,
    });
    expect(h.avaliar).not.toHaveBeenCalled();
    expect(jobs(db)).toEqual([]);
  });

  it('a ORDEM: tabela em branco E conta pausada ⇒ o 400 da tabela', async () => {
    h.loadCtx.mockResolvedValue(ctxDouble({ tabelaNormalOuterRef: null }));
    db.seed(`estoqueShopeeSync/${INT}`, {
      pausadoAte: AGORA_MS + 600_000,
      pausaMotivo: MOTIVOS_DE_PAUSA.burst,
    });

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(((await res.json()) as { code: string }).code).toBe(
      CODIGO_GUARDA_PRECO.contaSemTabelaNormal,
    );
  });

  it('PAR: pausa de COTA (burst) ⇒ 409 SHOPEE_CONTA_PAUSADA com pausadoAte, sem veredito e sem job', async () => {
    db.seed(`estoqueShopeeSync/${INT}`, {
      pausadoAte: AGORA_MS + 600_000,
      pausaMotivo: MOTIVOS_DE_PAUSA.burst,
    });

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: MENSAGEM_POR_MOTIVO_PRECO['conta-pausada'],
      code: CODIGO_GUARDA_PRECO.contaPausada,
      pausadoAte: new Date(AGORA_MS + 600_000).toISOString(),
    });
    expect(h.avaliar).not.toHaveBeenCalled();
    expect(jobs(db)).toEqual([]);
  });

  it('QUASE-IGUAL: a MESMA pausa com motivo de FÉRIAS não pausa o preço ⇒ 202', async () => {
    db.seed(`estoqueShopeeSync/${INT}`, {
      pausadoAte: AGORA_MS + 600_000,
      pausaMotivo: MOTIVOS_DE_PAUSA.lojaEmFerias,
    });

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(202);
    expect(jobs(db)).toHaveLength(1);
  });

  it('o veredito recusa ⇒ 422 SHOPEE_PRECO_CONTA_RECUSADA {motivo, mensagem, regiao}, e NENHUM job', async () => {
    h.avaliar.mockResolvedValue({
      ok: false,
      motivo: MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada,
      regiao: 'SG',
      erro: null,
    });

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(422);
    const mensagem = MENSAGEM_POR_MOTIVO_PRECO['regiao-nao-suportada'];
    await expect(res.json()).resolves.toEqual({
      error: mensagem,
      code: CODIGO_GUARDA_PRECO.contaRecusada,
      motivo: MOTIVO_PRECO_SHOPEE.regiaoNaoSuportada,
      mensagem,
      regiao: 'SG',
    });
    expect(jobs(db)).toEqual([]);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('o veredito que diz `sem-tabela-normal` é o 400, não o 422', async () => {
    h.avaliar.mockResolvedValue({
      ok: false,
      motivo: MOTIVO_PRECO_SHOPEE.semTabelaNormal,
      regiao: null,
      erro: null,
    });

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(400);
    expect(((await res.json()) as { code: string }).code).toBe(
      CODIGO_GUARDA_PRECO.contaSemTabelaNormal,
    );
    expect(jobs(db)).toEqual([]);
  });

  it('o veredito recebe o shop_id, a tabela e o instante da ÚNICA leitura do relógio', async () => {
    await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(h.avaliar).toHaveBeenCalledTimes(1);
    const [, conta, deps] = h.avaliar.mock.calls[0] as [unknown, unknown, { nowMs: number }];
    expect(conta).toEqual({ integracaoId: INT, shopId: 987_654, tabelaNormalOuterRef: TABELA_REF });
    expect(deps.nowMs).toBe(AGORA_MS);
  });
});

/* ------------------------------- (5) the job ------------------------------- */

describe('(5) o job e o primeiro despacho', () => {
  it('responde 202 {jobId}, cria UM job running e enfileira exatamente { jobId, integracaoId } sem opções', async () => {
    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(202);
    const { jobId } = (await res.json()) as { jobId: string };
    expect(jobs(db)).toEqual([jobId]);
    expect(doc(db, `${COL}/${jobId}`)).toMatchObject({
      integracaoId: INT,
      status: 'running',
      baixarPreco: false,
      startedBy: 'u1',
      startedAt: AGORA_MS,
      updatedAt: AGORA_MS,
    });
    expect(h.enqueue).toHaveBeenCalledTimes(1);
    expect(h.enqueue.mock.calls[0]).toEqual([{ jobId, integracaoId: INT }]);
  });

  it('(M-T1) o job nasce com expiraEm = um Date 180 dias depois do startedAt', async () => {
    const { jobId } = (await (await POST(req({ integracaoId: INT }, AUTORIZADO))).json()) as {
      jobId: string;
    };

    const expiraEm = doc(db, `${COL}/${jobId}`)['expiraEm'];
    expect(expiraEm).toBeInstanceOf(Date);
    expect((expiraEm as Date).getTime()).toBe(AGORA_MS + 180 * DIA_MS);
  });

  it('um job VIVO da conta ⇒ 409 SHOPEE_PRICE_SYNC_RUNNING, sem job novo e sem enfileirar', async () => {
    semearJob(db, 'job-vivo');

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toEqual({
      error: MSG_ENVIO_PRECO_EM_ANDAMENTO,
      code: CODIGO_ENVIO_PRECO_EM_ANDAMENTO,
    });
    expect(jobs(db)).toEqual(['job-vivo']);
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('um job ÓRFÃO (updatedAt de 7 h) é recuperado como failed e o novo começa ⇒ 202', async () => {
    semearJob(db, 'job-orfao', { updatedAt: AGORA_MS - 7 * 60 * 60 * 1000 });

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(202);
    expect(doc(db, `${COL}/job-orfao`)).toMatchObject({ status: 'failed' });
    expect(jobs(db)).toHaveLength(2);
  });

  it('⛔ o braço genérico responderia 500 ao 409: é o braço explícito que dá o status', async () => {
    const err = new ShopeeEnvioPrecoEmAndamentoError('em andamento');

    expect(isShopeeError(err)).toBe(true);
    expect(shopeeErrorResponse(err).status).toBe(500);
  });
});

/* ---------------------------- (6) enqueue failure --------------------------- */

describe('(6) o primeiro enfileiramento falhou — o job EXISTE e é carimbado', () => {
  async function iniciarComFalha(erro: unknown): Promise<{ res: Response; jobId: string }> {
    h.enqueue.mockRejectedValue(erro);
    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));
    const [jobId] = jobs(db);
    if (jobId === undefined) throw new Error('fixture: nenhum job foi criado');
    return { res, jobId };
  }

  it('a válvula fechada na hora do enqueue ⇒ 503 e o job failed com UMA linha job-interrompido', async () => {
    const { res, jobId } = await iniciarComFalha(new ShopeePriceSyncTasksDisabledError());

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      error: MSG_FILA_DE_PRECO_DESABILITADA,
      code: CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU,
    });
    expect(doc(db, `${COL}/${jobId}`)).toMatchObject({
      status: 'failed',
      erro: MSG_FILA_DE_PRECO_DESABILITADA,
      relatorioCompleto: false,
      finishedAt: AGORA_MS,
      relatorioLinhas: 1,
      relatorioShards: 1,
    });
    const linhas = Object.values(
      doc(db, `${COL}/${jobId}/relatorios/0000`)['linhas'] as Record<string, DocData>,
    );
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ resultado: 'nao-tentado', motivo: 'job-interrompido' });
  });

  it.each([
    ['uma falha gRPC do transporte', grpc(14, 'UNAVAILABLE https://tasks/…?token=abc')],
    ['a região ausente', new MissingRegionError('sem região ?token=abc', ['SHOPEE_TASKS_REGION'])],
  ])('%s ⇒ 503, e o erro carimbado é o NOME da classe, nunca a mensagem', async (_nome, erro) => {
    const { res, jobId } = await iniciarComFalha(erro);

    expect(res.status).toBe(503);
    const gravado = String(doc(db, `${COL}/${jobId}`)['erro']);
    expect(doc(db, `${COL}/${jobId}`)).toMatchObject({ status: 'failed' });
    expect(gravado).toContain((erro as Error).name);
    expect(gravado).not.toContain('token=abc');
    const corpo = (await res.json()) as { error: string; code: string };
    expect(corpo.code).toBe(CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU);
    expect(corpo.error).not.toContain('token=abc');
  });

  // (R-2) What the REAL transport raises: `taskQueue().enqueue` is REST, and
  // firebase-admin maps every HTTP failure to `FirebaseFunctionsError` (a queue
  // not deployed yet is `not-found` — the App-Hosting-before-functions order)
  // and a transport failure to `FirebaseAppError`. Both constructors are
  // public, so these are the SDK's own instances, not structural doubles.
  // ⚠️ Both leave `name` at `'Error'`, which is why the NAME assertion here is
  // the one that matters.
  it.each([
    [
      'FirebaseFunctionsError not-found (a fila ainda não implantada)',
      () =>
        new FirebaseFunctionsError({
          code: 'not-found',
          message: 'Queue projects/p/locations/r/queues/q does not exist ?token=abc',
        }),
      'FirebaseFunctionsError functions/not-found',
    ],
    [
      'FirebaseAppError network-error (o transporte REST caiu)',
      () =>
        new FirebaseAppError({
          code: 'network-error',
          message: 'ECONNRESET https://cloudtasks.googleapis.com/?token=abc',
        }),
      'FirebaseAppError app/network-error',
    ],
  ])(
    '(R-2) %s ⇒ 503 com o código de enfileiramento, job failed, e o erro carimbado nomeia a CLASSE e o código do SDK, nunca a mensagem',
    async (_nome, criar, nomeEsperado) => {
      const { res, jobId } = await iniciarComFalha(criar());

      expect(res.status).toBe(503);
      const corpo = (await res.json()) as { error: string; code: string };
      expect(corpo.code).toBe(CODIGO_ENVIO_PRECO_ENFILEIRAMENTO_FALHOU);
      const job = doc(db, `${COL}/${jobId}`);
      expect(job).toMatchObject({
        status: 'failed',
        relatorioCompleto: false,
        finishedAt: AGORA_MS,
      });
      const gravado = String(job['erro']);
      expect(gravado).toContain(`(${nomeEsperado})`);
      expect(gravado).not.toContain('token=abc');
      expect(gravado).not.toContain('ECONNRESET');
      expect(gravado).not.toContain('queues/q');
      expect(corpo.error).toBe(gravado);
      expect(console.warn).toHaveBeenCalledWith(
        expect.stringContaining('não foi enfileirado'),
        expect.objectContaining({ erro: nomeEsperado }),
      );
    },
  );

  it('(R-2) QUASE-IGUAL — um código fora da forma do SDK fica de fora: o carimbo diz só a CLASSE', async () => {
    const { res, jobId } = await iniciarComFalha(
      new FirebaseFunctionsError({ code: 'Not Found 404 ?token=abc', message: 'x' }),
    );

    expect(res.status).toBe(503);
    const gravado = String(doc(db, `${COL}/${jobId}`)['erro']);
    expect(gravado).toContain('(FirebaseFunctionsError)');
    expect(gravado).not.toContain('404');
    expect(gravado).not.toContain('token=abc');
  });

  it('⛔ uma classe DESCONHECIDA no enqueue: o job é carimbado failed E o erro sobe (rule 6)', async () => {
    h.enqueue.mockRejectedValue(new TypeError('bug nosso'));

    await expect(POST(req({ integracaoId: INT }, AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
    const [jobId] = jobs(db);
    expect(doc(db, `${COL}/${jobId!}`)).toMatchObject({ status: 'failed' });
  });

  it('PAR: o CARIMBO falha com gRPC ⇒ ainda 503, com um aviso no log', async () => {
    h.enqueue.mockRejectedValue(grpc(14, 'UNAVAILABLE'));
    db.occ.beforeCommit = () => {
      throw grpc(14, 'firestore indisponível');
    };

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(503);
    expect(console.warn).toHaveBeenCalled();
  });

  it('QUASE-IGUAL: o CARIMBO falha com um erro que NÃO é gRPC ⇒ sobe, nunca vira 503', async () => {
    h.enqueue.mockRejectedValue(grpc(14, 'UNAVAILABLE'));
    db.occ.beforeCommit = () => {
      throw new TypeError('bug no carimbo');
    };

    await expect(POST(req({ integracaoId: INT }, AUTORIZADO))).rejects.toBeInstanceOf(TypeError);
  });
});

/* ------------------------- (7) ONE conta ladder (R-1) ----------------------- */

describe('(7) a escada de conta é a MESMA do envio manual (R-1)', () => {
  it('no TEXTO: a válvula → a escada (UMA chamada) → o job → o enfileiramento; a rota não carrega cópia de degrau', () => {
    const fonte = readFileSync(new URL('./route.ts', import.meta.url), 'utf8');
    const corpo = fonte.slice(fonte.indexOf('export async function POST'));
    const posicoes = [
      'shopeeTasksDesabilitado()',
      'exigirContaParaPreco(',
      'iniciarEnvioPrecoShopee(',
      'createShopeePriceSyncScheduler()',
    ].map((trecho) => corpo.indexOf(trecho));

    expect(posicoes.every((p) => p > 0)).toBe(true);
    expect([...posicoes].sort((a, b) => a - b)).toEqual(posicoes);
    // The rungs are `regiaoPreco.ts`'s; a rung spelled here again is the second copy.
    for (const degrau of [
      'loadShopeeContext(',
      'CODIGO_GUARDA_PRECO.',
      'pausaDeCotaParaPreco(',
      'avaliarContaParaPreco(',
    ]) {
      expect(corpo).not.toContain(degrau);
    }
  });

  it('o braço que esta rota nunca exercitou: recusa SEM região e COM classe ⇒ 422 sem `regiao`, a classe no LOG com a tag desta rota, nunca no corpo', async () => {
    h.avaliar.mockResolvedValue({
      ok: false,
      motivo: MOTIVO_PRECO_SHOPEE.contaNaoConfigurada,
      regiao: null,
      erro: 'ShopeeSemCredencialError: Integração int-1 sem credencial 424242.',
    });

    const res = await POST(req({ integracaoId: INT }, AUTORIZADO));

    expect(res.status).toBe(422);
    const texto = await res.text();
    const corpo = JSON.parse(texto) as Record<string, unknown>;
    expect(Object.keys(corpo).sort()).toEqual(['code', 'error', 'mensagem', 'motivo']);
    expect(corpo).toMatchObject({
      code: CODIGO_GUARDA_PRECO.contaRecusada,
      motivo: MOTIVO_PRECO_SHOPEE.contaNaoConfigurada,
    });
    expect(texto).not.toContain('ShopeeSemCredencialError');
    expect(texto).not.toContain('424242');
    expect(console.warn).toHaveBeenCalledWith(
      '[shopee/precos] atualizar-precos: conta recusada (conta-nao-configurada)',
      expect.objectContaining({ integracaoId: INT, erro: expect.stringContaining('424242') }),
    );
    expect(jobs(db)).toEqual([]);
  });
});
