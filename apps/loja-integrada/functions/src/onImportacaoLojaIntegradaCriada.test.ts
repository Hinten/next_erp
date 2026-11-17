import { logger } from 'firebase-functions/v2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { importacaoLojaIntegradaCollection } from '@delfrance/data/admin/collections';
import { STATUS_IMPORTACAO_LI, type TarefaImportacaoLi } from '@delfrance/schemas';

import {
  type AgendadorImportacaoLi,
  type FilaImportacaoLi,
  type OpcoesEnfileiramentoImportacaoLi,
  criarAgendadorImportacaoLi,
} from '../../lib/lojaIntegrada/importacao/agendadorImportacao';
import { LiTarefasTransitoriasError } from '../../lib/lojaIntegrada/notificacoes/agendador';
import { FakeDb, asDb } from '../../lib/lojaIntegrada/testing/fakeDb';
import { falhaDoFunctions } from '../../lib/lojaIntegrada/testing/falhaDeEnfileiramento';
import { AGORA_MS } from '../../lib/lojaIntegrada/testing/fixtures';
import { caminhoJobLi, jobLi, seedJobLi } from '../../lib/lojaIntegrada/testing/importacaoLi';

/**
 * The product import's job-creation TRIGGER (master plan step 9): a job document created `pendente`
 * ⇒ ONE named task — dispatch 0 — on the reads queue; anything else ⇒ nothing.
 *
 * It fires on EVERY create of `importacoesLojaIntegrada/*`, including every emulator suite's seeded
 * `executando` jobs, so the absences are the contract and they are pinned HERE, by counting: the
 * reads the fake Firestore served, the enqueues the producer received, every log line. An emulator
 * cannot prove that a function did nothing.
 *
 * The producer is the REAL pure one (`criarAgendadorImportacaoLi`) over a recording transport, so
 * the task name, already-exists, the valve and the transient naming are the shipped rules. D17: the
 * trigger never calls Loja Integrada, and no network is reachable.
 */
const h = vi.hoisted(() => ({ db: null as unknown, agendador: null as unknown }));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));
vi.mock('./agendador', () => ({
  criarAgendadorImportacaoLiDoAmbiente: () => h.agendador,
}));

const { onImportacaoLojaIntegradaCriada, tratarImportacaoCriadaLi } =
  await import('./onImportacaoLojaIntegradaCriada');

const CONTA = 'conta-li-gatilho-importacao';
const JOB = 'jobGatilho0000000001';

let fake: FakeDb;
let dbs: number;
let agendadores: number;
type Linha = (msg: string, meta?: Record<string, unknown>) => void;
let info: ReturnType<typeof vi.fn<Linha>>;
let warn: ReturnType<typeof vi.fn<Linha>>;
const chamadasDeRede: string[] = [];

interface Transporte {
  readonly f: FilaImportacaoLi;
  readonly envios: { tarefa: TarefaImportacaoLi; opcoes: OpcoesEnfileiramentoImportacaoLi }[];
}

function transporte(falha: Error | null = null): Transporte {
  const envios: Transporte['envios'] = [];
  return {
    envios,
    f: {
      enqueue: (tarefa, opcoes) => {
        envios.push({ tarefa, opcoes });
        return falha === null ? Promise.resolve() : Promise.reject(falha);
      },
    },
  };
}

function deps(o: { t?: Transporte; desligado?: boolean } = {}) {
  const t = o.t ?? transporte();
  return {
    t,
    deps: {
      db: () => {
        dbs += 1;
        return asDb(fake);
      },
      agendador: (): AgendadorImportacaoLi => {
        agendadores += 1;
        return criarAgendadorImportacaoLi({ fila: () => t.f, desligado: o.desligado ?? false });
      },
      agoraMs: () => AGORA_MS,
      logger: { info, warn },
    },
  };
}

/** The created document's raw body, as the event carries it. */
function criado(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(jobLi(CONTA, { status: STATUS_IMPORTACAO_LI.pendente }) as object), ...over };
}

