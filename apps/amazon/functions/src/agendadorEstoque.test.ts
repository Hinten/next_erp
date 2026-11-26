import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MissingRegionError } from '@delfrance/core/region';

import { falhaDeTarefaJaExistente } from '../../lib/amazon/testing/falhaDeEnfileiramento';

/**
 * The functions codebase's COMPOSITION ROOT of the stock flow's two producers
 * (step 12a, PR 12-c: the jobs queue; step 12, PR 12-e1: the stock queue): what
 * it reads from the environment (the ONE valve, the ONE region) and what it
 * hands the Admin SDK (each region-qualified queue path, the payload, a task's
 * name and delay).
 *
 * Mocked: only the transport seams — `getFunctions` and the admin app. The SDK's
 * error CLASSES stay real (the pure producer narrows on them). No network is
 * reachable: the queue is a recording fake.
 */
const h = vi.hoisted(() => ({
  enqueue: vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve()),
  taskQueue: vi.fn(),
  getFunctions: vi.fn(),
}));

vi.mock('firebase-admin/functions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('firebase-admin/functions')>()),
  getFunctions: (...args: unknown[]) => {
    h.getFunctions(...args);
    return { taskQueue: h.taskQueue };
  },
}));

const APP = vi.hoisted(() => ({ __app: 'admin' }));
vi.mock('./lib/admin', () => ({ getAdminApp: () => APP }));

const {
  criarAgendadorLotesAmazonDoAmbiente,
  criarProdutorEstoqueAmazonDoAmbiente,
  regiaoDasFilasDoEstoqueAmazon,
  tarefasDoEstoqueAmazonDesligadas,
} = await import('./agendadorEstoque');
const { AmazonEstoqueTarefasDesligadasError, ATRASO_PAUSA_ESTOQUE_S } =
  await import('../../lib/amazon/estoque/produtorEstoque');
const { nomeDaTarefaEstoque, tarefaEstoqueAmazonSchema } =
  await import('../../lib/amazon/estoque/tarefaEstoque');
const { AmazonLotesTarefasDesligadasError } = await import('../../lib/amazon/feeds/agendadorLotes');
const { nomeConsultaFeed, tarefaLoteAmazonSchema } =
  await import('../../lib/amazon/feeds/tarefaLote');
// (step 13, PR 13-d) The price task's producer: its own transport, the jobs queue's path.
const { criarProdutorPrecoAmazonDoAmbiente } = await import('./agendadorEstoque');
const { ATRASO_ESPERA_FEED_PRECO_S, ATRASO_PAUSA_PRECO_S, ATRASO_VERIFICACAO_PRECO_S } =
  await import('../../lib/amazon/preco/produtorPreco');
const { nomeDaTarefaPrecoAmazon, tarefaPrecoSkuAmazonSchema } =
  await import('../../lib/amazon/preco/tarefaPreco');

const CONTA = 'conta-teste';
const FEED = '50001234567';
const RODADA = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-resultado',
  contaId: CONTA,
  feedId: FEED,
  rodada: 1,
  origem: 'consulta',
});
const NOME = nomeConsultaFeed(CONTA, FEED, 1);
const ESPERA = tarefaLoteAmazonSchema.parse({
  v: 1,
  tipo: 'feed-incerto',
  fluxo: 'estoque',
  contaId: CONTA,
  execucaoId: 'exec-teste-0001',
});
/** A stock task: a delta of one observation (identities only, never a quantity). */
const PATCH = tarefaEstoqueAmazonSchema.parse({
  v: 1,
  contaId: CONTA,
  sku: 'SKU-TESTE-1',
  origem: 'delta',
  referencia: '1700000000.000000001',
  depositoId: null,
});

const chamadasDeRede: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  h.enqueue.mockImplementation(() => Promise.resolve());
  h.taskQueue.mockReturnValue({ enqueue: h.enqueue });
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

/** A clean environment for one case: only what the case sets. */
function ambiente(o: { tasksRegion?: string; functionsRegion?: string; desligado?: string }): void {
  vi.stubEnv('AMAZON_TASKS_REGION', o.tasksRegion);
  vi.stubEnv('FUNCTIONS_REGION', o.functionsRegion);
  vi.stubEnv('AMAZON_TASKS_DISABLED', o.desligado);
}

