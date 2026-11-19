import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { MOTIVO_CONTA_AMAZON, idRegistroFeedAmazon } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../lib/amazon/core/contaCache';
import { criarProvedorLoteEstoqueAmazon } from '../../lib/amazon/estoque/provedorLoteEstoque';
import { DESTINO_LOTE_AMAZON } from '../../lib/amazon/feeds/destinosLote';
import type { ProvedorLoteAmazon } from '../../lib/amazon/feeds/provedorLote';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import { AGORA_MS, espiarStdout } from '../../lib/amazon/testing/fixtures';

/**
 * The jobs queue's BODY (step 12a, PR 12-c): what the function binds (the live
 * environment, the app's ONE logger, the stock root's producer, the seam's rows
 * BOUND once per process to that root's two producers — step 12, PR 12-e1 —
 * plus the real sleep, the aviso counter and a fresh run id — PR 12-f —, a
 * `fetch` read at call time), the dispatcher's one line for a refused payload,
 * and the sanitizing boundary of a throw. The declared options
 * live in `index.test.ts`; the handlers in `lib/amazon/feeds/*.test.ts`. No
 * network is reachable (D11): every `fetch` is refused and counted.
 */
const originalTasksInvokerSa = process.env.TASKS_INVOKER_SA;
process.env.TASKS_INVOKER_SA = '1-compute@developer.gserviceaccount.com';

const h = vi.hoisted(() => ({ db: null as unknown }));
vi.mock('./lib/admin', () => ({
  getDb: () => h.db,
  getAdminApp: () => {
    throw new Error('teste: nenhum app Admin real');
  },
}));

const {
  processAmazonListingsJob,
  ambienteDoProcessoAmazon,
  depsDosLotesAmazon,
  esperarMs,
  incrementoAmazon,
  novoExecucaoIdAmazon,
  PAGINA_RECONCILIACAO_AMAZON,
  PROVEDORES_DOS_LOTES_AMAZON,
  RAIZ_DOS_LOTES_AMAZON,
  SEGREDOS_DOS_LOTES_AMAZON,
} = await import('./filaLotes');
const { criarAgendadorLotesAmazonDoAmbiente, criarProdutorEstoqueAmazonDoAmbiente } =
  await import('./agendadorEstoque');

afterAll(() => {
  if (originalTasksInvokerSa === undefined) delete process.env.TASKS_INVOKER_SA;
  else process.env.TASKS_INVOKER_SA = originalTasksInvokerSa;
});

interface Requisicao {
  data: unknown;
  retryCount?: number;
  id?: string;
}

function rodar(req: Requisicao): Promise<void> {
  return (processAmazonListingsJob as unknown as { run(r: Requisicao): Promise<void> }).run(req);
}

const CONTA = 'conta-amz-fila-lotes';
const FEED = '50001234567';

let fake: FakeDb;
let stdout: ReturnType<typeof espiarStdout>;
const chamadasDeRede: string[] = [];

beforeEach(() => {
  fake = new FakeDb();
  h.db = asDb(fake);
  stdout = espiarStdout();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes(() => AGORA_MS);
  vi.stubEnv('AMAZON_CHAMADAS', undefined);
  vi.stubGlobal('fetch', (input: unknown) => {
    chamadasDeRede.push(String(input));
    return Promise.reject(new Error('teste: nenhuma chamada de rede é permitida'));
  });
});

afterEach(() => {
  stdout.restaurar();
  __resetAllReadCaches();
  __setRelogioDoCacheParaTestes();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  expect(chamadasDeRede).toEqual([]);
  chamadasDeRede.length = 0;
});