beforeEach(() => {
  fake = new FakeDb();
  dbs = 0;
  agendadores = 0;
  info = vi.fn<Linha>();
  warn = vi.fn<Linha>();
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

describe('tratarImportacaoCriadaLi', () => {
  it('a job created `pendente` ⇒ ONE task, named after dispatch 0, ids only, no delay — and no read', async () => {
    const { deps: d, t } = deps();
    const r = await tratarImportacaoCriadaLi(d, { jobId: JOB, dados: criado() });
    expect(r).toBe('enfileirado');
    expect(t.envios).toEqual([
      {
        tarefa: { tipo: 'importacao', contaId: CONTA, jobId: JOB, seq: 0 },
        opcoes: { id: `li-importacao-${JOB}-0` },
      },
    ]);
    expect(dbs).toBe(0);
    expect(fake.leituras).toEqual([]);
    expect(info).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('enfileirado'), {
      jobId: JOB,
      contaId: CONTA,
    });
  });

  it.each<[string, Record<string, unknown> | undefined]>([
    ['executando (what every emulator suite seeds)', criado({ status: 'executando' })],
    ['concluido', criado({ status: 'concluido' })],
    ['cancelado', criado({ status: 'cancelado' })],
    ['a status this build does not know', criado({ status: 'PENDENTE' })],
    ['no status at all', { integracaoId: CONTA }],
    ['no body at all', undefined],
  ])(
    'NEAR-MISS — a job created %s ⇒ NOTHING: no producer, no read, no line',
    async (_nome, dados) => {
      const { deps: d, t } = deps();
      expect(await tratarImportacaoCriadaLi(d, { jobId: JOB, dados })).toBe('ignorado');
      expect(agendadores).toBe(0);
      expect(t.envios).toEqual([]);
      expect(dbs).toBe(0);
      expect(info).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it('a `pendente` job that cannot name its task logs ONE warning with field NAMES and enqueues nothing', async () => {
    const { deps: d, t } = deps();
    const r = await tratarImportacaoCriadaLi(d, {
      jobId: JOB,
      dados: criado({ integracaoId: 'conta com espaço-valor-secreto' }),
    });
    expect(r).toBe('payload-invalido');
    expect(t.envios).toEqual([]);
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      jobId: JOB,
      campos: ['contaId'],
    });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('valor-secreto');
  });

  it('an answered task-already-exists (a redelivery) is success', async () => {
    const { deps: d } = deps({ t: transporte(falhaDoFunctions('task-already-exists', 409)) });
    expect(await tratarImportacaoCriadaLi(d, { jobId: JOB, dados: criado() })).toBe('enfileirado');
  });

  it('the tasks valve CLOSED stamps the job falhou/tarefas-desligadas at dispatch 0 — never `pendente` with nothing queued', async () => {
    seedJobLi(fake, JOB, CONTA, { status: STATUS_IMPORTACAO_LI.pendente });
    const { deps: d, t } = deps({ desligado: true });
    expect(await tratarImportacaoCriadaLi(d, { jobId: JOB, dados: criado() })).toBe(
      'tarefas-desligadas',
    );
    expect(t.envios).toEqual([]);
    expect(fake.ler(caminhoJobLi(JOB))).toMatchObject({
      status: 'falhou',
      motivo: 'tarefas-desligadas',
      concluidoEmMs: AGORA_MS,
    });
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      jobId: JOB,
      contaId: CONTA,
      encerrada: true,
    });
  });

  it('…but never over a cancel that already won', async () => {
    seedJobLi(fake, JOB, CONTA, { status: STATUS_IMPORTACAO_LI.cancelado });
    const { deps: d } = deps({ desligado: true });
    expect(await tratarImportacaoCriadaLi(d, { jobId: JOB, dados: criado() })).toBe('parado');
    expect(fake.ler(caminhoJobLi(JOB))).toMatchObject({ status: 'cancelado' });
    expect(fake.escritas).toEqual([]);
  });

  it('a transient Cloud Tasks failure is RETHROWN for Eventarc’s retry, and nothing is written', async () => {
    seedJobLi(fake, JOB, CONTA, { status: STATUS_IMPORTACAO_LI.pendente });
    const { deps: d } = deps({ t: transporte(falhaDoFunctions('unknown-error')) });
    await expect(
      tratarImportacaoCriadaLi(d, { jobId: JOB, dados: criado() }),
    ).rejects.toBeInstanceOf(LiTarefasTransitoriasError);
    expect(fake.escritas).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                               The deployed trigger                         */
/* -------------------------------------------------------------------------- */

function endpointOf(fn: unknown): Record<string, unknown> {
  return (fn as { __endpoint: Record<string, unknown> }).__endpoint;
}

describe('onImportacaoLojaIntegradaCriada — the declared options', () => {
  const gatilho = endpointOf(onImportacaoLojaIntegradaCriada).eventTrigger as {
    eventType?: string;
    eventFilters?: { database?: string };
    eventFilterPathPatterns?: { document?: string };
    retry?: boolean;
  };

  it('fires on CREATE of a job document, on the named `default` database, with retry', () => {
    expect(gatilho.eventType).toBe('google.cloud.firestore.document.v1.created');
    expect(gatilho.eventFilterPathPatterns?.document).toBe(
      `${importacaoLojaIntegradaCollection.resolvePath({})}/{jobId}`,
    );
    expect(gatilho.eventFilterPathPatterns?.document).toBe('importacoesLojaIntegrada/{jobId}');
    expect(gatilho.eventFilters?.database).toBe('default');
    expect(gatilho.retry).toBe(true);
  });

  it('declares no secret', () => {
    expect(endpointOf(onImportacaoLojaIntegradaCriada).secretEnvironmentVariables ?? []).toEqual(
      [],
    );
  });
});

describe('onImportacaoLojaIntegradaCriada — what the run binds', () => {
  function disparar(dados: Record<string, unknown>): Promise<unknown> {
    return (
      onImportacaoLojaIntegradaCriada as unknown as { run(e: unknown): Promise<unknown> }
    ).run({ data: { exists: true, data: () => dados }, params: { jobId: JOB } });
  }

  it('the producer root and the jobId from the path: a `pendente` job enqueues through them', async () => {
    const t = transporte();
    h.agendador = criarAgendadorImportacaoLi({ fila: () => t.f, desligado: false });
    const spy = vi.spyOn(logger, 'info').mockImplementation(() => {});
    try {
      await disparar(criado());
    } finally {
      spy.mockRestore();
    }
    expect(t.envios.map((e) => e.opcoes.id)).toEqual([`li-importacao-${JOB}-0`]);
  });

  it('the codebase db and a real clock: the closed valve stamps through them', async () => {
    h.db = asDb(fake);
    seedJobLi(fake, JOB, CONTA, { status: STATUS_IMPORTACAO_LI.pendente });
    h.agendador = criarAgendadorImportacaoLi({ fila: () => transporte().f, desligado: true });
    const spy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const antes = Date.now();
    try {
      await disparar(criado());
    } finally {
      spy.mockRestore();
    }
    const job = fake.ler(caminhoJobLi(JOB));
    expect(job).toMatchObject({ status: 'falhou', motivo: 'tarefas-desligadas' });
    expect(job?.concluidoEmMs).toBeGreaterThanOrEqual(antes);
  });
});
