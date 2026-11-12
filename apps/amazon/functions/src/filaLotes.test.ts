import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetAllReadCaches } from '@delfrance/data/admin/cache';
import { idRegistroFeedAmazon } from '@delfrance/schemas';

import { __setRelogioDoCacheParaTestes } from '../../lib/amazon/core/contaCache';
import { DESTINO_LOTE_AMAZON, provedorDoLoteAmazon } from '../../lib/amazon/feeds/destinosLote';
import { FakeDb, asDb } from '../../lib/amazon/testing/fakeDb';
import { AGORA_MS, espiarStdout } from '../../lib/amazon/testing/fixtures';

/**
 * The jobs queue's BODY (step 12a, PR 12-c): what the function binds (the live
 * environment, the app's ONE logger, the stock root's producer, the seam table
 * read per run, a `fetch` read at call time), the dispatcher's one line for a
 * refused payload, and the sanitizing boundary of a throw. The declared options
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

const { processAmazonListingsJob, depsDosLotesAmazon, SEGREDOS_DOS_LOTES_AMAZON } =
  await import('./filaLotes');
const { criarAgendadorLotesAmazonDoAmbiente } = await import('./agendadorEstoque');

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
  it('binds the LIVE environment, the stock root’s producer and the seam table itself', () => {
    const deps = depsDosLotesAmazon({ tentativa: 3, idTarefa: 't' });
    expect(deps.ambiente).toBe(process.env);
    expect(deps.agendador).toBe(criarAgendadorLotesAmazonDoAmbiente);
    expect(deps.provedorDe).toBe(provedorDoLoteAmazon);
    expect(deps.registro).toEqual({ tentativa: 3, idTarefa: 't' });
    expect(SEGREDOS_DOS_LOTES_AMAZON).toEqual(['AMAZON_LWA_CLIENT_SECRET']);
  });

  it('the seam is EMPTY in this PR: both fluxos read null through the bound reader', () => {
    expect(DESTINO_LOTE_AMAZON).toEqual({ estoque: null, preco: null });
    const deps = depsDosLotesAmazon({ tentativa: 0, idTarefa: null });
    expect(deps.provedorDe('estoque')).toBeNull();
    expect(deps.provedorDe('preco')).toBeNull();
  });

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

  it('a send under the empty seam ⇒ sem-provedor: the valve line, then ONE send line, the lease never read', async () => {
    vi.stubEnv('AMAZON_MODO_ESTOQUE', 'on');
    await rodar({
      data: {
        v: 1,
        tipo: 'feed-enviar',
        fluxo: 'estoque',
        contaId: CONTA,
        execucaoId: 'exec-fila-lotes',
        origem: 'delta',
        lote: { tipo: 'blocos', partes: 1, esperaAteMs: AGORA_MS },
      },
    });
    expect(linhas().map((l) => l.evento)).toEqual(['valvula', 'estoque']);
    expect(linhas().at(-1)).toMatchObject({ fase: 'envio', acao: 'sem-provedor' });
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