function linhas(): Record<string, unknown>[] {
  return stdout.linhas().map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe('processAmazonListingsJob — the body', () => {
  it('binds the LIVE environment, the stock root’s producer and the seam’s BOUND rows', () => {
    const deps = depsDosLotesAmazon({ tentativa: 3, idTarefa: 't' });
    expect(deps.ambiente).toBe(process.env);
    expect(deps.agendador).toBe(criarAgendadorLotesAmazonDoAmbiente);
    expect(deps.provedores).toBe(PROVEDORES_DOS_LOTES_AMAZON);
    expect(deps.registro).toEqual({ tentativa: 3, idTarefa: 't' });
    expect(SEGREDOS_DOS_LOTES_AMAZON).toEqual(['AMAZON_LWA_CLIENT_SECRET']);
  });

  it('★ the seam’s root holds BOTH of the stock root’s producers, as thunks (never built at load), the real sleep, the aviso counter and a fresh run id', () => {
    expect(RAIZ_DOS_LOTES_AMAZON).toEqual({
      agendadorLotes: criarAgendadorLotesAmazonDoAmbiente,
      produtorEstoque: criarProdutorEstoqueAmazonDoAmbiente,
      esperar: esperarMs,
      increment: incrementoAmazon,
      gerarExecucaoId: novoExecucaoIdAmazon,
      ambiente: ambienteDoProcessoAmazon,
    });
    // The environment as a THUNK, whole and live: what the call returns is the process's.
    expect(ambienteDoProcessoAmazon()).toBe(process.env);
    const [a, b] = [novoExecucaoIdAmazon(), novoExecucaoIdAmazon()];
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });

  it('(12-f) binds the stock reconcile’s page; a page dispatch runs it, valve first: unset reads NOTHING', async () => {
    const deps = depsDosLotesAmazon({ tentativa: 0, idTarefa: 'pagina-1' });
    expect(deps.paginaReconciliacao).toBe(PAGINA_RECONCILIACAO_AMAZON);
    vi.stubEnv('AMAZON_MODO_ESTOQUE', undefined);
    await rodar({
      data: { v: 1, tipo: 'reconciliacao', contaId: CONTA, execucaoId: 'exec-1', pagina: 0 },
      id: 'pagina-1',
    });
    expect(fake.operacoes).toBe(0);
    expect(linhas()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evento: 'estoque',
          fase: 'reconciliacao',
          etapa: 'pagina',
          acao: 'valvula-desligada',
          conta: CONTA,
        }),
      ]),
    );
  });

  it(
    '(12-f) the bound page gets the dispatch’s deps WHOLE plus the stock root’s producer (a thunk), the real sleep and a fresh run id per call',
    { timeout: 30_000 },
    async () => {
      vi.resetModules();
      const espiao = vi.fn((_db: unknown, _t: unknown, _deps: unknown) =>
        Promise.resolve({ acao: 'espiado' }),
      );
      vi.doMock('../../lib/amazon/estoque/reconciliacaoEstoque', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../lib/amazon/estoque/reconciliacaoEstoque')>()),
        processarPaginaReconciliacaoEstoqueAmazon: espiao,
      }));
      try {
        const fila = await import('./filaLotes');
        const raiz = await import('./agendadorEstoque');
        const base = fila.depsDosLotesAmazon({ tentativa: 2, idTarefa: 't-9' });
        const t = {
          v: 1,
          tipo: 'reconciliacao',
          contaId: CONTA,
          execucaoId: 'e1',
          pagina: 3,
        } as const;
        expect(await fila.PAGINA_RECONCILIACAO_AMAZON(asDb(fake), t, base)).toEqual({
          acao: 'espiado',
        });
        const [db, tarefa, deps] = espiao.mock.calls[0] as [
          unknown,
          unknown,
          Record<string, unknown>,
        ];
        expect(db).toBe(asDb(fake));
        expect(tarefa).toBe(t);
        expect(deps).toMatchObject({ ...base });
        expect(deps.produtorEstoque).toBe(raiz.criarProdutorEstoqueAmazonDoAmbiente);
        expect(deps.esperar).toBe(fila.esperarMs);
        const gerar = deps.gerarExecucaoId as () => string;
        const [a, b] = [gerar(), gerar()];
        expect(a).toMatch(/^[0-9a-f-]{36}$/);
        expect(a).not.toBe(b);
      } finally {
        vi.doUnmock('../../lib/amazon/estoque/reconciliacaoEstoque');
        vi.resetModules();
      }
    },
  );

  it('(12-f) the page’s sleep is a real one, of the asked milliseconds', async () => {
    vi.useFakeTimers();
    try {
      let acordou = false;
      const espera = esperarMs(334).then(() => {
        acordou = true;
      });
      await vi.advanceTimersByTimeAsync(333);
      expect(acordou).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await espera;
      expect(acordou).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('(12-f) the stock row is BOUND to the stock provider; the price row is still null', () => {
    expect(DESTINO_LOTE_AMAZON.estoque).toBe(criarProvedorLoteEstoqueAmazon);
    expect(DESTINO_LOTE_AMAZON.preco).toBeNull();
    const deps = depsDosLotesAmazon({ tentativa: 0, idTarefa: null });
    expect(deps.provedores.estoque?.fluxo).toBe('estoque');
    expect(deps.provedores.estoque?.motivoFalha).toBe(MOTIVO_CONTA_AMAZON.feedEstoqueFalhou);
    expect(deps.provedores.preco).toBeNull();
  });

  // Re-importing the root after `vi.resetModules()` loads the whole feed core again: CI headroom.
  it(
    '★ a FILLED row’s factory runs ONCE per process, with the root holding both producers, and every dispatch reads its one provider',
    { timeout: 30_000 },
    async () => {
      vi.resetModules();
      const provedor: ProvedorLoteAmazon<'estoque', unknown> = {
        fluxo: 'estoque',
        membros: () => Promise.reject(new Error('teste: não chamado')),
        montar: () => Promise.reject(new Error('teste: não chamado')),
        gravarResultado: () => Promise.reject(new Error('teste: não chamado')),
        recuperar: () => Promise.reject(new Error('teste: não chamado')),
        repassarParaPatches: () => Promise.reject(new Error('teste: não chamado')),
        motivoFalha: MOTIVO_CONTA_AMAZON.contaSemOperacao,
      };
      const fabrica = vi.fn((_raiz: unknown) => provedor);
      vi.doMock('../../lib/amazon/feeds/destinosLote', async (importOriginal) => ({
        ...(await importOriginal<typeof import('../../lib/amazon/feeds/destinosLote')>()),
        DESTINO_LOTE_AMAZON: { estoque: fabrica, preco: null },
      }));
      try {
        const fila = await import('./filaLotes');
        const raiz = await import('./agendadorEstoque');
        expect(fabrica).toHaveBeenCalledOnce();
        expect(fabrica.mock.calls[0]?.[0]).toEqual({
          agendadorLotes: raiz.criarAgendadorLotesAmazonDoAmbiente,
          produtorEstoque: raiz.criarProdutorEstoqueAmazonDoAmbiente,
          esperar: fila.esperarMs,
          increment: fila.incrementoAmazon,
          gerarExecucaoId: fila.novoExecucaoIdAmazon,
          ambiente: fila.ambienteDoProcessoAmazon,
        });
        const a = fila.depsDosLotesAmazon({ tentativa: 0, idTarefa: null });
        const b = fila.depsDosLotesAmazon({ tentativa: 1, idTarefa: 't-2' });
        expect(a.provedores.estoque).toBe(provedor);
        expect(a.provedores.preco).toBeNull();
        expect(b.provedores).toBe(a.provedores);
        // Two dispatches' deps later, still ONE call: never a factory per dispatch.
        expect(fabrica).toHaveBeenCalledOnce();
      } finally {
        vi.doUnmock('../../lib/amazon/feeds/destinosLote');
        vi.resetModules();
      }
    },
  );

  it('★ binds a fetch that reads the global AT CALL TIME — never a copy taken at load', async () => {
    const deps = depsDosLotesAmazon({ tentativa: 0, idTarefa: null });
    await expect(deps.fetch('https://example.invalid/sonda')).rejects.toThrow(
      'nenhuma chamada de rede',
    );
    expect(chamadasDeRede).toEqual(['https://example.invalid/sonda']);
    chamadasDeRede.length = 0;
  });

  it('a refused payload ⇒ ONE ERROR line naming the attempt and the task id, nothing read, no throw', async () => {
    await rodar({ data: { tipo: 'outra-coisa' }, retryCount: 1, id: 'tarefa-lotes-1' });
    expect(linhas()).toEqual([
      expect.objectContaining({
        evento: 'feed',
        severity: 'ERROR',
        recusa: 'tipo-desconhecido',
        tentativa: 1,
        idTarefa: 'tarefa-lotes-1',
      }),
    ]);
    expect(fake.operacoes).toBe(0);
  });

  it('★ a result rung of an unknown feed reads only its record: feed-desconhecido, ZERO Amazon calls, ONE line', async () => {
    await rodar({
      data: {
        v: 1,
        tipo: 'feed-resultado',
        contaId: CONTA,
        feedId: FEED,
        rodada: 0,
        origem: 'consulta',
      },
      retryCount: 0,
      id: 't-2',
    });
    expect(fake.leituras).toEqual([`feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`]);
    expect(linhas()).toEqual([
      expect.objectContaining({ evento: 'feed', fase: 'resultado', acao: 'feed-desconhecido' }),
    ]);
  });

  it('a send under the EMPTY price row ⇒ sem-provedor: the valve line, then ONE send line, the lease never read', async () => {
    vi.stubEnv('AMAZON_MODO_PRECO', 'on');
    await rodar({
      data: {
        v: 1,
        tipo: 'feed-enviar',
        fluxo: 'preco',
        contaId: CONTA,
        execucaoId: 'exec-fila-lotes',
        origem: 'delta',
        lote: {
          tipo: 'blocos',
          execucaoIdRun: 'run-teste',
          parteInicial: 0,
          partes: 1,
          esperaAteMs: AGORA_MS,
        },
      },
    });
    expect(linhas().map((l) => l.evento)).toEqual(['valvula', 'preco']);
    expect(linhas().at(-1)).toMatchObject({ fase: 'envio', acao: 'sem-provedor' });
    expect(fake.operacoes).toBe(0);
  });

  it('(12-f) a STOCK send reaches the bound stock provider only past the context: the switch off ⇒ contexto-recusado, ZERO Firestore operations', async () => {
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'on');
    await rodar({
      data: {
        v: 1,
        tipo: 'feed-enviar',
        fluxo: 'estoque',
        contaId: CONTA,
        execucaoId: 'exec-fila-lotes',
        origem: 'delta',
        lote: {
          tipo: 'blocos',
          execucaoIdRun: 'run-teste',
          parteInicial: 0,
          partes: 1,
          esperaAteMs: AGORA_MS,
        },
      },
    });
    expect(linhas().map((l) => l.evento)).toEqual(['valvula', 'chamada-bloqueada', 'estoque']);
    expect(linhas().at(-1)).toMatchObject({
      fase: 'envio',
      acao: 'contexto-recusado',
      motivo: 'chamadas-desligadas',
    });
    expect(fake.operacoes).toBe(0);
  });

  it('a throw leaves SANITIZED through the app’s boundary (a Firestore error stays itself), and no line', async () => {
    fake.falharLeitura(
      `feedsAmazon/${idRegistroFeedAmazon(CONTA, FEED)}`,
      Object.assign(new Error('x'), { code: 14 }),
    );
    await expect(
      rodar({
        data: {
          v: 1,
          tipo: 'feed-resultado',
          contaId: CONTA,
          feedId: FEED,
          rodada: 0,
          origem: 'consulta',
        },
      }),
    ).rejects.toMatchObject({ code: 14 });
    expect(linhas().filter((l) => l.fase === 'resultado')).toEqual([]);
  });
});
