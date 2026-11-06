/**
 * `POST …/conta/[id]/importacoes/[jobId]/cancelar` — stop one product import (master plan step 9),
 * end to end through the REAL cancel (`importacao/job.ts`) against the fake: one guarded update,
 * re-decided on a lost precondition. Mocked: the Admin singleton only. The global `fetch` THROWS for
 * the whole file and is never called.
 */
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CODIGO_ERRO_LI,
  erroContaLojaIntegradaSchema,
  respostaImportacaoLiSchema,
} from '@delfrance/schemas';

import { CHAMADAS_ENV_LI } from '@/lib/lojaIntegrada/core/valvulas';
import { FakeDb, asDb } from '@/lib/lojaIntegrada/testing/fakeDb';
import { AGORA_MS } from '@/lib/lojaIntegrada/testing/fixtures';
import { caminhoJobLi, seedJobLi } from '@/lib/lojaIntegrada/testing/importacaoLi';
import {
  ESCRITOR,
  LEITOR,
  espiarConsole,
  requisicao,
  textoDe,
} from '@/lib/lojaIntegrada/testing/rotas';
import {
  MAX_TENTATIVAS_ESCRITA_JOB_LI,
  gravarCheckpointDaUnidadeLi,
  lerJobLi,
} from '@/lib/lojaIntegrada/importacao/job';

const h = vi.hoisted(() => ({ verifyIdToken: vi.fn(), db: undefined as unknown }));

vi.mock('@/lib/firebase/admin', () => ({
  getAdminAuth: () => ({ verifyIdToken: h.verifyIdToken }),
  getAdminFirestore: () => h.db,
}));

const { POST } = await import('./route');

const CONTA = 'conta-li-cancelar-http';
const JOB = 'jobCancelar01';

let db: FakeDb;
let fetchFalso: Mock<typeof globalThis.fetch>;
let console_: ReturnType<typeof espiarConsole>;

function post(conta = CONTA, jobId = JOB, semAuth = false) {
  return POST(
    requisicao(
      'POST',
      `${encodeURIComponent(conta)}/importacoes/${encodeURIComponent(jobId)}/cancelar`,
      { semAuth },
    ),
    { params: Promise.resolve({ id: conta, jobId }) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(AGORA_MS + 60_000);
  db = new FakeDb();
  h.db = asDb(db);
  h.verifyIdToken.mockResolvedValue(ESCRITOR);
  fetchFalso = vi.fn<typeof globalThis.fetch>(() => {
    throw new Error('o cancelamento não chama a Loja Integrada');
  });
  vi.stubGlobal('fetch', fetchFalso);
  console_ = espiarConsole();
  // The switch as every environment has it until the window: the cancel works anyway.
  vi.stubEnv(CHAMADAS_ENV_LI, undefined);
});

afterEach(() => {
  console_.restaurar();
  expect(fetchFalso).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('POST …/cancelar', () => {
  it('401 without a bearer token; 403 with read only; nothing read or written', async () => {
    expect((await post(CONTA, JOB, true)).status).toBe(401);
    h.verifyIdToken.mockResolvedValue(LEITOR);
    expect((await post()).status).toBe(403);
    expect(db.leituras).toEqual([]);
    expect(db.escritas).toEqual([]);
  });

  it.each<[string, string]>([
    ['a.b', JOB],
    [CONTA, 'job/1'],
  ])('400 LI_ID_INVALIDO for (%j, %j), before anything is read', async (conta, jobId) => {
    const res = await post(conta, jobId);
    expect(res.status).toBe(400);
    expect(db.leituras).toEqual([]);
  });

  it.each(['pendente', 'executando'])(
    '200: a %s job is stamped cancelado by ONE guarded update; the answer is the job as written',
    async (status) => {
      seedJobLi(db, JOB, CONTA, { status });
      const res = await post();
      expect(res.status).toBe(200);
      const corpo = respostaImportacaoLiSchema.parse(await res.json());
      expect(corpo).toMatchObject({
        jobId: JOB,
        status: 'cancelado',
        concluidoEmMs: AGORA_MS + 60_000,
      });
      expect(db.escritas.map((e) => [e.verbo, e.caminho])).toEqual([['update', caminhoJobLi(JOB)]]);
      expect(db.ler(caminhoJobLi(JOB))).toMatchObject({ status: 'cancelado' });
    },
  );

  it.each(['concluido', 'falhou', 'cancelado'])(
    '409 LI_IMPORTACAO_ENCERRADA for a %s job: never relabelled, nothing written',
    async (status) => {
      seedJobLi(db, JOB, CONTA, { status });
      const res = await post();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: CODIGO_ERRO_LI.importacaoEncerrada });
      expect(db.escritas).toEqual([]);
      expect(db.ler(caminhoJobLi(JOB))?.status).toBe(status);
    },
  );

  it('404 LI_IMPORTACAO_NAO_ENCONTRADA for a missing job AND for another conta’s — same body, nothing written', async () => {
    seedJobLi(db, JOB, 'conta-li-outra');
    const deOutra = await post();
    const ausente = await post(CONTA, 'jobQueNaoExiste');
    expect(deOutra.status).toBe(404);
    expect(await deOutra.json()).toEqual(await ausente.json());
    expect(db.escritas).toEqual([]);
    expect(db.ler(caminhoJobLi(JOB))?.status).toBe('executando');
  });

  it('503 with the running jobId when the job checkpoints between every read and write — nothing written, ONE warn line with ids only', async () => {
    seedJobLi(db, JOB, CONTA, { seq: 0 });
    // A running dispatch checkpoints right before each of the cancel's three writes; each hook is
    // installed only after the previous one's own write landed.
    let feitas = 0;
    const instalar = (): void => {
      db.antesDaProximaEscrita(caminhoJobLi(JOB), async () => {
        const lido = await lerJobLi(asDb(db), JOB);
        if (lido === null) throw new Error('fixture: job gone');
        feitas += 1;
        await gravarCheckpointDaUnidadeLi(
          asDb(db),
          { jobId: JOB, seq: 0, versao: lido.versao },
          { pausas429: feitas },
          AGORA_MS,
        );
        if (feitas < MAX_TENTATIVAS_ESCRITA_JOB_LI) instalar();
      });
    };
    instalar();
    const res = await post();
    expect(res.status).toBe(503);
    const corpo = erroContaLojaIntegradaSchema.parse(await res.json());
    expect(corpo.code).toBe(CODIGO_ERRO_LI.importacaoEmConflito);
    // ⚠️ NEAR-MISS: never the start route's "attach to the running job" answer.
    expect(corpo.jobId).toBeUndefined();
    expect(db.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'executando',
      pausas429: MAX_TENTATIVAS_ESCRITA_JOB_LI,
    });
    const linhas = console_.argumentos();
    expect(linhas).toHaveLength(1);
    expect(textoDe(linhas[0])).toContain(JOB);
    expect(linhas[0]?.[1]).toEqual({ conta: CONTA, jobId: JOB, uid: ESCRITOR.uid });
  });
});