describe('the queue path', () => {
  it('★ enqueues onto locations/<region>/functions/processAmazonListingsJob, on the admin app', async () => {
    ambiente({ tasksRegion: 'xx-regiao1', functionsRegion: 'xx-regiao1' });

    await criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(RODADA, { nome: NOME });

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(
      'locations/xx-regiao1/functions/processAmazonListingsJob',
    );
    // NEVER another queue: a separate root binds a separate queue.
    for (const outra of [
      'filaLeituraAmazon',
      'processAmazonNfeUpload',
      'processAmazonEasyShipSchedule',
      'processAmazonStockPatch',
    ]) {
      expect(h.taskQueue).not.toHaveBeenCalledWith(expect.stringContaining(outra));
    }
  });

  it('a named enqueue carries its name; an unnamed wait carries only its delay', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });
    const agendador = criarAgendadorLotesAmazonDoAmbiente();

    expect(await agendador.enfileirarLote(RODADA, { nome: NOME, atrasoS: 120 })).toBe(
      'enfileirada',
    );
    await agendador.enfileirarLote(ESPERA, { atrasoS: 30 });

    expect(h.enqueue.mock.calls).toEqual([
      [RODADA, { id: NOME, scheduleDelaySeconds: 120 }],
      [ESPERA, { scheduleDelaySeconds: 30 }],
    ]);
  });

  it('the SDK’s own 409 for a held name reads ja-enfileirada through the root', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });
    h.enqueue.mockImplementationOnce(() => Promise.reject(falhaDeTarefaJaExistente(NOME)));

    expect(await criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(RODADA, { nome: NOME })).toBe(
      'ja-enfileirada',
    );
  });

  it('AMAZON_TASKS_REGION wins over FUNCTIONS_REGION', () => {
    ambiente({ tasksRegion: 'xx-regiao2', functionsRegion: 'xx-regiao1' });
    expect(regiaoDasFilasDoEstoqueAmazon()).toBe('xx-regiao2');
  });

  // NEAR-MISS of the fallback: a DECLARED but blank variable is not "set".
  it('falls back to FUNCTIONS_REGION when AMAZON_TASKS_REGION is unset or blank', async () => {
    for (const tasksRegion of [undefined, '   ']) {
      ambiente({ tasksRegion, functionsRegion: 'xx-regiao1' });
      await criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(ESPERA);
    }
    expect(h.taskQueue.mock.calls).toEqual([
      ['locations/xx-regiao1/functions/processAmazonListingsJob'],
      ['locations/xx-regiao1/functions/processAmazonListingsJob'],
    ]);
  });

  it('★ REFUSES the enqueue with no region at all, before touching the transport (no default)', async () => {
    ambiente({});
    await expect(
      criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(ESPERA),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it('★ writes requireRegion as an object literal of STATIC process.env reads — the shape `define` can inline', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendadorEstoque.ts', import.meta.url)),
      'utf8',
    ).replace(/\r\n/g, '\n');
    expect(fonte.match(/requireRegion\(/g) ?? []).toHaveLength(1);
    expect(fonte).toContain(
      [
        'requireRegion({',
        '    AMAZON_TASKS_REGION: process.env.AMAZON_TASKS_REGION,',
        '    FUNCTIONS_REGION: process.env.FUNCTIONS_REGION,',
        '  })',
      ].join('\n'),
    );
    expect(fonte).not.toMatch(/process\.env\[/);
  });

  it('★ the file has ONE `getFunctions(` call', () => {
    const fonte = readFileSync(
      fileURLToPath(new URL('./agendadorEstoque.ts', import.meta.url)),
      'utf8',
    );
    const codigo = fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(codigo.match(/\bgetFunctions\s*\(/g)).toHaveLength(1);
  });

  it('the NF-e root names nothing of the feed core or of the stock flow — the NF-e trigger’s closure does not grow', () => {
    const nfe = readFileSync(fileURLToPath(new URL('./agendadorNfe.ts', import.meta.url)), 'utf8');
    expect(nfe).not.toMatch(/feeds\//);
    expect(nfe).not.toMatch(/Lotes/);
    expect(nfe).not.toMatch(/estoque\//);
    expect(nfe).not.toMatch(/Estoque/);
  });
});

describe('the queue valve', () => {
  it("★ exactly '1' closes it: the enqueue rejects with the jobs queue’s class, and the SDK is never touched", async () => {
    ambiente({ functionsRegion: 'xx-regiao1', desligado: '1' });

    expect(tarefasDoEstoqueAmazonDesligadas()).toBe(true);
    const agendador = criarAgendadorLotesAmazonDoAmbiente();
    await expect(agendador.enfileirarLote(RODADA, { nome: NOME })).rejects.toBeInstanceOf(
      AmazonLotesTarefasDesligadasError,
    );
    await expect(agendador.enfileirarLote(ESPERA)).rejects.toBeInstanceOf(
      AmazonLotesTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  it('closed, it needs no region either', async () => {
    ambiente({ desligado: '1' });
    await expect(
      criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(ESPERA),
    ).rejects.toBeInstanceOf(AmazonLotesTarefasDesligadasError);
  });

  // NEAR-MISS: the valve is opt-in at EXACTLY '1' — never trimmed, never parsed.
  it.each([['1 '], [' 1'], ['true'], ['TRUE'], ['0'], [''], [undefined]])(
    'AMAZON_TASKS_DISABLED=%j leaves enqueuing ON',
    async (valor) => {
      ambiente({ functionsRegion: 'xx-regiao1', desligado: valor });

      expect(tarefasDoEstoqueAmazonDesligadas()).toBe(false);
      await criarAgendadorLotesAmazonDoAmbiente().enfileirarLote(ESPERA);
      expect(h.enqueue).toHaveBeenCalledExactlyOnceWith(ESPERA);
    },
  );
});

describe('the stock queue (step 12, PR 12-e1)', () => {
  it('★ enqueues onto locations/<region>/functions/processAmazonStockPatch, on the admin app — never the jobs queue', async () => {
    ambiente({ tasksRegion: 'xx-regiao1', functionsRegion: 'xx-regiao1' });

    expect(await criarProdutorEstoqueAmazonDoAmbiente().enfileirar(PATCH)).toBe('enfileirada');

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(
      'locations/xx-regiao1/functions/processAmazonStockPatch',
    );
    expect(h.taskQueue).not.toHaveBeenCalledWith(
      expect.stringContaining('processAmazonListingsJob'),
    );
    expect(h.enqueue.mock.calls).toEqual([[PATCH, { id: nomeDaTarefaEstoque(PATCH) }]]);
  });

  it('the 429 pause goes UNNAMED, delayed in whole seconds, through the same root', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });

    await criarProdutorEstoqueAmazonDoAmbiente().enfileirarPausa(PATCH);

    expect(h.enqueue.mock.calls).toEqual([
      [PATCH, { scheduleDelaySeconds: ATRASO_PAUSA_ESTOQUE_S }],
    ]);
  });

  it('the SDK’s own 409 for a held name reads ja-enfileirada through the root', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });
    h.enqueue.mockImplementationOnce(() =>
      Promise.reject(falhaDeTarefaJaExistente(nomeDaTarefaEstoque(PATCH))),
    );

    expect(await criarProdutorEstoqueAmazonDoAmbiente().enfileirar(PATCH)).toBe('ja-enfileirada');
  });

  it('★ shares the jobs queue’s region: AMAZON_TASKS_REGION wins, a blank one falls back, none at all REFUSES before the transport', async () => {
    ambiente({ tasksRegion: 'xx-regiao2', functionsRegion: 'xx-regiao1' });
    await criarProdutorEstoqueAmazonDoAmbiente().enfileirarPausa(PATCH);
    ambiente({ tasksRegion: '   ', functionsRegion: 'xx-regiao1' });
    await criarProdutorEstoqueAmazonDoAmbiente().enfileirarPausa(PATCH);
    expect(h.taskQueue.mock.calls).toEqual([
      ['locations/xx-regiao2/functions/processAmazonStockPatch'],
      ['locations/xx-regiao1/functions/processAmazonStockPatch'],
    ]);

    h.taskQueue.mockClear();
    h.enqueue.mockClear();
    ambiente({});
    await expect(
      criarProdutorEstoqueAmazonDoAmbiente().enfileirarPausa(PATCH),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("★ the SAME valve: exactly '1' refuses with the stock queue’s class, the SDK never touched", async () => {
    ambiente({ functionsRegion: 'xx-regiao1', desligado: '1' });

    const produtor = criarProdutorEstoqueAmazonDoAmbiente();
    await expect(produtor.enfileirar(PATCH)).rejects.toBeInstanceOf(
      AmazonEstoqueTarefasDesligadasError,
    );
    await expect(produtor.enfileirarPausa(PATCH)).rejects.toBeInstanceOf(
      AmazonEstoqueTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  // NEAR-MISS: the valve is opt-in at EXACTLY '1' for this producer too.
  it.each([['1 '], ['true'], [''], [undefined]])(
    'AMAZON_TASKS_DISABLED=%j leaves the stock enqueue ON',
    async (valor) => {
      ambiente({ functionsRegion: 'xx-regiao1', desligado: valor });
      await criarProdutorEstoqueAmazonDoAmbiente().enfileirarPausa(PATCH);
      expect(h.enqueue).toHaveBeenCalledOnce();
    },
  );
});

describe('the price task’s producer (step 13, PR 13-d)', () => {
  /** A manual price task: identities and the consent only, never a price. */
  const PRECO = tarefaPrecoSkuAmazonSchema.parse({
    v: 1,
    tipo: 'preco-sku',
    contaId: CONTA,
    sku: 'SKU-TESTE-1',
    origem: 'manual',
    referencia: 'req-teste-0001',
    parte: null,
    baixarPreco: false,
    solicitadoEmMs: 1_800_000_000_000,
    codigosAntes: [],
  });

  it('★ enqueues onto the JOBS queue, locations/<region>/functions/processAmazonListingsJob — never a queue of its own', async () => {
    ambiente({ tasksRegion: 'xx-regiao1', functionsRegion: 'xx-regiao1' });

    expect(await criarProdutorPrecoAmazonDoAmbiente().enfileirar(PRECO)).toBe('enfileirada');

    expect(h.getFunctions).toHaveBeenCalledExactlyOnceWith(APP);
    expect(h.taskQueue).toHaveBeenCalledExactlyOnceWith(
      'locations/xx-regiao1/functions/processAmazonListingsJob',
    );
    // NEAR-MISS: the stock queue is the other path this root binds.
    expect(h.taskQueue).not.toHaveBeenCalledWith(
      expect.stringContaining('processAmazonStockPatch'),
    );
    expect(h.enqueue.mock.calls).toEqual([[PRECO, { id: nomeDaTarefaPrecoAmazon(PRECO) }]]);
  });

  it('the check goes NAMED after the submission, 900 s later; the wait and the pause UNNAMED, through the same root', async () => {
    ambiente({ functionsRegion: 'xx-regiao1' });
    const produtor = criarProdutorPrecoAmazonDoAmbiente();

    await produtor.enfileirarVerificacao(PRECO, 'sub-teste-0001', ['19037']);
    await produtor.enfileirarEspera(PRECO);
    await produtor.enfileirarPausa(PRECO);

    const [verificacao, espera, pausa] = h.enqueue.mock.calls as [
      unknown,
      Record<string, unknown>,
    ][];
    expect(verificacao?.[0]).toMatchObject({
      origem: 'verificacao',
      referencia: 'sub-teste-0001',
      codigosAntes: ['19037'],
    });
    expect(verificacao?.[1]).toEqual({
      id: nomeDaTarefaPrecoAmazon(
        tarefaPrecoSkuAmazonSchema.parse(verificacao?.[0] as Record<string, unknown>),
      ),
      scheduleDelaySeconds: ATRASO_VERIFICACAO_PRECO_S,
    });
    expect(espera).toEqual([PRECO, { scheduleDelaySeconds: ATRASO_ESPERA_FEED_PRECO_S }]);
    expect(pausa).toEqual([PRECO, { scheduleDelaySeconds: ATRASO_PAUSA_PRECO_S }]);
    expect(new Set(h.taskQueue.mock.calls.map((c) => c[0]))).toEqual(
      new Set(['locations/xx-regiao1/functions/processAmazonListingsJob']),
    );
  });

  it('★ shares the jobs queue’s region: none at all REFUSES before the transport (no default)', async () => {
    ambiente({});
    await expect(
      criarProdutorPrecoAmazonDoAmbiente().enfileirarPausa(PRECO),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });

  it("★ the SAME valve: exactly '1' refuses with the JOBS queue’s class, the SDK never touched", async () => {
    ambiente({ functionsRegion: 'xx-regiao1', desligado: '1' });

    const produtor = criarProdutorPrecoAmazonDoAmbiente();
    await expect(produtor.enfileirar(PRECO)).rejects.toBeInstanceOf(
      AmazonLotesTarefasDesligadasError,
    );
    await expect(produtor.enfileirarPausa(PRECO)).rejects.toBeInstanceOf(
      AmazonLotesTarefasDesligadasError,
    );
    expect(h.getFunctions).not.toHaveBeenCalled();
    expect(h.taskQueue).not.toHaveBeenCalled();
  });

  // NEAR-MISS: the valve is opt-in at EXACTLY '1' for this producer too.
  it.each([['1 '], ['true'], [''], [undefined]])(
    'AMAZON_TASKS_DISABLED=%j leaves the price enqueue ON',
    async (valor) => {
      ambiente({ functionsRegion: 'xx-regiao1', desligado: valor });
      await criarProdutorPrecoAmazonDoAmbiente().enfileirarPausa(PRECO);
      expect(h.enqueue).toHaveBeenCalledOnce();
    },
  );
});

describe('a price run’s page producer (step 13, PR 13-e)', () => {
  const PAGINA = {
    v: 1,
    tipo: 'preco-pagina',
    contaId: CONTA,
    execucaoId: 'exec-teste-0001',
    pagina: 2,
  };

  it('★ enqueues onto the JOBS queue — the page NAMED by (conta, run, page), the re-kick by the stall, the pause UNNAMED 60 s later', async () => {
    const { criarProdutorExecucaoPrecoAmazonDoAmbiente } = await import('./agendadorEstoque');
    const { ATRASO_PAUSA_PAGINA_PRECO_S } =
      await import('../../lib/amazon/preco/inicioExecucaoPreco');
    const { nomePaginaPrecoAmazon, nomeRetomadaPrecoAmazon } =
      await import('../../lib/amazon/preco/tarefaPreco');
    ambiente({ tasksRegion: 'xx-regiao1', functionsRegion: 'xx-regiao1' });
    const produtor = criarProdutorExecucaoPrecoAmazonDoAmbiente();

    expect(await produtor.enfileirarPagina(CONTA, 'exec-teste-0001', 2)).toBe('enfileirada');
    await produtor.enfileirarRetomada(CONTA, 'exec-teste-0001', 2, 1_800_000_000_000);
    await produtor.enfileirarPausa(CONTA, 'exec-teste-0001', 2);

    expect(h.enqueue.mock.calls).toEqual([
      [PAGINA, { id: nomePaginaPrecoAmazon(CONTA, 'exec-teste-0001', 2) }],
      [PAGINA, { id: nomeRetomadaPrecoAmazon(CONTA, 'exec-teste-0001', 2, 1_800_000_000_000) }],
      [PAGINA, { scheduleDelaySeconds: ATRASO_PAUSA_PAGINA_PRECO_S }],
    ]);
    expect(new Set(h.taskQueue.mock.calls.map((c) => c[0]))).toEqual(
      new Set(['locations/xx-regiao1/functions/processAmazonListingsJob']),
    );
    // NEAR-MISS: never the stock queue this root also binds.
    expect(h.taskQueue).not.toHaveBeenCalledWith(
      expect.stringContaining('processAmazonStockPatch'),
    );
  });

  it('★ the SAME valve: exactly 1 refuses with the JOBS queue’s class, the SDK never touched; no region REFUSES before the transport', async () => {
    const { criarProdutorExecucaoPrecoAmazonDoAmbiente } = await import('./agendadorEstoque');
    ambiente({ functionsRegion: 'xx-regiao1', desligado: '1' });
    await expect(
      criarProdutorExecucaoPrecoAmazonDoAmbiente().enfileirarPagina(CONTA, 'exec-teste-0001', 0),
    ).rejects.toBeInstanceOf(AmazonLotesTarefasDesligadasError);
    expect(h.getFunctions).not.toHaveBeenCalled();
    ambiente({});
    await expect(
      criarProdutorExecucaoPrecoAmazonDoAmbiente().enfileirarPagina(CONTA, 'exec-teste-0001', 0),
    ).rejects.toBeInstanceOf(MissingRegionError);
    expect(h.taskQueue).not.toHaveBeenCalled();
    expect(h.enqueue).not.toHaveBeenCalled();
  });
});
